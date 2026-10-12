/**
 * 论文检索与全文获取（**不走 dsh 的 web search**）。
 *
 * # 为什么要自建，而不是用 dsh 的 `web_search`
 *
 * dsh 的 `web_search` 走的是**模型服务端的联网能力**：
 *
 *  - 它看不见用户所在机构（大学图书馆）的订阅 —— 那是**基于来源 IP 或机构代理**
 *    的授权，服务端的检索请求不带这些身份；
 *  - 它返回的是**网页摘要**，不是结构化元数据，拿去建条目要再解析一遍；
 *  - 它无论如何都拿不到 `Zotero.Items`，**建不了条目、挂不了附件**。
 *
 * 而论文这件事上，Zotero 本身就有多年积累的能力，且**在用户的网络环境里**：
 *
 * | 需求 | 走谁 |
 * | --- | --- |
 * | 检索元数据（DOI / 标题 / 作者） | Zotero 的**检索型翻译器**（Crossref REST）或 DOI Content Negotiation |
 * | 走机构订阅 | `Zotero.Proxies.properToProxy()` —— 用**用户自己配的图书馆代理** |
 * | 下载 PDF | `Zotero.HTTP.request`（带用户的 cookie 罐，机构登录态就在里面） |
 * | 挂到条目 | `Zotero.Attachments.addAvailableFile()` |
 *
 * 所以这一层的定位是：**让 Agent 用上用户已经有的访问权限**，
 * 而不是替它去公网抓网页。
 *
 * # 文件分工
 *
 *  - 本文件是**纯逻辑**（检索式构造、响应解析、候选排序、URL 判定），
 *    不碰 Zotero API —— 可单测，且不依赖真实网络；
 *  - 真正发请求、建条目、下附件在 `sessionPane.ts`（工具执行处）与
 *    `paperFetch.ts`（Zotero 侧 I/O）。
 *
 * 这条分工与项目其它模块一致：**能纯逻辑化的都纯逻辑化**，
 * 否则"检索结果解析对不对"这种事只能靠真机试。
 */

// ── DOI ────────────────────────────────────────────────────────

/**
 * 规整 DOI。
 *
 * 模型与用户给出的 DOI 有各种写法，全都见过：
 *
 * ```text
 *   10.1145/3290605.3300233
 *   doi:10.1145/3290605.3300233
 *   https://doi.org/10.1145/3290605.3300233
 *   http://dx.doi.org/10.1145/3290605.3300233
 *   DOI: 10.1145/3290605.3300233.
 * ```
 *
 * 直接拿去做 Content Negotiation 会 404，而 404 看起来像"这篇不存在"。
 * 所以先剥掉前缀、URL 外壳与句末标点。
 */
export function normalizeDoi(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let value = raw.trim();
  // 去掉 URL 外壳
  value = value.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  // 去掉 doi: 前缀（大小写与空格都容忍）
  value = value.replace(/^doi\s*:\s*/i, "");
  // 去掉句末标点（中文句号也去掉：模型常在句子里带出来）
  value = value.replace(/[.,;。，；]+$/, "");
  value = value.trim();
  return value || undefined;
}

/**
 * DOI 形状校验。
 *
 * 规则来自 DOI 手册：`10.` + 4 位以上注册机构号 + `/` + 后缀。
 * 这里**只做形状判断**，不联网核实 —— 形状不对时提前报错，
 * 比发一个注定 404 的请求更省事，报错也更可读。
 */
export function looksLikeDoi(value: string): boolean {
  return /^10\.\d{4,9}\/\S+$/.test(value.trim());
}

/** DOI → 可点击的解析地址（给 Agent 与条目 `url` 字段用） */
export function doiUrl(doi: string): string {
  return `https://doi.org/${doi}`;
}

// ── 检索式 ─────────────────────────────────────────────────────

/** 一次检索的输入 */
export interface PaperQuery {
  /** 自由文本（标题 / 作者 / 关键词都会拼进 query.bibliographic） */
  query?: string;
  title?: string;
  author?: string;
  year?: number;
  doi?: string;
  /** 返回条数上限 */
  limit?: number;
}

