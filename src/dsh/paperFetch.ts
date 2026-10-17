/**
 * 论文获取的 **Zotero 侧** I/O：检索元数据、解析开放获取、把全文挂成附件。
 *
 * # 与 `paperSearch.ts` 的分工
 *
 * 那边是纯逻辑（构造检索式、解析响应、排序、判定 URL），这边只做三件事：
 * **发请求、调 Zotero 的解析器、写附件**。分开是为了让"解析对不对"能单测，
 * 而那三件事只能真机验证 —— 混在一起会让单测覆盖不到任何东西。
 *
 * # 最关键的复用：不要自己写"找 PDF"
 *
 * `Zotero.Attachments.addAvailableFile(item)` 内部已经是一条完整的解析链
 * （`attachments.js` 的 `getFileResolvers`）：
 *
 * | 方法 | 做什么 |
 * | --- | --- |
 * | `doi` | 跟随条目的 DOI 到出版社页面（**用用户本机的网络与机构代理**） |
 * | `url` | 条目里的 `url` 字段 |
 * | `oa` | `Zotero.Utilities.Internal.getOpenAccessPDFURLs` |
 * | `custom` | 用户在 Zotero 里配的**自定义解析器**（很多学校有专门的规则） |
 *
 * 这就是"用户提供的本机联网环境（如大学图书馆）"的落点 ——
 * 它用的是 Zotero 自己那套已经为机构访问调优过的东西，
 * 而不是我们猜的一串直链。所以**优先用它**，只用 HTTP 兜底。
 *
 * # 为什么需要兜底
 *
 * `addAvailableFile` 的 `url` / `doi` 两条路会开 **HiddenBrowser**（隐藏浏览器）
 * 去跟随跳转，那在插件沙箱里未必可用，而且遇到验证码会卡住。
 * 所以：先试它（它最懂怎么找全文），失败或超时再走 `Zotero.HTTP.request` 直链。
 */

import { appendPanelLog } from "./runLog";
import {
  buildCrossrefSearch,
  DATACITE_API,
  itemTypeFromDataCite,
  looksLikeDoi,
  normalizeDoi,
  parseDataCite,
  pickOpenAccessPdf,
  type PaperCandidate,
  type PaperQuery,
  parseCrossrefItems,
} from "./paperSearch";

/** 检索用的 Crossref 接口（公开、无需 key；Zotero 的检索型翻译器走的也是它） */
const CROSSREF_API = "https://api.crossref.org/works";

/** 开放获取查询（OpenAlex：不需要邮箱，Unpaywall 需要，见 paperSearch.ts 的说明） */
const OPENALEX_API = "https://api.openalex.org/works/doi:";

/** 单次网络请求超时 */
const REQUEST_TIMEOUT_MS = 20000;

/**
 * Zotero **全文解析器**（`addAvailableFile`）的超时。
 *
 * ## ⚠️ 为什么必须有（真机事故：整批确认卡死 7 分钟）
 *
 * `addAvailableFile` 是 Zotero 自己的"帮我找 PDF"入口，对**需要机构登录**的
 * 出版商（Elsevier / Wiley / Springer）它会：
 *
 *  - 打开**隐藏浏览器**去走机构的登录/代理流程；
 *  - 等一个可能永远不来的跳转。
 *
 * 实测：28 条批量确认，第 7 条（DOI `10.1016/j.aiopen.2022.10.001`）在
 * 「开始取全文」之后**再也没有下文**，日志停在那里 6 分 13 秒，
 * 而界面显示「正在全部确认…（6/28）」—— **剩下 21 条全被这一条堵住**。
 *
 * 界面上看不出任何原因，因为这不是"失败"，是**没有返回**。
 * 而批量确认是**串行**的：一条挂住，后面全部停摆。
 *
 * ## 为什么是"超时后继续"而不是"重试"
 *
 * 拿不到全文是**常态**（没有开放获取版、机构未订阅），不是错误。
 * 超时后应当**照常建条目**（条目已经建好了，只是没挂上 PDF），
 * 然后继续下一条 —— 用户的目的是"这批文献进库"，不是"必须先有 PDF"。
 */
