/**
 * DSH 本地 RPC 客户端（一元调用）。
 *
 * 线协议（docs/DSH集成与桥接协议.md §4）：
 *   请求  POST /api/<namespace>/<method>
 *         { "type":"client-request", "rpcId":"<uuid>", "method":"<ns>/<m>", "payload": { "args": {...} } }
 *   响应  { "type":"server-response", "rpcId":"…", "result": { "ok":true, "value":… } }
 *         或 { … "result": { "ok":false, "error": { code, message, details } } }
 *
 * 三个必须记住的点（均已在真机验证）：
 *  1. **业务失败也返回 HTTP 200** —— 成败只看 `result.ok`；
 *  2. 路径必须恰好两段，`method` 必须与 URL 末尾一致，否则 404 / gateway/bad-request；
 *  3. 认证必须带 cookie；`Cookie` 是 fetch 的禁止头，所以优先写 cookie 罐，回退用 XHR 显式设头。
 */

import type { AuthCookie } from "./auth";
import { clearCookieFromJar, putCookieInJar } from "./auth";
import { decodeBase64UrlToString } from "./base64url";
import type { DshRuntimeConfig } from "./config";

export type DshCookieDelivery = "cookie-jar" | "xhr-header";

/**
 * RPC 调用失败。
 *
 * ## 调用者必须分清的两类失败（这决定了怎么向用户解释）
 *
 * | 情形 | `code` | 含义 | 该怎么做 |
 * | --- | --- | --- | --- |
 * | HTTP 非 2xx，或响应不是合法信封 | `rpc/http-<status>` / `rpc/bad-envelope` | **通道**问题 | 检查运行时是否还在、cookie 是否过期（`refreshCookie` 会自愈一次） |
 * | HTTP 200 但信封里 `ok: false` | **服务端给的业务码**（原样带出） | **业务**问题 | 直接看 `message`，通常是参数或状态不对 |
 *
 * ⚠️ **不要一律当成"dsh 挂了"**：业务失败也是 HTTP 200，只看到状态码会误判。
 * 早期实现就有过"把所有失败都报成运行时未就绪"，让排查方向完全跑偏。
 *
 * `details` 保留服务端原始附加信息，`httpStatus` 便于日志里对齐抓包。
 */
export class DshRpcError extends Error {
  readonly code: string;
  readonly details?: unknown;
  readonly httpStatus?: number;

  constructor(
    code: string,
    message: string,
    options: { details?: unknown; httpStatus?: number } = {},
  ) {
    super(message);
    this.name = "DshRpcError";
    this.code = code;
    this.details = options.details;
    this.httpStatus = options.httpStatus;
  }
}

export interface DshCallResult<T> {
  value: T;
  httpStatus: number;
  /** 实际使用的 cookie 投递方式（诊断用） */
  delivery: DshCookieDelivery;
  rpcId: string;
}

