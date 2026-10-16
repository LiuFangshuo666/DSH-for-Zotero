/**
 * Markdown → HTML 的**共享用例夹具**。
 *
 * ## 为什么需要它（三份独立审计的共同发现）
 *
 * 同一个模型输出会在两个地方渲染成 HTML，而它们是**两份独立实现**：
 *
 *  - `addon/content/sessionPage.js` 的 `renderMarkdown()` —— 会话页显示；
 *  - `src/notes/writeback.ts` 的 `markdownToHtml()` —— **存为笔记**。
 *
 * 两份各有自己的测试（`sessionRender.test.mjs` / `writeback.test.mjs`），
 * 于是**没人比对过它们对同一输入是否给出同样的结果**。
 * 而会话页那边的注释自己写着它修过一个 writeback 也有的毛病
 * （"行内代码会被后续粗体/斜体规则再处理"）—— 也就是说：
 *
 * > 同一段回答，在会话页里和在笔记里**渲染结果不同**，而且没人在看。
 *
 * ## 这个夹具怎么用
 *
 * `CASES` 是"两边都应当满足"的用例：每条给 markdown 与**期望的片段**
 * （用片段而不是整串比对，避免只因空白/属性顺序不同就失败）。
 *
 * `DIFFERENCES` 是**已确认、且有意**的差异：每条都要写清"为什么两边不同"。
 * 把它显式登记，是为了让"差异"变成**有人负责的决定**，
 * 而不是哪天两个人各改各的、谁也没发现。
 *
 * ⚠️ 新增差异时请**先问这是不是有意的**。如果有意，在这里登记；
 * 如果不是，那就是 bug，别登记 —— 去修。
 */

/** 标题起始层级：两边**故意不同**，见 DIFFERENCES */
export const HEADING_BASE = {
  /** 会话页是整页内容，从 h1 起 */
  sessionPage: 1,
  /** 笔记内嵌在 Zotero 的富文本里，从 h3 起，避免层级倒挂 */
  writeback: 3,
};

/**
 * 两边都应当满足的用例。
 *
 * `expect` 里用 `{h: n}` 占位表示"第 n 级标题（n 相对该渲染器的起始层级）"，
 * 由各测试自行展开 —— 这样同一份用例能覆盖两套层级。
 */
export const CASES = [
  {
    name: "**行内代码里的 Markdown 记号不得被再处理**（两份实现都要过）",
    // ⚠️ 这条是**实测确认过**的：会话页的注释曾断言
    // "writeback.ts 那份实现有个既有局限：代码内容会被后续粗体/斜体规则再处理"——
    // 而实测表明**两份都不会**（都用了 NUL 哨兵占位符再放回）。
    // 那条注释是过时的，已改正。这个用例把事实钉住，防止任何一份将来退化。
    md: "a **bold** and `b**c`",
    expect: ["<strong>bold</strong>", "<code>b**c</code>"],
    absent: ["<code>b<strong>"],
  },
  {
    name: "行内代码里的单个星号与下划线也不得被再处理",
    md: "`x*y*z` 与 `a_b_c`",
    expect: ["<code>x*y*z</code>", "<code>a_b_c</code>"],
    absent: ["<em>", "<strong>"],
  },
  {
    name: "标题渲染成 h 标签，而不是显示井号",
    md: "### 结论\n\n正文",
    expect: ["{h:3}>结论</", "<p>正文</p>"],
  },
  {
    name: "无序列表渲染成 ul/li",
    md: "- 第一\n- 第二",
    expect: ["<ul>", "<li>第一</li>", "<li>第二</li>", "</ul>"],
  },
  {
    name: "有序列表渲染成 ol/li",
    md: "1. 第一\n2. 第二",
    expect: ["<ol>", "<li>第一</li>", "</ol>"],
  },
  {
    name: "行内代码渲染成 code，且不显示反引号",
    md: "用 `getFullText` 读",
    expect: ["<code>getFullText</code>"],
    absent: ["`getFullText`"],
  },
  {
    name: "粗体与斜体",
    md: "**粗**与*斜*",
    expect: ["<strong>粗</strong>", "<em>斜</em>"],
  },
  {
    name: "代码围栏整段转义，不做行内替换",
    md: "```js\nconst a = 1 < 2;\n```",
    // ⚠️ 只断言 `<pre` 与 `<code>`，**不绑定具体属性**：
    // 会话页给 `<pre>` 加了 `class="dsh-code"` / `data-lang`（用于样式与语言标注），
    // 而写笔记那份没有。那是**表现层差异**，不是行为差异 ——
    // 断言写死 `<pre><code>` 会让这条用例变成"两处必须一模一样"，
    // 而那正是我们要避免的过度约束。
    expect: ["<pre", "<code>", "&lt;"],
    absent: ["<strong>"],
  },
  {
    name: "**危险的 HTML 必须被转义**（模型可以写出 `<script>`）",
    md: "正文 <script>alert(1)</script> 结束",
    expect: ["&lt;script&gt;"],
    absent: ["<script>"],
  },
  {
    name: "段落之间成为独立的 <p>",
    md: "第一段\n\n第二段",
    expect: ["<p>第一段</p>", "<p>第二段</p>"],
  },
  {
    name: "中文与全角标点原样保留",
    md: "结论：**是**（真的）",
    expect: ["结论：", "（真的）"],
  },
];

/**
 * **已确认、且有意**的差异。
 *
 * 每条都必须回答"为什么两边不同" —— 写不出理由的，就别登记，去修。
 */
export const DIFFERENCES = [
  {
    what: "标题起始层级",
    sessionPage: "h1 起（整页内容）",
    writeback: "h3 起（内嵌进笔记，避免层级倒挂）",
    why:
      "writeback.ts 原注释：「笔记内嵌用 h3 起步，避免层级倒挂」——" +
      "Zotero 笔记本身是个富文本块，标题从 h1 起会与周围结构冲突。",
  },
  {
    what: "行内代码里的 `*` / `_` 是否会被后续粗斜体规则再处理",
    sessionPage: "不会",
    writeback: "不会",
    why:
      "**两边一致 —— 这条曾经被误记为「差异」。**\n" +
      "会话页的注释原先断言「writeback.ts 那份实现有个既有局限：代码内容会被后续" +
      "粗体/斜体规则再处理」，而实测评测表明**两份都不会**（都用 NUL 哨兵占位符\n" +
      "把代码抽出来、渲染完再放回）。那条注释是过时的，已改正；\n" +
      "`CASES` 里加了两条用例把这个事实钉住，任何一份将来退化都会红。",
  },
  {
    what: "块级包装",
    sessionPage: "纯行内（渲染器只产出行内片段，块级由调用方拼）",
    writeback: "单段输入也会包成 `<p>…</p>`",
    why: "调用方式不同：会话页那层负责整页结构，笔记那层负责一段完整 HTML。",
  },
  {
    what: "代码围栏 `<pre>` 上的属性",
    sessionPage: '带 `class="dsh-code"` 与 `data-lang`（样式与语言标注）',
    writeback: "没有额外属性",
    why:
      "纯表现层差异：会话页要自己上样式，笔记交给 Zotero 的富文本渲染。" +
      "夹具因此只断言 `<pre` 与 `<code>`，不绑定属性。",
  },
];

/**
 * 把 `{h: n}` 占位展开成实际层级的正则片段。
 *
 * @param fragment - 含 `{h:n}` 的期望片段
 * @param base - 该渲染器的标题起始层级
 */
export function expandHeading(fragment, base) {
  return fragment.replace(
    /\{h:(\d+)\}/g,
    (_, d) => `<h${base + Number(d) - 1}`,
  );
}