/** Crossref REST 的查询参数（与 `Zotero.Translate.Search` 的 `search` 对象同形） */
export interface CrossrefSearchFields {
  "query.bibliographic"?: string;
  "query.title"?: string;
  "query.author"?: string;
  "query.container-title"?: string;
  /** `from-pub-date` / `until-pub-date` 的简写：Crossref 支持 `filter=from-pub-date:YYYY-01-01` */
  filter?: string;
  rows?: number;
  /** 按相关度排序（默认就是 relevance，写出来是为了自文档） */
  sort?: string;
  select?: string;
}

/**
 * 把用户/模型的输入拼成 Crossref 检索字段。
 *
 * ## 为什么分开拼而不是一律塞进一个 `query`
 *
 * Crossref 的字段限定查询（`query.title` / `query.author`）**比自由文本准得多**：
 * 用 `query.bibliographic` 查一个含作者姓的标题时，会把"引用了该作者的其它文章"
 * 排到前面。所以能分开就分开。
 *
 * `query.bibliographic` 只在既没有 title 也没有 author 时才用作兜底 ——
 * 它是 Crossref 里最宽的那个字段。
 */
export function buildCrossrefSearch(query: PaperQuery): CrossrefSearchFields {
  const fields: CrossrefSearchFields = {};
  const title = query.title?.trim();
  const author = query.author?.trim();
  const free = query.query?.trim();

  if (title) fields["query.title"] = title;
  if (author) fields["query.author"] = author;
  if (!title && !author && free) fields["query.bibliographic"] = free;
  // 标题 + 自由文本同时给时，自由文本往往含会议名/关键词，用 bibliographic 兜住
  if (title && free) fields["query.bibliographic"] = free;

  if (query.year) {
    // Crossref 的 filter 用日期区间；取整年
    fields.filter = `from-pub-date:${query.year}-01-01,until-pub-date:${query.year}-12-31`;
  }
  const limit = query.limit;
  fields.rows = Math.min(Math.max(limit ?? 10, 1), 50);
  fields.sort = "relevance";
  return fields;
}

/** 至少要有一样可以用来检索的东西 */
export function validatePaperQuery(query: PaperQuery): string | undefined {
  const hasAny =
    Boolean(query.doi?.trim()) ||
    Boolean(query.title?.trim()) ||
    Boolean(query.author?.trim()) ||
    Boolean(query.query?.trim());
  if (!hasAny) {
    return (
      "需要至少一个检索条件：doi / title / author / query 之一。" +
      "已知 DOI 时**优先用 doi** —— 它唯一且不用猜。"
    );
  }
  if (query.year !== undefined) {
    if (
      !Number.isInteger(query.year) ||
      query.year < 1600 ||
      query.year > 2200
    ) {
      return `year 看起来不是年份：${query.year}`;
    }
  }
  return undefined;
}

// ── 检索结果 ───────────────────────────────────────────────────

/** 一条检索候选（**给模型看**的字段，故意精简） */
export interface PaperCandidate {
  title: string;
  authors?: string[];
  year?: number;
  /** 期刊 / 会议名 */
  venue?: string;
  doi?: string;
  url?: string;
  abstract?: string;
  /**
   * 可下载的 PDF 直链（若已探明）。
   *
   * ⚠️ 拿到它**不等于**能下：可能是付费墙，或需要机构登录。
   * 下载环节会用用户自己的网络与 cookie 再试一次。
   */
  pdfUrl?: string;
  /** 来源标记，便于模型判断可信度 */
  source?: string;
}

/** Crossref 单条记录里我们会用到的字段（其余忽略） */
interface CrossrefItem {
  DOI?: unknown;
  title?: unknown;
  author?: unknown;
  issued?: unknown;
  "published-print"?: unknown;
  "published-online"?: unknown;
  "container-title"?: unknown;
  URL?: unknown;
  abstract?: unknown;
  type?: unknown;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value)) {
    for (const v of value) {
      const s = firstString(v);
      if (s) return s;
    }
  }
  return undefined;
}

