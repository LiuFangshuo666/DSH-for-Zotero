/**
 * ## 公共助手自身的回归测试
 *
 * `codeOnly()` 被十几个守卫依赖。它一旦出错，守卫会**静默地**变成假绿或假红 ——
 * 而假红比假绿更糟：它会让人去改本来正确的代码。
 *
 * 这里的用例全部来自**真实踩过的坑**，不是设想。
 */
import assert from "node:assert/strict";
import { codeOnly, markupOnly } from "./helpers/codeOnly.mjs";

describe("守卫助手：剥注释", function () {
  it("去掉整行注释与块注释", function () {
    const src = [
      "// 行注释",
      "const a = 1;",
      "/**",
      " * 块注释",
      " */",
      "const b = 2;",
    ].join("\n");
    const out = codeOnly(src);
    assert.ok(!out.includes("行注释"));
    assert.ok(!out.includes("块注释"));
    assert.ok(out.includes("const a = 1;"));
    assert.ok(out.includes("const b = 2;"));
  });

  it("**行注释里的 `/*` 不得被当成块注释开头**（真实踩过的坑）", function () {
    // Zotero 的图标路径里就有这个序列，写进行注释后
    // 旧的剥离顺序会从 `/*` 一路吃到下一个 `*/`，删掉中间全部真实代码。
    const src = [
      "// 图标是 chrome://zotero/skin/16/universal/*.svg 这种",
      "const style = 'list-style-image: url(x)';",
      "function keepMe() {}",
      "/* 真正的块注释 */",
      "const tail = 1;",
    ].join("\n");
    const out = codeOnly(src);
    assert.ok(
      out.includes("list-style-image"),
      "行注释里的 /* 骗过了剥离，把真实代码吃掉了",
    );
    assert.ok(out.includes("keepMe"), "函数体被误删");
    assert.ok(out.includes("const tail = 1;"));
  });

  it("保留换行（顺序类守卫要按位置比较）", function () {
    const out = codeOnly("a();\n\nb();");
    assert.ok(out.includes("\n\n"), "不应把多行压成一行");
  });

  it("空输入不抛错", function () {
    assert.equal(codeOnly(""), "");
    assert.equal(codeOnly(undefined), "");
    assert.equal(codeOnly(null), "");
  });

  it("markupOnly 去掉 HTML 注释（说明里提到标签不算用了它）", function () {
    const html = [
      "<!-- 这里刻意不用 <select> -->",
      "<div id='model-trigger'></div>",
    ].join("\n");
    const out = markupOnly(html);
    assert.ok(!out.includes("<select>"), "注释里的标签被当成了真实元素");
    assert.ok(out.includes("model-trigger"));
  });
});
