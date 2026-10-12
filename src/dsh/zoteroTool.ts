/**
 * Zotero 工具调用协议（文件式请求/应答）。
 *
 * ## 为什么是文件而不是真正的 RPC
 *
 * 架构事实（都已实测）：
 *  - Zotero API **只能在 Zotero 进程内**调用；dsh 是独立进程，够不到 `Zotero.Items`；
 *  - 早期判断是"沙箱白名单（`xpcom/plugins.js:141-156`）里没有 `Components`/`Cc`/`Ci`，
 *    所以插件做不了服务端"。
 *
 * ⚠️ **那个判断后来被本项目的深度探测推翻了**：沙箱里 `Cc`/`Ci`/`Components`
 * **都存在**，而且 `ChromeUtils.importESModule("Subprocess.sys.mjs")` 也可用
 * （见 `src/dsh/cookieProbe.ts` 与 `subprocessProbe.ts` 的实测输出）。
 *
 * **但结论没变**：仍然用文件式传输。理由是**简单与可审计** ——
 * 调用与结果都留在工作区里，用户能直接看懂 Agent 做了什么；
 * 而不是"被沙箱逼的"。写清这一点是为了避免后来者以为"当时没别的选择"，
 * 从而在错误的前提下做架构判断。
 *
 * 于是用**文件**当传输层，但**语义是真正的 tool 调用**：
 * 有请求 id、有返回值、有错误信息，模型可以迭代（读结果 → 修正 → 再调）。
 * 这对 dsh 很自然 —— 它本身有 shell，等一个文件出现即可。
 *
 * ## 目录与文件
 *
 * 全部在会话工作区内（模型唯一该碰的地方）：
 *
 * ```
 * <workspace>/zotero/call.json     模型写：{ id, op, args }
 * <workspace>/zotero/result.json   插件写：{ id, ok, data } 或 { id, ok: false, error }
 * ```
 *
 * （这里原有一行 `history.jsonl 插件追加：每次调用的摘要` —— **从未实现**，
 *  全仓库只有那行注释提到它。审计记录落在 `<数据目录>/dsh-for-zotero-panel.txt`。）
 *
 * ## 安全边界（用户选择"读+写自由，仅删除需确认"）
 *
 *  - **读**：直接执行（`getFullText` 按 key **可在整个文库内**查找）；
 *  - **写**（标签/笔记/加分类）：直接执行，但带 `undoAction` 进撤销栈，
 *    且**限定在该会话范围内**的条目（分类会话 = 该分类下的条目）；
 *  - **结构性改动**（新建条目 / 删除）：**不直接执行** —— 登记为待确认，
 *    由用户在插件里逐条点确认。
 *
 * 写操作的"会话范围"限制是"第二主人"与"失控"之间的界线。
 */

/** 读操作：直接执行 */
export const READ_OPS = [
  "search",
  "getItem",
  "listCollections",
  "listItems",
  "getNotes",
  // 按需读某篇的**原文**（Zotero 全文缓存）。
  // 此前工作区里只有"会话建立时"写入的 paper.txt，分类会话根本没有全文，
  // 于是 Agent 只能靠标题与摘要判断内容（真机反馈过这个限制）。
  "getFullText",
  // 在**外部数据库**里检索论文（Crossref / DOI），返回候选与 DOI。
  //
  // 为什么单独做成一个 op，而不是让 Agent 用 dsh 的 web_search：
  //  - web_search 走**模型服务端**的联网，看不见用户机构的订阅（授权基于 IP/代理）；
  //  - 它返回网页摘要，不是结构化元数据，拿去建条目要再解析；
  //  - 它够不到 Zotero，建不了条目、挂不了全文。
  // 详见 paperSearch.ts 顶部的说明。
  "findPaper",
] as const;

/** 写操作：直接执行 + 撤销栈 */
export const WRITE_OPS = ["setTags", "addNote", "addToCollection"] as const;

/**
 * 结构性改动：登记待确认，不直接执行。
 *
 * `createItem` 也在这里 —— 它不是删除，但**新建条目会永久改动文库结构**。
 * 用户要的是"读+写自由，仅删除需确认"；新建条目属于**结构性改动**，
 * 建错（重复条目、错误类型）比改错标签难清理得多，所以与删除同样处理：**登记待确认**。
 */
export const DESTRUCTIVE_OPS = [
  "deleteItems",
  "deleteNote",
  "createItem",
] as const;

export type ToolOp =
  | (typeof READ_OPS)[number]
  | (typeof WRITE_OPS)[number]
  | (typeof DESTRUCTIVE_OPS)[number];

const ALL_OPS: readonly string[] = [
  ...READ_OPS,
  ...WRITE_OPS,
  ...DESTRUCTIVE_OPS,
];

export function isKnownOp(op: string): op is ToolOp {
  return ALL_OPS.includes(op);
}

export function isDestructiveOp(op: ToolOp): boolean {
  return (DESTRUCTIVE_OPS as readonly string[]).includes(op);
}

