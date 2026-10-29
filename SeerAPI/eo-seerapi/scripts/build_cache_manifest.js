import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function optionalText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function generateCacheManifest({
  dataDir = resolve("data/sharded_data"),
  outFile = resolve("generated/cache-manifest.ts"),
} = {}) {
  // 缺少部署数据时构建必须失败，而不是静默发布过期或空的清单。
  // 该文件也用作 _data.ts 的运行时根目录探测。
  const root = JSON.parse(await readFile(join(dataDir, "index.json"), "utf8"));
  if (!isObject(root)) throw new Error("sharded_data/index.json 无效");
  const manifest = Object.create(null);
  const directories = (await readdir(dataDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  for (const resource of directories) {
    const directory = join(dataDir, resource);
    const indexText = await optionalText(join(directory, "id-index.json"));
    const hashText = await optionalText(join(directory, "resource.hash"));
    if (indexText === null) {
      if (hashText !== null) throw new Error(`${resource}: resource.hash 缺少 id-index.json`);
      continue;
    }
    const index = JSON.parse(indexText);
    if (!isObject(index.by_id)) throw new Error(`${resource}: by_id 索引无效`);
    // 与云函数 tryGetResourceHash 回退逻辑的优先级保持一致。
    const hash = hashText?.trim() || index.resource_hash;
    if (typeof hash !== "string" || !/^[A-Za-z0-9._-]+$/.test(hash)) {
      throw new Error(`${resource}: resource hash 无效`);
    }
    const ids = Object.keys(index.by_id).sort();
    const shards = new Map();
    for (const id of ids) {
      const shard = index.by_id[id];
      if (!/^\d+$/.test(id) || typeof shard !== "string" || !/^[A-Za-z0-9_-]+$/.test(shard)) {
        throw new Error(`${resource}: 为 ${id} 提供的 ID 或分片无效`);
      }
      if (!shards.has(shard)) {
        shards.set(shard, JSON.parse(await readFile(join(directory, "id/shards", `${shard}.json`), "utf8")));
      }
      const records = shards.get(shard);
      if (!isObject(records) || !Object.hasOwn(records, id) || records[id] == null) {
        throw new Error(`${resource}/${id}: 分片 ${shard} 中缺少记录`);
      }
    }
    const nameText = await optionalText(join(directory, "name-index.json"));
    const byName = nameText === null ? {} : JSON.parse(nameText).by_name;
    if (!isObject(byName)) throw new Error(`${resource}: by_name 索引无效`);
    const names = Object.keys(byName).sort();
    for (const name of names) {
      if (!Array.isArray(byName[name]) || byName[name].some((id) =>
        !Number.isSafeInteger(id) || !Object.hasOwn(index.by_id, String(id)))) {
        throw new Error(`${resource}/${name}: name 索引引用无效`);
      }
    }
    manifest[resource] = { hash, ids, names, hasNameIndex: nameText !== null };
  }
  // 输出与 JS 兼容的 TypeScript 模块，而不是运行时 JSON 文件导入。
  // JSON.parse 也会把 __proto__ 等键保留为普通自有键。
  const source = '// 由 npm run generate:cache 生成，请勿手动编辑。\n' +
    'import type { CacheManifest } from "../shared/cache.js";\n' +
    `export const cacheManifest: CacheManifest = JSON.parse(${JSON.stringify(JSON.stringify(manifest))});\n`;
  const bytes = Buffer.byteLength(source);
  if (bytes > 4 * 1024 * 1024) throw new Error(`缓存清单过大（${bytes} 字节）；请拆分 middleware 清单`);
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(`${outFile}.tmp`, source);
  await rename(`${outFile}.tmp`, outFile);
  return { manifest, bytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { manifest, bytes } = await generateCacheManifest();
  console.log(`缓存清单: ${Object.keys(manifest).length} 个资源，${bytes} 字节`);
}
