// 会话页 Markdown 渲染器的测试。
//
// 为什么要单独测：页面脚本是 IIFE，渲染函数不导出。这里把源码读出来、
// 剥掉"操作 DOM 的收尾部分"，只求值到渲染函数，再对它们做断言。
// 关键断言是**注入安全**：模型输出或论文原文里的标签绝不能变成可执行标签。
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import vm from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pagePath = join(here, "..", "..", "addon", "content", "sessionPage.js");
const source = readFileSync(pagePath, "utf8");

/**
 * 取出渲染相关函数并求值。
 *
 * 做法：截取从文件开头到 `var messages = document.getElementById` 之前的部分
 * （那里开始就要 DOM 了），补上导出语句，在 vm 里跑。
 */
function loadRenderer() {
  const cut = source.indexOf("var messages = document.getElementById");
  assert.ok(cut > 0, "找不到 DOM 操作的分界点，测试需要更新");
  const head = source.slice(0, cut);
  const code = `${head}
    exports.renderMarkdown = renderMarkdown;
    exports.renderInline = renderInline;
    exports.escapeHtml = escapeHtml;
  })();`;
  const sandbox = {
    exports: {},
    document: undefined,
    window: undefined,
    Zotero: undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "sessionPage.js" });
  return sandbox.exports;
}

const { renderMarkdown, renderInline, escapeHtml } = loadRenderer();