/** Crossref 的日期字段形如 `{ "date-parts": [[2023, 5, 1]] }` */
function yearFromDateParts(value: unknown): number | undefined {
  const parts = (value as { "date-parts"?: unknown })?.["date-parts"];
  if (!Array.isArray(parts) || !Array.isArray(parts[0])) return undefined;
  const year = Number((parts[0] as unknown[])[0]);
  return Number.isInteger(year) && year > 1000 ? year : undefined;
}

/** Crossref 的作者形如 `{ given, family, name }`；有的机构作者只有 `name` */
function authorsFromCrossref(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const raw of value) {
    const a = raw as { given?: unknown; family?: unknown; name?: unknown };
    const family = typeof a?.family === "string" ? a.family.trim() : "";
    const given = typeof a?.given === "string" ? a.given.trim() : "";
    const name = typeof a?.name === "string" ? a.name.trim() : "";
    const full = [given, family].filter(Boolean).join(" ") || name;
    if (full) out.push(full);
  }
  return out.length ? out : undefined;
}

/**
 * 剥掉 JATS 标签（Crossref 的摘要是 JATS XML 片段）。
 *
 * ## ⚠️ 为什么标签替换成**空串**而不是空格
 *
 * 早期写成 `.replace(/<[^>]+>/g, " ")`，于是
 * `<jats:p>We study <jats:italic>X</jats:italic>.</jats:p>` 变成
 * `We study X .` —— 多出一个**空格在句号前面**。看着只是小瑕疵，
 * 但它会**真的进到条目的 `abstractNote` 里**（用户复制摘要时会带出去），
 * 而且单靠肉眼很难发现。
 *
 * 换成空串后会有另一个问题：`</jats:p><jats:p>` 这类相邻块会被**粘在一起**
 * （`…end.Start…`）。所以最后再补一条规则：**块级标签**（段落、换行、列表项）
 * 替换成一个空格，行内标签（italic/bold/sub/sup 等）替换成空串。
 *
 * 顺序很重要：先处理块级（给空格），再处理剩余的（给空串）。
 */
export function stripJats(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const text = html
    // ① 块级标签 → 空格（避免相邻段落粘连）
    .replace(
      /<\/?(jats:)?(p|br|sec|title|list|list-item|disp-quote)\b[^>]*>/gi,
      " ",
    )
    // ② 其余标签（行内）→ 空串（避免句号前多出空格）
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text || undefined;
}

/**
 * 把 Crossref 的 `message.items` 转成候选列表。
 *
 * ## 为什么把 `score` 也读出来
 *
 * Crossref 会返回相关度分数。模型拿到一串候选后要判断"哪条是我要的"，
 * 而**第一条未必对**（同名论文、预印本与正式版并存）。把分数一并给出，
 * 它就有依据比较，而不是盲选第一条。
 */
export function parseCrossrefItems(
  payload: unknown,
): Array<PaperCandidate & { score?: number }> {
  const items = (payload as { message?: { items?: unknown } })?.message?.items;
  if (!Array.isArray(items)) return [];
  const out: Array<PaperCandidate & { score?: number }> = [];
  for (const raw of items) {
    const item = raw as CrossrefItem;
    const title = firstString(item.title);
    if (!title) continue; // 没有标题的条目对建条目没用
    const score = Number((raw as { score?: unknown }).score);
    out.push({
      title,
      authors: authorsFromCrossref(item.author),
      year:
        yearFromDateParts(item.issued) ??
        yearFromDateParts(item["published-print"]) ??
        yearFromDateParts(item["published-online"]),
      venue: firstString(item["container-title"]),
      doi: normalizeDoi(firstString(item.DOI)),
      url: firstString(item.URL),
      abstract: stripJats(firstString(item.abstract)),
      source: "crossref",
      ...(Number.isFinite(score) ? { score } : {}),
    });
  }
  return out;
}

// ── 开放获取 PDF ───────────────────────────────────────────────

/**
 * 从 OpenAlex 的响应里挑出最好的 PDF 直链。
 *
 * ## 为什么用 OpenAlex 而不是 Unpaywall
 *
 * Unpaywall **必须带一个邮箱**（`?email=`），否则拒绝服务 —— 插件里没有
 * 合适的、属于用户的邮箱可用，而我们**不该编一个**。
 * OpenAlex 的同一份数据不需要，且它的 `best_oa_location` 已经替我们挑好了。
 *
 * 顺序：`best_oa_location` → `primary_location` → 其它 `locations`。
 * 只在 `pdf_url` 上取，`landing_page_url` 是网页不是 PDF，对它下载会得到 HTML。
 */
