/**
 * 结果回写的测试（纯逻辑部分）。
 *
 * 重点是**转义**：笔记内容是 HTML，会被 Zotero 直接渲染；论文原文与模型输出里出现
 * 尖括号、引号是常态（甚至可能有 <img onerror=…> 这类内容），一旦漏转义就是注入。
 */

import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const writeback = await import(
  new URL(
    `file://${join(here, ".build", "unit-entry.mjs").replace(/\\/g, "/")}`,
  ).href
);
const {
  escapeHtml,
  buildNoteHtml,
  buildNoteTitle,
  buildSessionNoteTitle,
  buildMarkdown,
} = writeback;

describe("HTML 转义", function () {
  it("转义五个危险字符", function () {
    assert.equal(escapeHtml("<b>&\"'"), "&lt;b&gt;&amp;&quot;&#39;");
  });

  it("挡住真实的注入样本", function () {
    const evil = '<img src=x onerror="alert(1)">';
    const escaped = escapeHtml(evil);
    assert.ok(!escaped.includes("<img"), "不应保留可执行的标签");
    assert.ok(escaped.includes("&lt;img"));
  });

  it("中文与普通标点不受影响", function () {
    assert.equal(
      escapeHtml("样本量 N=120（p<0.05）"),
      "样本量 N=120（p&lt;0.05）",
    );
  });
});

describe("笔记 HTML", function () {
  const payload = {
    question: "他们的样本量是多少？",
    answer: "论文写了 N=120。\n\n分两个队列。",
    selection: "We recruited 120 participants.",
    pageLabel: "第 5 页",
    model: "deepseek-flash",
  };
  const when = new Date("2026-10-02T12:00:00Z");

  it("包含问题、原文引用、回答与页脚", function () {
    const html = buildNoteHtml(payload, when);
    assert.match(html, /他们的样本量是多少？/);
    assert.match(html, /We recruited 120 participants\./);
    assert.match(html, /N=120/);
    assert.match(html, /第 5 页/);
    assert.match(html, /deepseek-flash/);
    assert.match(html, /估算值/);
  });

  it("回答的段落被拆成多个 <p>", function () {
    const html = buildNoteHtml(payload, when);
    assert.equal((html.match(/<p>/g) ?? []).length >= 3, true, `实际：${html}`);
  });

  it("无论输入多危险，输出里都不出现未转义的标签", function () {
    const html = buildNoteHtml(
      {
        question: '<script>alert("q")</script>',
        answer: '<iframe src="evil"></iframe>',
        selection: '"><img onerror="x">',
      },
      when,
    );
    // 严格断言：这些标签名不能以"真实标签"形式出现
    for (const tag of ["<script", "<iframe", "<img", "<a ", "<svg"]) {
      assert.ok(!html.includes(tag), `输出不应包含未转义的 ${tag}`);
    }
    assert.ok(html.includes("&lt;script"), "危险内容应被转义后保留为文本");
    // 反转义回来必须与原文等价：说明它只是文本，不是结构
    const decoded = html
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
    assert.ok(
      decoded.includes('<img onerror="x">'),
      "反转义后应是原样文本（证明它不构成标签）",
    );
  });

  it("没有选区时不产生**原文**引用块（提问块是结构的一部分，不算）", function () {
    const html = buildNoteHtml({ question: "Q", answer: "A" }, when);
    // 提问现在也用 blockquote 呈现（作为回答下方的上下文），
    // 所以这里断言的是"没有额外的原文引用块"，而不是"完全没有 blockquote"。
    assert.ok(!/原文位置/.test(html), "没有选区时不该出现原文位置");
    const blocks = html.match(/<blockquote>/g) ?? [];
    assert.equal(
      blocks.length,
      1,
      `只应有提问那一个引用块，实际 ${blocks.length} 个`,
    );
    assert.match(html, /问：Q/);
  });
});

