/**
 * `ask_user_question` 工具调用的解析，以及相关参数的规整。
 *
 * ## 背景（源码依据：`packages/interaction/tool-ask-user`）
 *
 * dsh 的"给用户选项"不是普通文本，而是一个**工具调用**：
 *
 * ```json
 * { "questions": [{
 *     "id": "q1", "question": "…", "header": "…", "detail": "…",
 *     "options": [{ "label": "方案 A", "description": "…" }],
 *     "multi_select": false
 * }] }
 * ```
 *
 * 它的 README 写明 **"Callers provide the answer UI"（调用方自己提供回答界面）** ——
 * dsh 桌面端把选项渲染到输入框区域；而我们的会话页**只取 `text` 块**，
 * 于是选项被整段丢掉，用户只看到"有几件事要你定："，模型则一直阻塞等待。
 *
 * ## 为什么解析层单独成模块
 *
 * 参数来自模型，形状不可全信（可能缺 `id`、`options` 不是数组、字段类型不对）。
 * 解析必须**宽容但不静默**：能用的尽量用，坏条目跳过并说明。
 * 这段逻辑是纯函数，可以直接单测 —— 上面那个 bug 的性质就是"数据没被解析"，
 * 而不是"渲染不好看"，所以必须用测试钉住。
 */

/**
 * 支持的条目类型（Zotero 的英文标识符）。
 *
 * 白名单**只认英文**，因为 Zotero 的 `new Zotero.Item(type)` 需要标识符。
 */
export const ALLOWED_ITEM_TYPES = [
  "journalArticle",
  "conferencePaper",
  "book",
  "bookSection",
  "report",
  "thesis",
  "preprint",
  "webpage",
  "document",
  "manuscript",
] as const;

/**
 * 允许写入的**字段名**白名单（`createItem` 与 `setFields` 共用这一份）。
 *
 * ## 为什么是白名单而不是"Zotero 认什么就写什么"
 *
 * 这是**跨类型通用**的名单，因为同一套字段名要同时服务
 * `journalArticle`（`publicationTitle`）与 `conferencePaper`
 * （`proceedingsTitle`）。Zotero 自己会按类型校验：该类型没有的字段
 * 写进去会被**跳过**并在返回值里列出，不会让整次调用失败。
 *
 * ## ⚠️ 为什么必须只有一份
 *
 * `createItem` 与 `setFields` 是同一件事的两个方向（新建 vs 修改）。
 * 两份名单一旦漂移，就会出现"能建出来的条目改不了"或"能改的字段建不出来" ——
 * 这种不一致极难自查，因为两条路各自看起来都对。
 */
export const ALLOWED_ITEM_FIELDS = [
  "title",
  "abstractNote",
  "date",
  "publicationTitle",
  "proceedingsTitle",
  "bookTitle",
  "publisher",
  "place",
  "volume",
  "issue",
  "pages",
  "DOI",
  "ISBN",
  "ISSN",
  "url",
  "language",
  "extra",
  "university",
  "institution",
  "reportNumber",
  // 会议论文的会场有时单独存这两个（Zotero 按类型二选一）
  "conferenceName",
  "journalAbbreviation",
  "shortTitle",
  "edition",
  "series",
  "seriesTitle",
  "numberOfPages",
  "accessDate",
  "archive",
  "libraryCatalog",
  "callNumber",
  "rights",
] as const;

/**
 * 中文（及少数别名）→ Zotero 标识符。
 *
 * ## 为什么需要（真机故障）
 *
 * Agent 传了 `"itemType": "网页"` —— 它照着我写的**中文说明**推断，
 * 而白名单只认英文，于是**用户确认后四条新建全部失败**：
 * `不支持的条目类型 网页`。
 *
 * 根因是说明里没列合法值（已补全）。但再加一层别名兜底是划算的：
 * 对用户与模型而言"网页"都是完全合理的说法，因为它而拒掉整次操作没有意义。
 */
const TYPE_ALIASES: Record<string, string> = {
  网页: "webpage",
  网站: "webpage",
  期刊文章: "journalArticle",
  期刊论文: "journalArticle",
  论文: "journalArticle",
  会议论文: "conferencePaper",
  会议: "conferencePaper",
  图书: "book",
  书籍: "book",
  专著: "book",
  章节: "bookSection",
  报告: "report",
  技术报告: "report",
  学位论文: "thesis",
  学位: "thesis",
  预印本: "preprint",
  文档: "document",
  手稿: "manuscript",
};

/**
 * 把模型给的类型名规整为 Zotero 标识符。
 *
 * 三道处理，都不改语义、只做容错：
 *  1. **中文别名**映射（`网页` → `webpage`）；
 *  2. 忽略大小写与分隔符（`Web Page` / `web_page` → `webpage`）；
 *  3. 都匹配不上则返回 `undefined`，由调用方给出**可操作**的错误。
 */