export function pickOpenAccessPdf(payload: unknown): string | undefined {
  const root = payload as {
    best_oa_location?: { pdf_url?: unknown };
    primary_location?: { pdf_url?: unknown };
    locations?: Array<{ pdf_url?: unknown }>;
    open_access?: { oa_url?: unknown };
  };
  const tries: unknown[] = [
    root?.best_oa_location?.pdf_url,
    root?.primary_location?.pdf_url,
    ...(Array.isArray(root?.locations)
      ? root.locations.map((l) => l?.pdf_url)
      : []),
    root?.open_access?.oa_url,
  ];
  for (const candidate of tries) {
    const url = typeof candidate === "string" ? candidate.trim() : "";
    if (url && isPlausiblePdfUrl(url)) return url;
  }
  return undefined;
}

/**
 * 判断一个 URL 像不像"能直接下到 PDF"。
 *
 * ⚠️ 这条判据是**保守**的：宁可漏掉一个真 PDF，也不要把一个网页当 PDF 下下来 ——
 * 后者会被当成附件挂进条目，而用户看到的是一堆"下载到 HTML 的附件"，
 * 比"这次没拿到全文"难清理得多。
 */
export function isPlausiblePdfUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const path = parsed.pathname.toLowerCase();
  if (path.endsWith(".pdf")) return true;
  // 有些仓库用查询参数给文件（如 `?format=pdf`、`/download?type=pdf`）
  const query = parsed.search.toLowerCase();
  if (
    /\b(pdf|download|fulltext|full-text)\b/.test(query) &&
    /pdf/.test(query)
  ) {
    return true;
  }
  // 常见的 PDF 端点（arXiv / PMC / 出版社的 pdf 路径）
  if (/\/(pdf|epdf|article-pdf|download\/pdf)(\/|$)/.test(path)) return true;
  return false;
}

/**
 * 判断一个 URL 是否是"需要机构访问"的（用于给模型一句提示）。
 *
 * 这不是拦截，只是**在结果里说明情况**：模型据此知道"下不到不一定是坏了"，
 * 从而不去反复重试同一个付费墙链接。
 */
export function looksPaywalled(url: string): boolean {
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();
  if (!host) return false;
  // 出版社主域（需要订阅或单篇购买）
  const publishers = [
    "sciencedirect.com",
    "link.springer.com",
    "onlinelibrary.wiley.com",
    "tandfonline.com",
    "ieeexplore.ieee.org",
    "dl.acm.org",
    "pubs.acs.org",
    "journals.aps.org",
    "academic.oup.com",
    "cambridge.org",
    "jstor.org",
    "nature.com",
    "science.org",
    "cell.com",
    "sagepub.com",
    "iopscience.iop.org",
    "aps.org",
    "emerald.com",
    "wolterskluwer.com",
  ];
  return publishers.some((p) => host === p || host.endsWith("." + p));
}

// ── 结果排序与呈现 ─────────────────────────────────────────────

/**
 * 按"最可能是用户要的那篇"排序。
 *
 * 规则（从强到弱）：
 *  1. DOI 完全命中 —— 没有比这更确定的；
 *  2. 有 DOI 的优先于没 DOI 的（没 DOI 的常常是预印本或会议摘要）；
 *  3. 标题与查询标题的**词重合度**高的优先；
 *  4. 年份越接近查询年份越优先（用户给年份时）；
 *  5. Crossref 分数高的优先。
 *
 * 之所以要排：Crossref 对"标题 + 作者"的查询经常把综述或引用它的文章排前面，
 * 而模型倾向于拿第一条去建条目 —— 建错条目比建不出来更难处理。
 */
