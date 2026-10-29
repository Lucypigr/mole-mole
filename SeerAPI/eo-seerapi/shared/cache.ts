// 由边缘中间件和 Node.js 处理器共享。保持此模块不依赖 Node.js：
// 在这里引入 _common.ts 也会连带引入 zlib 和环境变量。
export interface PageQueryParam {
  offset: number;
  limit: number;
  expand?: boolean;
}

export function normalizeName(name: string): string {
  return name.trim().normalize("NFKC").toLowerCase();
}

export function parseNameQuery(query: URLSearchParams): {
  name: string | null;
  valid: boolean;
} {
  const raw = query.get("name");
  return {
    name: raw === null ? null : normalizeName(raw) || null,
    // 按用户输入的 Unicode 码点计数，在规范化之前限制长度。
    valid: raw === null || [...raw].length <= 64,
  };
}

export function parsePageQuery(query: URLSearchParams): PageQueryParam {
  const expand = query.get("expand");
  return {
    // 保留现有 API 的默认值和 parseInt 行为。
    offset: parseInt(query.get("offset") || "0") || 0,
    limit: parseInt(query.get("limit") || "20") || 20,
    expand:
      query.has("expand") &&
      (expand === "" || expand === "true" || expand === "1"),
  };
}

export function buildPageEtag(
  hash: string,
  page: PageQueryParam,
  name: string | null = null,
): string {
  const filter = name === null ? "" : `-name-${new URLSearchParams({ name })}`;
  return `${hash}-${page.offset}-${page.limit}${page.expand ? "-expanded" : ""}${filter}`;
}

export function isValidPageQuery(page: PageQueryParam): boolean {
  return (
    Number.isSafeInteger(page.offset) &&
    page.offset >= 0 &&
    Number.isSafeInteger(page.limit) &&
    page.limit >= 1 &&
    page.limit <= 200
  );
}

export function normalizeEtag(etag: string): string {
  return etag.trim().replace(/^W\//, "").replace(/^"/, "").replace(/"$/, "");
}

export function formatEtag(value: string): string {
  return `"${normalizeEtag(value)}"`;
}

export function etagMatches(ifNoneMatch: string, etag: string): boolean {
  if (!ifNoneMatch || !etag) return false;
  if (ifNoneMatch.trim() === "*") return true;
  const normalized = normalizeEtag(etag);
  return ifNoneMatch
    .split(",")
    .some((tag) => normalizeEtag(tag) === normalized);
}

export const ETAG_FALLBACK_HEADER = "x-if-none-match";

export function createNotModifiedResponse(etag?: string): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache",
    Vary: "Accept-Encoding",
  };
  if (etag) headers.ETag = formatEtag(etag);
  return new Response(null, { status: 304, headers });
}

export interface ResourceVersion {
  hash: string;
  // 有序的精确键集合，而不是分片文件名或记录内容。
  ids: string[];
  names: string[];
  hasNameIndex?: boolean;
}

export type CacheManifest = Record<string, ResourceVersion>;

function contains(sorted: string[], value: string): boolean {
  let low = 0;
  let high = sorted.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const key = sorted[middle]!;
    if (key === value) return true;
    if (key < value) low = middle + 1;
    else high = middle - 1;
  }
  return false;
}

// 当中间件无法证明该请求代表一个成功的可缓存响应时返回 null。
// 错误仍由源站负责处理。
export function getManifestEtag(
  url: URL,
  manifest: CacheManifest,
): string | null {
  const match = /^\/v1\/([^/]+)(?:\/([^/]+))?\/?$/.exec(url.pathname);
  if (!match) return null;
  let resource: string;
  let name: string | undefined;
  try {
    resource = decodeURIComponent(match[1]!);
    name = match[2] === undefined ? undefined : decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  // 将模糊编码和类似文件系统的路径留给源站处理。Schema 有它自己的
  // 处理器，目前不会产生资源 ETag。
  if (
    resource === "schemas" ||
    /[/%\\]/.test(resource) ||
    (name !== undefined && /[/%\\]/.test(name))
  )
    return null;
  if (!Object.hasOwn(manifest, resource)) return null;
  const entry = manifest[resource]!;
  if (name === undefined) {
    const filter = parseNameQuery(url.searchParams);
    if (!filter.valid || (filter.name !== null && entry.hasNameIndex !== true))
      return null;
    const page = parsePageQuery(url.searchParams);
    if (!isValidPageQuery(page)) return null;
    return buildPageEtag(entry.hash, page, filter.name);
  }
  return contains(/^\d+$/.test(name) ? entry.ids : entry.names, name)
    ? entry.hash
    : null;
}
