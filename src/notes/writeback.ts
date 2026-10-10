/**
 * 结果回写：把 AI 的回答变成 Zotero 里的笔记与高亮注释。
 *
 * 依据（Zotero 10 源码核实，见 docs/设计文档-DSH-for-Zotero.md §3.4）：
 *  - 子笔记：`new Zotero.Item('note')` + `libraryID` + `parentID` + `setNote(html)` + `saveTx(saveOptions)`
 *    （Zotero 自身用法见 `elements/attachmentBox.js:723-735`）；
 *  - 高亮注释：`Zotero.Annotations.saveFromJSON(attachment, json, saveOptions)`
 *    （`xpcom/annotations.js:214-265`），json 字段为
 *    `{ key, type:'highlight', text, comment, color, pageLabel, sortIndex, position }`，
 *    其中 `position` 是 JSON 字符串化后的 `{ pageIndex, rects }`；
 *  - 注释 key 用 `Zotero.Utilities.generateObjectKey()`（同 Zotero 内部生成的 8 位 key）。
 *
 * ## 关于 `undoAction`（2026-10-02 依 `xpcom/undoHistory.js` 原文更正）
 *
 * 该文件顶部注释写明：
 *   - "Only tracks modifications to **existing** objects."
 *   - "DataObject.save() calls stageChange unconditionally for **non-isNew** saves;
 *      stageAction is opt-in via save({ undoAction, ... })"
 *   - "A transaction that stages changes without an action … is **silently discarded** at commit."
 *
 * 据此可得两条结论：
 *  1. **新建**笔记 / 新注解属于 isNew，不产生 stageChange，也就不进撤销栈 ——
 *     因此给它们传 `undoAction` **没有意义**（早先版本传了，属于误解）。
 *  2. **修改已有**笔记（本模块的 append 模式）才是 non-isNew，**必须**带 `undoAction`，
 *     否则该次提交会被**静默丢弃** —— 这是真正需要它的地方。
 *
 * 另：`undoAction` 是 Fluent 消息 ID，必须真实存在。实测 Zotero 10.0.5 的 zotero.ftl 里
 * 只有 `undo-action-edit-note`；`undo-action-new-note` / `undo-action-add-annotation` /
 * `undo-action-edit-tags` **都不存在**（早先版本用了这三个，属编造）。
 */

export interface AnswerPayload {
  question: string;
  answer: string;
  /** 若来源于划词，带上选中原文 */
  selection?: string;
  /** 页码（估算值，来自选区或模型自报） */
  pageLabel?: string;
  model?: string;
}

const NOTE_TAG = "DSH-for-Zotero";
/** 追加到同一笔记时用来识别的标题前缀 */
const NOTE_TITLE_PREFIX = "DSH 伴读";

/**
 * Zotero 10 的保存选项比 zotero-types 的声明更新：`undoAction` / `skipSelect`
 * 都是运行时真实存在的字段，但 `SaveOptions` 类型里还没有。这里统一断言。
 *
 * `undoAction` 只在**修改已有对象**时才有意义（见文件顶部说明）；
 * 新建对象的保存不必带它，因此这里是可选的。
 */
type SaveOptionsLike = Parameters<Zotero.Item["saveTx"]>[0] | undefined;

function saveOptions(options: {
  /** 仅"修改已有对象"时需要；新建对象传了也没用 */
  undoAction?: string;
  skipSelect?: boolean;
}): SaveOptionsLike {
  return options as unknown as SaveOptionsLike;
}

/** HTML 转义：模型输出与论文原文都可能包含标签，绝不直接拼接 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ⚠️ 这里原有 `paragraphs()`（按空行切段、每段包 `<p>` 并把换行转 `<br/>`）。
// 全仓库无一处调用 —— 实际的 Markdown → HTML 走下面的 `markdownToHtml`，
// 它自己处理段落与换行。两份实现并存只会让人不确定该用哪个。

/**
 * 行内 Markdown → HTML。
 *
 * **安全前提**：先整体转义，再只替换我们自己生成的标签。
 * 这样论文原文或模型输出里的任何 HTML 都无法注入 —— 有意为之。
 *
 * 支持：`**粗体**`、`*斜体*`、`` `行内代码` ``、`[文字](链接)`。
 */
