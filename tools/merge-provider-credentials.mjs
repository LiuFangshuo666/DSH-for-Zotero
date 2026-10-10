// 把模型侧凭据合并进隔离实例，然后验证模型能否真正回答。
// 逻辑与 src/dsh/credentialMerge.ts 一致（按 YAML 文本块搬运）。
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const HOME = process.env.USERPROFILE;
const sourcePath = `${HOME}\\.dsh\\.credentials.yaml`;
const targetPath = `${HOME}\\Zotero\\dsh-for-zotero\\home\\.credentials.yaml`;

const BROWSER_SESSION_KEY = "client-connection/browser-session";

function extractRecordBlock(text, key) {
  const lines = text.split(/\r?\n/);
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(`^\\s{2}${esc}\\s*:\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    if (!header.test(lines[i])) continue;
    const block = [lines[i]];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim()) continue;
      if (/^\s{2}\S/.test(line) || /^\S/.test(line)) break;
      block.push(line);
    }
    return block.join("\n");
  }
  return undefined;
}

function extractRefLine(text, key) {
  const lines = text.split(/\r?\n/);
  let inRefs = false;
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const line of lines) {
    if (/^refs\s*:\s*$/.test(line)) {
      inRefs = true;
      continue;
    }
    if (inRefs) {
      if (/^\S/.test(line)) break;
      if (new RegExp(`^\\s+${esc}\\s*:`).test(line)) return line;
    }
  }
  return undefined;
}

const source = readFileSync(sourcePath, "utf8");
let target = existsSync(targetPath)
  ? readFileSync(targetPath, "utf8")
  : "version: 1\nrecords:\nrefs:\n";
console.log("=== 合并前 ===");
console.log(
  "  目标记录数: " + (target.match(/^\s{2}\S.*:\s*$/gm) || []).length,
);
console.log("  含 DEEPSEEK_API_KEY: " + /DEEPSEEK_API_KEY\s*:/.test(target));

const copied = [];
for (const key of [
  "deepseek-account-platform/device",
  "deepseek-account-platform/default",
]) {
  if (target.includes(`${key}:`)) continue;
  const block = extractRecordBlock(source, key);
  if (!block) {
    console.log("  源里没有 " + key);
    continue;
  }
  const lines = target.split(/\r?\n/);
  const recordsAt = lines.findIndex((l) => /^records\s*:\s*$/.test(l));
  let insertAt = lines.length;
  for (let i = recordsAt + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) {
      insertAt = i;
      break;
    }
  }
  lines.splice(insertAt, 0, block);
  target = lines.join("\n");
  copied.push(key);
}

if (!/DEEPSEEK_API_KEY\s*:/.test(target)) {
  const refLine = extractRefLine(source, "DEEPSEEK_API_KEY");
  if (refLine) {
    const lines = target.split(/\r?\n/);
    const refsAt = lines.findIndex((l) => /^refs\s*:\s*$/.test(l));
    if (refsAt < 0) lines.push("refs:", refLine);
    else lines.splice(refsAt + 1, 0, refLine);
    target = lines.join("\n");
    copied.push("refs.DEEPSEEK_API_KEY");
  }
}

if (!target.includes(BROWSER_SESSION_KEY)) {
  console.error("❌ 合并后丢了浏览器会话记录，放弃写入");
  process.exit(1);
}

writeFileSync(targetPath, target);
console.log("\n=== 合并后 ===");
console.log("  已复制: " + copied.join("、"));
console.log("  含 DEEPSEEK_API_KEY: " + /DEEPSEEK_API_KEY\s*:/.test(target));
console.log(
  "  浏览器会话密钥仍在（隔离保持）: " + target.includes(BROWSER_SESSION_KEY),
);
console.log("  文件大小: " + Buffer.byteLength(target) + " 字节");
