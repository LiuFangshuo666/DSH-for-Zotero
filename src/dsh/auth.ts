/**
 * DSH 本地 API 认证。
 *
 * 协议（packages/client/connection/src/browser-auth.ts，见 docs/DSH集成与桥接协议.md §3）：
 *   authority = Host 头的 host[:port]，如 "127.0.0.1:19387"
 *   cookie 名 = "dsh-auth-" + b64url( SHA-256(authority) )
 *   payload   = { version: 1, authority, issuedAt, expiresAt }
 *   body      = b64url( JSON.stringify(payload) )
 *   cookie 值 = "v1." + body + "." + b64url( HMAC-SHA256(secret, body) )
 *   secret    = $DSH_HOME/.credentials.yaml 的 client-connection/browser-session 记录
 *
 * 关键沙箱约束（docs §7）：
 *  1. `Cookie` 是 fetch 的禁止头 → 必须走 cookie 罐（Services.cookies）或 XHR 的 setRequestHeader；
 *  2. 沙箱里没有 AbortController → 超时用 XHR.timeout 或 fetch+Promise.race。
 */

import { encodeBase64Url, encodeBase64UrlString } from "./base64url";
import { credentialsPath, type DshRuntimeConfig } from "./config";
import { BROWSER_SESSION_RECORD, readCredentials } from "./credentials";
import { decodeSecret, hmacSha256, sha256 } from "./crypto";

export interface AuthCookie {
  name: string;
  value: string;
  /** Cookie 头形式：name=value */
  header: string;
  expiresAt: number;
  /** 凭据来源：目前只有“读 .credentials.yaml 自签”一种 */
  source: "credentials";
}

export interface CookieParts {
  name: string;
  payload: {
    version: 1;
    authority: string;
    issuedAt: number;
    expiresAt: number;
  };
  body: string;
}

/** cookie 名：dsh-auth-<b64url(sha256(authority))> */
export async function cookieNameFor(authority: string): Promise<string> {
  const digest = await sha256(new TextEncoder().encode(authority));
  return "dsh-auth-" + encodeBase64Url(digest);
}

/** 构造待签名部分（纯逻辑，便于单测） */
export function buildCookieParts(
  authority: string,
  name: string,
  issuedAt: number,
  expiresAt: number,
): CookieParts {
  return {
    name,
    payload: { version: 1, authority, issuedAt, expiresAt },
    body: encodeBase64UrlString(
      JSON.stringify({ version: 1, authority, issuedAt, expiresAt }),
    ),
  };
}

/** 用密钥对 body 签名，产出完整 cookie 值 */
export async function signCookieValue(
  secret: Uint8Array,
  parts: CookieParts,
): Promise<string> {
  const signature = await hmacSha256(
    secret,
    new TextEncoder().encode(parts.body),
  );
  return `v1.${parts.body}.${encodeBase64Url(signature)}`;
}

const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // dsh 默认 30 天

/**
 * 通过读取凭据密钥自签 cookie（首选方式，全自动）。
 * 失败时返回带原因的 error，由上层决定是否回退到 token 方式。
 */
export async function mintCookieFromCredentials(
  config: DshRuntimeConfig,
): Promise<{
  cookie?: AuthCookie;
  error?: string;
  details?: Record<string, unknown>;
}> {
  const path = credentialsPath(config.dshHome);
  const parsed = await readCredentials(path);
  if (!parsed.exists) {
    return {
      error: `读不到凭据文件：${path}`,
      details: { path, recordKeys: parsed.recordKeys, readError: parsed.error },
    };
  }
  if (!parsed.secret) {
    return {
      error: `凭据文件里没有 ${BROWSER_SESSION_RECORD} 的 secret`,
      details: { path, recordKeys: parsed.recordKeys },
    };
  }
  const secret = decodeSecret(parsed.secret);
  if (!secret) {
    return {
      error: "凭据里的 secret 不是 32 字节的 base64url",
      details: {
        path,
        secretLength: parsed.secret.length,
        quoted: parsed.secretWasQuoted,
      },
    };
  }

  const issuedAt = Date.now();
  const expiresAt = issuedAt + COOKIE_MAX_AGE_MS;
  const name = await cookieNameFor(config.authority);
  const parts = buildCookieParts(config.authority, name, issuedAt, expiresAt);
  const value = await signCookieValue(secret, parts);
  return {
    cookie: {
      name,
      value,
      header: `${name}=${value}`,
      expiresAt,
      source: "credentials",
    },
  };
}

// ⚠️ 这里原有 `mintCookieFromToken`（用启动 token 换 cookie）。
// 它只服务于共享模式的回退路径，而那条路已随共享模式删除，
// 现在没有任何调用点。隔离模式下认证只有“读凭据自签”一条路。