const FULLTEXT_RESOLVER_TIMEOUT_MS = 45000;

/**
 * 给 Promise 加超时；超时返回 `undefined`（**不抛**）。
 *
 * ⚠️ 底层操作**无法取消** —— `addAvailableFile` 没有取消入口。
 * 所以超时后我们只是"不再等它"，它若稍后真的成功，附件仍会落盘（那是意外之喜）；
 * 但它若稍后抛错，不能让那个 rejection 变成未处理异常。
 * 这就是 `.catch()` 存在的原因，不是多余的防御。
 */
export async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      appendPanelLog(
        "session",
        `${label} 超时（${Math.round(ms / 1000)} 秒），不再等待，继续下一步`,
      );
      resolve(undefined);
    }, ms);
  });
  // 超时后底层仍可能 reject —— 吞掉，避免未处理 rejection 打断后续流程
  void work.catch(() => undefined);
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 给 Crossref 一个可识别的 UA（公开 API 的礼貌要求，也便于对方限流时区分） */
const USER_AGENT =
  "DSH-for-Zotero (Zotero plugin; mailto:noreply@example.invalid)";

/** Zotero 里够得到的 HTTP 客户端（带全局 cookie，机构登录态就在其中） */
type ZoteroHttpResponse = { status: number; responseText: string };

interface ZoteroHttp {
  request(
    method: string,
    url: string,
    options?: Record<string, unknown>,
  ): Promise<ZoteroHttpResponse>;
}

function http(): ZoteroHttp | undefined {
  const z = Zotero as unknown as { HTTP?: ZoteroHttp };
  return typeof z.HTTP?.request === "function" ? z.HTTP : undefined;
}

/** 发一个 GET 并取回文本；非 2xx 时抛出**可读**的错误 */
async function getText(
  url: string,
  options: { timeout?: number; anon?: boolean } = {},
): Promise<string> {
  const client = http();
  if (!client) throw new Error("Zotero.HTTP 不可用，无法发起网络请求");
  const response = await client.request("GET", url, {
    timeout: options.timeout ?? REQUEST_TIMEOUT_MS,
    // ⚠️ 默认**带**全局 cookie：机构登录态就是靠它。
    // 只有明确要匿名时才传 anon（否则会拿不到订阅内容）。
    anon: options.anon ?? false,
    headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
    // 让 404 之类的错误走 reject，便于统一处理
    successCodes: false,
  });
  const status = response?.status ?? 0;
  if (status < 200 || status >= 300) {
    throw new Error(`HTTP ${status}`);
  }
  return response?.responseText ?? "";
}

/**
 * 一次检索：给定 DOI / 标题 / 作者，返回候选列表。
 *
 * ## 有 DOI 就直接查那一条
 *
 * DOI 唯一，用它查 Crossref 的 `/works/{doi}` 比检索更准也更快，
 * 且**不会**返回一堆同名文章让模型挑错。
 */
export async function searchPapers(
  query: PaperQuery,
): Promise<PaperCandidate[]> {
  const doi = normalizeDoi(query.doi);
  if (doi && looksLikeDoi(doi)) {
    const one = await fetchByDoi(doi);
    return one ? [one] : [];
  }

  const fields = buildCrossrefSearch(query);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === "") continue;
    params.set(key, String(value));
  }
  const url = `${CROSSREF_API}?${params.toString()}`;
  appendPanelLog("session", `论文检索：${url}`);
  const text = await getText(url);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("Crossref 返回的不是 JSON（可能被网络中间层改写了响应）");
  }
  return parseCrossrefItems(payload);
}

/**
 * 按 DOI 取单条元数据：**先 Crossref，查不到再 DataCite**。
 *
 * ## ⚠️ 为什么必须两个源都试（真机教训）
 *
 * 用户实测查 arXiv 的经典 DOI `10.48550/arXiv.1706.03762` 时**查不到** ——
 * 因为 arXiv 的 DOI 注册在 **DataCite**，不在 Crossref。
 *
 * 而"查不到"的后果比看起来严重：模型不会就此停下，它会**从命中的近似结果里
 * 挑一条**继续（真机上挑了一条 2025 年由某机构重复登记的同一篇论文），
 * 于是条目里的 **DOI 与年份都是错的**，而标题作者看起来完全正常。
 * 错元数据一旦进库，用户很难发现。
 *
 * Crossref 优先的理由：期刊论文的**正式版**记录在那里，质量更高。
 */
