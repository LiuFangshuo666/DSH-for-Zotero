/**
 * # 对话传输层
 *
 * 把 dsh 的会话协议封装成"发问 → 拿到回答"的接口。**只做协议与生命周期**：
 * 不碰 DOM、不碰 Zotero 条目 —— 事件交给 `src/chat/state.ts` 的状态机。
 *
 * ## 通道优先级（两条都实现了，实测决定哪条真正生效）
 *
 * ```text
 *  1. session/follow + assistantStream   逐字流式（ChromeWorker WebSocket）
 *  2. session/page 轮询                   分段实时 ← 本环境实际走这条
 * ```
 *
 * ⚠️ 流式在本环境**基本必然失败**：WebSocket 握手要带登录 cookie，而沙箱写不进
 * cookie 罐（`Services.cookies.add` 的形参个数是 12，历史实现传的是 11，见 auth.ts）。
 * **这不是 bug，是已知限制** —— 轮询路径功能完整，只是"生成完一次性显示"。
 *
 * ## 取回答时最容易搞错的一处
 *
 * `readTurn()` 里那条链条（**改之前务必读完它的注释**）：
 * `session/projections` → `asOfSeq` → `session/page` 的 `throughSeq` **必须用 asOfSeq**
 * （传 -1 会返回空记录，正是"面板永远空白"的原因，实测过两次）。
 *
 * 另外回答正文可能有**多个** `assistant/message`（模型分几步收尾），
 * 必须用 `mergeResponseText` 合并，**不能只取最后一段** —— 这也是真机故障。
 */

import { mintCookieFromCredentials, type AuthCookie } from "../dsh/auth";
import { selectedModel } from "../dsh/modelConfig";
import {
  credentialsPath,
  resolveRuntimeConfig,
  type DshRuntimeConfig,
} from "../dsh/config";
import {
  cancelSession,
  createSession,
  DshClient,
  DshRpcError,
  listSessions,
  promptSession,
  selectSessionModel,
  type SessionSummary,
} from "../dsh/rpc";
import {
  openFollowStream,
  workerCandidates,
  type FollowFrame,
  type StreamTransport,
} from "../dsh/stream";
import type { ChatEvent } from "../chat/state";
import { mergeResponseText } from "../chat/mergeText";
import { appendPanelLog } from "../dsh/runLog";
import { parseAskUserQuestions, type AskUserQuestion } from "../dsh/askUser";

export interface ChatTransportDeps {
  /** 事件出口（交给状态机） */
  emit: (event: ChatEvent) => void;
  /** 诊断日志 */
  log?: (message: string) => void;
  /** 每个文献对应的 dsh 会话 id（读） */
  getSessionId: (itemKey: string) => string | undefined;
  /** 记住新建的会话 id（写） */
  rememberSession: (itemKey: string, sessionId: string) => void;
  /** 论文工作区目录（作为会话 cwd） */
  workspaceDir: (itemKey: string) => string;
}

export interface AskOptions {
  itemKey: string;
  /** 送进会话的完整提示词（元数据 + 选区 + 问题） */
  prompt: string;
}

/** 传输层就绪状态，供面板显示 */
export interface TransportStatus {
  ready: boolean;
  transport?: StreamTransport | "polling";
  sessionId?: string;
  port?: number;
  error?: string;
}

type Unsubscribe = () => void;

const POLL_INTERVAL_MS = 700;
const POLL_MAX_MS = 180_000;

// ── 面板粘性（按文献 key 记住当前面板实例） ──────────────
// 为什么需要：划词工具条（官方 `renderTextSelectionPopup` 事件）拿不到 Zotero.Item，
// 只能拿到选区文本；要把它送进"该文献的面板"，就必须能按 itemKey 找回面板。
// 这里用一个极薄的注册表：面板注册自己，划词动作按 key 解析。
export interface SelectionSink {
  itemKey: string;
  /** 带选区文本发起一次提问；rects 用于后续"存为高亮" */
  askWithSelection: (
    text: string,
    pageIndex?: number,
    preset?: string,
    rects?: number[][],
  ) => Promise<void>;
}

const selectionSinks = new Map<string, SelectionSink>();

export function registerSelectionSink(sink: SelectionSink): () => void {
  selectionSinks.set(sink.itemKey, sink);
  return () => {
    if (selectionSinks.get(sink.itemKey) === sink)
      selectionSinks.delete(sink.itemKey);
  };
}

export function selectionSinkCount(): number {
  return selectionSinks.size;
}

/**
 * 用一段划选文本发起提问。
 * 找不到该文献的面板时返回 "no-panel"，由调用方给出可读提示。
 */
export async function askWithSelectionAny(
  itemKey: string,
  text: string,
  pageIndex?: number,
  preset?: string,
  rects?: number[][],
): Promise<"ok" | "no-panel"> {
  const sink = selectionSinks.get(itemKey);
  if (!sink) return "no-panel";
  await sink.askWithSelection(text, pageIndex, preset, rects);
  return "ok";
}

/**
 * 一条会话的传输实例（**每个界面各一份**，不共享）。
 *
 * ## 状态机
 *
 * ```text
 *   idle ──ask()──▶ 生成中 ──┬─ 正文连续 N 轮不变 ─▶ 完成
 *                            ├─ cancel() ──────────▶ 已取消
 *                            └─ dispose() ─────────▶ 释放（界面关闭时必须调用）
 * ```
 *
 * 状态变化通过 `onStatus()` 广播；界面只消费事件，不直接读私有字段。
 *
 * ## ⚠️ `dispose()` 必须调用（真机泄漏过）
 *
 * 实例持有 `activeStream`（WebSocket）与 `pollTimer`。阅读器侧栏每次切换条目都会
 * 新建面板 —— 不释放就会累积定时器与连接，表现为"用一阵子后变慢、且回答串台"。
 *
 * ## 关于"生成结束"的判定
 *
 * 没有可靠的结束事件可依赖，所以用**正文连续若干轮不再变化**来判定（`pollStableRounds`）。
 * 这是权衡的结果：宁可多等一两轮，也不要提前收尾把半截回答当成完整回答。
 */
/**
 * 一轮读完之后该怎么走 —— 抽成**纯函数**，便于单测。
 *
 * ## ⚠️ 这条规则的由来（真机缺陷，任务被打断在一半）
 *
 * 用户实测：界面弹「请求失败：本轮以空回答结束（模型没有产出正文）」，
 * 而日志的块构成明明是 `tool-call:pwsh` / `tool-call:read` —— **Agent 在干活**。
 * 于是同一句话被连发三次、又被取消。
 *
 * 根因：**多步执行时每一步都会带一个 `turn/end`**，而"工具步"的
 * `assistant/message` 里没有 text 块。旧代码一见"结束且无正文"就抛错，
 * 把正在进行的任务判成失败。
 *
 * 所以规则是：
 *
 * | 情况 | 处理 |
 * | --- | --- |
 * | 有错误 | `throw`（没有凭据等，必须立刻报出来） |
 * | 有正文 | `return` |
 * | 无正文，但 harness **明确说停了** | `throw`（确实什么都没产出，别让用户白等） |
 * | 无正文，harness 还在跑或**问不到** | `wait`（它在干活，等下一轮的正文） |
 *
 * 抽出来的另一个原因：我原本把这条测试写成集成测试，却因为它需要
 * XHR/沙箱而反复失败在**与规则无关的环境问题**上。纯函数可以直接测规则本身。
 */
export function decideTurnOutcome(input: {
  ended: boolean;
  error?: string;
  textLength: number;
  /**
   * harness 是否仍在运行：`true` / `false` / `undefined`（问不到）。
   * ⚠️ 只有**明确的 `false`** 才算"它停了" —— `undefined` 必须当作"不确定"。
   */
  harnessRunning?: boolean;
}): { action: "continue" | "return" } | { action: "throw"; message: string } {
  if (input.error) {
    return { action: "throw", message: input.error };
  }
  if (!input.ended) return { action: "continue" };
  if (input.textLength > 0) return { action: "return" };
  // 结束但无正文：这正是"工具步"的形态
  if (input.harnessRunning === false) {
    return {
      action: "throw",
      message:
        "本轮结束但没有产出正文（可能是模型只调用了工具、没有输出文字；" +
        "也可能被取消或出错）。可查看会话页的「块构成」日志行确认它做了什么。",
    };
  }
  return { action: "continue" };
}

/**
 * 流式的 `end` 帧到达后该"接管"还是"收尾" —— 与 `decideTurnOutcome` 同理，抽成纯函数。
 *
 * ## ⚠️ 为什么必须问一次 harness 才能收尾（真机缺陷）
 *
 * 用户实测：界面在 14:20:22 显示「本轮结束」，而插件日志显示 Agent
 * 在 14:21–14:22 **持续每秒一次**地调用 `getFullText` —— 它才刚开始干活。
 * 流一断，界面就与 Agent **完全脱节**：之后它做的事全都看不到。
 *
 * 根因：`assistant-stream` 的 `end` 帧是"**一个 step 结束了**"，
 * 与 `turn/end` 是同一个病的两条路 —— 多步执行时每步都会结束一次。
 *
 * ## 三态的处理在这里**刻意与 `decideTurnOutcome` 相反**
 *
 * | 值 | 决定 | 理由 |
 * | --- | --- | --- |
 * | `true` | 接管（轮询顶上） | 确认它还在跑，界面必须继续跟 |
 * | `false` | 收尾 | 确实停了 |
 * | `undefined` | **收尾** | 见下 |
 *
 * `undefined` 在这里选"收尾"，是因为触发它的是**流自己关闭** ——
 * 通道已经没了，我们再也收不到后续增量。此时若宣布"还在跑"却不接上轮询，
 * 界面会**永远停在"生成中"**，比提前显示结束更难受。
 * 而"接管"这条路径本身只有在**确认**它在跑时才走，所以不会误伤正常收尾。
 */