// ⚠️ 这里原有 `extractTokenFromLaunchUrl`（从**用户粘贴的**启动 URL 里取 token）。
// 它只服务于共享模式的"token 换 cookie"回退 —— 那条路已随共享模式一起删除，
// 且 `config.launchUrl` 现在恒为空，所以它没有任何调用点。
//
// 注意区分：运行时**读宿主自己打印的启动 URL**（`launchUrlFile` / `RuntimeStatus.launchUrl`）
// 仍然有效，那是会话页 URL 要用它的 token —— 与本函数无关，别一起删。

// ── cookie 投递方式（三种，按可用性尝试） ────────────────────────────

/**
 * `nsICookie` / `nsICookieManager` 的常量。
 * 插件沙箱**没有注入 `Ci`**（只有 Zotero 自身代码能用），所以这里写字面量。
 * 取值见 nsICookie.idl：SAMESITE_NONE=0 / LAX=1 / STRICT=2。
 */
const SAMESITE_STRICT = 2;

/** 上一次成功写罐所用的签名标签（自检展示用） */
let lastJarSignature: string | undefined;

export function lastCookieJarSignature(): string | undefined {
  return lastJarSignature;
}

/**
 * 把 cookie 写进 cookie 罐：之后 fetch **与 WebSocket 握手**都会自动携带。
 * 这是绕过"Cookie 是 fetch 禁止头"的首选方案。
 *
 * 为什么需要自适应（实测教训，见 docs/DSH集成与桥接协议.md §7.1）：
 * `nsICookieManager.add` 的实现在 C++ 层、源码不在 omni.ja 里，无法静态核对参数表。
 * Zotero 10.0.5 实测报 `NS_ERROR_XPC_NOT_ENOUGH_ARGS`，说明参数个数不足；
 * Gecko 140 在首位多了 originAttributes，尾部还有可选的 partitionKey。
 * 因此这里**探测着试**：先按新序试 11 参，报"参数不够"就补一个参数继续，
 * 再退回旧序；任一成功即记住用的哪种，全部失败由上层回退 XHR 显式设头。
 */
export function putCookieInJar(
  cookie: AuthCookie,
  config: DshRuntimeConfig,
): void {
  const host = config.authority.split(":")[0] ?? "127.0.0.1";
  const expiry = Math.floor(
    (cookie.expiresAt || Date.now() + COOKIE_MAX_AGE_MS) / 1000,
  );
  const cookies = Services.cookies as unknown as {
    add?: (...args: unknown[]) => void;
  };
  if (typeof cookies?.add !== "function") {
    throw new Error("Services.cookies.add 不可用");
  }

  const newOrder = (trailing: unknown[]): unknown[] => [
    // 第一个参数在 Gecko 140 是 originAttributes（OriginAttributes 字典）。
    // 传 {} 是可接受的"默认值"写法，但要给 duration/expiry 用整数。
    {},
    host,
    "/",
    cookie.name,
    cookie.value,
    false, // isSecure（本机 http）
    true, // isHttpOnly
    false, // isSession
    expiry,
    SAMESITE_STRICT,
    ...trailing,
  ];

  const oldOrder = (extra: number): unknown[] => {
    const args: unknown[] = [
      host,
      "/",
      cookie.name,
      cookie.value,
      false,
      true,
      false,
      expiry,
    ];
    if (extra >= 1) args.push({}); // originAttributes
    if (extra >= 2) args.push(SAMESITE_STRICT);
    return args;
  };

  /**
   * 关键线索（真机实测，2026-10-02）：
   *  - 10 参 → `NS_ERROR_XPC_NOT_ENOUGH_ARGS`（**参数个数不足**）
   *  - 11/12 参 → `NS_ERROR_ILLEGAL_VALUE`（**个数对了，但某个值非法**）
   * 即：11 参才是正确个数，问题出在第 11 个参数（partitionKey）的**取值**上。
   * 之前一律传 `{}`，对 partitionKey 而言不是合法值（它要么是 null，要么是字符串形式的
   * 分区键）。因此这一轮把第 11 参的各种可能取值都试一遍，并同时试 originAttributes
   * 的几种写法 —— 每多试一种只花一次调用，代价极低。
   */
  const partitionKeyVariants: Array<{ label: string; value: unknown }> = [
    { label: "null", value: null },
    { label: "undefined", value: undefined },
    { label: "空字符串", value: "" },
    { label: "空对象", value: {} },
  ];
  const originVariants: Array<{ label: string; value: unknown }> = [
    { label: "{}", value: {} },
    { label: "null", value: null },
  ];

  const attempts: Array<{ label: string; args: unknown[] }> = [];
  for (const oa of originVariants) {
    for (const pk of partitionKeyVariants) {
      const args = newOrder([pk.value]);
      args[0] = oa.value;
      attempts.push({
        label: `11 参（origin=${oa.label}, partitionKey=${pk.label}）`,
        args,
      });
    }
  }
  // 再补两个"个数明确不足"的已知形态，保留诊断信息
  attempts.push({
    label: "10 参（新序，无 partitionKey）",
    args: newOrder([]),
  });
  attempts.push({
    label: "10 参（旧序 + originAttributes + sameSite）",
    args: oldOrder(2),
  });
  attempts.push({
    label: "9 参（旧序 + originAttributes）",
    args: oldOrder(1),
  });
  attempts.push({ label: "8 参（旧序）", args: oldOrder(0) });

  const failures: string[] = [];
  for (const attempt of attempts) {
    try {
      // 逐参截断会误导，这里把参数个数也记进失败原因
      cookies.add(...attempt.args);
      lastJarSignature = attempt.label;
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 只保留错误代号，避免把一大段 XPConnect 文本塞进自检结果
      const code =
        /NS_ERROR_[A-Z_]+/.exec(message)?.[0] ?? message.slice(0, 60);
      failures.push(`${attempt.label}: ${code}`);
    }
  }
  lastJarSignature = undefined;
  throw new Error(
    `cookie 罐写入失败（试了 ${attempts.length} 种参数形态）：${failures.join(" | ")}`,
  );
}

