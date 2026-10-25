/**
 * ## 文档注释的正文行里，不得出现注释的**闭合序列**
 *
 * 这不是风格洁癖，是**真实的语法错误来源**。今天踩了三次：
 *
 * 1. `helpers/codeOnly.mjs`（解释这个坑的那份文档）里原样写出了闭合序列，
 *    把**自己这篇注释提前结束**，后面的说明变成代码 → 整个文件语法错。
 * 2. `mainToolbar.test.mjs` 里又写了一遍，同样炸。
 * 3. 这条守卫的**第一版文档**里又写了一遍，于是守卫自己也解析不了。
 *
 * 更隐蔽的是：`node --check` 对 `.mjs` **不报错**（退出码 0），
 * 只有真正 `import()` 才抛 `SyntaxError`，而且**不给出错行号** ——
 * 表现是"测试跑不起来、但看不出在哪"。
 *
 * ## 判据只盯"文档注释的正文行"
 *
 * 第一版守卫扫的是**整行文本**，结果一口气报了三个假红：
 *
 * 1. 一个字符串字面量里出现了起始序列 —— 字符串里安全；
 * 2. 一行**行注释**里出现了闭合序列 —— 行注释到换行就结束，
 *    闭合序列在那里关不掉任何东西，安全；
 * 3. 一个**正则字面量**里同时出现了两者 —— 正则里安全。
 *
 * 只有**块注释的正文里**出现闭合序列才会提前闭合上下文。而文档注释的正文行
 * 有一个稳定的形状：行首是可选空格 + 一个星号 + 空格。所以：
 *
 * - 只看「可选空格 + 星号 + 空格」开头的行；
 * - 该行里出现闭合序列，且**不是行末最后一个非空内容**（行末那个才是真正的结束符）。
 *
 * 这条判据能抓住前面三次真实事故，且不误报上面三类。
 *
 * ⚠️ 写这段说明时又踩了第 4 次：上面三条本来是**原文照抄**那三处代码，
 * 其中第 2 条包含裸的闭合序列 —— 于是**这条守卫自己又一次解析失败**。
 * 现在只描述形态，不抄原文。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

const ROOTS = ["src", "test", "addon/content"];
const EXTENSIONS = [".ts", ".mjs", ".js", ".xhtml"];

function collect(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".build") continue;
      collect(full, out);
    } else if (EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

/** 闭合序列（拼出来，避免这份文件自己也中招） */
const CLOSER = "*" + "/";

/**
 * 判断一行文档注释正文里是否**嵌着**闭合序列。
 *
 * 不导出：ESLint 的 `mocha/no-exports` 禁止测试文件导出，
 * 而这里也没有跨文件复用的必要。
 *
 * @param line 单行文本
 * @returns true = 这一行会让所在注释提前结束
 */
function hasEmbeddedCommentCloser(line) {
  const text = String(line ?? "");
  // 只查文档注释正文行：可选空格 + `*` + 空格
  if (!/^\s*\*\s/.test(text)) return false;
  const at = text.indexOf(CLOSER);
  if (at < 0) return false;
  // 行末那个才是真正的结束符（` */` 或 ` * …… */`）
  const rest = text.slice(at + CLOSER.length).trim();
  return rest.length > 0;
}

describe("文档注释正文里不得嵌着闭合序列", function () {
  it("全仓库扫描", function () {
    const offenders = [];
    for (const dirName of ROOTS) {
      for (const file of collect(join(root, dirName))) {
        const lines = readFileSync(file, "utf8").split(/\r?\n/);
        lines.forEach((line, i) => {
          if (!hasEmbeddedCommentCloser(line)) return;
          offenders.push(
            `${file.slice(root.length + 1).replace(/\\/g, "/")}:${i + 1}  ${line
              .trim()
              .slice(0, 70)}`,
          );
        });
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "这些文档注释正文行里嵌着注释的闭合序列 —— 会把所在注释提前结束，" +
        "后面的说明文字变成代码（语法错，而且 `node --check` 查不出来）。" +
        "改成文字描述（如「星号 斜杠」）：\n    " +
        offenders.join("\n    "),
    );
  });

  it("判据本身：真会提前闭合的才算", function () {
    // 真实事故的形态
    assert.equal(
      hasEmbeddedCommentCloser(
        " * 一路吃到下一个 `" + CLOSER + "`，后面还有字",
      ),
      true,
    );
    // 正常的结束符行
    assert.equal(hasEmbeddedCommentCloser(" */"), false);
    // 行末的显式结束
    assert.equal(hasEmbeddedCommentCloser(" * 说明文字 " + CLOSER), false);
    // 不在文档注释正文里的行，一律不管
    assert.equal(hasEmbeddedCommentCloser('  it("a ' + CLOSER + ' b")'), false);
    assert.equal(
      hasEmbeddedCommentCloser("  // 行注释 " + CLOSER + " 后续"),
      false,
    );
    assert.equal(
      hasEmbeddedCommentCloser("const re = /x" + CLOSER + "/g;"),
      false,
    );
  });
});