function newRpcId(): string {
  const random = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(random, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface ServerResponse {
  type?: string;
  rpcId?: string;
  result?: {
    ok?: boolean;
    value?: unknown;
    error?: { code?: string; message?: string; details?: unknown };
  };
}

/** 把响应体解析成结果或抛错 */
function interpret<T>(
  response: ServerResponse,
  httpStatus: number,
  rpcId: string,
  delivery: DshCookieDelivery,
): DshCallResult<T> {
  const result = response?.result;
  if (result?.ok === true) {
    return { value: result.value as T, httpStatus, delivery, rpcId };
  }
  if (result?.ok === false) {
    const err = result.error ?? {};
    throw new DshRpcError(
      err.code ?? "gateway/unknown",
      err.message ?? "DSH 返回了失败结果",
      {
        details: err.details,
        httpStatus,
      },
    );
  }
  throw new DshRpcError(
    "gateway/malformed",
    "DSH 响应不是合法的 server-response 信封",
    {
      details: { keys: Object.keys(response ?? {}) },
      httpStatus,
    },
  );
}

export interface DshClientOptions {
  config: DshRuntimeConfig;
  cookie: AuthCookie;
  /** 强制走某条 cookie 通道（诊断/自检用） */
  forceDelivery?: DshCookieDelivery;
  /**
   * 401 时重新获取 cookie 的回调（重读凭据文件并重签）。
   *
   * 为什么需要：dsh 的宿主进程重启后会换成新一套会话密钥，此时旧 cookie 一律 401。
   * 实测（2026-10-02）：宿主 13:53 重启，插件在 13:51 自检拿到 401，
   * 而用同一份凭据现签的 cookie 立刻又是 200 —— 说明**服务端没问题，是 cookie 陈旧**。
   * 有了这个回调，插件遇到 401 会自己重签并重试一次，不必等用户重启 Zotero。
   */
  refreshCookie?: () => Promise<AuthCookie | undefined>;
}

/**
 * 一元 RPC 客户端。
 * 首次调用时自动选择 cookie 投递方式：先写 cookie 罐（若成功则用 fetch），否则退回 XHR 显式设头。
 */
export class DshClient {
  private readonly config: DshRuntimeConfig;
  private cookie: AuthCookie;
  private delivery: DshCookieDelivery;
  private jarWritten = false;
  private readonly refreshCookie?: () => Promise<AuthCookie | undefined>;
  /** 是否已经为 401 重签过一次（避免循环） */
  private refreshedOnce = false;

  constructor(options: DshClientOptions) {
    this.config = options.config;
    this.cookie = options.cookie;
    this.delivery = options.forceDelivery ?? "cookie-jar";
    this.refreshCookie = options.refreshCookie;
  }

  get currentDelivery(): DshCookieDelivery {
    return this.delivery;
  }

  /**
   * 诊断用：把**实际会发出去的请求要素**暴露出来。
   *
   * 为什么需要：真机上出现过"同一份凭据、同一时刻，外部脚本签的 cookie 是 200、
   * 插件自己的请求是 401"。此时唯一能定位的办法是把插件**实际用的**
   * URL / authority / cookie 名 / 载荷形状摊开看，而不是继续推断。
   */
  describeRequest(): {
    baseUrl: string;
    authority: string;
    cookieName: string;
    /** 完整 cookie 值：取证要判断"同一个 token 为何一边 200 一边 401" */
    cookieValue: string;
    cookieValueLength: number;
    cookieHeaderLength: number;
    payloadKeys: string[];
    issuedAtDigits: number;
    expiresAtDigits: number;
  } {
    const parts = this.cookie.value.split(".");
    let payloadKeys: string[] = [];
    let issuedAtDigits = 0;
    let expiresAtDigits = 0;
    try {
      const json = decodeBase64UrlToString(parts[1] ?? "") ?? "";
      const parsed = JSON.parse(json) as Record<string, unknown>;
      payloadKeys = Object.keys(parsed).sort();
      issuedAtDigits = String(parsed.issuedAt ?? "").length;
      expiresAtDigits = String(parsed.expiresAt ?? "").length;
    } catch {
      // 解析失败就留空
    }
    return {
      baseUrl: this.config.baseUrl,
      authority: this.config.authority,
      cookieName: this.cookie.name,
      cookieValue: this.cookie.value,
      cookieValueLength: this.cookie.value.length,
      cookieHeaderLength: this.cookie.header.length,
      payloadKeys,
      issuedAtDigits,
      expiresAtDigits,
    };
  }

  /** 尝试把 cookie 写进 cookie 罐；失败则把投递方式降级为 XHR */
  prepare(): { delivery: DshCookieDelivery; jarError?: string } {
    if (this.delivery === "xhr-header") return { delivery: this.delivery };
    if (this.jarWritten) return { delivery: this.delivery };
    try {
      putCookieInJar(this.cookie, this.config);
      this.jarWritten = true;
      return { delivery: this.delivery };
    } catch (error) {
      this.delivery = "xhr-header";
      return {
        delivery: this.delivery,
        jarError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** 清理写进 cookie 罐的条目（卸载时调用） */
  dispose(): void {
    if (!this.jarWritten) return;
    try {
      clearCookieFromJar(this.config);
    } catch {
      // 忽略
    }
    this.jarWritten = false;
  }

  async call<T = unknown>(
    method: string,
    args: Record<string, unknown> = {},
  ): Promise<DshCallResult<T>> {
    this.prepare();
    const rpcId = newRpcId();
    const url = `${this.config.baseUrl}/api/${method}`;
    const body = JSON.stringify({
      type: "client-request",
      rpcId,
      method,
      payload: { args },
    });

    try {
      return await this.send<T>(url, body, rpcId);
    } catch (error) {
      // 401 说明 cookie 不被当前宿主认可（宿主重启换密钥、或换了 dsh 实例）。
      // 重读凭据、重签 cookie，再试一次；只试一次，避免死循环。
      if (
        !this.isUnauthorized(error) ||
        !this.refreshCookie ||
        this.refreshedOnce
      )
        throw error;
      this.refreshedOnce = true;
      const fresh = await this.refreshCookie();
      if (!fresh) throw error;
      this.cookie = fresh;
      this.jarWritten = false;
      this.prepare();
      return this.send<T>(url, body, rpcId);
    }
  }

  /** 判断错误是否为 401（认证失败） */
  private isUnauthorized(error: unknown): boolean {
    const status = (error as { httpStatus?: number } | undefined)?.httpStatus;
    if (status === 401) return true;
    const message = error instanceof Error ? error.message : String(error);
    return /\b401\b|unauthorized/i.test(message);
  }

  private send<T>(
    url: string,
    body: string,
    rpcId: string,
  ): Promise<DshCallResult<T>> {
    return this.delivery === "cookie-jar"
      ? this.callViaFetch<T>(url, body, rpcId)
      : this.callViaXhr<T>(url, body, rpcId);
  }

  private async callViaFetch<T>(
    url: string,
    body: string,
    rpcId: string,
  ): Promise<DshCallResult<T>> {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const text = await response.text();
    let json: ServerResponse;
    try {
      json = JSON.parse(text) as ServerResponse;
    } catch {
      throw new DshRpcError(
        "gateway/non-json",
        `DSH 返回了非 JSON 响应（HTTP ${response.status}）`,
        {
          details: { excerpt: text.slice(0, 200) },
          httpStatus: response.status,
        },
      );
    }
    return interpret<T>(json, response.status, rpcId, "cookie-jar");
  }

  private callViaXhr<T>(
    url: string,
    body: string,
    rpcId: string,
  ): Promise<DshCallResult<T>> {
    return new Promise<DshCallResult<T>>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url, true);
      xhr.setRequestHeader("content-type", "application/json");
      // 沙箱里没有 AbortController，超时靠 XHR 自带的 timeout
      xhr.timeout = this.config.requestTimeoutMs;
      try {
        xhr.setRequestHeader("Cookie", this.cookie.header);
      } catch (error) {
        reject(
          new DshRpcError(
            "client/cookie-header-rejected",
            `XHR 无法设置 Cookie 头：${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }
      xhr.onload = () => {
        const responseText = xhr.responseText ?? "";
        let json: ServerResponse;
        try {
          json = JSON.parse(responseText) as ServerResponse;
        } catch {
          reject(
            new DshRpcError(
              "gateway/non-json",
              `DSH 返回了非 JSON 响应（HTTP ${xhr.status}）`,
              {
                details: { excerpt: responseText.slice(0, 200) },
                httpStatus: xhr.status,
              },
            ),
          );
          return;
        }
        try {
          resolve(interpret<T>(json, xhr.status, rpcId, "xhr-header"));
        } catch (error) {
          reject(error);
        }
      };
      xhr.onerror = () =>
        reject(
          new DshRpcError(
            "client/network",
            "连接 DSH 失败（端口不可达或被拒绝）",
          ),
        );
      xhr.ontimeout = () =>
        reject(
          new DshRpcError(
            "client/timeout",
            `请求超时（${this.config.requestTimeoutMs}ms）`,
          ),
        );
      xhr.send(body);
    });
  }
}

// ── 会话接口的类型与薄封装 ──────────────────────────────────────

export interface SessionSummary {
  sessionId: string;
  updatedAt?: number;
  running?: boolean;
  blank?: boolean;
  agentAvailable?: boolean;
  cwd?: string;
  [key: string]: unknown;
}

export interface SessionCreateValue {
  sessionId: string;
  agentPreset?: string;
}

export interface SessionPromptValue {
  accepted: boolean;
}

/** 连通性/登录自检：POST /api/session/list，参数名是 `_request`（已核实） */
export async function listSessions(
  client: DshClient,
): Promise<DshCallResult<{ items: SessionSummary[] }>> {
  return client.call<{ items: SessionSummary[] }>("session/list", {
    _request: {},
  });
}

/** 创建或恢复会话：cwd 与 workspaceId 互斥；带 sessionId 即恢复（cwd 必须一致） */
export async function createSession(
  client: DshClient,
  request: {
    cwd?: string;
    sessionId?: string;
    agentPreset?: string;
    workspaceId?: string;
  },
): Promise<DshCallResult<SessionCreateValue>> {
  return client.call<SessionCreateValue>("session/create", { request });
}

/** 投递一条用户输入；requestId 是幂等键 */
export async function promptSession(
  client: DshClient,
  request: {
    requestId: string;
    sessionId: string;
    mode: "queue" | "steer";
    content: Array<Record<string, unknown>>;
    clientTimeZone?: string;
  },
): Promise<DshCallResult<SessionPromptValue>> {
  return client.call<SessionPromptValue>("session/prompt", { request });
}

/** 取消当前回合（不会触发 resume；没有活跃 agent 时抛 session/not-found） */
export async function cancelSession(
  client: DshClient,
  sessionId: string,
): Promise<DshCallResult<SessionPromptValue>> {
  return client.call<SessionPromptValue>("session/cancel", {
    request: { sessionId },
  });
}

// ── 模型选择（推理等级） ────────────────────────────────────────

/** 一个可选的推理等级（由模型自己声明，不是我们写死的） */
export interface ModelReasoningEffort {
  id: string;
  name: string;
  description?: string;
}

/** 某个模型支持的推理等级与默认值 */
export interface ModelReasoning {
  efforts: ModelReasoningEffort[];
  defaultEffort?: string;
}

/** 目录里的一个模型 */
export interface ModelCatalogModel {
  id: string;
  name: string;
  description?: string;
  reasoning?: ModelReasoning;
}

/** 一个 provider 及其可用模型 */
export interface ModelProviderGroup {
  id: string;
  name: string;
  models: ModelCatalogModel[];
}

/**
 * 模型目录。
 *
 * ## 为什么用它而不是在设置页写死选项
 *
 * **可选模型与推理等级都是模型自己声明的**（dsh 侧由适配器提供）。写死一份的话，
 * 模型换了、等级加了，设置页就会给出宿主根本不接受的取值 —— 而失败是静默的
 * （`selectModel` 抛错、用户只看到"没生效"）。
 *
 * 实测 `deepseek-official` 的等级是 `off` / `low` / `high` / `max`（默认 `high`），
 * 但这个结论来自 dsh 源码，**不该由插件固化**。
 */
export interface ModelCatalog {
  default: { provider?: string; model?: string; reasoningEffort?: string };
  routableProviders: string[];
  groups: ModelProviderGroup[];
  /** 加载失败的 provider（例如没有凭据）—— 设置页要如实显示 */
  failures: Array<{ id: string; name: string; message: string }>;
}

/** 取模型目录（设置页据此填充下拉框） */
export async function fetchModelCatalog(
  client: DshClient,
): Promise<DshCallResult<ModelCatalog>> {
  return client.call<ModelCatalog>("session/modelCatalog", {});
}

/**
 * 为某条会话选定模型与推理等级。
 *
 * ⚠️ dsh 侧的注释写明要"**显式恢复该会话**"之后再选 —— 所以调用方应先
 * `session/create`（带 sessionId 即恢复），再调这个。
 *
 * `reasoningEffort` 省略时用模型的默认等级；传了宿主不接受的值会抛错，
 * 所以设置页的取值只能来自 {@link fetchModelCatalog}。
 */
export async function selectSessionModel(
  client: DshClient,
  request: {
    sessionId: string;
    provider: string;
    model: string;
    reasoningEffort?: string;
  },
): Promise<DshCallResult<{ selected: Record<string, unknown> }>> {
  return client.call<{ selected: Record<string, unknown> }>(
    "session/selectModel",
    { request },
  );
}

export { newRpcId };