/**
 * 列出 cookie 罐里本插件的 dsh-auth cookie。
 *
 * 注意：`Services.cookies.getCookiesFromHost()` 返回的是**数组**（Zotero 自身用法见
 * `xpcom/browserRequest.js:231` 的 `for (let cookie of cookies)`），不是 XPCOM 枚举器——
 * 曾经按枚举器用 `hasMoreElements()`，实测报 "is not a function"。这里两种都兼容。
 */
function listDshCookies(config: DshRuntimeConfig): {
  readable: boolean;
  cookies: Array<{ name: string; path: string }>;
  error?: string;
} {
  const host = config.authority.split(":")[0] ?? "127.0.0.1";
  const cookies = Services.cookies as unknown as {
    getCookiesFromHost?: (host: string, oa: object) => unknown;
  };
  if (typeof cookies?.getCookiesFromHost !== "function") {
    return { readable: false, cookies: [], error: "getCookiesFromHost 不可用" };
  }
  try {
    const result = cookies.getCookiesFromHost(host, {}) as unknown;
    const items: unknown[] = [];
    if (Array.isArray(result)) {
      items.push(...result);
    } else if (
      result &&
      typeof (result as { hasMoreElements?: unknown }).hasMoreElements ===
        "function"
    ) {
      const enumerator = result as {
        hasMoreElements(): boolean;
        getNext(): unknown;
      };
      while (enumerator.hasMoreElements()) items.push(enumerator.getNext());
    } else if (
      result &&
      typeof (result as { [Symbol.iterator]?: unknown })[Symbol.iterator] ===
        "function"
    ) {
      for (const item of result as Iterable<unknown>) items.push(item);
    }
    const found: Array<{ name: string; path: string }> = [];
    for (const item of items) {
      const name = (item as { name?: unknown })?.name;
      if (typeof name === "string" && name.startsWith("dsh-auth-")) {
        found.push({
          name,
          path: String((item as { path?: unknown })?.path ?? "/"),
        });
      }
    }
    return { readable: true, cookies: found };
  } catch (error) {
    return {
      readable: false,
      cookies: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 探测 cookie 罐里是否已有本插件的 dsh-auth cookie（只读；用于自检报告实况） */
export function inspectJarForDshCookie(config: DshRuntimeConfig): {
  readable: boolean;
  found: boolean;
  names: string[];
  error?: string;
} {
  const listed = listDshCookies(config);
  return {
    readable: listed.readable,
    found: listed.cookies.length > 0,
    names: listed.cookies.map((c) => c.name),
    error: listed.error,
  };
}

/** 从 cookie 罐移除本插件写入的 cookie（卸载/切换端口时清理）；返回移除条数 */
export function clearCookieFromJar(config: DshRuntimeConfig): number {
  const host = config.authority.split(":")[0] ?? "127.0.0.1";
  const cookies = Services.cookies as unknown as {
    remove?: (host: string, path: string, name: string, oa: object) => void;
  };
  if (typeof cookies?.remove !== "function") return 0;

  const listed = listDshCookies(config);
  let removed = 0;
  for (const cookie of listed.cookies) {
    try {
      cookies.remove(host, cookie.path, cookie.name, {});
      removed++;
    } catch {
      // 单条失败不影响其余
    }
  }
  return removed;
}
