import {
  API_BASE_URL,
  RESPONSE_HEADERS,
  type EventContext,
  buildUrl,
  createSuccessResponse,
  createRawJsonResponse,
  createNotFoundResponse,
  stringIsInteger,
  handlePathParam,
  createNotModifiedResponse,
  getEtagFromRequest,
  etagMatches,
  formatEtag,
  type EdgeOneRequest,
} from "./_common.js";
import { getData } from "./_data.js";

import {
  buildPageEtag,
  isValidPageQuery,
  parsePageQuery,
  parseNameQuery,
  normalizeName,
  type PageQueryParam,
} from "../../shared/cache.js";

interface ShardIdIndex {
  by_id: Record<string, string>;
  resource_hash: string;
}

interface ShardNameIndex {
  by_name: Record<string, number[]>;
  // resource_hash: string;
}

function getSortedIdKeys(byId: Record<string, string>): string[] {
  return Object.keys(byId).sort((a, b) => Number(a) - Number(b));
}

async function getShardIdIndex(
  resourceName: string,
): Promise<ShardIdIndex | null> {
  return await getData(`sharded_data/${resourceName}/id-index.json`, {
    type: "json",
  });
}

async function getShardNameIndex(
  resourceName: string,
): Promise<ShardNameIndex | null> {
  return await getData(`sharded_data/${resourceName}/name-index.json`, {
    type: "json",
  });
}

async function tryGetResourceHash(
  resourceName: string,
): Promise<string | null> {
  const hash = await getData(`sharded_data/${resourceName}/resource.hash`, {
    type: "text",
  });
  return hash ? hash.trim() : null;
}

function tryNotModifiedResponse(
  requestEtag: string,
  etag: string,
): Response | null {
  if (etagMatches(requestEtag, etag)) {
    return createNotModifiedResponse(etag);
  }
  return null;
}

async function fetchShardRecord(
  resourceName: string,
  shardFilename: string,
  id: string,
): Promise<any> {
  const data = await getData(
    `sharded_data/${resourceName}/id/shards/${shardFilename}.json`,
    { type: "json" },
  );
  if (!data) {
    throw new Error(`未找到数据: ${resourceName}/${id}`);
  }
  return data[id];
}

async function fetchShardRecordById(
  resourceName: string,
  id: string,
  idIndex: ShardIdIndex,
): Promise<any | null> {
  const shardFilename = idIndex.by_id[id];
  if (!shardFilename) {
    return null;
  }
  return fetchShardRecord(resourceName, shardFilename, id);
}

/** 并行加载一批分片文件，返回 shardFilename -> 分片内容 */
async function loadShardsByFilenames(
  resourceName: string,
  shardFilenames: Iterable<string>,
): Promise<Map<string, Record<string, any>>> {
  const unique = [...new Set(shardFilenames)];
  const entries = await Promise.all(
    unique.map(async (shardFilename) => {
      const data = await getData(
        `sharded_data/${resourceName}/id/shards/${shardFilename}.json`,
        { type: "json" },
      );
      if (!data) {
        throw new Error(`未找到数据: ${resourceName}/${shardFilename}`);
      }
      return [shardFilename, data] as const;
    }),
  );
  return new Map(entries);
}

async function fetchShardRecordsByName(
  resourceName: string,
  name: string,
  idIndex: ShardIdIndex,
  nameIndex: ShardNameIndex,
): Promise<Record<string, any> | null> {
  const ids = nameIndex.by_name[name];
  if (!ids) {
    return null;
  }
  const sortedIds = [...ids].sort((a, b) => a - b);
  const idStrs = sortedIds.map((id) => id.toString());
  const shardCache = await loadShardsByFilenames(
    resourceName,
    idStrs.map((idStr) => idIndex.by_id[idStr]).filter((s): s is string => !!s),
  );

  const result: Record<string, any> = {};
  for (const id of sortedIds) {
    const idStr = id.toString();
    const shardFilename = idIndex.by_id[idStr];
    if (!shardFilename) {
      continue;
    }
    result[id] = shardCache.get(shardFilename)![idStr];
  }
  return result;
}

