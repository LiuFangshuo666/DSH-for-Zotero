/**
 * 自检运行的取证记录。
 *
 * 为什么单独做：真机上出现过**同一份凭据、同一时刻，两条路径结果不同**的情况 ——
 * 自动自检（窗口加载时跑）HTTP 200，手动自检（菜单点开）HTTP 401。
 * 这种情况下"继续推断"毫无意义，必须把两次运行**实际发出的请求**并排记录下来比对。
 *
 * 记录写在 Zotero 数据目录（与 dsh-for-zotero-menu.txt 同处），每次自检追加一条。
 * 写失败绝不影响自检本身。
 */

export interface SelfCheckRunRecord {
  /** 触发方式：auto = 启动时自动跑；manual = 菜单点开 */
  trigger: "auto" | "manual";
  baseUrl: string;
  authority: string;
  cookieName: string;
  cookieValueLength: number;
  cookieValue: string;
  cookieHeaderLength: number;
  payloadKeys: string[];
  issuedAtDigits: number;
  expiresAtDigits: number;
  /** 本次 session/list 的结果：HTTP 状态或错误摘要 */
  rpcOutcome: string;
  delivery: string;
  elapsedMs: number;
}

/**
 * 自检记录文件名（**全项目唯一一份**）。
 *
 * ⚠️ 这里曾经有两个名字：本文件用 `dsh-for-zotero-selfcheck.txt`，
 * 而 `modules/selfCheck.ts` 的完整报告写 `dsh-for-zotero-last-selfcheck.txt` ——
 * 只差一个 `last-`，**面向用户的文案却只提前者之外的那个**，
 * 于是自检记录对用户隐形。现已统一到这个名字（导出供别处引用，避免再次分叉）。
 */
export const SELF_CHECK_FILE = "dsh-for-zotero-selfcheck.txt";

/**
 * 组装一行记录。
 * 刻意带上**完整的 cookie 值**：它是本机回环令牌、且目标文件在用户自己的数据目录里
 * （与 `.credentials.yaml` 同权限级别）；没有它就无法判断"同一个 token 为何一边 200 一边 401"。
 */
export function formatRunLine(record: SelfCheckRunRecord): string {
  const parts = [
    `[${new Date().toISOString()}] trigger=${record.trigger}`,
    `rpc=${record.rpcOutcome}`,
    `delivery=${record.delivery}`,
    `elapsed=${record.elapsedMs}ms`,
    `baseUrl=${record.baseUrl}`,
    `authority=${record.authority}`,
    `cookieName=${record.cookieName}`,
    `valueLen=${record.cookieValueLength}`,
    `headerLen=${record.cookieHeaderLength}`,
    `payloadKeys=[${record.payloadKeys.join(",")}]`,
    `tsDigits=${record.issuedAtDigits}/${record.expiresAtDigits}`,
    `cookie=${record.cookieValue}`,
  ];
  return parts.join(" | ");
}

/** 追加一条记录；任何失败都被吞掉（取证不应影响功能） */
export async function appendRunRecord(
  record: SelfCheckRunRecord,
): Promise<void> {
  try {
    const dir = Zotero.DataDirectory?.dir;
    if (!dir) return;
    const path = PathUtils.join(dir, SELF_CHECK_FILE);
    // 同样改为**追加写**（原先的读-改-写会在并发时丢记录，见 appendPanelLog 的说明）
    enqueueWrite(path, formatRunLine(record) + "\n", "run");
  } catch {
    // 忽略
  }
}

/**
 * 面板日志文件（reader 面板的日志、故障、隔离运行时、会话）。
 *
 * 取值类型定义成宽松的字符串联合而不是枚举：这几条路径由不同模块写入，
 * 每加一个来源都要改类型会不断打断；日志本身只用于诊断。
 */
const PANEL_LOG_FILE = "dsh-for-zotero-panel.txt";

export type PanelLogKind =
  | "log"
  | "fault"
  | "notice"
  | "runtime"
  | "session"
  // ⚠️ 这里原有 `"batch"` —— 批量处理功能已整体删除，该取值**再无写入方**。
  // 留着它会让"日志里出现 batch 行"看起来仍可能发生，实际永远不会。
  // 换成新手引导：首次启动的一次性动作，值得在日志里单独可辨。
  | "onboarding";