export function rankCandidates(
  candidates: PaperCandidate[],
  query: PaperQuery,
): PaperCandidate[] {
  const wantDoi = normalizeDoi(query.doi);
  const wantTitle = query.title?.trim().toLowerCase();
  const wantYear = query.year;
  const wantWords = wantTitle
    ? new Set(
        wantTitle
          .split(/[^\p{L}\p{N}]+/u)
          .map((w) => w.trim())
          .filter((w) => w.length > 1),
      )
    : undefined;

  const score = (c: PaperCandidate): number => {
    let s = 0;
    if (wantDoi && c.doi?.toLowerCase() === wantDoi.toLowerCase()) s += 1000;
    if (c.doi) s += 50;
    if (wantWords && c.title) {
      const words = new Set(
        c.title
          .toLowerCase()
          .split(/[^\p{L}\p{N}]+/u)
          .map((w) => w.trim())
          .filter(Boolean),
      );
      let hit = 0;
      for (const w of wantWords) if (words.has(w)) hit++;
      s += wantWords.size ? (hit / wantWords.size) * 200 : 0;
    }
    if (wantYear && c.year) {
      const gap = Math.abs(c.year - wantYear);
      s += gap === 0 ? 60 : gap === 1 ? 30 : Math.max(0, 20 - gap * 5);
    }
    const raw = (c as PaperCandidate & { score?: number }).score;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      // Crossref 分数没有固定量纲，压到 0..40 之间当微弱加权
      s += Math.min(40, Math.max(0, raw) * 2);
    }
    if (c.abstract) s += 5; // 有摘要的更完整
    return s;
  };

  return [...candidates].sort((a, b) => score(b) - score(a));
}

/**
 * 生成**给模型看**的检索结果文本。
 *
 * ## 为什么不直接返回 JSON
 *
 * 模型读紧凑文本比读大 JSON 更省 token，而这里每条候选的字段很少。
 * 但**关键字段一个都不能省**：`doi` 是下一步要用的东西（检索 → 建条目靠它串起来），
 * 少了它模型就会自己去猜，或者去 web search。
 */
export function formatCandidates(
  candidates: PaperCandidate[],
  options: { max?: number; note?: string } = {},
): string {
  const max = options.max ?? 10;
  if (candidates.length === 0) {
    return (
      "没有检索到匹配的论文。\n" +
      "可以试着：换更完整的标题片段、只给作者姓、去掉年份限制，" +
      "或者先只在**本机文库**里搜（工具 op `search`）看是否已经收录。"
    );
  }
  const lines: string[] = [];
  const shown = candidates.slice(0, max);
  shown.forEach((c, i) => {
    const bits: string[] = [];
    if (c.authors?.length) {
      const a = c.authors;
      bits.push(a.length > 3 ? `${a[0]} 等 ${a.length} 位` : a.join(", "));
    }
    if (c.year) bits.push(String(c.year));
    if (c.venue) bits.push(c.venue);
    lines.push(`${i + 1}. ${c.title}`);
    lines.push(`   ${bits.join(" · ")}`);
    if (c.doi) lines.push(`   DOI: ${c.doi}`);
    if (c.url) lines.push(`   URL: ${c.url}`);
    if (c.pdfUrl) {
      lines.push(
        `   开放获取 PDF: ${c.pdfUrl}` +
          (looksPaywalled(c.pdfUrl) ? "（可能仍需机构访问）" : ""),
      );
    }
    if (c.abstract) {
      lines.push(
        `   摘要: ${c.abstract.slice(0, 300)}${c.abstract.length > 300 ? "…" : ""}`,
      );
    }
  });
  if (candidates.length > shown.length) {
    lines.push(`…另有 ${candidates.length - shown.length} 条未显示`);
  }
  if (options.note) lines.push("", options.note);
  return lines.join("\n");
}

/**
 * 给 Agent 的**下一步指引**（附在检索结果后面）。
 *
 * 为什么必须写这段：检索与建条目是两个 op，中间要人工（或模型）把 DOI 传过去。
 * 不写清这一点，模型很可能拿检索到的**标题**去 web search 找全文 ——
 * 那正是我们要它别做的事。
 */
export const PAPER_NEXT_STEP_HINT =
  "下一步：把你要的那条的 DOI（或 pdfUrl）传给 `createItem` 的 `pdfUrl` 参数，" +
  "插件会**用你本机的网络与机构登录**去取全文并作为附件挂到新条目上。" +
  "不要用 web search 去找 PDF —— 它拿不到你机构的订阅。";