export interface ToolCall {
  id: string;
  op: ToolOp;
  args: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  ok: boolean;
  /** 成功时的返回值（必须是可 JSON 序列化的） */
  data?: unknown;
  /** 失败原因；面向模型，应当**可操作**（告诉它怎么改） */
  error?: string;
  /** 删除类操作：不执行，只登记，等用户确认 */
  pending?: boolean;
}

export type ParseCallResult =
  | { ok: true; call: ToolCall }
  | { ok: false; error: string; id: string };

/**
 * 解析模型写下的调用文件。
 *
 * 宽松解析、**明确报错**：模型写出的 JSON 常有小毛病，
 * 错误信息要说清"哪里不对、该怎么写"，否则它会反复试同一个错误形状。
 */
export function parseToolCall(text: string): ParseCallResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      id: "",
      error:
        `call.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}。` +
        `请写入形如 {"id":"1","op":"search","args":{"query":"..."}} 的对象`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, id: "", error: "call.json 顶层必须是一个对象" };
  }
  const raw = parsed as { id?: unknown; op?: unknown; args?: unknown };
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : "";

  if (typeof raw.op !== "string" || !raw.op.trim()) {
    return { ok: false, id, error: "缺少 op 字段（字符串）" };
  }
  const op = raw.op.trim();
  if (!isKnownOp(op)) {
    return {
      ok: false,
      id,
      error:
        `未知操作 op="${op}"。可用操作：` +
        // ⚠️ 第三组不能叫「删」：它含 `createItem`（新建条目）。
        // 早先写成「删 …」时，报错会显示「删 deleteItems/deleteNote/createItem」——
        // 与 `describeOps` 里的「结构性改动」自相矛盾，真机上已经让 Agent 误读过。
        `读 ${READ_OPS.join("/")}；` +
        `写 ${WRITE_OPS.join("/")}；` +
        `结构性改动（需用户确认） ${DESTRUCTIVE_OPS.join("/")}`,
    };
  }
  let args: Record<string, unknown> = {};
  if (raw.args !== undefined) {
    if (!raw.args || typeof raw.args !== "object" || Array.isArray(raw.args)) {
      return { ok: false, id, error: "args 必须是对象（没有参数就省略它）" };
    }
    args = raw.args as Record<string, unknown>;
  }
  if (!id) {
    return {
      ok: false,
      id: "",
      error:
        '缺少 id 字段：请给每次调用一个唯一标识（如 "1"、"2"），结果里会带回它',
    };
  }
  return { ok: true, call: { id, op, args } };
}

/** 从参数里取字符串（缺省或类型不符时返回 undefined，而不是抛错） */
export function argString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 从参数里取字符串数组（同时容忍单个字符串） */
export function argStringArray(
  args: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = args[key];
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
}

/** 从参数里取正整数（容忍字符串形式的数字） */
export function argInt(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  if (typeof value === "number" && Number.isFinite(value))
    return Math.trunc(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim()))
    return Number(value.trim());
  return undefined;
}

/**
 * 生成给模型看的**操作说明**（写进工作区 README，也随错误信息返回）。
 *
 * 为什么单独一个函数：说明必须与实现同源，否则改了实现忘了改文档，
 * 模型就会按过时的说明调用（这个项目已经因为"文档与实现不一致"踩过坑）。
 */