describe("会话页 Markdown 渲染", function () {
  it("标题渲染成 h 标签，而不是显示井号", function () {
    const html = renderMarkdown("### 结论\n\n正文");
    assert.match(html, /<h3>结论<\/h3>/);
    assert.match(html, /<p>正文<\/p>/);
    assert.ok(!html.includes("###"), "不应残留井号");
  });

  it("粗体、斜体、行内代码、链接都转成标签", function () {
    const html = renderInline(
      "**粗** 与 *斜* 与 `code` 与 [文](https://example.com)",
    );
    assert.match(html, /<strong>粗<\/strong>/);
    assert.match(html, /<em>斜<\/em>/);
    assert.match(html, /<code>code<\/code>/);
    assert.match(html, /<a href="https:\/\/example\.com"/);
  });

  it("无序与有序列表转成 ul/ol", function () {
    const ul = renderMarkdown("- 甲\n- 乙");
    assert.match(ul, /<ul><li>甲<\/li><li>乙<\/li><\/ul>/);
    const ol = renderMarkdown("1. 一\n2. 二");
    assert.match(ol, /<ol><li>一<\/li><li>二<\/li><\/ol>/);
  });

  it("表格转成真正的 table", function () {
    const html = renderMarkdown("| 列A | 列B |\n| --- | --- |\n| 1 | 2 |");
    assert.match(html, /<table class="dsh-table">/);
    assert.match(html, /<th>列A<\/th>/);
    assert.match(html, /<td>2<\/td>/);
  });

  it("代码围栏整段转义，且内容不被行内规则再处理", function () {
    const html = renderMarkdown("```python\nx = **1** <b>\n```");
    assert.match(html, /<pre class="dsh-code" data-lang="python"><code>/);
    // 代码里的 ** 与 <b> 必须原样保留（转义后），不能变成粗体或标签
    assert.ok(html.includes("**1**"), "代码里的星号不应被当成粗体");
    assert.ok(html.includes("&lt;b&gt;"), "代码里的尖括号必须被转义");
    assert.ok(!html.includes("<b>"), "不得产生可执行的 <b> 标签");
  });

  it("**回归**：Agent 列出的选项必须真的渲染出来（真机反馈「看不到选项」）", function () {
    // 真机场景：Agent 先说"有几个决定要你拍板："，**下面才是选项**。
    // 用户看到提示说"Agent 在等你"，却看不到选项 —— 一端是正文合并丢段落，
    // 另一端可能就是渲染。这里钉住渲染端：选项一个都不能少。
    const sample = [
      "落地前有几个决定要你拍板：",
      "",
      "1. **方案 A（阶段主导）**：按研发阶段划分标签",
      "2. **方案 B（主题主导）**：按研究主题划分标签",
      "",
      "你倾向哪一个？",
    ].join("\n");

    const html = renderMarkdown(sample);
    assert.ok(html.includes("方案 A"), "选项 A 必须渲染出来");
    assert.ok(html.includes("方案 B"), "选项 B 必须渲染出来");
    assert.ok(html.includes("阶段主导"), "选项的说明不能丢");
    assert.ok(html.includes("主题主导"), "选项的说明不能丢");
    // 编号列表必须是真列表，而不是原样文本
    assert.match(html, /<ol>/, "编号选项应渲染成有序列表");
    // 结尾的问句也要在（用户据此知道该回应）
    assert.ok(html.includes("你倾向哪一个"), "结尾的问句不能丢");
  });

  it("引用与分隔线", function () {
    const html = renderMarkdown("> 引用\n\n---");
    assert.match(html, /<blockquote>引用<\/blockquote>/);
    assert.match(html, /<hr\/>/);
  });

  it("**安全**：模型输出里的标签一律被转义，不产生可执行标签", function () {
    const attacks = [
      "<script>alert(1)</script>",
      '<img src=x onerror="alert(1)">',
      "<svg/onload=alert(1)>",
      "<iframe src=javascript:alert(1)></iframe>",
      "**<script>bad</script>**",
      "# <script>h</script>",
      "| <script>t</script> | b |\n| --- | --- |\n| 1 | 2 |",
    ];
    for (const attack of attacks) {
      const html = renderMarkdown(attack);
      // ⚠️ 测**真正的威胁模型**：危险的是**未转义的标签起始**，而不是文本里出现
      // `onload=` 这类子串 —— `&lt;svg/onload=alert(1)&gt;` 是纯文本，完全安全。
      // 先前两版断言都在这点上误报（`onerror=`、`onload=`），误报比不报更糟：
      // 它会掩盖真正的问题。
      //
      // 允许出现的标签只有本渲染器自己生成的那些白名单标签。
      const allowed = new Set([
        "p",
        "/p",
        "strong",
        "/strong",
        "em",
        "/em",
        "code",
        "/code",
        "pre",
        "/pre",
        "ul",
        "/ul",
        "ol",
        "/ol",
        "li",
        "/li",
        "h1",
        "/h1",
        "h2",
        "/h2",
        "h3",
        "/h3",
        "h4",
        "/h4",
        "h5",
        "/h5",
        "h6",
        "/h6",
        "blockquote",
        "/blockquote",
        "table",
        "/table",
        "thead",
        "/thead",
        "tbody",
        "/tbody",
        "tr",
        "/tr",
        "th",
        "/th",
        "td",
        "/td",
        "hr/",
        "hr",
        "a",
        "/a",
        "br/",
        "br",
      ]);
      const tags = [...html.matchAll(/<\/?([a-zA-Z][\w-]*)[^>]*>/g)];
      for (const tag of tags) {
        const name = tag[1].toLowerCase();
        assert.ok(
          allowed.has(name) || allowed.has("/" + name),
          `输入 ${JSON.stringify(attack)} 产生了非白名单标签 <${name}>：${html}`,
        );
      }
      // 攻击载荷必须整体以转义形式出现
      assert.ok(
        html.includes("&lt;"),
        `输入 ${JSON.stringify(attack)} 的尖括号必须被转义：${html}`,
      );
    }
  });

  it("**安全**：链接只允许 http/https，javascript: 不生成 a 标签", function () {
    const html = renderInline("[点我](javascript:alert(1))");
    assert.ok(
      !html.includes("<a "),
      `javascript: 链接不得生成 a 标签：${html}`,
    );
    assert.ok(html.includes("javascript:alert(1)"), "应作为纯文本保留");
  });

  it("**安全**：行内代码里的标签也被转义", function () {
    const html = renderInline("`<script>x</script>`");
    assert.ok(!html.toLowerCase().includes("<script"), "行内代码内容必须转义");
    assert.match(html, /<code>/);
  });

  it("escapeHtml 覆盖五个字符", function () {
    assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
  });

  it("空输入不产生垃圾标签", function () {
    assert.equal(renderMarkdown("").trim(), "");
    assert.equal(renderMarkdown("\n\n").trim(), "");
  });
});
