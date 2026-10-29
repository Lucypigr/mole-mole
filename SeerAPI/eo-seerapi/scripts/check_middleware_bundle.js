import { build } from "esbuild";

const result = await build({
  entryPoints: ["middleware.ts"],
  bundle: true,
  platform: "browser",
  format: "esm",
  write: false,
  metafile: true,
});
// 为平台包装代码保留空间，使其低于文档规定的 5 MB 上限。
const bytes = result.outputFiles[0].contents.byteLength;
if (bytes > 4_500_000) {
  throw new Error(`middleware 打包为 ${bytes} 字节；超出 4.5 MB 构建预算`);
}
console.log(`middleware 浏览器打包: ${bytes} 字节；${Object.keys(result.metafile.inputs).length} 个源模块`);