export function decideStreamEnd(input: {
  /** harness 是否仍在运行：`true` / `false` / `undefined`（问不到） */
  stillRunning?: boolean;
}): "takeover" | "finish" {
  return input.stillRunning === true ? "takeover" : "finish";
}

export class ChatTransport {
  private readonly deps: ChatTransportDeps;
  private config?: DshRuntimeConfig;
  private client?: DshClient;
  private cookie?: AuthCookie;
  private sessionId?: string;
  private activeStream?: { transport: StreamTransport; close: () => void };
  private pollTimer?: number;
  private pollStartedAt = 0;
  /** 轮询累计到的正文（来自投影的最后一轮 response） */
  private pollText = "";
  /** 文本连续不变的轮数，用于判定生成结束 */
  private pollStableRounds = 0;
  /**
   * 是否已经就"这一轮跑了很久但仍在生成"提醒过用户。
   *
   * 只提醒**一次**：长任务每超时一轮就发一条，会把界面的提示区刷满 ——
   * 提示的价值在于"告诉你它没死"，重复说反而变成噪音。
   */
  private longRunNoticeSent = false;
  private listeners = new Set<(status: TransportStatus) => void>();
  private lastStatus: TransportStatus = { ready: false };

  constructor(deps: ChatTransportDeps) {
    this.deps = deps;
  }

  onStatus(listener: (status: TransportStatus) => void): Unsubscribe {
    this.listeners.add(listener);
    listener(this.lastStatus);
    return () => this.listeners.delete(listener);
  }