function inlineMarkdown(text: string): string {
  let out = escapeHtml(text);
  // 行内代码优先：其内容不应再被其它规则处理
  const codes: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(code);
    return `\u0000CODE${codes.length - 1}\u0000`;
  });
  // 链接：只允许 http/https，避免 javascript: 之类的注入
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, label: string, href: string) => {
      return `<a href="${href}">${label}</a>`;
    },
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(
    // Markdown → HTML 是**两阶段**的：先把代码块抽出来、用占位符替换，
    // 渲染完再塞回去 —— 否则代码块里的 `**`、`#` 会被当成 Markdown 记号。
    // 占位符必须挑一个**正文里不可能出现**的字符，`\u0000`（NUL）正合适。
    // 这不是"手滑写了控制字符"，而是刻意的哨兵值，故豁免该规则。
    //
    // ⚠️ 豁免必须写在**同一行**（行尾注释）而不是上一行：prettier 会把这个正则
    // 和它的说明排版成多行，`eslint-disable-next-line` 就会与目标行脱节而失效。
    /\u0000CODE(\d+)\u0000/g /* eslint-disable-line no-control-regex */,
    (_m, i: string) => `<code>${codes[Number(i)]}</code>`,
  );
  return out;
}

/** 判断是否为表格分隔行，如 `|---|:--:|` */
function isTableDivider(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-");
}

