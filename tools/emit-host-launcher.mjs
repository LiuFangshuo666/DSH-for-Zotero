// 验证内嵌的宿主代理源码：打包求值 → 落盘 → 语法检查。
// 与单元测试同一套打包方式，避免手动抽字符串时猜错转义（先前正是这样写错过一次）。
import { writeFileSync } from "node:fs";
import { build } from "esbuild";

const out = await build({
  entryPoints: ["src/dsh/hostLauncher.ts"],
  bundle: true,
  format: "esm",
  write: false,
  platform: "neutral",
});
const code = out.outputFiles[0].text;
const mod = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);
const src = mod.HOST_LAUNCHER_SOURCE;

console.log("  源码长度: " + Buffer.byteLength(src) + " 字节");
console.log("  含真换行: " + src.includes("\n"));
console.log("  含字面量 \\n: " + src.includes("\\n"));

const usageLine = src
  .split("\n")
  .find((line) => line.includes("host-launcher: usage"));
console.log("  usage 行是否完整（未断行）: " + JSON.stringify(usageLine));

const target =
  process.env.USERPROFILE + "\\Zotero\\dsh-for-zotero\\host-launcher.mjs";
writeFileSync(target, src);
console.log("  已写入: " + target);