describe("笔记标题", function () {
  it("按日期生成，同一天稳定（用于幂等追加）", function () {
    const a = buildNoteTitle(new Date("2026-10-02T01:00:00"));
    const b = buildNoteTitle(new Date("2026-10-02T23:00:00"));
    assert.equal(a, b);
    assert.match(a, /^DSH 伴读 - \d{4}-\d{2}-\d{2}$/);
  });

  it("跨天不同", function () {
    assert.notEqual(
      buildNoteTitle(new Date("2026-10-02T12:00:00")),
      buildNoteTitle(new Date("2026-10-03T12:00:00")),
    );
  });
});

describe("Markdown 复制", function () {
  it("含选区时用引用块，并标注页码为估算", function () {
    const md = buildMarkdown({
      question: "这句什么意思？",
      answer: "意思是……",
      selection: "line one\nline two",
      pageLabel: "第 3 页",
    });
    assert.match(md, /^### 这句什么意思？/);
    assert.match(md, /^> line one$/m);
    assert.match(md, /^> line two$/m);
    assert.match(md, /估算/);
    assert.match(md, /意思是……/);
  });

  it("无选区时不产生空引用块", function () {
    const md = buildMarkdown({ question: "Q", answer: "A" });
    assert.ok(!md.includes("> "));
    assert.match(md, /### Q/);
  });

  it("Markdown 不做 HTML 转义（复制到外部编辑器要保持原样）", function () {
    const md = buildMarkdown({ question: "Q", answer: "结论 p<0.05 & N>100" });
    assert.match(md, /p<0\.05 & N>100/);
  });
});

describe("Markdown → 笔记 HTML（真机反馈：曾被二次格式化）", function () {
  // 真机反馈原话："md 格式的文本写入笔记时被二次格式化"。
  // 原因是模型按提示词输出 Markdown，而旧实现只把整段 escapeHtml 后塞进 <p>，
  // 于是笔记里显示的是 `###`、`**`、`|---|` 这些符号本身。
  const { markdownToHtml } = writeback;

  it("标题渲染成 h 标签，而不是显示井号", function () {
    const html = markdownToHtml("## 一、原文定位\n\n正文。");
    assert.match(html, /<h4>一、原文定位<\/h4>/);
    assert.ok(!html.includes("##"), "不应残留井号");
  });

  it("粗体、行内代码、链接都转成标签", function () {
    const html = markdownToHtml(
      "这是 **重点**，以及 `code()`，见 [文档](https://example.com/a)。",
    );
    assert.match(html, /<strong>重点<\/strong>/);
    assert.match(html, /<code>code\(\)<\/code>/);
    assert.match(html, /<a href="https:\/\/example\.com\/a">文档<\/a>/);
    assert.ok(!html.includes("**"), "不应残留星号");
  });

  it("无序与有序列表转成 ul/ol", function () {
    const html = markdownToHtml("- 甲\n- 乙\n\n1. 一\n2. 二");
    assert.match(html, /<ul>\s*<li>甲<\/li>\s*<li>乙<\/li>\s*<\/ul>/s);
    assert.match(html, /<ol>\s*<li>一<\/li>\s*<li>二<\/li>\s*<\/ol>/s);
  });

  it("表格转成真正的 table", function () {
    const html = markdownToHtml(
      "| 维度 | 甲 | 乙 |\n| --- | --- | --- |\n| 方法 | A | B |",
    );
    assert.match(html, /<table>/);
    assert.match(html, /<th>维度<\/th>/);
    assert.match(html, /<td>方法<\/td>/);
    assert.ok(!html.includes("---"), "分隔行不应出现在结果里");
  });

  it("引用与代码块", function () {
    assert.match(
      markdownToHtml("> 原文引用"),
      /<blockquote><p>原文引用<\/p><\/blockquote>/,
    );
    const code = markdownToHtml("```\nconst a = 1 < 2;\n```");
    assert.match(code, /<pre><code>const a = 1 &lt; 2;<\/code><\/pre>/);
  });

  it("**安全**：模型输出或论文原文里的标签一律被转义，绝不产生可执行标签", function () {
    const html = markdownToHtml(
      "看这个 <script>alert(1)</script> 和 <img src=x onerror=alert(2)> 以及 <b>粗</b>",
    );
    assert.ok(!/<script/i.test(html), "绝不能出现 script 标签");
    assert.ok(!/<img/i.test(html), "绝不能出现 img 标签");
    assert.ok(!/<b>/i.test(html), "原文里的 b 标签也必须转义");
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&lt;img/);
  });

  it("**安全**：链接只允许 http/https，javascript: 不生成 a 标签", function () {
    const html = markdownToHtml("[点我](javascript:alert(1))");
    assert.ok(!/<a /i.test(html), "javascript: 链接不得变成 a 标签");
    assert.match(html, /javascript:alert\(1\)/);
  });

  it("**安全**：在 Markdown 语法里夹带 HTML 也逃不掉转义", function () {
    const html = markdownToHtml(
      "## <img src=x onerror=alert(1)>\n\n- <script>bad()</script>",
    );
    assert.ok(!/<img/i.test(html));
    assert.ok(!/<script/i.test(html));
    assert.match(html, /&lt;img/);
  });

  it("空回答不产生垃圾标签", function () {
    assert.equal(markdownToHtml(""), "");
    assert.equal(markdownToHtml("\n\n  \n"), "");
  });

  it("笔记里嵌入了渲染后的回答，且**回答是主体**（用户反馈后的结构）", function () {
    const html = buildNoteHtml(
      {
        question: "这篇讲了什么？",
        answer: "## 结论\n\n- **要点一**\n- 要点二",
      },
      new Date("2026-10-02T12:00:00Z"),
    );
    // 回答必须被 Markdown 渲染（不是原样塞进去）
    assert.match(html, /<h4>结论<\/h4>/);
    assert.match(html, /<strong>要点一<\/strong>/);
    assert.ok(!html.includes("##"), "笔记里不应出现 Markdown 符号");

    // 醒目的来源标记
    assert.match(html, /DSH 回答/, "要有醒目的来源标记");

    // ⚠️ 顺序：**回答在前、提问在后**。
    // 用户反馈"记录的是用户的消息，而非 DSH 的回答" —— 原先把提问放在 <h2>，
    // 是整条笔记最醒目的位置，主次颠倒。
    const answerAt = html.indexOf("结论");
    const questionAt = html.indexOf("问：这篇讲了什么？");
    assert.ok(questionAt > 0, "提问应作为上下文保留（带「问：」前缀）");
    assert.ok(
      answerAt < questionAt,
      `回答必须排在提问前面（回答位置 ${answerAt}，提问位置 ${questionAt}）`,
    );
    assert.ok(!/<h2>/.test(html), "提问不应再占用 <h2>");
  });

  it("会话笔记的标题直接反映问题（不只是一个日期）", function () {
    const payload = { question: "这几篇的对比结论是什么？", answer: "……" };
    const title = buildSessionNoteTitle(
      payload,
      new Date("2026-10-02T12:00:00Z"),
    );
    assert.match(title, /^DSH 回答 · /, "标题应有可识别前缀");
    assert.match(title, /对比结论/, "标题应含问题摘要，便于在笔记列表里辨认");
    assert.ok(!title.includes("\n"), "标题必须是一行");

    // 没有问题时退化为日期型标题（不能产生 "DSH 回答 · " 这种空标题）
    const fallback = buildSessionNoteTitle(
      { question: "   ", answer: "…" },
      new Date("2026-10-02T12:00:00Z"),
    );
    assert.match(fallback, /^DSH 回答 - \d{4}-\d{2}-\d{2}$/);

    // 超长问题要截断（标题不能撑爆笔记列表）
    const long = buildSessionNoteTitle(
      { question: "问".repeat(200), answer: "…" },
      new Date("2026-10-02T12:00:00Z"),
    );
    assert.ok(long.length < 80, `标题过长：${long.length} 字符`);
  });
});