/**
 * 写日志的串行队列。
 *
 * ## ⚠️ 为什么必须串行 + 追加（这是一次代价很大的教训）
 *
 * 早先的实现是"读整个文件 → 拼上新行 → 整体写回"：
 *
 * ```js
 * const existing = await IOUtils.readUTF8(path);
 * await IOUtils.writeUTF8(path, (existing + line)…);
 * ```
 *
 * 而 `appendPanelLog` 是**即发即忘**（`void (async () => …)()`），于是启动时
 * 短时间内的几十次并发调用会各自读到**同一份旧快照**，后写的那次把先写的**整段覆盖掉** ——
 * 日志行被静默抹掉，文件看起来"从没出现过那些记录"。
 *
 * 真实后果：我据"日志里没有某行"判断"那段代码没执行"，
 * **连续几轮都建立在错误前提上**（实际是行被并发写覆盖了）。
 * 诊断工具本身不可靠时，排查会一路跑偏 —— 所以这里改成追加写。
 *
 * ## 做法
 *
 *  - 每次写只做**一次** `IOUtils.writeUTF8(path, line, { mode: "appendOrCreate" })`，
 *    不读旧内容（`WriteMode` 的合法值是 `append` / `appendOrCreate` / `create` / `overwrite`，
 *    由 `zotero-types` 的 `lib.gecko.dom.d.ts` 给出；**没有 `append: true` 这种字段**）；
 *  - 用一条 Promise 链把写入**串行化**，避免并发交叉；
 *  - 超过阈值才做一次裁剪（裁剪同样排在队列里，不会与追加交叉）。
 */
let writeQueue: Promise<void> = Promise.resolve();
/** 超过这个行数才触发裁剪，避免频繁读写 */
const TRIM_THRESHOLD_LINES = 400;
/** 裁剪后保留的行数 */
const KEEP_LINES = 200;

function enqueueWrite(path: string, line: string, kind: "panel" | "run"): void {
  writeQueue = writeQueue
    .then(async () => {
      try {
        await IOUtils.writeUTF8(path, line, { mode: "appendOrCreate" });
      } catch {
        return; // 写失败就算了，绝不影响功能
      }
      // 偶尔裁剪一次，防止无限增长
      try {
        if (kind !== "panel") return;
        const text = await IOUtils.readUTF8(path);
        const lines = text.split("\n").filter((l) => l.trim().length > 0);
        if (lines.length <= TRIM_THRESHOLD_LINES) return;
        await IOUtils.writeUTF8(
          path,
          lines.slice(-KEEP_LINES).join("\n") + "\n",
        );
      } catch {
        // 裁剪失败不影响已写入的内容
      }
    })
    .catch(() => {
      // 队列本身绝不 reject，否则后续写入会被跳过
    });
}

/**
 * 把面板的日志/故障追加到数据目录。
 *
 * 为什么需要：面板的错误只呈现在界面状态条上，**外部完全读不到**。
 * 实测中面板出问题时我只能反复猜测与要求人工描述；落盘后可以直接读取，
 * 与自检取证文件同一思路。
 */
export function appendPanelLog(kind: PanelLogKind, message: string): void {
  // 故意做成"即发即忘"：面板路径上不能因为写日志而阻塞或抛错。
  try {
    const dir = Zotero.DataDirectory?.dir;
    if (!dir) return;
    const path = PathUtils.join(dir, PANEL_LOG_FILE);
    enqueueWrite(
      path,
      `[${new Date().toISOString()}] ${kind}: ${message}\n`,
      "panel",
    );
  } catch {
    // 忽略
  }
}

/** 诊断文件（与面板日志分开：它是"给人贴出来"的，要求可读、分段） */
const DIAGNOSTIC_FILE = "dsh-for-zotero-diagnostics.txt";

/**
 * 追加一段诊断（供用户整段复制出来定位问题）。
 *
 * ## ⚠️ 两条用血换来的约束
 *
 * 1. **不能在模块加载期调用**。这个函数原先写在 `index.ts` 的模块体里，
 *    而那时 `Zotero.DataDirectory._dir` **尚未初始化** —— `?.dir` 拿到
 *    undefined，于是整个诊断**什么都没写**。我为了排查"没反应"而加的诊断，
 *    自己"没反应"了，白绕一圈。数据目录要等 `Zotero.initializationPromise`
 *    完成，所以调用点必须在 `onStartup` 里。
 *
 * 2. **走 `enqueueWrite` 串行追加**，不要"读全文→拼→整体写回"：
 *    启动期短时间内的并发调用会各自读到同一份旧快照，后写的把先写的盖掉
 *    （见上面 `enqueueWrite` 的说明，这个坑已经踩过一次）。
 *
 * 写失败时退到 `Zotero.logError`，绝不留"什么都没有"的结果。
 */
export function appendDiagnostic(title: string, lines: string[]): void {
  try {
    const dir = Zotero.DataDirectory?.dir;
    if (!dir) {
      Zotero.logError(
        new Error(
          `[DSH-for-Zotero] 数据目录未就绪，诊断「${title}」无法落盘：${lines.join("；")}`,
        ),
      );
      return;
    }
    const path = PathUtils.join(dir, DIAGNOSTIC_FILE);
    const body = [
      "",
      `---- ${title} @ ${new Date().toISOString()} ----`,
      ...lines,
      "",
    ].join("\n");
    enqueueWrite(path, body, "panel");
  } catch (error) {
    try {
      Zotero.logError(
        new Error(
          `[DSH-for-Zotero] 诊断写入失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    } catch {
      // 连 logError 都不可用
    }
  }
}