export function normalizeItemType(raw: string | undefined): string | undefined {
  if (!raw) return "journalArticle"; // 未给类型时按最常用的期刊文章
  const trimmed = raw.trim();
  if ((ALLOWED_ITEM_TYPES as readonly string[]).includes(trimmed))
    return trimmed;
  const alias = TYPE_ALIASES[trimmed];
  if (alias) return alias;
  const normalized = trimmed.replace(/[\s_-]/g, "").toLowerCase();
  return (ALLOWED_ITEM_TYPES as readonly string[]).find(
    (t) => t.replace(/[\s_-]/g, "").toLowerCase() === normalized,
  );
}

export interface AskUserOption {
  label: string;
  description?: string;
}

export interface AskUserQuestion {
  id: string;
  question: string;
  header?: string;
  detail?: string;
  options: AskUserOption[];
  multiSelect: boolean;
}

/** `ask_user_question` 的工具名（与 dsh 源码 `ASK_USER_QUESTION_TOOL` 一致） */
export const ASK_USER_TOOL = "ask_user_question";

/**
 * 从工具名与参数里解析出问题批。
 *
 * @param name 工具名
 * @param rawArgs 工具参数（对象或 JSON 字符串，两种 dsh 都出现过）
 * @returns 问题数组；不是该工具、或参数不可用时返回 `undefined`（区别于"空数组"）
 */
export function parseAskUserQuestions(
  name: unknown,
  rawArgs: unknown,
): AskUserQuestion[] | undefined {
  if (name !== ASK_USER_TOOL) return undefined;

  let args: unknown = rawArgs;
  if (typeof rawArgs === "string") {
    try {
      args = JSON.parse(rawArgs);
    } catch {
      return undefined;
    }
  }
  if (!args || typeof args !== "object") return undefined;

  const raw = (args as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return undefined;

  const out: AskUserQuestion[] = [];
  for (const candidate of raw) {
    const q = candidate as {
      id?: unknown;
      question?: unknown;
      header?: unknown;
      detail?: unknown;
      options?: unknown;
      multi_select?: unknown;
      multiSelect?: unknown;
    };
    if (!q || typeof q !== "object") continue;
    // `id` 与 `question` 是 schema 里的必填项；缺了就跳过（答案要靠 id 对应）
    if (typeof q.question !== "string" || !q.question.trim()) continue;
    const id =
      typeof q.id === "string" && q.id.trim()
        ? q.id.trim()
        : `q${out.length + 1}`;

    const options: AskUserOption[] = [];
    if (Array.isArray(q.options)) {
      for (const opt of q.options) {
        const o = opt as { label?: unknown; description?: unknown };
        if (!o || typeof o.label !== "string" || !o.label.trim()) continue;
        options.push({
          label: o.label.trim(),
          description:
            typeof o.description === "string" ? o.description : undefined,
        });
      }
    }

    out.push({
      id,
      question: q.question.trim(),
      header: typeof q.header === "string" ? q.header : undefined,
      detail: typeof q.detail === "string" ? q.detail : undefined,
      options,
      // dsh 用 snake_case；两种都容忍
      multiSelect: q.multi_select === true || q.multiSelect === true,
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * 把用户的选择拼成**送给模型的一段文本**。
 *
 * ## 为什么用可读文本而不是精确的协议 JSON
 *
 * dsh 的原生回答是 `{"answers":[{id, selected, custom}]}`，且 `continued` 状态下
 * README 明确说它"steers the reply into the agent as a `user-question-reply` message" ——
 * 也就是说**回答本来就是以 steer 的用户消息形态送达的**。
 *
 * 我们使用同一机制（`steer`，已实现），但文本做成"协议 JSON + 人类可读摘要"：
 *  - JSON 让模型能精确对应 `id`；
 *  - 摘要让人（以及万一不认 JSON 的模型）一眼看懂选了什么。
 *
 * 用户的要求是"只要会话不被选项卡死就行"，所以这里优先**确定性可用**，
 * 而不是去赌一个我无法用插件侧验证的私有 RPC。
 */
export function formatAnswersForSteer(
  questions: AskUserQuestion[],
  answers: Record<string, { selected: string[]; custom?: string }>,
): string {
  const payload = {
    answers: questions
      .filter((q) => answers[q.id] !== undefined)
      .map((q) => {
        const a = answers[q.id];
        const item: { id: string; selected: string[]; custom?: string } = {
          id: q.id,
          selected: a.selected ?? [],
        };
        if (a.custom && a.custom.trim()) item.custom = a.custom.trim();
        return item;
      }),
  };

  const readable = questions
    .filter((q) => answers[q.id] !== undefined)
    .map((q) => {
      const a = answers[q.id];
      const picked = [...(a.selected ?? [])];
      if (a.custom && a.custom.trim()) picked.push(a.custom.trim());
      return `- ${q.question} → ${picked.length ? picked.join("、") : "（未选）"}`;
    });

  return [
    "【对提问的回答】",
    ...readable,
    "",
    "（结构化数据，便于精确对应）",
    JSON.stringify(payload),
  ].join("\n");
}