async function fetchShardRecordsByIds(
  resourceName: string,
  ids: string[],
  idIndex: ShardIdIndex,
): Promise<any[]> {
  const shardCache = await loadShardsByFilenames(
    resourceName,
    ids.map((id) => idIndex.by_id[id]).filter((s): s is string => !!s),
  );

  const results: any[] = [];
  for (const id of ids) {
    const shardFilename = idIndex.by_id[id];
    if (!shardFilename) {
      continue;
    }
    results.push(shardCache.get(shardFilename)![id]);
  }
  return results;
}

function buildPageUrl(
  url: string | URL,
  queryParam?: PageQueryParam | null,
): URL | null {
  if (!queryParam) {
    return null;
  }
  url = new URL(url);
  url.searchParams.set("offset", queryParam.offset.toString());
  url.searchParams.set("limit", queryParam.limit.toString());
  if (queryParam.expand) {
    url.searchParams.set("expand", "true");
  }
  return url;
}

function getNextPage(
  pageParam: PageQueryParam,
  count: number,
): PageQueryParam | null {
  const nextOffset = pageParam.offset + pageParam.limit;
  if (nextOffset < count) {
    return {
      offset: nextOffset,
      limit: pageParam.limit,
      ...(pageParam.expand ? { expand: true } : {}),
    };
  }
  return null;
}

function getPreviousPage(pageParam: PageQueryParam): PageQueryParam | null {
  if (pageParam.offset > 0) {
    const previousOffset = Math.max(0, pageParam.offset - pageParam.limit);
    return {
      offset: previousOffset,
      limit: pageParam.limit,
      ...(pageParam.expand ? { expand: true } : {}),
    };
  }
  return null;
}

function getFirstPage(pageParam: PageQueryParam): PageQueryParam {
  return {
    offset: 0,
    limit: pageParam.limit,
    ...(pageParam.expand ? { expand: true } : {}),
  };
}

function getLastPage(pageParam: PageQueryParam, count: number): PageQueryParam {
  const lastOffset = Math.max(
    0,
    Math.floor((count - 1) / pageParam.limit) * pageParam.limit,
  );
  return {
    offset: lastOffset,
    limit: pageParam.limit,
    ...(pageParam.expand ? { expand: true } : {}),
  };
}

/**
 * 构建 RFC 5988 Link Header（包含 describedby）
 * @param url 基础 URL
 * @param path 路径
 * @param pageParam 当前分页参数
 * @param count 总数
 * @param schemaUrl Schema URL（可选）
 * @returns Link Header 字符串
 */
function buildLinkHeader(
  url: string,
  pageParam: PageQueryParam,
  count: number,
  schemaUrl?: URL,
): string {
  const links: string[] = [];

  // Schema describedby 链接（RFC 5988）
  if (schemaUrl) {
    links.push(`<${schemaUrl.toString()}>; rel="describedby"`);
  }

  // 下一页链接
  const nextPage = getNextPage(pageParam, count);
  if (nextPage) {
    const nextUrl = buildPageUrl(url, nextPage);
    if (nextUrl) links.push(`<${nextUrl}>; rel="next"`);
  }

  // 上一页链接
  const prevPage = getPreviousPage(pageParam);
  if (prevPage) {
    const prevUrl = buildPageUrl(url, prevPage);
    if (prevUrl) links.push(`<${prevUrl}>; rel="prev"`);
  }

  // 第一页链接
  const firstPage = getFirstPage(pageParam);
  const firstUrl = buildPageUrl(url, firstPage);
  if (firstUrl) links.push(`<${firstUrl}>; rel="first"`);

  // 最后一页链接
  const lastPage = getLastPage(pageParam, count);
  const lastUrl = buildPageUrl(url, lastPage);
  if (lastUrl) links.push(`<${lastUrl}>; rel="last"`);

  return links.join(", ");
}