  private setStatus(status: TransportStatus): void {
    this.lastStatus = status;
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch {
        // 单个监听者出错不影响其它
      }
    }
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }

  /**
   * 建立认证与客户端。失败时发 fault 事件并返回 undefined。
   */
  /**
   * 取运行期配置；**运行时未就绪时返回 undefined 并发出可读故障**。
   *
   * ## 为什么集中在一处（用户要求：删除共享模式，只允许隔离）
   *
   * `resolveRuntimeConfig()` 现在只在隔离宿主已就绪时返回值。若让每个调用点各自判空，
   * 迟早有人写 `!` 断言把它糊过去，于是又回到"静默连到别的实例"的老问题。
   * 统一从这里取，未就绪就**明确报出来**，让用户知道该等运行时启动。
   */
  private ensureRuntimeConfig(): DshRuntimeConfig | undefined {
    const config = resolveRuntimeConfig();
    if (!config) {
      this.emitFault(
        "client/runtime-not-ready",
        "隔离运行时尚未就绪，插件无法连接 DSH。请稍候（启动时会显示进度），若持续如此请到「设置 → DSH-for-Zotero → 自检」查看。",
      );
      return undefined;
    }
    return config;
  }

  async connect(): Promise<DshClient | undefined> {
    if (this.client) return this.client;

    // ⚠️ 运行时未就绪时**明确报错，不再回退到桌面版 dsh**。
    //
    // 用户要求只允许隔离使用。以前这里会回退到桌面版：用户以为在用隔离实例，
    // 实际连到了另一个实例（凭据与会话都串了），而且那个回退还让一堆
    // 桌面版设置项看起来"有用"。现在给出可读原因，让用户知道该等运行时起来。
    const config = this.ensureRuntimeConfig();
    if (!config) return undefined;
    this.config = config;

    let cookie: AuthCookie | undefined;
    try {
      const minted = await mintCookieFromCredentials(config);
      cookie = minted.cookie;
      if (!cookie) {
        this.log(`凭据自签失败：${minted.error ?? "未知"}`);
      }
    } catch (error) {
      this.log(
        `凭据自签异常：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // ⚠️ 这里原有一个"用设置里粘贴的启动 URL 换 cookie"的回退分支。
    // 它随共享模式一起作废：`config.launchUrl` 在隔离分支里恒为空串，
    // 所以那段代码**永远不会执行**。已删除 —— 连同 `extractTokenFromLaunchUrl`
    // 与 `config.launchUrl` 字段。隔离模式下的认证只有"读凭据自签"这一条路。
    //
    // （运行时自己读宿主打印的 `launchUrl` 是另一回事，那是给会话页 URL 取 token 用的，
    //   见 `RuntimeStatus.launchUrl` —— 不受本次删除影响。）

    if (!cookie) {
      this.emitFault(
        "client/auth-unavailable",
        `无法取得 dsh 会话凭据。请确认隔离运行时已启动，且 ${credentialsPath(config.dshHome)} 可读。`,
      );
      return undefined;
    }

    this.cookie = cookie;
    // 认证已完成，但还要确认**投递通道真的可用**：
    //  - cookie 罐写入失败时会回退到 XHR 显式 Cookie 头；
    //  - 而 XHR 在少数环境里可能不可用（例如测试宿主），此时 fetch 才是唯一可行路径。
    // 之前不做这个判断的后果是"回退到一条不存在的通道"，表现为晦涩的超时/未捕获异常，
    // 集成测试正是这样抓到的。这里显式校验，并给出可读原因。
    let delivery = this.chooseDelivery(config, cookie);
    if (!delivery) {
      this.emitFault(
        "client/no-http-transport",
        "本环境既无法写入 cookie 罐（需要 WebSocket 握手用），也没有可用的 XMLHttpRequest（fetch 无法设置 Cookie 头）。请联系开发者并提供自检输出。",
      );
      return undefined;
    }

    this.client = new DshClient({
      config,
      cookie,
      forceDelivery: delivery,
      refreshCookie: () => this.refreshCookie(),
    });
    const prepared = this.client.prepare();
    delivery = prepared.delivery;
    this.log(
      `cookie 投递通道：${delivery}${prepared.jarError ? `（cookie 罐不可用：${prepared.jarError}）` : ""}`,
    );
    return this.client;
  }

  /**
   * 重读凭据、重签 cookie。
   *
   * 为什么收口在这里：宿主（dsh 桌面版）重启后会换一套会话密钥，旧 cookie 一律 401。
   * 早先这段逻辑只写在面板路径上，**批量路径没有** —— 真机实测批量就报了
   * `DSH 返回了非 JSON 响应（HTTP 401）`。放在连接层后，两条路径都自动获得自愈能力。
   */
  private async refreshCookie(): Promise<AuthCookie | undefined> {
    const config = this.config;
    if (!config) return undefined;
    try {
      const refreshed = await mintCookieFromCredentials(config);
      if (refreshed.cookie) {
        this.cookie = refreshed.cookie;
        this.log("已重读凭据并重新签发 cookie（原 cookie 未被宿主认可）");
        return refreshed.cookie;
      }
      this.log(`重新签发 cookie 失败：${refreshed.error ?? "未知"}`);
    } catch (error) {
      this.log(
        `重新签发 cookie 异常：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return undefined;
  }

  /**
   * 选一条真正可用的 cookie 投递通道。
   *  - 能写 cookie 罐 → 用 cookie-jar（fetch 自动携带，且 WebSocket 握手也受益）；
   *  - 否则必须有 XMLHttpRequest（XHR 允许显式设置 Cookie 头）；
   *  - 都没有 → 返回 undefined，由调用方给出可读错误。
   */
  private chooseDelivery(
    config: DshRuntimeConfig,
    cookie: AuthCookie,
  ): "cookie-jar" | "xhr-header" | undefined {
    const probe = new DshClient({ config, cookie });
    const prepared = probe.prepare();
    if (prepared.delivery === "cookie-jar") return "cookie-jar";
    const hasXhr =
      typeof (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest ===
      "function";
    return hasXhr ? "xhr-header" : undefined;
  }

  /** 连通性检查（自检命令之外，面板启动时用） */
  async ping(): Promise<{
    ok: boolean;
    sessions?: SessionSummary[];
    error?: string;
  }> {
    const client = await this.connect();
    if (!client)
      return { ok: false, error: this.lastStatus.error ?? "认证未就绪" };
    try {
      const result = await listSessions(client);
      return { ok: true, sessions: result.value?.items ?? [] };
    } catch (error) {
      const message = this.describeError(error);
      this.emitFault("client/ping-failed", message);
      return { ok: false, error: message };
    }
  }

  /**
   * 为一个文献准备会话：优先恢复已记录的会话，否则新建（cwd = 论文工作区）。
   */
  async ensureSession(itemKey: string): Promise<string | undefined> {
    const client = await this.connect();
    if (!client || !this.config) return undefined;

    const existing = this.deps.getSessionId(itemKey);
    const cwd = this.deps.workspaceDir(itemKey);

    if (existing) {
      try {
        // 显式 sessionId 即"恢复"；cwd 必须与会话记录一致，否则 dsh 抛 ApiSessionCwdConflict
        const restored = await createSession(client, {
          sessionId: existing,
          cwd,
        });
        this.sessionId = restored.value.sessionId;
        this.setStatus({
          ready: true,
          sessionId: this.sessionId,
          port: this.config.port,
        });
        this.deps.emit({
          kind: "ready",
          sessionId: this.sessionId,
          transport: this.lastStatus.transport ?? "unknown",
          resumed: true,
        });
        return this.sessionId;
      } catch (error) {
        this.log(`恢复会话失败，改为新建：${this.describeError(error)}`);
      }
    }

    try {
      const created = await createSession(client, { cwd });
      this.sessionId = created.value.sessionId;
      this.deps.rememberSession(itemKey, this.sessionId);
      this.setStatus({
        ready: true,
        sessionId: this.sessionId,
        port: this.config.port,
      });
      this.deps.emit({
        kind: "ready",
        sessionId: this.sessionId,
        transport: this.lastStatus.transport ?? "unknown",
        resumed: false,
      });
      return this.sessionId;
    } catch (error) {
      this.emitFault("client/session-create-failed", this.describeError(error));
      return undefined;
    }
  }

  /**
   * 列出该文献工作区下的历史会话（按活动时间倒序）。
   * 用途：M3 的"会话切换"——用户可以回到之前的对话，而不是只能新建。
   */
  async listWorkspaceSessions(itemKey: string): Promise<SessionSummary[]> {
    const client = await this.connect();
    if (!client) return [];
    const cwd = this.deps.workspaceDir(itemKey);
    try {
      const result = await listSessions(client);
      const items = result.value?.items ?? [];
      if (!cwd) return items;
      const normalize = (p?: string) =>
        (p ?? "").replace(/[\\/]+$/, "").toLowerCase();
      const wanted = normalize(cwd);
      return items.filter((s) => normalize(s.cwd) === wanted);
    } catch (error) {
      this.log(`列出会话失败：${this.describeError(error)}`);
      return [];
    }
  }

  /**
   * 切换到指定会话（用户从历史上选一个）。
   * 与 `ensureSession` 的区别：不查映射、失败即报错，避免"静默换了别的会话"。
   */
  async openSession(itemKey: string, sessionId: string): Promise<boolean> {
    const client = await this.connect();
    if (!client) return false;
    const cwd = this.deps.workspaceDir(itemKey);
    try {
      const restored = await createSession(client, { sessionId, cwd });
      this.stopStream();
      this.stopPolling();
      this.sessionId = restored.value.sessionId;
      this.deps.rememberSession(itemKey, this.sessionId);
      this.setStatus({
        ready: true,
        transport: this.lastStatus.transport,
        sessionId: this.sessionId,
        port: this.config?.port,
      });
      this.deps.emit({
        kind: "ready",
        sessionId: this.sessionId,
        transport: this.lastStatus.transport ?? "unknown",
        resumed: true,
      });
      return true;
    } catch (error) {
      this.emitFault("client/session-open-failed", this.describeError(error));
      return false;
    }
  }

  /** 为同一文献开一条全新会话（"新建对话"） */
  async startNewSession(itemKey: string): Promise<string | undefined> {
    const client = await this.connect();
    if (!client) return undefined;
    const cwd = this.deps.workspaceDir(itemKey);
    try {
      this.stopStream();
      this.stopPolling();
      const created = await createSession(client, { cwd });
      this.sessionId = created.value.sessionId;
      this.deps.rememberSession(itemKey, this.sessionId);
      this.setStatus({
        ready: true,
        transport: this.lastStatus.transport,
        sessionId: this.sessionId,
        port: this.config?.port,
      });
      this.deps.emit({
        kind: "ready",
        sessionId: this.sessionId,
        transport: this.lastStatus.transport ?? "unknown",
        resumed: false,
      });
      return this.sessionId;
    } catch (error) {
      this.emitFault("client/session-create-failed", this.describeError(error));
      return undefined;
    }
  }

  /**
   * 发问并开始接收回答。
   * 事件流：ready（若尚未就绪）→ prompt-accepted → assistant-start →
   * assistant-delta* → assistant-end。失败发 fault。
   */
  async ask(options: AskOptions): Promise<void> {
    const sessionId =
      this.sessionId ?? (await this.ensureSession(options.itemKey));
    if (!sessionId) return;
    const client = this.client;
    if (!client) return;

    // 先挂流再发问，避免丢掉最早的增量。
    //
    // `streaming` 偏好此前**在界面上暴露但代码从不读取** —— 用户勾了没有任何效果。
    // 现在真正接上：关掉即跳过 follow 流，直接走轮询。
    //
    // ## ⚠️ 本环境里流式**基本必然失败**（机制已定位，2026-10-06）
    //
    // WebSocket 握手要带 dsh 的登录 cookie，而沙箱里 **cookie 罐写不进去**：
    // `Services.cookies.add` 的 `add.length` = **12**（真机内省测得），
    // 而历史上一直传 11 个 —— 个数不对，引擎在校验阶段就抛
    // `NS_ERROR_ILLEGAL_VALUE`。尾部两个参数是较新版本新增的
    // （`isPartitioned` 与 `schemeMap`），补上后是否可行**尚未验证**。
    //
    // 所以这个开关现在的实际作用是：**关掉可以省掉一轮注定失败的尝试**，
    // 让诊断更干净。界面文案已相应改写过，不再暗示"打开就能逐字显示"。
    const streamingWanted = this.prefStreaming();
    const streaming = streamingWanted
      ? await this.startStream(sessionId, options.itemKey)
      : false;
    if (!streamingWanted) {
      this.log("已按设置跳过 follow 流，直接使用轮询");
    }

    try {
      const requestId = this.newRequestId();
      await promptSession(client, {
        requestId,
        sessionId,
        mode: "queue",
        content: [{ type: "text", text: options.prompt }],
        clientTimeZone: this.timeZone(),
      });
      this.deps.emit({
        kind: "prompt-accepted",
        text: this.questionFromPrompt(options.prompt),
      });
      this.deps.emit({ kind: "assistant-start" });
      this.deps.emit({ kind: "status", generating: true });
      if (!streaming) this.startPolling(sessionId);
    } catch (error) {
      this.stopStream();
      this.emitFault("client/prompt-failed", this.describeError(error));
    }
  }

  /**
   * 读取该会话已有的问答轮次（用于面板回填历史）。
   *
   * 真机反馈"看不到会话历史"—— 面板此前只显示当前这一轮，切走再回来就像记录丢了。
   * 这里从 dsh 取回全部轮次。`turnOutline` 的 response 是**截断摘要**，
   * 所以正文仍走 `session/page`（throughSeq = asOfSeq），只从投影取 `prompt`。
   *
   * @param itemKey 条目 key（面板路径用 `deps.getSessionId` 映射到会话）
   * @param explicitSessionId 直接指定会话 id。
   *   ⚠️ 必须支持它：会话查看器用的是**常驻 transport**，其 `getSessionId` 返回
   *   `undefined`（它服务于多条会话，没有"当前会话"的概念）。只靠 itemKey 映射时
   *   `sessionId` 为假值，函数会**静默返回空数组** —— 真机现象就是
   *   "点进会话不显示历史"，且没有任何报错。
   */
  async loadHistory(
    itemKey: string,
    explicitSessionId?: string,
  ): Promise<Array<{ prompt: string; response: string }>> {
    const sessionId =
      explicitSessionId ?? this.deps.getSessionId(itemKey) ?? this.sessionId;
    if (!sessionId) return [];
    const client = await this.connect();
    if (!client) return [];
    try {
      const proj = await client.call<{
        asOfSeq?: unknown;
        values?: { turnOutline?: Array<{ prompt?: unknown; turn?: unknown }> };
      }>("session/projections", { request: { sessionId } });
      const asOfSeq = proj.value?.asOfSeq;
      const outline = proj.value?.values?.turnOutline;
      if (
        typeof asOfSeq !== "number" ||
        !Array.isArray(outline) ||
        outline.length === 0
      )
        return [];

      const page = await client.call<{ records?: unknown[] }>("session/page", {
        request: {
          address: { kind: "session", sessionId },
          throughSeq: asOfSeq,
          maxMessages: 500,
        },
      });
      const records = Array.isArray(page.value?.records)
        ? page.value.records
        : [];

      // 按轮聚合：turn/start 开一轮，assistant/message 填正文，user/message 填提问
      const turns: Array<{ prompt: string; response: string }> = [];
      let current: { prompt: string; response: string } | undefined;
      for (const record of records) {
        const event = (
          record as { event?: { type?: unknown; data?: unknown } } | undefined
        )?.event;
        const type = typeof event?.type === "string" ? event.type : "";
        if (type === "turn/start") {
          if (current) turns.push(current);
          current = { prompt: "", response: "" };
          continue;
        }
        if (!current) continue;
        if (type === "user/message") {
          // ⚠️ 只把**用户真正输入的**消息当作提问。
          //
          // 不能靠文本特征（先前用 `^<(system-reminder|current runtime context)` 判断，
          // 结果漏了 —— 真机里注入文本是 `Current runtime context. …`，**没有尖括号**，
          // 于是界面把运行时上下文当成用户的提问显示出来）。
          //
          // dsh 在 `data.source` 里明确标注来源，这是可靠判据。真机实测的三种：
          //   { kind: "user", … }              用户真实输入
          //   { kind: "runtime-context", … }   运行时上下文快照（注入）
          //   { kind: "skill-catalog", … }     skill 清单（注入）
          const source = (
            event?.data as { source?: { kind?: unknown } } | undefined
          )?.source;
          const sourceKind =
            typeof source?.kind === "string" ? source.kind : undefined;
          if (sourceKind !== "user") continue;
          const text = this.textFromMessageEvent(event);
          if (text) current.prompt += text;
          continue;
        }
        if (type === "assistant/message") {
          const text = this.textFromMessageEvent(event);
          // ⚠️ 不能简单赋值（真机反馈"会话显示不全，回答停在半句"）。
          //
          // dsh 在**多步执行**（例如调用工具）时会写多条 `assistant/message`：
          // 先前是 `current.response = text`，于是每一段都**覆盖**前一段 ——
          // 最后一条若正文为空（只有工具调用的那一轮），`if (text)` 还会跳过，
          // 结果回答就**停在倒数第二条的边界上**，看着像被截断。
          //
          // 两种可能的语义都要兼容：
          //  - **重发式**：每条给的是"到目前为止的全文" → 新文本以旧文本开头，替换即可；
          //  - **累积式**：每条只给这一段的增量 → 追加。
          // 用"新文本是否以旧文本开头"来区分，两种都不会重复也不会丢。
          if (text)
            current.response = this.mergeResponseText(current.response, text);
        }
      }
      if (current) turns.push(current);
      return turns.filter((turn) => turn.response.trim() || turn.prompt.trim());
    } catch (error) {
      this.log(`读取会话历史失败：${this.describeError(error)}`);
      return [];
    }
  }

  /**
   * 合并同一轮里的多段助手正文。
   *
   * 为什么需要：一轮里可能有多条 `assistant/message`（多步执行、调用工具），
   * 而先前直接赋值会让后一段**覆盖**前一段，回答看起来被截断。
   * 实现见 `mergeText.ts` 的 `mergeResponseText`（纯函数，有单测）。
   */
  private mergeResponseText(existing: string, incoming: string): string {
    return mergeResponseText(existing, incoming);
  }

  /** 从消息类事件的 content[] 里取 `type === "text"` 的正文（忽略 reasoning） */
  private textFromMessageEvent(event: { data?: unknown } | undefined): string {
    const data = event?.data as
      | { message?: { content?: unknown }; content?: unknown }
      | undefined;
    const content = data?.message?.content ?? data?.content;
    if (!Array.isArray(content)) return "";
    return content
      .filter(
        (part): part is { type?: unknown; text?: unknown } =>
          typeof part === "object" && part !== null,
      )
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("");
  }

  /**
   * 在一个**指定工作区**里新建 dsh 会话，返回会话 id。
   *
   * 供 Session 模型使用：独立会话的工作区是当前文库分类，条目会话的工作区是条目。
   * 与 `ask()` 的区别是不走面板状态机 —— 面板按条目 key 复用会话，
   * 而这里显式指定工作区、每次可新建。
   */
  async createSessionIn(cwd: string): Promise<string | undefined> {
    try {
      const client = await this.connect();
      if (!client) {
        this.log(`新建会话失败：${this.lastStatus.error ?? "无法连接 dsh"}`);
        return undefined;
      }
      const created = await createSession(client, { cwd });
      const sessionId = created.value?.sessionId;
      // 用户选过模型/推理等级的话，把选择装到这条新会话上。
      // 放在这里而不是调用方，是为了**每条新建路径都覆盖到**（建会话、
      // 会话丢失后自愈重建、以及测试用的直建）—— 漏一条就会出现
      // "有的会话按我选的等级跑、有的不按"，那种不一致极难自查。
      if (sessionId) await this.applyModelSelection(client, sessionId);
      return sessionId;
    } catch (error) {
      this.log(`新建会话失败：${this.describeError(error)}`);
      return undefined;
    }
  }

  /**
   * 把用户在设置页选的 provider / 模型 / 推理等级装到某条会话上。
   *
   * ## 三个都要注意的点
   *
   * 1. **没选就什么都不做** —— 保持宿主自己的默认，不替用户做决定；
   * 2. dsh 侧要求**先显式恢复会话**再选（`selectModel` 内部会 `resolveAgent`）——
   *    所以调用它的时机必须在 `session/create` 之后（本方法的所有调用点都满足）；
   * 3. **失败不抛出**：模型选择失败不该让建会话整体失败 ——
   *    那用户会看到"会话建不出来"，而真实原因是"等级填错了"。
   *    这里记日志并继续，让问答照常进行（用宿主默认等级）。
   */
  private async applyModelSelection(
    client: DshClient,
    sessionId: string,
  ): Promise<void> {
    const choice = selectedModel();
    if (!choice) return;
    try {
      await selectSessionModel(client, {
        sessionId,
        provider: choice.provider,
        model: choice.model,
        // 空串表示"用模型的默认等级"，此时**不要**传这个字段 ——
        // 传空串会被宿主当成无效的 ReasoningEffortId。
        ...(choice.reasoningEffort
          ? { reasoningEffort: choice.reasoningEffort }
          : {}),
      });
      this.log(
        `已为会话 ${sessionId} 选定模型 ${choice.provider}/${choice.model}` +
          (choice.reasoningEffort
            ? `（推理等级 ${choice.reasoningEffort}）`
            : ""),
      );
    } catch (error) {
      this.log(
        `选定模型失败（继续用宿主默认，问答不受影响）：${this.describeError(error)}`,
      );
    }
  }

  /**
   * 直接对某个会话发问并取回完整回答（不经过面板）。
   *
   * ## 会话丢失的自愈（真机反馈："session … not found"）
   *
   * dsh 的会话存活在**宿主进程**里。宿主重启（或先前进程被结束）后，记录里的
   * sessionId 就可能不存在了 —— 真机上正是如此：会话建在一个后来被结束的宿主上，
   * 再提问就报 `session "…" not found`。
   *
   * 这里做一次**自愈**：检测到 not-found 时，用**同一个工作区**重新建一个会话，
   * 换上回答并把新 id 通过 `onSessionReplaced` 回报给调用方持久化。
   * 这样用户看到的是"接着用"，而不是一个无法恢复的错误。
   */
  /**
   * 向**正在进行的轮次**送入补充内容（用户回答 Agent 的提问）。
   *
   * ## 为什么必须用 `mode: "steer"` 而不是普通提问
   *
   * Agent 常常在轮次中途停下来问"要做 A 还是 B"（真机反馈的正是这种情况）。
   * 此时轮次**尚未结束**，如果把它当新提问（queue）：
   *  - 界面会立刻变成"生成中"，而真正该显示的是"Agent 在等你的选择"；
   *  - dsh 侧会排队到本轮之后才处理，用户会觉得"发了没反应"。
   *
   * `steer` 是 dsh 为"给进行中的轮次补充输入"提供的模式，正好对应这个场景。
   */
  /**
   * 取消**当前正在进行的轮次**。
   *
   * ## 为什么必须有（真机反馈"会话怎么又卡住了"）
   *
   * Agent 多步执行（并行调用工具、反复验证）时一轮可能跑很久。此前**唯一的出路是等
   * 180 秒超时**，而超时只是"放弃" —— 界面停在"生成中…"，用户只能关掉 Zotero。
   *
   * dsh 提供 `session/cancel`（"不会触发 resume；没有活跃 agent 时抛 session/not-found"）。
   * 这里把"没有活跃轮次"当成**已经结束**处理，而不是报错 —— 用户点"停止"时轮次
   * 恰好自己结束了，是正常情况，不该弹一条错误。
   */
  async cancelTurn(sessionId: string): Promise<void> {
    const client = await this.connect();
    if (!client) throw new Error(this.lastStatus.error ?? "无法连接 dsh");
    try {
      await cancelSession(client, sessionId);
      this.log(`已请求取消会话轮次：${sessionId}`);
    } catch (error) {
      const code = error instanceof DshRpcError ? error.code : "";
      if (code === "session/not-found") {
        // 没有活跃轮次 = 已经结束了，视为成功
        this.log("取消请求时已无活跃轮次（视为已结束）");
        return;
      }
      throw error;
    }
  }

  async steerSession(input: {
    sessionId: string;
    text: string;
  }): Promise<void> {
    const client = await this.connect();
    if (!client) throw new Error(this.lastStatus.error ?? "无法连接 dsh");
    await promptSession(client, {
      requestId: this.newRequestId(),
      sessionId: input.sessionId,
      mode: "steer",
      content: [{ type: "text", text: input.text }],
      clientTimeZone: this.timeZone(),
    });
    this.log(`已向进行中的轮次送入补充内容（${input.text.length} 字）`);
  }

  async askInSession(params: {
    sessionId: string;
    prompt: string;
    /** 会话丢失并重建后回调新 id，供调用方更新记录 */
    onSessionReplaced?: (newSessionId: string) => Promise<void> | void;
    /** 重建时使用的工作区 */
    workspace?: string;
    timeoutMs?: number;
    /**
     * **增量回显**：正文每有变化就回调一次（传的是到目前为止的全文）。
     *
     * 为什么需要（真机反馈"一次性输出展示，看不到会话中进行的选项"）：
     * 本方法只在**轮次结束时**返回，而 Agent 常常中途停下来问"选 A 还是 B"——
     * 那句话在结束前一直不可见，用户既看不到问题，也不知道它在等自己。
     * 有了这个回调，界面可以边生成边显示。
     */
    onDelta?: (fullTextSoFar: string) => void;
    /**
     * 本轮出现 `ask_user_question` 时回调（含选项）。
     *
     * 为什么要回调而不是等返回：模型在**阻塞等待**回答，而轮次可能很久才结束 ——
     * 用户需要在它问出来的**当下**就看到选项，否则会话看起来就是卡住。
     */
    onQuestions?: (questions: AskUserQuestion[]) => void;
    /**
     * 会话因**跨设备同步**（工作目录不匹配）而被迫在当前工作区重建时回调。
     *
     * 与 `onSessionReplaced` 分开，因为要告诉用户的话不同：
     * 那个是"宿主重启了，无缝续上"，这个是"换了台机器，**原对话历史留在原机器**"——
     * 后者必须说明白，否则用户会以为记录丢了。
     */
    onWorkspaceMigrated?: () => void;
  }): Promise<string> {
    const client = await this.connect();
    if (!client) throw new Error(this.lastStatus.error ?? "无法连接 dsh");

    let sessionId = params.sessionId;
    try {
      await promptSession(client, {
        requestId: this.newRequestId(),
        sessionId,
        mode: "queue",
        content: [{ type: "text", text: params.prompt }],
        clientTimeZone: this.timeZone(),
      });
    } catch (error) {
      const code = error instanceof DshRpcError ? error.code : "";
      const message = this.describeError(error);
      const missing =
        code === "session/not-found" || /not found/i.test(message);
      /**
       * ⚠️ **跨设备同步后的核心情况**（用户反馈的路径不匹配）。
       *
       * dsh 会话的 `cwd` 在创建时固定，事后不能改。所以当记录里那台机器上的
       * 绝对路径与 dsh 里存的对不上时，宿主抛 `session/conflict`
       * （带 `requestedCwd` / `existingCwd`，见 dsh 的 `ApiSessionCwdConflict`）。
       *
       * 早先只处理 `session/not-found`，于是换台机器之后**用户根本发不出消息**，
       * 只看到一句 cwd 冲突 —— 而用户的心智模型是"文献库同步过来了，会话也该在"。
       *
       * 现在的处理与"会话不存在"一致：在当前工作区**重建**一条会话。
       * 代价是那条会话的**对话历史留在原机器**（dsh 侧数据不在 Zotero 里）——
       * 这一点如实告诉用户，而不是假装历史还在。
       */
      const cwdConflict = code === "session/conflict";
      if ((!missing && !cwdConflict) || !params.workspace) throw error;

      if (cwdConflict) {
        this.log(
          `会话 ${sessionId} 的工作目录与当前机器不符（跨设备同步），` +
            `在当前工作区重建（原对话历史留在原机器）`,
        );
        try {
          params.onWorkspaceMigrated?.();
        } catch {
          // 通知失败不影响重建
        }
      } else {
        this.log(
          `会话 ${sessionId} 已不存在（宿主可能重启过），用同一工作区重建`,
        );
      }
      const created = await createSession(client, { cwd: params.workspace });
      const replacement = created.value?.sessionId;
      if (!replacement) throw error;
      sessionId = replacement;
      await params.onSessionReplaced?.(replacement);
      await promptSession(client, {
        requestId: this.newRequestId(),
        sessionId,
        mode: "queue",
        content: [{ type: "text", text: params.prompt }],
        clientTimeZone: this.timeZone(),
      });
    }

    const timeoutMs = params.timeoutMs ?? 180_000;
    const deadline = Date.now() + timeoutMs;
    let text = "";
    let lastReported = "";
    /** 上一次已上报的提问指纹：避免每轮询都重复回调 */
    let lastQuestionsReported = "";
    while (Date.now() < deadline) {
      const turn = await this.readTurn(client, sessionId);
      if (turn) {
        text = turn.text;
        // 增量回显：每次轮询发现正文变化就报一次（传全文，便于界面直接替换）
        if (text && text !== lastReported) {
          lastReported = text;
          try {
            params.onDelta?.(text);
          } catch {
            // 界面的问题不该影响取回答
          }
        }
        // 一发现提问就报出去（别等轮次结束 —— 模型正阻塞等着回答）
        if (turn.questions && turn.questions.length > 0) {
          const fingerprint = JSON.stringify(turn.questions);
          if (fingerprint !== lastQuestionsReported) {
            lastQuestionsReported = fingerprint;
            try {
              params.onQuestions?.(turn.questions);
            } catch {
              // 界面的问题不该影响取回答
            }
          }
        } else if (lastQuestionsReported) {
          // 本轮没有提问（或提问已被清空）→ 通知界面收起上一题的卡片。
          // 否则「已经回答过的选择题」会一直挂着，用户以为还要再答一遍。
          lastQuestionsReported = "";
          try {
            params.onQuestions?.([]);
          } catch {
            // 同上
          }
        }
        /**
         * ## ⚠️ `turn/end` **不等于**"这一问的回答完了"（真机缺陷，差点误判成别的问题）
         *
         * 这里原来是：
         *
         * ```js
         *   if (turn.ended) {
         *     if (text.length > 0) return text;
         *     throw new Error("本轮以空回答结束（模型没有产出正文）");
         *   }
         * ```
         *
         * 用户实测（分类下补全文那一次）：**Agent 明明在干活**，界面却弹
         * 「请求失败：本轮以空回答结束（模型没有产出正文）」，
         * 于是一句话被连发三次、又被取消 —— 任务被打断在一半。
         *
         * 日志给出了铁证（块构成快照）：
         *
         * ```text
         *   正文 0 字；已结束=true；start=2个@[4,236]；end@[233,277]；
         *   块构成 = reasoning(...) ｜ tool-call:pwsh(...) ｜ tool-call:read(...)
         * ```
         *
         * **轮次边界完全正常**（有新轮、有新结束），只是那一步的
         * `assistant/message` 里**没有 text 块** —— 多步执行时 Agent 常常
         * 只调工具、不写给人看的话。而这种"工具步"**每一步都会带一个 `turn/end`**。
         *
         * 所以空正文**不是失败**，是"它在干活，还没轮到我说话"。
         * 正确做法是**继续等**下一轮的正文，而不是把整问判失败。
         *
         * ## 什么时候才算真的空
         *
         * 一直等到超时（下面的 `throw`）—— 那才是"确实什么都没产出"。
         * 中途如果 harness **明确说它停了**且仍然没有正文，也不必再等，
         * 直接说清"它结束了但没给正文"，比让它白等到超时更有用。
         */
        // 结束与否的判断交给纯函数（有单测）—— 规则本身就是一个真机缺陷的修正，
        // 写在这里会被环境问题掩盖掉（我就因此白折腾了几轮）。
        let stillRunning: boolean | undefined;
        if (turn.ended && text.length === 0) {
          stillRunning = await this.harnessRunning(client, sessionId);
        }
        const verdict = decideTurnOutcome({
          ended: turn.ended,
          ...(turn.error ? { error: turn.error } : {}),
          textLength: text.length,
          ...(stillRunning === undefined
            ? {}
            : { harnessRunning: stillRunning }),
        });
        if (verdict.action === "throw") throw new Error(verdict.message);
        if (verdict.action === "return") return text;
        if (turn.ended && text.length === 0) {
          appendPanelLog(
            "session",
            `第 ${turn.endedTurn} 轮结束但无正文（Agent 可能只在调用工具），继续等待后续轮次`,
          );
        }
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    if (text) return text;
    throw new Error(
      `生成超时（${Math.round(timeoutMs / 1000)}s）。若反复超时，请检查「设置 → DSH-for-Zotero」里的运行时状态与模型凭据。`,
    );
  }

  /** 读 `streaming` 偏好；读不到时按开启处理（保持既有行为） */
  private prefStreaming(): boolean {
    try {
      const value = Zotero.Prefs.get(
        `${addon.data.config.prefsPrefix}.streaming`,
        true,
      ) as boolean | undefined;
      return value !== false;
    } catch {
      return true;
    }
  }

  /** 用户点停止：先协议层取消流，再调 session/cancel */
  async stop(): Promise<void> {
    this.deps.emit({ kind: "cancel-requested" });
    this.stopStream();
    const client = this.client;
    const sessionId = this.sessionId;
    if (client && sessionId) {
      try {
        await cancelSession(client, sessionId);
      } catch (error) {
        this.log(`取消会话失败：${this.describeError(error)}`);
      }
    }
  }

  dispose(): void {
    this.stopStream();
    this.client?.dispose();
    this.client = undefined;
  }

  // ── 流式通道 ────────────────────────────────────────────

  private async startStream(
    sessionId: string,
    itemKey: string,
  ): Promise<boolean> {
    if (!this.config) return false;
    void itemKey;

    const handle = openFollowStream(this.config, {
      sessionId,
      assistantStream: true,
      openTimeoutMs: 8000,
      onFrame: (frame) => this.onFollowFrame(frame, sessionId),
      onClose: (info) => {
        // 流被对端关闭：若仍在生成，退化为轮询
        this.log(`follow 流关闭（${info.transport}）：${info.reason}`);
        if (this.activeStream) {
          this.activeStream = undefined;
          this.startPolling(sessionId);
        }
      },
    });

    if (handle.error) {
      this.log(
        `流式通道不可用：${handle.error}；候选 worker 地址 ${workerCandidates().join(", ")}`,
      );
      this.setStatus({
        ready: true,
        transport: "polling",
        sessionId,
        port: this.config.port,
      });
      return false;
    }

    this.activeStream = { transport: handle.transport, close: handle.close };
    this.setStatus({
      ready: true,
      transport: handle.transport,
      sessionId,
      port: this.config.port,
    });
    this.log(`流式通道：${handle.transport}`);
    return true;
  }

  /**
   * 流式的 `end` 帧到达后：**先确认整轮是否真的结束**，再决定要不要收尾。
   *
   * 见 `onFollowFrame` 里那段的说明 —— 这个 `end` 只是"一个 step 结束了"。
   *
   * 三种结果：
   *  - harness 仍在跑 → 转为轮询继续盯，并告知用户还在干活（**不发结束**）；
   *  - harness 已停   → 正常收尾（发结束）；
   *  - 问不到（RPC 抖动等）→ 采取**保守**的一侧：按"已停"收尾。
   *
   * ## 为什么 `undefined` 在这里选"收尾"而不是"继续等"
   *
   * 与 `decideTurnOutcome` 相反，这里刻意保守在**另一端**，理由是这个方法
   * 由**流自己关闭**触发：流已经断了，我们**没有任何通道**再收到后续增量。
   * 此时若强行宣布"还在跑"却又不把轮询接上，界面会永远停在"生成中"——
   * 那是比"提前显示结束"更难受的卡死。
   *
   * 所以：**能确认它还在跑**就接管（轮询顶上）；确认不了就按常规收尾，
   * 让用户至少能继续操作。真正的兜底是"轮询接管"这条路径本身。
   */
  private async endStreamStep(
    sessionId: string,
    kind: "committed" | "abandoned",
  ): Promise<void> {
    let stillRunning: boolean | undefined;
    try {
      const client = this.client;
      if (client) stillRunning = await this.harnessRunning(client, sessionId);
    } catch {
      stillRunning = undefined;
    }

    if (
      decideStreamEnd({
        ...(stillRunning === undefined ? {} : { stillRunning }),
      }) === "takeover"
    ) {
      appendPanelLog(
        "session",
        "流式的 end 帧到达，但 harness **仍在运行** —— 不宣布本轮结束，" +
          "改用轮询继续盯着（多步执行时每一步都会结束一次）",
      );
      // 接管：轮询会负责后续的增量与最终结束
      this.startPolling(sessionId);
      try {
        this.deps.emit({
          kind: "assistant-note",
          note: "Agent 仍在继续工作（多步执行）—— 界面已切换为持续跟踪，请稍候。",
        });
      } catch {
        // 界面的问题不该影响传输
      }
      return;
    }

    this.deps.emit({ kind: "assistant-end", outcome: kind });
    this.deps.emit({ kind: "status", generating: false });
  }

  private stopStream(): void {
    try {
      this.activeStream?.close();
    } catch {
      // 忽略
    }
    this.activeStream = undefined;
  }

  private onFollowFrame(frame: FollowFrame, sessionId: string): void {
    if (frame.type === "transport-error") {
      this.log(`流式传输错误：${frame.error?.message ?? "未知"}`);
      this.stopStream();
      this.startPolling(sessionId);
      return;
    }
    if (frame.type !== "item") return;
    const value = frame.value as
      | {
          type?: string;
          frame?: { type?: string; outcome?: { kind?: string } };
          event?: unknown;
        }
      | undefined;
    if (!value) return;

    if (value.type === "assistant-stream" && value.frame) {
      const inner = value.frame as {
        type?: string;
        chunk?: unknown;
        outcome?: { kind?: string };
      };
      switch (inner.type) {
        case "start":
          this.deps.emit({ kind: "assistant-start" });
          this.deps.emit({ kind: "status", generating: true });
          break;
        case "chunk":
          if (inner.chunk) {
            this.deps.emit({
              kind: "assistant-delta",
              chunk: inner.chunk as never,
            });
          }
          break;
        case "end": {
          const kind =
            inner.outcome?.kind === "committed" ? "committed" : "abandoned";
          /**
           * ⚠️ **流式 `end` 帧是"一个 step 结束了"，不是"整轮结束了"**
           * （真机缺陷：界面报「本轮结束」而 Agent 又干了 2 分多钟）
           *
           * 用户实测：界面在 14:20:22 显示「本轮结束」，而日志显示 Agent
           * **在 14:21–14:22 持续每秒一次地调用 `getFullText`** —— 它才刚开始干活。
           *
           * 这里和上一轮修的 `turn/end` 是**同一个病的两条路**：
           * 多步执行时，每一步都会结束一次（`turn/end` 一个、`assistant-stream`
           * 的 `end` 一个），而它们都**不代表这一问答完了**。
           *
           * 后果比"显示不准"严重：流一断，**界面与 Agent 完全脱节** ——
           * 之后 Agent 做的所有事（这里是一口气检查 255 条条目）
           * 界面上再也看不到，用户以为任务结束了。
           *
           * 所以收到 `end` 时先**问一次 harness**：
           *  - 它还在跑 → 不宣布结束，改由**轮询**继续盯着，
           *    并发一条说明让用户知道"还在干活"；
           *  - 它确实停了 → 才是真的结束（照旧发 `assistant-end`）。
           *
           * 与 `askInSession` 的 `decideTurnOutcome` 同一条原则：
           * **`undefined`（问不到）不能当"停了"。**
           */
          void this.endStreamStep(sessionId, kind);
          break;
        }
        default:
          break;
      }
    }
    // event / snapshot 帧：M2 起用于补齐历史与页码溯源
  }

  // ── 轮询兜底（分段实时） ─────────────────────────────────

  private startPolling(sessionId: string): void {
    if (this.pollTimer) return;
    this.pollStartedAt = Date.now();
    this.pollText = "";
    this.pollStableRounds = 0;
    // ⚠️ 必须**每轮重置**：否则第二轮的长任务不会再收到"仍在生成"的提醒
    // （标志留在上一轮的值上），用户又会以为它卡死了。
    this.longRunNoticeSent = false;
    this.setStatus({
      ready: true,
      transport: "polling",
      sessionId,
      port: this.config?.port,
    });
    this.log("流式不可用，改用 session/page 轮询");
    this.pollTimer = setInterval(() => {
      void this.pollOnce(sessionId);
    }, POLL_INTERVAL_MS) as unknown as number;
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  /**
   * 该文献的工作区里，**是否有会话正在进行**？
   *
   * ## 为什么需要（真机反馈的缺口）
   *
   * 用户："对话容易因轮询读取超时或**中途退出会话界面**而被判断为一轮对话的结束，
   * 缺乏对 harness 状态的监测表示。"
   *
   * `pollOnce` 那边已经做得很谨慎（超时先问 `running`，不确定就继续盯）——
   * **但那份知识只活在传输层实例的内存里**。用户退出会话页，面板被销毁；
   * 再回来是新实例，`state.generating` 是初始的 `false`，界面显示空闲，
   * 而 harness 那边上一轮**还在跑**。用户于是追问一句 → 轮次错乱。
   *
   * 这个方法就是给"回来时"用的：**按工作区**问一次（而不是按某个已知 sessionId，
   * 因为新实例未必知道当前该看哪个会话），把答案交给界面。
   *
   * 返回**在跑的那个**会话 id（便于界面直接接管），或 `undefined`（没人跑 / 问不到）。
   * ⚠️ 调用方不能把 `undefined` 当成"确定空闲" —— 见 `probeHarnessRunning` 的说明。
   */
  async findRunningSession(itemKey: string): Promise<string | undefined> {
    try {
      const sessions = await this.listWorkspaceSessions(itemKey);
      const running = sessions.find((s) => s.running === true);
      return running?.sessionId;
    } catch (error) {
      this.log(`查询工作区运行状态失败：${this.describeError(error)}`);
      return undefined;
    }
  }

  /**
   * 问 harness：这个会话的 agent 现在**还在跑吗**？
   *
   * ## 为什么必须是公开方法（真机反馈的缺口）
   *
   * 用户反馈："对话容易因轮询读取超时或**中途退出会话界面**而被判断为一轮对话的结束，
   * 缺乏对 harness 状态的监测表示。"
   *
   * 传输层这边其实已经处理得很谨慎（见 `pollOnce`：超时先问 `running`，
   * 不确定就继续盯）。**但那份知识只活在传输层的内存里** ——
   * 用户一旦退出会话页再回来，面板是**新实例**：
   *
   * ```text
   *   新实例的 state.generating === false（初始值）
   *   → 状态行显示"已连接 dsh"，看起来空闲
   *   → 用户以为这一轮结束了，于是追问一句
   *   → 而 harness 那边上一轮还在跑 → 轮次错乱
   * ```
   *
   * 所以这里把"问一次 harness"开放给界面：**面板挂载时先问一次**，
   * 若仍在跑就明确显示"仍在生成"，而不是显示成空闲。
   *
   * 返回三态，**调用方必须区分 `undefined` 与 `false`**：
   *  - `true`  → 确实还在跑
   *  - `false` → 确实停了
   *  - `undefined` → **问不到**（RPC 失败 / 会话不在列表里）
   *
   * 把 `undefined` 当 `false` 会在 RPC 抖动时宣布"结束了"，正是误导用户的根源。
   */
  async probeHarnessRunning(sessionId: string): Promise<boolean | undefined> {
    const client = this.client ?? (await this.connect());
    if (!client) return undefined;
    return this.harnessRunning(client, sessionId);
  }

  /**
   * 问 harness：这个会话的 agent 现在**还在跑吗**？
   *
   * `session/list` 的每一项都带 `running`（dsh 侧来自 `agent.status === "running"`，
   * 见 `packages/api/session-controller/src/list.ts`）。字段在 `SessionSummary`
   * 里其实**早就解析出来了**，只是一直没用 —— 而它正是"这一轮到底结束没有"
   * 唯一可靠的答案（比"文本连续不变"和"我们等够了"都可靠）。
   *
   * 返回 `true`/`false`/`undefined`（问不到）。**调用方必须把 `undefined` 当作
   * "不确定"，而不是"没在跑"** —— 在 RPC 抖动时宣布结束，正是误导用户的根源。
   */
  private async harnessRunning(
    client: DshClient,
    sessionId: string,
  ): Promise<boolean | undefined> {
    try {
      const result = await listSessions(client);
      const items = result.value?.items;
      if (!Array.isArray(items)) return undefined;
      const mine = items.find((s) => s.sessionId === sessionId);
      if (!mine) return undefined;
      return mine.running === true;
    } catch (error) {
      this.log(
        `查询 harness 运行状态失败（保守处理为"仍在跑"）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    }
  }

  /**
   * 超过 POLL_MAX_MS 但 harness 仍在跑时：**继续盯**，但降低查询频率。
   *
   * 为什么节流：长任务可能要跑十几分钟，没有必要每 700ms 问一次 ——
   * 那是几百次 RPC 换一个不会变的事实。这里把下一次检查推到 5 秒后。
   *
   * 同时发一条 `assistant-note`，让界面能显示"仍在生成"而不是让用户
   * 对着不动的界面猜（界面侧对它的处理见 readerPanel/sessionPage）。
   */
  private extendPollingDeadline(): void {
    // 推后一整个 POLL_MAX_MS 周期，而不是"再等 5 秒就又问一遍"——
    // 后者会让长时间任务每 5 秒走一次完整判断，日志与 RPC 都被刷满。
    this.pollStartedAt = Date.now();
    if (!this.longRunNoticeSent) {
      this.longRunNoticeSent = true;
      this.deps.emit({
        kind: "assistant-note",
        note: "这一轮仍在生成（Agent 可能正在连续调用工具）—— 请稍候，可以离开这个界面，回来还能接着看。",
      });
    }
  }

  /**
   * 轮询取一次。
   *
   * ⚠️ 关键（2026-10-02 真机实测更正）：**回答文本在 `session/projections` 里，不在
   * `session/page` 的 `records` 里。** 实测同一个已完成两轮问答的会话：
   *   - `session/page` → `records: []`（0 条）
   *   - `session/projections` → `turnOutline: [{ turn, seq, prompt, response }, …]`
   * 早先这里只读 `session/page`，于是**永远取不到文本、面板空白** —— 而模型其实已经把
   * 回答写进了会话。这是面板"看不到输出"的直接原因。
   *
   * 现在的策略：以 `turnOutline` 为正文来源，按轮累积并发出增量；
   * 结束以 `turn/end` 为准，超时前**先问 harness 还在不在跑**（见下）。
   */
  private async pollOnce(sessionId: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    // ⚠️ 超时**不再等于"这一轮结束了"**（真机反馈：长任务被误判为已完成）。
    //
    // `POLL_MAX_MS` 是"我们愿意盯着看多久"，不是"harness 干完了"。
    // Agent 多步执行（并行调工具、反复验证）很容易超过 3 分钟 —— 而那时它**还在干活**。
    // 早先直接 emit `assistant-end`，界面就显示这一轮结束了；
    // 用户接着发下一句，得到的是错乱的结果（前一问还在跑）。
    //
    // 现在的做法：超时后问一次 `session/list` 的 `running` 字段。
    //   - 仍在跑 → **继续盯**，只是把间隔放宽（省 RPC），并告知界面"仍在生成"；
    //   - 已停下 → 才是真的结束（此时按 committed 处理，正文已经在上面的分支里发过）；
    //   - 问不到（RPC 失败）→ 保守地**继续盯**，绝不在不确定时宣布结束。
    if (Date.now() - this.pollStartedAt > POLL_MAX_MS) {
      const state = await this.harnessRunning(client, sessionId);
      if (state === false) {
        // harness 明确说它不跑了 —— 这一轮确实结束了
        this.stopPolling();
        this.deps.emit({ kind: "assistant-end", outcome: "committed" });
        return;
      }
      // true（仍在跑）或 undefined（问不到）：继续等，但要节流并让界面知道
      this.extendPollingDeadline();
      return;
    }
    try {
      const turn = await this.readTurn(client, sessionId);
      if (turn) {
        if (turn.text !== this.pollText) {
          const delta = turn.text.startsWith(this.pollText)
            ? turn.text.slice(this.pollText.length)
            : turn.text;
          this.pollText = turn.text;
          if (delta.length > 0) {
            this.deps.emit({
              kind: "assistant-delta",
              chunk: { type: "text-delta", index: 0, text: delta },
            });
          }
        }
        // `turn/end` 是权威的结束信号；文本非空但长时间无 turn/end 的情况由
        // POLL_MAX_MS 兜底，不再用"文本连续不变"猜测（投影的 response 字段是截断摘要，
        // 靠它会过早或过晚收尾 —— 真机踩过）。
        //
        // ⚠️ 结束**不等于**成功：真机实测，没有模型凭据时 turn/end 立刻到来但
        // `reason.kind === "error"`，正文永远为空。只判"有文本"会让面板一直停在
        // "生成中"（按钮永远禁用），所以这里必须把错误报出去。
        if (turn.error) {
          this.stopPolling();
          this.emitFault("client/turn-failed", turn.error);
          this.deps.emit({ kind: "assistant-end", outcome: "abandoned" });
          return;
        }
        if (turn.ended) {
          this.stopPolling();
          this.deps.emit({ kind: "assistant-end", outcome: "committed" });
        }
      }
    } catch (error) {
      const code =
        error instanceof DshRpcError ? error.code : "client/poll-failed";
      if (code === "session/not-found") {
        this.stopPolling();
        this.emitFault(code, "会话已不存在，请重开面板");
      } else {
        this.log(`轮询失败：${this.describeError(error)}`);
      }
    }
  }

  /**
   * 读取"当前这一轮"的完整助手正文与是否已结束。
   *
   * ⚠️ 这是本项目最容易搞错的一处，两次真机故障都出在这里，务必按下面的链条来：
   *
   *  1. `session/projections` → 拿 **`asOfSeq`**（日志切点）与 `turnOutline`（**只有摘要，
   *     被截断到约 120 字符，不能当正文**）。
   *  2. `session/page` 的 **`throughSeq` 必须用 `asOfSeq`**（该字段注释写明"来自 follow 开场帧"）。
   *     传 `-1` 会返回 `records: []` —— 这正是"面板永远空白"的原因（实测过两次）。
   *  3. 正文在 `assistant/message` 记录的 `message.content[]` 里，
   *     **只取 `type === "text"` 的块**（`reasoning` 块是模型思考，不能显示给用户）。
   *  4. `turn/end` 事件出现即代表本轮生成结束 —— 比"文本连续不变"可靠，
   *     因为 `assistant/message` 只在一步**收尾时**才写进日志，生成期间 `turn/end` 尚未出现。
   */
  private async readTurn(
    client: DshClient,
    sessionId: string,
  ): Promise<
    | {
        text: string;
        ended: boolean;
        /** 本轮结束时的错误原因（有值即代表这一轮失败） */
        error?: string;
        /** 当前已结束到的轮次号，用于区分"上一轮的 turn/end" */
        endedTurn: number;
        /**
         * 本轮里 `ask_user_question` 提出的问题（含选项）。
         *
         * 为什么必须把它取出来：选项是**工具调用的参数**，不在 `text` 块里。
         * 早先只取 `text`，于是用户看到"有几件事要你定："却看不到选项，
         * 而模型一直阻塞等待 —— 表现为会话卡住（真机反馈过）。
         */
        questions?: AskUserQuestion[];
      }
    | undefined
  > {
    const proj = await client.call<{
      asOfSeq?: unknown;
      values?: { turnOutline?: unknown };
    }>("session/projections", { request: { sessionId } });
    const asOfSeq = proj.value?.asOfSeq;
    if (typeof asOfSeq !== "number") return undefined;

    const page = await client.call<{ records?: unknown[] }>("session/page", {
      request: {
        address: { kind: "session", sessionId },
        throughSeq: asOfSeq,
        maxMessages: 200,
      },
    });
    const records = Array.isArray(page.value?.records)
      ? page.value.records
      : [];

    let text = "";
    let ended = false;
    let error: string | undefined;
    let endedTurn = 0;
    /**
     * 诊断用：本轮每条 `assistant/message` 的**块构成**（不含正文）。
     *
     * 为什么要记（真机反复出现"看不到 Agent 列出的选项"）：取文只认
     * `content[].type === "text"`，而多步执行/工具调用时块形状可能不同
     * （工具调用块、空文本块、甚至没有 content）。只看到"内容缺了"无从判断
     * 是**没发出来**还是**我们没取到** —— 把块构成落盘，下一次一眼可辨。
     */
    const blockShapes: string[] = [];
    /** 本轮 `ask_user_question` 的问题批（含选项） */
    let questions: AskUserQuestion[] | undefined;
    /**
     * 诊断用：这一页里**轮次的边界信息**。
     *
     * ## 为什么必须记（本轮排查的教训）
     *
     * 用户反馈："（我怀疑它结束了，试探性发消息）1 —— 这里又把前面的对话内容
     * 复制了一份，说明当轮会话没有结束，但是仍然会有[本轮结束]提前出现截断输出。"
     *
     * 我有一个**合乎逻辑但无法证实**的怀疑：`readTurn` 读的是**整页历史**，
     * 里面的 `turn/end` 是"**某一轮**结束了"，不是"当前这一轮结束了" ——
     * 于是刚发完提问、新轮的 `turn/start` 还没进日志时，可能把**上一轮**的
     * 正文与结束当成本轮的，界面就提前画上「本轮结束」并重复渲染内容。
     *
     * 我据此改了 7 版轮询逻辑，**每次都引入新的测试回归，而且始终无法证实**。
     * 最后全部撤回 —— 因为我在**没有证据**的情况下改核心链路，
     * 那比不改更危险。
     *
     * 缺的正是这几个数字：**这页里有几个 turn/start、文本属于哪一轮、
     * 最后一个 turn/end 在第几条**。有了它们，"是不是拿到了上一轮的结束"
     * 一查便知，不必再猜。
     */
    const startSeqs: number[] = [];
    const endSeqs: number[] = [];
    /** 最后一条 `assistant/message` 属于第几个 `turn/start`（0 = 它之前没有 start） */
    let textAfterStartIndex = 0;
    let startCount = 0;
    for (const record of records) {
      const event = (
        record as { event?: { type?: unknown; data?: unknown } } | undefined
      )?.event;
      const type = typeof event?.type === "string" ? event.type : "";
      if (type === "turn/end") {
        ended = true;
        const seq = (event as { seq?: unknown } | undefined)?.seq;
        if (typeof seq === "number") endSeqs.push(seq);
        const data = event?.data as
          | {
              turn?: unknown;
              reason?: { kind?: unknown; error?: { message?: unknown } };
            }
          | undefined;
        if (typeof data?.turn === "number") endedTurn = data.turn;
        // ⚠️ 结束不等于成功。真机实测：没有模型凭据时 turn/end 立刻到来，
        // 但 reason.kind === "error"，正文永远为空 —— 只看 ended 会一直空转到超时。
        const reason = data?.reason;
        if (reason && reason.kind === "error") {
          const message =
            typeof reason.error?.message === "string"
              ? reason.error.message
              : "本轮以错误结束（未提供原因）";
          error = message;
        }
      }
      if (type === "turn/start") {
        startCount += 1;
        const sseq = (event as { seq?: unknown } | undefined)?.seq;
        if (typeof sseq === "number") startSeqs.push(sseq);
        text = "";
        ended = false;
        error = undefined;
        // ⚠️ `questions` 也必须一起清空。
        //
        // 真机反馈"每次发消息，之前已经回答过的选择题又出现"：
        // 这几行是**每轮开始时的重置**，而我加 `questions` 时漏了它 ——
        // 于是上一轮的提问一直留着，每个新轮次都被重新上报一次。
        // **以后新增任何"本轮状态"字段，都要同时改这里。**
        questions = undefined;
      }
      if (type !== "assistant/message") continue;
      const data = event?.data as
        | { message?: { role?: unknown; content?: unknown } }
        | undefined;
      const content = data?.message?.content;
      // ⚠️ 顺手把 `ask_user_question` 的问题取出来 —— 选项在**工具调用的参数**里，
      // 不在 text 块里。只取 text 就会让"用户看到提问却看不到选项"，模型则一直阻塞。
      if (Array.isArray(content)) {
        for (const part of content) {
          const p = part as {
            type?: unknown;
            name?: unknown;
            input?: unknown;
            arguments?: unknown;
          };
          if (p?.type !== "tool-call") continue;
          const parsed = parseAskUserQuestions(p.name, p.input ?? p.arguments);
          if (parsed && parsed.length > 0) questions = parsed;
        }
      }
      // 诊断：记下每条的块类型构成（不含正文），供"看不到内容"时判断是没发还是没取到
      if (blockShapes.length < 12) {
        blockShapes.push(
          Array.isArray(content)
            ? content
                .map((p) => {
                  const part = p as {
                    type?: unknown;
                    text?: unknown;
                    name?: unknown;
                    input?: unknown;
                    arguments?: unknown;
                  };
                  const len =
                    typeof part?.text === "string" ? part.text.length : 0;
                  // ⚠️ 工具块要记**工具名**：真机上用户问"Agent 给了选项但我看不到"，
                  // 而 dsh 的选项很可能是**某个工具调用的参数**（前端渲染成可点选项）——
                  // 若如此，我们只取 text 块就会把选项整段丢掉。
                  if (part?.type === "tool-call") {
                    const name =
                      typeof part.name === "string" ? part.name : "?";
                    const raw = part.input ?? part.arguments;
                    const argLen =
                      typeof raw === "string"
                        ? raw.length
                        : raw
                          ? JSON.stringify(raw).length
                          : 0;
                    return `tool-call:${name}(${argLen})`;
                  }
                  return `${String(part?.type)}(${len})`;
                })
                .join(",")
            : "no-content",
        );
      }
      if (!Array.isArray(content)) continue;
      const parts = content
        .filter(
          (part): part is { type?: unknown; text?: unknown } =>
            typeof part === "object" && part !== null,
        )
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string);
      // ⚠️ 之前是 `text = parts.join("")` —— **取最后一条**。
      //
      // 多步执行（调用工具）时一轮里会有多条 `assistant/message`：
      // Agent 常在前一条里列出选项、在后一条里问"选哪个"。取最后一条就会把
      // **选项整段丢掉**，用户只看到"有几个决定要你拍板："——
      // 真机反复反馈的"看不到选项"就是这个。
      // 现在与历史分支用同一套合并逻辑（重发式替换 / 累积式追加）。
      if (parts.length > 0) {
        text = mergeResponseText(text, parts.join(""));
        textAfterStartIndex = startCount;
      }
    }
    // ⚠️ 诊断必须用 `appendPanelLog`（**落盘**），不能用 `this.log`。
    //
    // `this.log` 走的是 `deps.log` → Zotero 调试输出，在会话外**读不到** ——
    // 我上一版把诊断写成 `this.log`，结果它压根没进面板日志文件，
    // 我拿不到证据又只能猜。本项目早就定过规矩：诊断一律落盘。
    //
    // 另外**只在快照变化时记**：`readTurn` 是每 700ms 轮询调用的，
    // 不去重就会每 700ms 刷一行相同内容（真机日志 356 行里 354 行都是它，
    // 把真正有用的历史全挤掉了）。
    //
    // 记**正文尾部**是为了定位"看不到选项"：只有长度与尾部同时落盘，
    // 才能判断"选项没发出来"还是"发了但我们没取到/没显示"。
    // 尾部只取最后 80 字 —— 够看到"决定要你拍板：1. … 2. …"这类结构，
    // 又不至于把用户正文大量写进日志。
    if (blockShapes.length > 0) {
      const tail = text.slice(-80).replace(/\s+/g, " ");
      const snapshot =
        `${blockShapes.join(" ｜ ")}；正文 ${text.length} 字；尾部「${tail}」；已结束=${ended}` +
        `；start=${startCount}个@[${startSeqs.slice(-3).join(",")}]` +
        `；end@[${endSeqs.slice(-3).join(",")}]` +
        `；文本属于第${textAfterStartIndex}个start（共${startCount}个）`;
      if (this.lastBlockShapeLog !== snapshot) {
        this.lastBlockShapeLog = snapshot;
        appendPanelLog(
          "session",
          `本轮 assistant 块构成（${blockShapes.length} 条）：${snapshot}`,
        );
      }
    }
    return { text, ended, error, endedTurn, questions };
  }

  /** 上一次记录的块构成快照：用于去重，避免轮询时反复刷同一行 */
  private lastBlockShapeLog = "";
  // ── 小工具 ──────────────────────────────────────────────

  private emitFault(code: string, message: string): void {
    this.setStatus({ ready: false, error: message, port: this.config?.port });
    this.deps.emit({ kind: "fault", code, message });
  }

  private describeError(error: unknown): string {
    if (error instanceof DshRpcError) {
      const hint =
        error.httpStatus === 401
          ? "（认证未通过：cookie 未生效或密钥已轮换）"
          : error.httpStatus === 403
            ? "（信任检查拒绝）"
            : error.code === "client/network"
              ? "（端口不可达：dsh 没在运行？）"
              : "";
      return `${error.code}: ${error.message}${hint}`;
    }
    return error instanceof Error ? error.message : String(error);
  }

  private newRequestId(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  private timeZone(): string | undefined {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return undefined;
    }
  }

  /** 面板显示用户消息时，把提示词里的"问题"部分抽出来（提示词自带上下文前缀） */
  private questionFromPrompt(prompt: string): string {
    const marker = "\n\n【我的问题】";
    const at = prompt.lastIndexOf(marker);
    return at >= 0 ? prompt.slice(at + marker.length).trim() : prompt;
  }
}
