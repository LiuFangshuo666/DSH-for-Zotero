/**
 * ## 把会话归档成 Zotero 笔记（跨设备可读）
 * ## 为什么是笔记，不是附件
 *
 * 直觉做法是"导出成文件、作为附件挂到条目上" —— 但那条路有一个**静默的失败模式**：
 *
 * ```text
 *   附件是「文件」→ 需要开启 Zotero 文件同步（Zotero Storage 有配额 / WebDAV）
 *   没开文件同步 → 设备 A 归档成功，设备 B 只收到一个**空壳附件**
 *                  （元数据在，文件不在，双击报"找不到文件"）
 * ```
 *
 * 而**笔记是数据，不是文件** —— 它随条目一起同步，永远会到。而且笔记：
 *
 * - 参与 Zotero 全文搜索
 * - 可引用、可复制、可导出
 * - 不占文件配额
 *
 * 所以选笔记。代价是笔记里不能放二进制，也不能放工具调用的完整参数 ——
 * 但那本来就不是"要跨设备读"的东西。
 *
 * ## 为什么可以分成多篇
 *
 * 一篇笔记塞进几百万字符会让 Zotero 的编辑器卡住。所以按**轮次边界**切分，
 * 每篇不超过 {@link NOTE_CHAR_BUDGET}。切分**绝不丢内容** ——
 * 宁可多一篇笔记，也不要静默截断（这个项目里"静默截断"已经造成过多次误判）。
 */

/** 单篇笔记的字符预算（HTML 字符数，含标签） */
export const NOTE_CHAR_BUDGET = 250_000;

/** 归档笔记所属的 Zotero 分类名 */
export const ARCHIVE_COLLECTION_NAME = "DSH 会话归档";

/** 一轮问答 */
export interface ArchiveTurn {
  prompt: string;
  response: string;
}

/** 归档所需的展示信息 */
export interface ArchiveMeta {
  sessionId: string;
  /** 会话绑定的范围标题（条目标题或分类名） */
  scopeTitle: string;
  title: string;
  /** `provider/model`，没有就省略 */
  modelLabel?: string;
  /** 归档时间（毫秒） */
  archivedAt: number;
  /** 时区，用于把时间写成人能读的形式 */
  timeZone?: string;
}

/**
 * ⚠️ HTML 转义**复用** `notes/writeback` 里那一个，不再自己写一份。
 *
 * 两份逐字符相同的转义实现只会日后分叉（一份补了字符、另一份没补），
 * 而这种分叉在"笔记结构偶尔坏掉"里极难定位。测试入口也因为它重名而导出冲突 ——
 * 那是编译器在替我指出重复。
 */
import { escapeHtml } from "../notes/writeback";

/** 纯文本 → 笔记里的段落（换行转 `<br/>`） */
export function textToNoteHtml(text: string): string {
  const safe = escapeHtml(text)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join("<br/>");
  return `<p>${safe}</p>`;
}

/**
 * 把毫秒时间格式化成人能读的字符串。
 *
 * 用 `Intl.DateTimeFormat` 而不是手算：手算时区差一小时的 bug 我在本项目里
 * 已经写过一次（"归档时间比实际早 8 小时"）。
 */
export function formatArchivedAt(
  at: number,
  timeZone = "Asia/Shanghai",
): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 16).replace("T", " ");
  }
}

/** 单篇笔记的标题（也决定 Zotero 列表里显示的名字） */
export function archiveNoteTitle(
  meta: ArchiveMeta,
  part: number,
  total: number,
): string {
  const base = `DSH 会话归档：${meta.title || meta.scopeTitle || meta.sessionId}`;
  return total > 1 ? `${base}（${part}/${total}）` : base;
}

/**
 * 头部：说明这是**快照**，并如实写明"对话本身留在原机器"。
 *
 * 为什么必须写清楚：用户在另一台机器上看到归档，很容易以为"会话同步过来了，
 * 可以接着聊"。但 dsh 会话与机器绑定（cwd 创建时固定），续写会新建一条。
 * 不说明白，用户就会以为插件坏了。
 */
function headerHtml(meta: ArchiveMeta, part: number, total: number): string {
  const rows = [
    `<strong>条目</strong>：${escapeHtml(meta.scopeTitle || "（无）")}`,
    `<strong>会话</strong>：${escapeHtml(meta.sessionId)}`,
  ];
  if (meta.modelLabel) {
    rows.push(`<strong>模型</strong>：${escapeHtml(meta.modelLabel)}`);
  }
  rows.push(
    `<strong>归档时间</strong>：${escapeHtml(formatArchivedAt(meta.archivedAt, meta.timeZone))}`,
  );
  if (total > 1) rows.push(`<strong>分篇</strong>：第 ${part} / ${total} 篇`);
  rows.push(
    "<strong>说明</strong>：这是对话记录的**快照**。对话本身留在生成它的那台机器上" +
      "（dsh 会话的工作目录创建时固定、不可更改），所以在另一台机器上是**只读**的，" +
      "不能接着原会话续写；但内容、以及 AI 对文献库做过的事都在这里可查。",
  );
  return `<h1>${escapeHtml(archiveNoteTitle(meta, part, total))}</h1><p>${rows.join("<br/>")}</p>`;
}

/** 一轮问答的 HTML（不含头部） */
function turnHtml(index: number, turn: ArchiveTurn): string {
  const question = textToNoteHtml(turn.prompt || "（空）");
  const answer = textToNoteHtml(turn.response || "（这一轮没有文字回答）");
  return (
    `<h2>第 ${index} 轮</h2>` +
    `<p><strong>问</strong></p>${question}` +
    `<p><strong>答</strong></p>${answer}`
  );
}

/**
 * 生成归档笔记的分篇 HTML。
 *
 * 切分规则：按轮次累加，超过 {@link NOTE_CHAR_BUDGET} 就开新篇。
 * **单轮就超预算**时不强行切割正文（那会切断代码块/句子）—— 让它独占一篇，
 * 并在结果里由调用方提示"这一轮很长"。
 */
export function buildArchiveParts(
  meta: ArchiveMeta,
  turns: ArchiveTurn[],
  budget: number = NOTE_CHAR_BUDGET,
): string[] {
  const usable = turns.length > 0 ? turns : [{ prompt: "", response: "" }];
  // 先按预算把轮次分组
  const groups: ArchiveTurn[][] = [];
  let current: ArchiveTurn[] = [];
  let size = 0;
  for (const turn of usable) {
    const len = turnHtml(0, turn).length;
    if (current.length > 0 && size + len > budget) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(turn);
    size += len;
  }
  if (current.length > 0) groups.push(current);

  const total = groups.length;
  let turnIndex = 0;
  return groups.map((group, i) => {
    const body = group
      .map((turn) => {
        turnIndex += 1;
        return turnHtml(turnIndex, turn);
      })
      .join("");
    return headerHtml(meta, i + 1, total) + body;
  });
}

/** 归档结果（给界面直接显示） */
export interface ArchiveResult {
  ok: boolean;
  结果: string;
  分篇?: number;
  分类?: string;
  说明?: string;
}