async function handleDataRequest(
  path: string[],
  request: EdgeOneRequest,
  queryParams: URLSearchParams = new URLSearchParams(),
): Promise<Response> {
  const gzip = true;
  if (path.length > 2) return createNotFoundResponse();
  const [resource_name, name] = path;
  // name 查询参数只筛选资源列表，路径详情保持原有行为。
  if (!resource_name) {
    const raw = await getData(`sharded_data/index.json`, { type: "text" });
    if (!raw) {
      return createNotFoundResponse();
    }
    return createRawJsonResponse(raw, 200, "OK", {}, { gzip });
  }
  const requestEtag = getEtagFromRequest(request);

  // 如果没有二级路径，则查找一级路径是资源名称还是文件名称，
  if (!name) {
    const nameQuery = parseNameQuery(queryParams);
    if (!nameQuery.valid) {
      return new Response(
        JSON.stringify({ error: "name 长度不能超过 64 个字符" }),
        {
          status: 400,
          headers: RESPONSE_HEADERS,
        },
      );
    }
    const queryName = nameQuery.name;
    const pageParam = parsePageQuery(queryParams);
    if (!isValidPageQuery(pageParam)) {
      return new Response(
        JSON.stringify({
          error: pageParam.limit > 200 ? "limit 参数过大" : "分页参数无效",
        }),
        {
          status: 400,
          headers: RESPONSE_HEADERS,
        },
      );
    }

    // 快速路径：仅读取 resource.hash 即可完成条件请求，跳过 id-index.json
    const resourceHash = await tryGetResourceHash(resource_name);
    if (resourceHash && queryName === null) {
      const earlyResponse = tryNotModifiedResponse(
        requestEtag,
        buildPageEtag(resourceHash, pageParam),
      );
      if (earlyResponse) {
        return earlyResponse;
      }
    }

    const idIndex = await getShardIdIndex(resource_name);
    // 如果id索引不存在，则尝试直接返回文件
    if (!idIndex) {
      const raw = await getData(`sharded_data/${resource_name}.json`, {
        type: "text",
      });
      if (!raw) {
        return createNotFoundResponse();
      }
      if (queryName !== null) {
        return new Response(JSON.stringify({ error: "该资源不支持名称查询" }), {
          status: 400,
          headers: RESPONSE_HEADERS,
        });
      }
      const schemaUrl = buildUrl(API_BASE_URL, ["schemas", resource_name]);
      return createRawJsonResponse(
        raw,
        200,
        "OK",
        {
          Link: `<${schemaUrl}>; rel="describedby"`,
          "Content-Type": "application/schema-instance+json",
        },
        { gzip },
      );
    }

    const nameIndex =
      queryName === null ? null : await getShardNameIndex(resource_name);
    if (queryName !== null && !nameIndex) {
      return new Response(JSON.stringify({ error: "该资源不支持名称查询" }), {
        status: 400,
        headers: RESPONSE_HEADERS,
      });
    }
    const hash = resourceHash ?? idIndex.resource_hash;
    if (!resourceHash || queryName !== null) {
      const notModified = tryNotModifiedResponse(
        requestEtag,
        buildPageEtag(hash, pageParam, queryName),
      );
      if (notModified) {
        return notModified;
      }
    }

    const url = buildUrl(API_BASE_URL, [resource_name]);
    let idKeys = getSortedIdKeys(idIndex.by_id);
    if (queryName !== null) {
      url.searchParams.set("name", queryName);
      const matchingIds = new Set<string>();
      if (nameIndex) {
        for (const [indexedName, ids] of Object.entries(nameIndex.by_name)) {
          if (normalizeName(indexedName).includes(queryName)) {
            for (const id of ids) matchingIds.add(String(id));
          }
        }
      }
      idKeys = idKeys
        .filter((id) => matchingIds.has(id))
        .sort((a, b) => Number(a) - Number(b));
    }
    const count = idKeys.length;

    const nextUrl = buildPageUrl(url, getNextPage(pageParam, count));
    const prevUrl = buildPageUrl(url, getPreviousPage(pageParam));
    const firstUrl = buildPageUrl(url, getFirstPage(pageParam));
    const lastUrl = buildPageUrl(url, getLastPage(pageParam, count));
    const pageIds = idKeys.slice(
      pageParam.offset,
      pageParam.offset + pageParam.limit,
    );
    const results = pageParam.expand
      ? await fetchShardRecordsByIds(resource_name, pageIds, idIndex)
      : pageIds.map((idStr) => ({
          id: parseInt(idStr),
          url: buildUrl(API_BASE_URL, [resource_name, idStr]).toString(),
        }));
    const pageEtag = buildPageEtag(hash, pageParam, queryName);
    const schemaUrl = buildUrl(API_BASE_URL, ["schemas", resource_name]);
    return createSuccessResponse(
      {
        count: count,
        next: nextUrl,
        previous: prevUrl,
        first: firstUrl,
        last: lastUrl,
        results,
        hash,
      },
      200,
      "OK",
      {
        ETag: formatEtag(pageEtag),
        Link: buildLinkHeader(url.toString(), pageParam, count, schemaUrl),
        "Content-Type": "application/schema-instance+json",
      },
      { gzip },
    );
  }

  const resourceHash = await tryGetResourceHash(resource_name);
  const idIndex = await getShardIdIndex(resource_name);
  if (!idIndex) {
    return createNotFoundResponse();
  }

  const hash = resourceHash ?? idIndex.resource_hash;

  if (stringIsInteger(name)) {
    // 匹配的资源 hash 不能把不存在的记录变成 304。
    if (!Object.hasOwn(idIndex.by_id, name)) return createNotFoundResponse();
    const notModified = tryNotModifiedResponse(requestEtag, hash);
    if (notModified) return notModified;
    const record = await fetchShardRecordById(resource_name, name, idIndex);
    if (record === null) {
      return createNotFoundResponse();
    }
    const schemaUrl = buildUrl(API_BASE_URL, ["schemas", resource_name, "$id"]);
    return createSuccessResponse(
      record,
      200,
      "OK",
      {
        Link: `<${schemaUrl}>; rel="describedby"`,
        ETag: formatEtag(hash),
        "Content-Type": "application/schema-instance+json",
      },
      { gzip },
    );
  }

  const nameIndex = await getShardNameIndex(resource_name);
  if (!nameIndex || !Object.hasOwn(nameIndex.by_name, name)) {
    return createNotFoundResponse();
  }
  const notModified = tryNotModifiedResponse(requestEtag, hash);
  if (notModified) return notModified;

  const result = await fetchShardRecordsByName(
    resource_name,
    name,
    idIndex,
    nameIndex,
  );
  if (result === null) {
    return createNotFoundResponse();
  }

  const schemaUrl = buildUrl(API_BASE_URL, ["schemas", resource_name, "$name"]);
  return createSuccessResponse(
    { data: result },
    200,
    "OK",
    {
      Link: `<${schemaUrl}>; rel="describedby"`,
      ETag: formatEtag(hash),
      "Content-Type": "application/schema-instance+json",
    },
    { gzip },
  );
}

/**
 * EdgeOne Pages Function Handler - 处理 GET 请求
 */
export async function onRequestGet(context: EventContext): Promise<Response> {
  if (!API_BASE_URL) {
    return new Response(JSON.stringify({ error: "API_BASE_URL 未设置" }), {
      status: 500,
      headers: RESPONSE_HEADERS,
    });
  }

  const { request, params } = context;
  const url = new URL(request.url, API_BASE_URL);
  const { searchParams } = url;

  const paths = handlePathParam(params.default);
  return await handleDataRequest(paths, request, searchParams);
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, If-None-Match",
    },
  });
}
