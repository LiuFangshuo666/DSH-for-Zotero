/**
 * 注释的**自我一致性**。
 *
 * ## 为什么值得单独一条测试
 *
 * 这个仓库的注释密度很高，因为大部分设计决定都来自真机故障 —— 不写清楚，
 * 后来者就会把"刻意的取舍"当成"写错了"而改回去。
 *
 * 但注释有个固有弱点：**没有任何工具会检查它**。改代码时删掉一个函数、
 * 重命名一个文件，引用它的注释不会报错，只会安静地腐烂。等到有人照着注释
 * 去找东西却找不到时，他已经浪费了一轮排查。
 *
 * 这不是假想 —— 就在写这份测试的前一轮，我往 README 里写了一个**不存在的**
 * 函数名（`menuIconHint`），又给划词工具条写了**错误的**注册机制描述
 * （说"必须在窗口加载后注册"，实际是 `Zotero.Reader.registerEventListener`）。
 * 两处都是我"凭印象写"的，而且都不会让任何检查变红。
 *
 * ## 这个测试查什么（只查能机械验证的部分）
 *
 * 1. 注释里以 `` `foo()` `` 形式引用的函数名，代码里确实存在；
 * 2. 注释里以 `` `src/xxx.ts` `` 形式引用的**仓库内路径**确实存在。
 *
 * 它**不**检查注释说的"为什么"是否正确 —— 那没法机械验证，只能靠人。
 * 但"引用的东西还在不在"已经能拦住最常见的那类腐烂。
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 递归列出目录下的文件（跳过不该扫的） */
function walk(dir, out = []) {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (
        !/^(\.git|node_modules|\.scaffold|test\/unit\/\.build)$/.test(
          entry.name,
        )
      ) {
        walk(rel, out);
      }
    } else {
      out.push(rel);
    }
  }
  return out;
}

const sourceFiles = [
  ...walk("src"),
  ...walk("addon"),
  ...walk("tools"),
  ...walk("test"),
].filter((f) => /\.(ts|js|mjs)$/.test(f));

const allSource = sourceFiles
  .map((f) => readFileSync(join(root, f), "utf8"))
  .join("\n");

/** 只在注释行里找引用 —— 代码行里的调用不需要检查（编译器会管） */
function commentLines(file) {
  const lines = readFileSync(join(root, file), "utf8").split("\n");
  const out = [];
  let inBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("/*")) inBlock = true;
    const isComment =
      inBlock || trimmed.startsWith("*") || trimmed.startsWith("//");
    if (trimmed.endsWith("*/")) inBlock = false;
    if (isComment) out.push(line);
  }
  return out;
}

describe("注释引用的一致性", function () {
  it("注释里以 `foo()` 形式提到的函数，代码里必须存在", function () {
    const missing = [];
    const checked = new Set();
    for (const file of sourceFiles) {
      for (const line of commentLines(file)) {
        for (const match of line.matchAll(/`([A-Za-z_]\w{3,})\(\)`/g)) {
          const name = match[1];
          if (checked.has(name)) continue;
          checked.add(name);
          // 认这几种出现形式：函数声明、赋值、属性、方法定义、调用
          const pattern = new RegExp(
            `(function\\s+${name}\\b|${name}\\s*[=(:]|\\.${name}\\b|${name}\\()`,
          );
          if (!pattern.test(allSource)) missing.push(`${name}()  ← ${file}`);
        }
      }
    }
    assert.ok(
      checked.size > 10,
      `只找到 ${checked.size} 个注释引用，太少 —— 提取逻辑可能失效了`,
    );
    assert.deepEqual(
      missing,
      [],
      `注释引用了不存在的函数：\n    ${missing.join("\n    ")}`,
    );
  });

  it("注释里提到的仓库内路径必须存在（历史文档除外）", function () {
    // ⚠️ docs/ 是**历史记录**，故意保留了对已删除文件的引用
    // （"当时用过 tools/dsh-auth-poc.mjs，后来删了"）。所以只查代码。
    //
    // ⚠️ 也必须排除**本文件自己**：它的 JSDoc 里用 `src/xxx.ts` 举例说明
    // "路径引用长什么样"，那不是真引用。第一版没排除，于是被自己的例子拦下。
    const missing = [];
    const files = [
      ...walk("src"),
      ...walk("addon"),
      ...walk("tools"),
      ...walk("test"),
    ].filter(
      (f) =>
        /\.(ts|js|mjs)$/.test(f) &&
        !f.endsWith("test/unit/commentRefs.test.mjs"),
    );
    for (const file of files) {
      const lines = readFileSync(join(root, file), "utf8").split("\n");
      lines.forEach((line, index) => {
        for (const match of line.matchAll(
          /`((?:src|addon|test|tools|typings)\/[\w\u4e00-\u9fa5./-]+)`/g,
        )) {
          if (!existsSync(join(root, match[1]))) {
            missing.push(`${match[1]}  ← ${file}:${index + 1}`);
          }
        }
      });
    }
    assert.deepEqual(
      missing,
      [],
      `注释引用了不存在的路径：\n    ${missing.join("\n    ")}`,
    );
  });
});