export async function fetchByDoi(
  doi: string,
): Promise<PaperCandidate | undefined> {
  const fromCrossref = await fetchDoiFromCrossref(doi);
  if (fromCrossref) return fromCrossref;
  appendPanelLog("session", `Crossref 没有这个 DOI，改试 DataCite：${doi}`);
  return fetchDoiFromDataCite(doi);
}

/** Crossref 的 `/works/{doi}` */
async function fetchDoiFromCrossref(
  doi: string,
): Promise<PaperCandidate | undefined> {
  const url = `${CROSSREF_API}/${encodeURIComponent(doi)}`;
  appendPanelLog("session", `按 DOI 取元数据（Crossref）：${url}`);
  try {
    const text = await getText(url);
    const parsed = parseCrossrefItems({
      message: {
        items: [(JSON.parse(text) as { message?: unknown })?.message],
      },
    });
    return parsed[0];
  } catch (error) {
    appendPanelLog(
      "session",
      `Crossref 取元数据失败（${doi}）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

/**
 * DataCite 的 `/dois/{doi}`（arXiv / Zenodo / 机构库的 DOI 在这里）。
 *
 * 顺便把 DataCite 的**资源类型**映射成 Zotero 条目类型一并带回 ——
 * 它明确给了 `resourceTypeGeneral`，我们不必猜，也就能把 arXiv 预印本
 * 正确建成 `preprint` 而不是默认的 `journalArticle`。
 */
async function fetchDoiFromDataCite(
  doi: string,
): Promise<PaperCandidate | undefined> {
  const url = `${DATACITE_API}${encodeURIComponent(doi)}`;
  appendPanelLog("session", `按 DOI 取元数据（DataCite）：${url}`);
  try {
    const text = await getText(url);
    const payload: unknown = JSON.parse(text);
    const candidate = parseDataCite(payload);
    if (!candidate) return undefined;
    const itemType = itemTypeFromDataCite(payload);
    return itemType ? { ...candidate, itemType } : candidate;
  } catch (error) {
    appendPanelLog(
      "session",
      `DataCite 取元数据失败（${doi}）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

/** 查开放获取 PDF 直链（拿不到就返回 undefined，不是错误） */
export async function findOpenAccessPdf(
  doi: string,
): Promise<string | undefined> {
  const clean = normalizeDoi(doi);
  if (!clean) return undefined;
  try {
    const text = await getText(`${OPENALEX_API}${encodeURIComponent(clean)}`);
    return pickOpenAccessPdf(JSON.parse(text));
  } catch (error) {
    // 开放获取查不到是常态（很多论文就没有 OA 版），所以只记日志不抛
    appendPanelLog(
      "session",
      `开放获取查询无结果（${clean}）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

// ── 把全文挂成附件 ─────────────────────────────────────────────

/** 挂附件的结果（面向模型与用户，都要可读） */
export interface AttachOutcome {
  ok: boolean;
  /** 成功时的附件条目 key */
  attachmentKey?: string;
  /** 用的是哪条路（便于排查"为什么这次没拿到"） */
  via?: string;
  detail: string;
}

/** `Zotero.Attachments` 里我们用到的方法 */
interface ZoteroAttachments {
  addAvailableFile?: (
    item: unknown,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
}

function attachments(): ZoteroAttachments | undefined {
  const z = Zotero as unknown as { Attachments?: ZoteroAttachments };
  return z.Attachments;
}

/**
 * 为一个条目**尽力**取回全文 PDF 并挂成附件。
 *
 * ## 顺序（从"最懂行"到"最兜底"）
 *
 * 1. `pdfUrl`（用户/模型明确给的直链）—— 最确定，先试；
 * 2. `Zotero.Attachments.addAvailableFile(item)` —— Zotero 自己的解析链，
 *    会用用户的网络与机构代理（见文件头说明）；
 * 3. 开放获取直链（OpenAlex）—— 只对**已经知道 DOI** 的条目有意义，
 *    且能覆盖"没有机构订阅但要 OA 版"的情况。
 *
 * ## 为什么每一步失败都不抛出
 *
 * 这是"尽力而为"的增强：**拿不到全文不该让新建条目失败**。
 * 用户要的是一件条目 + 尽可能有全文；把"没有全文"变成"条目也没建"是明显的倒退。
 * 所以每步失败都记日志、最后汇总成一句可读的 `detail`，由调用方拼进结果。
 */
export async function attachBestPdf(
  item: unknown,
  options: { doi?: string; pdfUrl?: string; isRetracted?: boolean } = {},
): Promise<AttachOutcome> {
  const tried: string[] = [];

  // ① 明确给了直链：直接用 Zotero.HTTP 取，再作为附件落盘
  const direct = options.pdfUrl?.trim();
  if (direct) {
    tried.push("直链");
    const viaDirect = await attachFromUrl(item, direct);
    if (viaDirect.ok) return viaDirect;
    appendPanelLog("session", `直链取全文失败：${viaDirect.detail}`);
  }

  // ② 让 Zotero 自己找（最懂机构访问）
  const att = attachments();
  if (typeof att?.addAvailableFile === "function") {
    tried.push("Zotero 解析器");
    try {
      /**
       * ⚠️ **必须加超时**（真机事故：整批确认卡死 7 分钟）。
       *
       * 对需要机构登录的出版商，`addAvailableFile` 会开隐藏浏览器走登录流程，
       * 可能**永远不返回**。而批量确认是串行的 —— 实测 28 条里第 7 条挂在
       * 「开始取全文」之后 6 分 13 秒，界面停在「正在全部确认…（6/28）」，
       * 剩下 21 条全部停摆，用户完全看不出原因（它是"没返回"，不是"失败"）。
       *
       * 超时后**照常建条目**（条目本身已经建好），只是没挂上 PDF —— 这是常态。
       */
      const created = await withTimeout(
        Promise.resolve(
          att.addAvailableFile(item, {
            methods: ["doi", "url", "oa", "custom"],
          }),
        ),
        FULLTEXT_RESOLVER_TIMEOUT_MS,
        "Zotero 全文解析器",
      );
      const key = (created as { key?: unknown } | undefined)?.key;
      if (typeof key === "string" && key) {
        return {
          ok: true,
          attachmentKey: key,
          via: "Zotero 解析器",
          detail: `已通过 Zotero 的全文解析器取得附件（key=${key}）`,
        };
      }
      if (created === undefined) {
        // 超时：不是"没找到"，是"没等到"。说清区别，否则用户以为这篇没 OA 版。
        tried.push("解析器超时");
        appendPanelLog(
          "session",
          "Zotero 全文解析器超时未返回（通常是出版商要求机构登录）—— 条目已建好，只是没挂 PDF",
        );
      } else {
        appendPanelLog(
          "session",
          "Zotero 全文解析器未找到可用 PDF（该文可能没有开放获取版或机构未订阅）",
        );
      }
    } catch (error) {
      appendPanelLog(
        "session",
        `Zotero 全文解析器出错：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  } else {
    appendPanelLog("session", "本机 Zotero 没有 addAvailableFile，跳过解析器");
  }

  // ③ 开放获取直链兜底
  const doi = normalizeDoi(options.doi);
  if (doi) {
    tried.push("开放获取");
    const oa = await findOpenAccessPdf(doi);
    if (oa) {
      const viaOa = await attachFromUrl(item, oa);
      if (viaOa.ok) return { ...viaOa, via: "开放获取" };
      appendPanelLog("session", `开放获取直链取全文失败：${viaOa.detail}`);
    }
  }

  return {
    ok: false,
    detail:
      `未能取得全文（试过：${tried.join("、") || "无可用途径"}）。` +
      "常见原因：该文没有开放获取版、机构未订阅、或需要先在浏览器里登录机构账号。" +
      "条目本身**已经建好**，你可以在 Zotero 里手动右键「查找可用 PDF」。",
  };
}

/**
 * 从一个 URL 取回 PDF 并挂到条目上。
 *
 * ## ⚠️ 这里**必须**校验拿到的确实是 PDF
 *
 * 出版社的"全文链接"经常先把人送到一个**登录页或 interstitial HTML**。
 * 若不做校验，那个 HTML 会被当成附件存下来 —— 用户看到一堆点开是网页的"PDF 附件"，
 * 比"这次没拿到全文"难清理得多（要逐条删）。
 *
 * 所以：先按二进制取回、检查**魔术字节** `%PDF-`，再落盘挂附件。
 */
export async function attachFromUrl(
  item: unknown,
  url: string,
): Promise<AttachOutcome> {
  let tempPath: string | undefined;
  try {
    const client = http();
    if (!client) throw new Error("Zotero.HTTP 不可用");
    const response = (await client.request("GET", url, {
      timeout: REQUEST_TIMEOUT_MS * 2,
      anon: false,
      responseType: "arraybuffer",
      headers: { "User-Agent": USER_AGENT },
      successCodes: false,
    })) as unknown as { status: number; response?: ArrayBuffer };

    const status = response?.status ?? 0;
    if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
    const buffer = response?.response;
    if (!buffer || buffer.byteLength === 0) throw new Error("响应为空");

    if (!isPdfBytes(new Uint8Array(buffer))) {
      // 关键判断：不是 PDF 就**不要**挂上去
      throw new Error("返回的不是 PDF（多半是登录页或跳转页）");
    }

    const dir = Zotero.getTempDirectory?.()?.path;
    if (!dir) throw new Error("取不到 Zotero 的临时目录");
    tempPath = PathUtils.join(
      dir,
      `dsh-paper-${Date.now()}-${Math.floor(Math.random() * 1e6)}.pdf`,
    );
    await IOUtils.write(tempPath, new Uint8Array(buffer));

    const att = attachments() as unknown as {
      importFromFile?: (options: Record<string, unknown>) => Promise<unknown>;
    };
    if (typeof att?.importFromFile !== "function") {
      throw new Error("Zotero.Attachments.importFromFile 不可用");
    }
    const parentID = (item as { id?: number })?.id;
    const libraryID =
      (item as { libraryID?: number })?.libraryID ??
      Zotero.Libraries.userLibraryID;
    const created = await att.importFromFile({
      libraryID,
      file: tempPath,
      ...(parentID ? { parentItemID: parentID } : {}),
      contentType: "application/pdf",
    });
    const key = (created as { key?: unknown })?.key;
    return {
      ok: true,
      ...(typeof key === "string" ? { attachmentKey: key } : {}),
      via: "直链下载",
      detail: `已从直链取得 PDF 并挂为附件${typeof key === "string" ? `（key=${key}）` : ""}`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: `${error instanceof Error ? error.message : String(error)}（${url.slice(0, 120)}）`,
    };
  } finally {
    // 临时文件用完即删：留在磁盘上只会在用户排查时造成困惑
    if (tempPath) {
      try {
        await IOUtils.remove(tempPath, { ignoreAbsent: true });
      } catch {
        // 删不掉不影响已经挂好的附件
      }
    }
  }
}

/** PDF 魔术字节：`%PDF-`（也容忍前面有空白/BOM） */
export function isPdfBytes(bytes: Uint8Array): boolean {
  // 跳过前导空白与 UTF-8 BOM
  let i = 0;
  while (
    i < bytes.length &&
    (bytes[i] === 0x20 ||
      bytes[i] === 0x09 ||
      bytes[i] === 0x0a ||
      bytes[i] === 0x0d ||
      (i === 0 && bytes[i] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf))
  ) {
    i += i === 0 && bytes[i] === 0xef ? 3 : 1;
  }
  const magic = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
  if (i + magic.length > bytes.length) return false;
  return magic.every((b, k) => bytes[i + k] === b);
}