/** 拆分表格行成单元格 */
function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/**
 * Markdown → 笔记 HTML。
 *
 * 为什么需要它（真机反馈）：模型按提示词输出 **Markdown**，而此前实现只是把整段文本
 * `escapeHtml` 后塞进 `<p>`，于是笔记里显示的是一堆 `###`、`**`、`|---|` 符号 ——
 * 用户看到的正是"Markdown 被二次格式化"。
 *
 * 安全仍然第一：**所有文本先转义**，只由本函数生成标签；
 * 因此即便论文原文或模型输出里含 `<script>`，最终 HTML 里也不会出现可执行的标签。
 */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  /** 当前打开的列表标签（ul/ol），用于正确闭合 */
  let listTag: "ul" | "ol" | undefined;
  let paragraph: string[] = [];

  const closeList = () => {
    if (listTag) {
      html.push(`</${listTag}>`);
      listTag = undefined;
    }
  };
  const closeParagraph = () => {
    if (paragraph.length > 0) {
      html.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const openList = (tag: "ul" | "ol") => {
    if (listTag !== tag) {
      closeList();
      html.push(`<${tag}>`);
      listTag = tag;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      closeParagraph();
      closeList();
      continue;
    }

    // 代码块：原样保留（转义后），不做行内处理
    if (/^```/.test(trimmed)) {
      closeParagraph();
      closeList();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        body.push(lines[i]);
        i++;
      }
      html.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    // 标题
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      closeParagraph();
      closeList();
      const level = Math.min(6, heading[1].length + 2); // 笔记内嵌用 h3 起步，避免层级倒挂
      html.push(`<h${level}>${inlineMarkdown(heading[2].trim())}</h${level}>`);
      continue;
    }

    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed) && !isTableDivider(trimmed)) {
      closeParagraph();
      closeList();
      html.push("<hr/>");
      continue;
    }

    // 表格：当前行含 |，且下一行是分隔行
    if (
      trimmed.includes("|") &&
      i + 1 < lines.length &&
      isTableDivider(lines[i + 1])
    ) {
      closeParagraph();
      closeList();
      const header = tableCells(trimmed);
      i += 2; // 跳过表头与分隔行
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(tableCells(lines[i]));
        i++;
      }
      i--; // 回退一格，交给 for 的 i++
      const head = header
        .map((cell) => `<th>${inlineMarkdown(cell)}</th>`)
        .join("");
      const body = rows
        .map(
          (row) =>
            `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`,
        )
        .join("");
      html.push(
        `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`,
      );
      continue;
    }

    // 引用
    const quote = /^>\s?(.*)$/.exec(trimmed);
    if (quote) {
      closeParagraph();
      closeList();
      const body: string[] = [quote[1]];
      while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1].trim())) {
        i++;
        body.push(lines[i].trim().replace(/^>\s?/, ""));
      }
      html.push(
        `<blockquote><p>${inlineMarkdown(body.join(" "))}</p></blockquote>`,
      );
      continue;
    }

    // 有序 / 无序列表
    const ordered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed);
    if (ordered) {
      closeParagraph();
      openList("ol");
      html.push(`<li>${inlineMarkdown(ordered[2])}</li>`);
      continue;
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      closeParagraph();
      openList("ul");
      html.push(`<li>${inlineMarkdown(bullet[1])}</li>`);
      continue;
    }

    // 普通段落行
    closeList();
    paragraph.push(trimmed);
  }

  closeParagraph();
  closeList();
  return html.join("\n");
}

/**
 * 把一条问答组装成笔记 HTML。
 *
 * ## 结构（按用户反馈调整：**以 DSH 回答为主体**）
 *
 * ```
 * 【DSH 回答】            ← 醒目标记（Zotero 笔记里没有自定义 CSS，
 * ────────────────           所以用 span 的行内样式做视觉强调）
 * {回答，Markdown 渲染}   ← 主体，放在最显眼的位置
 *
 * > 问：{提问}            ← 提问降为引用块，作为上下文
 *
 * 由 DSH-for-Zotero 生成于 …
 * ```
 *
 * 用户反馈两点，都体现在上面：
 *  1. "标题不醒目" —— 原先整条笔记没有任何视觉焦点，且笔记**标题**只有日期；
 *  2. "记录的是用户的消息，而非 DSH 的回答" —— 原先把**提问**放在 `<h2>`
 *     （最醒目位置），回答反而在下面，主次颠倒。
 */
export function buildNoteHtml(
  payload: AnswerPayload,
  generatedAt: Date,
): string {
  const parts: string[] = [];

  // 醒目的来源标记。行内样式是刻意的：Zotero 笔记的渲染环境不加载我们的 CSS。
  parts.push(
    `<p><span style="background:#1d4ed8;color:#ffffff;padding:2px 8px;` +
      `border-radius:4px;font-size:11px;font-weight:700;">DSH 回答</span></p>`,
  );

  // ⚠️ 主体是**回答**，不是提问。
  parts.push(markdownToHtml(payload.answer));

  // 提问作为上下文放在回答之后，用引用块弱化
  if (payload.question.trim()) {
    parts.push(
      `<blockquote><p>问：${escapeHtml(payload.question.slice(0, 200))}</p></blockquote>`,
    );
  }

  if (payload.selection?.trim()) {
    parts.push(
      `<blockquote><p>${escapeHtml(payload.selection.trim())}</p></blockquote>` +
        (payload.pageLabel
          ? `<p><em>（原文位置：${escapeHtml(payload.pageLabel)}）</em></p>`
          : ""),
    );
  }

  const stamp = generatedAt.toLocaleString();
  const footer = [`由 DSH-for-Zotero 生成于 ${stamp}`];
  if (payload.pageLabel)
    footer.push(`页码：${payload.pageLabel}（估算值，请核对原文）`);
  if (payload.model) footer.push(`模型：${payload.model}`);
  parts.push(`<hr/><p><em>${escapeHtml(footer.join("；"))}</em></p>`);

  return parts.join("\n");
}

/** 笔记标题：<前缀> - <日期>，同一文献同一天追加到同一笔记 */
export function buildNoteTitle(generatedAt: Date): string {
  const y = generatedAt.getFullYear();
  const m = String(generatedAt.getMonth() + 1).padStart(2, "0");
  const d = String(generatedAt.getDate()).padStart(2, "0");
  return `${NOTE_TITLE_PREFIX} - ${y}-${m}-${d}`;
}

/**
 * **会话笔记**的标题：`DSH 回答 · <问题摘要>`。
 *
 * 为什么要单独一个：会话里每条回答是独立一次问答，
 * 用"日期"当标题在笔记列表里完全看不出内容（用户反馈"标题不醒目"）。
 * 用问题摘要当标题，一眼就知道这条记的是哪一问 —— 而且是可搜索的。
 *
 * （阅读器侧栏的"存为笔记"仍是同一天追加到一条，所以仍用 `buildNoteTitle`。）
 */
export function buildSessionNoteTitle(
  payload: AnswerPayload,
  generatedAt: Date,
): string {
  const y = generatedAt.getFullYear();
  const m = String(generatedAt.getMonth() + 1).padStart(2, "0");
  const d = String(generatedAt.getDate()).padStart(2, "0");
  // 压掉换行与多余空白：标题必须是一行
  const summary = payload.question.replace(/\s+/g, " ").trim().slice(0, 48);
  if (!summary) return `DSH 回答 - ${y}-${m}-${d}`;
  return `DSH 回答 · ${summary}`;
}

/** 复制的 Markdown 形式 */
export function buildMarkdown(payload: AnswerPayload): string {
  const lines: string[] = [];
  lines.push(`### ${payload.question}`);
  if (payload.selection?.trim()) {
    lines.push("");
    lines.push(`> ${payload.selection.trim().replace(/\n/g, "\n> ")}`);
    if (payload.pageLabel)
      lines.push(`> 原文位置：${payload.pageLabel}（估算）`);
  }
  lines.push("");
  lines.push(payload.answer);
  return lines.join("\n");
}

/**
 * 该落点下已存在的本插件当天笔记（按标题识别）。
 *
 * 两种落点：
 *  - 有 `parent` → 该条目的子笔记；
 *  - 有 `collectionID` → 该分类下的**顶层**笔记（独立会话的落点）。
 */
function findAppendTarget(
  target: { parent?: Zotero.Item; collectionID?: number },
  title: string,
): Zotero.Item | undefined {
  let notes: Zotero.Item[] = [];
  try {
    if (target.parent) {
      notes = (target.parent.getNotes?.() ?? [])
        .map((id) => Zotero.Items.get(id))
        .filter((item): item is Zotero.Item => !!item);
    } else if (target.collectionID) {
      // 分类下的顶层笔记。
      // ⚠️ `getChildItems` 是重载：`asIDs: true` 返回 number[]，默认/`false` 才返回 Item[]。
      // 不显式传 `false` 时 TS 会按第一个重载推断，类型对不上（已实测报错）。
      const collection = Zotero.Collections.get(target.collectionID);
      const children = collection?.getChildItems?.(false) ?? [];
      notes = (Array.isArray(children) ? children : []).filter(
        (item): item is Zotero.Item =>
          !!item && item.isNote?.() === true && !item.parentID,
      );
    }
  } catch {
    return undefined;
  }
  const exact = notes.find((note) => {
    try {
      return note.getNoteTitle?.() === title;
    } catch {
      return false;
    }
  });
  return exact;
}

/**
 * 保存回答为笔记。
 *
 * ## 两种落点（对应两类会话）
 *
 *  - **条目会话**：传 `parent`，笔记挂在该条目下（原有行为）；
 *  - **独立会话**：不传 `parent`、传 `collectionID`，笔记成为**顶层条目并加入该分类**。
 *    Zotero 里分类不是条目、不能当父级，所以顶层 + `addToCollection` 是唯一可行形态
 *    （与"会话附件挂到分类下"同一套做法）。
 *
 * `mode = "append"` 时若当天的笔记已存在则追加，否则新建
 * （幂等：同一天的问答聚在一条笔记里）。
 *
 * `title` 可覆盖默认标题：会话笔记希望标题直接反映"回答了什么"，
 * 而不是只看得出日期的 `DSH 伴读 - 日期`（用户反馈"标题不醒目"）。
 */
export async function saveAnswerAsNote(
  payload: AnswerPayload,
  options: {
    mode?: "append" | "new";
    now?: Date;
    /** 挂到哪个条目下（条目会话用） */
    parent?: Zotero.Item;
    /** 加入哪个分类（独立会话用；与 parent 二选一） */
    collectionID?: number;
    /** 所属文库（没有 parent 时必须给，否则不知道建在哪个文库） */
    libraryID?: number;
    /** 覆盖笔记标题（不传则用 `DSH 伴读 - 日期`） */
    title?: string;
  } = {},
): Promise<{ noteID: number; created: boolean }> {
  const now = options.now ?? new Date();
  const mode = options.mode ?? "append";
  const title = options.title?.trim() || buildNoteTitle(now);
  const html = buildNoteHtml(payload, now);

  // 追加模式下只在"同一个落点"里找当天的笔记：条目会话找该条目的子笔记，
  // 独立会话找该分类下的顶层笔记。
  const existing =
    mode === "append" ? findAppendTarget(options, title) : undefined;
  if (existing) {
    const previous = (() => {
      try {
        return existing.getNote();
      } catch {
        return "";
      }
    })();
    existing.setNote(`${previous}\n<hr/>\n${html}`);
    // Zotero 10 撤销是两步协议：不带 undoAction 的修改会在提交时静默丢弃
    await existing.saveTx(saveOptions({ undoAction: "undo-action-edit-note" }));
    return { noteID: existing.id, created: false };
  }

  const note = new Zotero.Item("note");
  const parent = options.parent;
  note.libraryID =
    parent?.libraryID ?? options.libraryID ?? Zotero.Libraries.userLibraryID;
  if (parent) note.parentID = parent.id;
  note.setNote(html);
  try {
    note.addTag(NOTE_TAG);
  } catch {
    // 标签失败不影响保存
  }
  // 新建对象（isNew）不产生 stageChange，不需要 undoAction 也会正常提交。
  await note.saveTx();
  // 独立会话：顶层笔记要显式加进分类，否则会落在文库根（用户找不到）
  if (!parent && options.collectionID) {
    try {
      note.addToCollection(options.collectionID);
      await note.saveTx();
    } catch (error) {
      ztoolkit.log("[DSH] 把笔记加入分类失败", error);
    }
  }
  return { noteID: note.id, created: true };
}

/**
 * 保存回答为 PDF 高亮注释。
 *
 * **必须提供选区几何信息**（`position.pageIndex` + `rects`）：注释位置是 Zotero 的必填字段，
 * 没有坐标就无法创建高亮。因此本函数只在"用户划了字"的场景可用；
 * 纯问答（没有选区）应当用 `saveAnswerAsNote`。
 */
export async function saveAnswerAsHighlight(
  attachment: Zotero.Item,
  payload: AnswerPayload,
  position: { pageIndex: number; rects: number[][] },
  options: { color?: string } = {},
): Promise<{ annotationID: number }> {
  const color = options.color ?? "#ffd400"; // Zotero 默认黄
  const json = {
    key: Zotero.Utilities.generateObjectKey(),
    type: "highlight",
    text: payload.selection ?? "",
    comment: [payload.question, payload.answer].filter(Boolean).join("\n\n"),
    color,
    pageLabel: payload.pageLabel ?? "",
    sortIndex: String(position.pageIndex).padStart(5, "0"),
    position: { pageIndex: position.pageIndex, rects: position.rects },
  };
  const item = await Zotero.Annotations.saveFromJSON(
    attachment,
    // zotero-types 的 AnnotationJson 声明要求 id/libraryID/readOnly/dateModified 等内部字段，
    // 而运行时（xpcom/annotations.js:214-265）只读取 key/type/text/comment/color/
    // pageLabel/sortIndex/position/authorName/isExternal/tags，故此处断言。
    json as unknown as Parameters<typeof Zotero.Annotations.saveFromJSON>[1],
    // 新注解同样是 isNew，不需要 undoAction；skipSelect 避免抢走用户的当前选择。
    saveOptions({ skipSelect: true }),
  );
  return { annotationID: item.id };
}

/** 把一条回答复制到剪贴板 */
export function copyAnswerToClipboard(payload: AnswerPayload): boolean {
  try {
    new ztoolkit.Clipboard()
      .addText(buildMarkdown(payload), "text/unicode")
      .copy();
    return true;
  } catch (error) {
    ztoolkit.log("[DSH] 复制失败", error);
    return false;
  }
}