export function describeOps(): string {
  return [
    "### 可用操作（写进 zotero/call.json）",
    "",
    '`{"id":"1","op":"<操作>","args":{…}}` —— 结果会写到 `zotero/result.json`。',
    "",
    "**读**（直接执行）：",
    "- `search` args `{query, limit?}` —— 按标题/作者/摘要关键词搜索" +
      "（限定本会话范围；`limit` 默认 20、最多 100）",
    "- `getItem` args `{key}` —— 条目的元数据与现有标签",
    "- `listItems` args `{}` —— 本会话范围内的条目清单（key + 标题 + 年份 + 现有标签）",
    "- `listCollections` args `{}` —— 文库里的分类树",
    "- `getNotes` args `{key}` —— 某条目下的笔记",
    "- `getFullText` args `{key, offset?, maxChars?}` —— **读该条目的论文原文**",
    "  - `maxChars` 默认 **12000**，硬性夹在 **[1000, 40000]** 之间；" +
      "传更大的值会被**截断**，不是报错 —— 需要更多内容请用 `offset` 往后接着读。",
    "  - 首次读某篇可能**稍慢**（缓存不存在时会先触发一次 Zotero 全文索引）。",
    "  - 扫描件可能没有文字层，此时会明确说明，而不是返回空。",
    "  - ⚠️ 这个操作**按 key 在整个文库内查找**（读允许跨库；写操作才限定在本会话范围）。",
    "- `findPaper` args `{doi?, title?, author?, year?, query?, limit?}` —— " +
      "**在外部数据库里检索论文**（Crossref），拿回标题/作者/年份/期刊/**DOI**/摘要",
    "  - **这是找论文该用的操作，不要用 web search**。原因：它走的是**用户本机的网络**，",
    "    因此能利用用户机构（大学图书馆）的订阅与代理；web search 走模型服务端，看不见这些。",
    "  - 已知 DOI 时**优先传 `doi`** —— 唯一、不用猜，也不会返回一堆同名文章。",
    "  - 只有标题片段时传 `title`（比 `query` 准）；`query` 是最宽的兜底。",
    "  - `year` 用于收窄（同名文章很多时很有用）。`limit` 默认 10、最多 50。",
    "  - 返回值里每条都带 `DOI`；**下一步就是拿这个 DOI 去 `createItem`**（见下）。",
    "",
    "**写**（直接执行，进入 Zotero 撤销栈）：",
    "- `setTags` args `{key, tags:[…]}` —— 覆盖该条目的标签（`_` 开头的系统标签保留）",
    "- `addNote` args `{key, html}` —— 给条目加一条子笔记",
    "  - ⚠️ 正文**按纯文本处理**：HTML 标签会被**转义成字面量**（传 `<b>要点</b>`" +
      " 笔记里就显示 `<b>要点</b>`）。换行会保留。想强调就用 Markdown 记号或纯文字。",
    "- `addToCollection` args `{key, collectionKey}` —— 把条目加入分类",
    "",
    "**结构性改动**（不会立即执行，需用户确认）：",
    "- `createItem` args `{itemType?, fields:{…}, creators?, collectionKey?, tags?, fetchPdf?, pdfUrl?}` —— **新建条目**",
    "  - **`itemType` 可省略**（默认 `journalArticle`）。给的时候必须用英文标识符，不要写中文：",
    "    `journalArticle`（期刊文章）、`conferencePaper`（会议论文）、`book`（图书）、",
    "    `bookSection`（章节）、`report`（报告）、`thesis`（学位论文）、`preprint`（预印本）、",
    "    `webpage`（网页）、`document`（文档）、`manuscript`（手稿）",
    "    ⚠️ 失败过：传中文「网页」会被拒（白名单只认英文）。",
    "  - `fields` 只接受这些键：`title`（必填）、`abstractNote`、`date`、`publicationTitle`、",
    "    `proceedingsTitle`、`bookTitle`、`publisher`、`place`、`volume`、`issue`、`pages`、",
    "    `DOI`、`ISBN`、`ISSN`、`url`、`language`、`extra`、`university`、`institution`、`reportNumber`",
    "    - 值必须是**非空字符串**；空串、纯空白或非字符串会被**当作没给**（并在返回值里列出）。",
    "    - ⚠️ **`findPaper` 查到的 `DOI` 一定要填进 `fields.DOI`** —— 取全文靠它。",
    "  - `creators` 每项**必须有 `lastName`**（非空），否则该位作者会被**静默跳过**。",
    "  - **`fetchPdf`（默认 `true`）**：用户确认后，插件会**用用户本机的网络与机构登录**",
    "    去取全文 PDF 并挂成附件。不需要全文时传 `false`。",
    "  - `pdfUrl` 可选：明确指定要下载的 PDF 直链（`findPaper` 结果里的「开放获取 PDF」）。",
    "    不给时插件会让 Zotero 自己按 DOI / url / 开放获取去找。",
    "  - ⚠️ **取全文可能要几十秒**（跟随 DOI 跳转、机构代理认证）。这是正常的，",
    "    用户确认后请告诉他在等下载，不要因为「没立刻看到附件」就重复提交。",
    "  - 完整示例：",
    "    ```json",
    '    { "id": "7", "op": "createItem", "args": {',
    '        "itemType": "journalArticle",',
    '        "fields": { "title": "…", "DOI": "10.1145/…", "date": "2023",',
    '                    "publicationTitle": "…" },',
    '        "creators": [{ "firstName": "A", "lastName": "B" }],',
    '        "collectionKey": "VZVXRZ6D", "fetchPdf": true } }',
    "    ```",
    "- `deleteItems` args `{keys:[…]}`（也接受单个 `{key}`）—— 登记为待确认",
    "- `deleteNote` args `{key}` —— 同上",
    "",
    "这几类操作的结果里 `pending: true`，表示「已登记、等用户确认」，不是失败。",
    "",
    "## 关于 `id` 的两条纪律",
    "",
    "1. **每次调用都请用一个没被用过的 id**（例如自增数字，或 `时间戳-序号`）。",
    "2. ⚠️ **不要以为「用过的 id 一定不会再被执行」**：插件**只记住最近一次**执行过的 id，",
    "   而且这个记忆**在 Zotero 重启后会清空**。所以复用 id（尤其 `1`、`2` 这类短 id）",
    "   有可能被**重复执行** —— 对写操作尤其要小心。",
    "",
    "⚠️ **不要为同一件事反复提交**：重复提交会让用户在确认区看到多条相同的待确认项。",
    "提交一次后，请告诉用户「会话页顶部黄色角标处有待确认项」，然后继续其它工作。",
  ].join("\n");
}
