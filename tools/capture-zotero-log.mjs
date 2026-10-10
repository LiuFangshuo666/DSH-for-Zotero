// 抓取 Zotero 的完整调试输出到文件。
// 为什么不用 PowerShell 的 Select-String：它会按匹配行输出，容易把异常类型那行漏掉，
// 而我们要的正是完整的异常信息。
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const out = "E:/zotero-plugin-project/zotero-full.txt";
const child = spawn(
  "C:/Program Files/Zotero/zotero.exe",
  [
    "-ZoteroDebugText",
    "-profile",
    process.env.APPDATA + "/Zotero/Zotero/Profiles/4gvbpaje.default",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);

const chunks = [];
const collect = (buf) => chunks.push(buf.toString("utf8"));
child.stdout.on("data", collect);
child.stderr.on("data", collect);

const stopAfterMs = Number(process.argv[2] ?? 40000);
setTimeout(() => {
  try {
    child.kill();
  } catch {
    // 忽略
  }
  const text = chunks.join("");
  writeFileSync(out, text, "utf8");
  console.log(`已写入 ${out}（${text.length} 字符）`);
  process.exit(0);
}, stopAfterMs);
