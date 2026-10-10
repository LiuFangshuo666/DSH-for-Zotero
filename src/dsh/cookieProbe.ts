/**
 * cookie 罐写入的离线探针：一次性试完参数形态矩阵，把结论写进启动诊断文件。
 *
 * 为什么单独做：自检里的 cookie 那项要人工点菜单才能跑，而这件事已经卡了三轮。
 * 探针在 `onMainWindowLoad` 时自动执行，结果落在 `dsh-for-zotero-menu.txt`，
 * 因此"到底哪种参数形态能写进 cookie 罐"可以**离线、一次性**判定。
 *
 * 实测背景（见 docs/DSH集成与桥接协议.md §10）：
 *  - 10 参 → NS_ERROR_XPC_NOT_ENOUGH_ARGS（个数不足）
 *  - 11/12 参 → NS_ERROR_ILLEGAL_VALUE（个数对了，值非法）
 * 所以 11 是正确个数，问题在第 11 个参数（partitionKey）的取值。
 * 本探针把 originAttributes / partitionKey 的取值组合全部试一遍。
 */

import type { DshRuntimeConfig } from "./config";

export interface CookieProbeAttempt {
  label: string;
  ok: boolean;
  /** 失败时的 NS_ERROR 代号（只留代号，避免上百字 XPCOM 文本） */
  code?: string;
}

export interface CookieProbeResult {
  /** cookie 罐接口是否可用 */
  available: boolean;
  /** 是否有任一形态成功 */
  succeeded: boolean;
  /** 成功形态的标签 */
  winner?: string;
  attempts: CookieProbeAttempt[];
}

/** 探针用的 cookie 名（带标记，便于事后清理） */
const PROBE_COOKIE = "dsh-probe-cookie";

/**
 * 试遍参数形态。
 * 注意：**成功的那个 cookie 会被删掉**，探针不留痕迹。
 */
export function probeCookieJar(config: DshRuntimeConfig): CookieProbeResult {
  const result: CookieProbeResult = {
    available: false,
    succeeded: false,
    attempts: [],
  };

  const cookies = (Services as unknown as { cookies?: Record<string, unknown> })
    .cookies as
    | {
        add?: (...args: unknown[]) => void;
        remove?: (...args: unknown[]) => void;
      }
    | undefined;
  if (typeof cookies?.add !== "function") {
    return result;
  }
  result.available = true;

  const host = config.authority.split(":")[0] ?? "127.0.0.1";
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const SAMESITE_STRICT = 2;

  const originVariants: Array<{ label: string; value: unknown }> = [
    { label: "{}", value: {} },
    { label: "null", value: null },
  ];

  // 实测发现沙箱**其实有** `Cc`/`Ci`/`Components`（推翻了早先"没有 Ci"的判断）。
  // 于是把"真正的接口对象"也纳入矩阵 —— 12 种普通 JS 取值全部 ILLEGAL_VALUE，
  // 说明缺的很可能正是这类对象。
  try {
    const Ci = (globalThis as unknown as { Ci?: Record<string, unknown> }).Ci;
    const Cc = (globalThis as unknown as { Cc?: Record<string, () => unknown> })
      .Cc;
    const oaCtor = Ci?.nsIOriginAttributes as (new () => unknown) | undefined;
    if (typeof oaCtor === "function") {
      originVariants.push({
        label: "new Ci.nsIOriginAttributes()",
        value: new oaCtor(),
      });
    }
    const cookieCtor = Ci?.nsICookie as (new () => unknown) | undefined;
    if (
      typeof cookieCtor === "function" &&
      typeof Cc?.["@mozilla.org/cookie;1"] === "function"
    ) {
      // 有些版本要求第一个参数是 nsICookie 实例
      const instance = Cc["@mozilla.org/cookie;1"]() as Record<string, unknown>;
      originVariants.push({ label: "nsICookie 实例", value: instance });
    }
  } catch {
    // 构造失败就跳过这些变体
  }

  const partitionVariants: Array<{ label: string; value: unknown }> = [
    { label: "null", value: null },
    { label: "undefined", value: undefined },
    { label: '""', value: "" },
    { label: "{}", value: {} },
  ];

  const attempts: Array<{ label: string; args: unknown[] }> = [];
  for (const oa of originVariants) {
    for (const pk of partitionVariants) {
      attempts.push({
        label: `11参 oa=${oa.label} pk=${pk.label}`,
        args: [
          oa.value,
          host,
          "/",
          PROBE_COOKIE,
          "v1",
          false, // isSecure（本机 http）
          true, // isHttpOnly
          false, // isSession
          expiry,
          SAMESITE_STRICT,
          pk.value,
        ],
      });
    }
  }
  // 对照：已知"个数不足"的形态，确认错误码分类仍然成立
  attempts.push({
    label: "10参 无pk",
    args: [
      host,
      "/",
      PROBE_COOKIE,
      "v1",
      false,
      true,
      false,
      expiry,
      SAMESITE_STRICT,
      {},
    ],
  });

  for (const attempt of attempts) {
    try {
      cookies.add(...attempt.args);
      result.attempts.push({ label: attempt.label, ok: true });
      result.succeeded = true;
      result.winner = attempt.label;
      // 立刻清理探针 cookie，避免污染用户的 cookie 罐
      try {
        if (typeof cookies.remove === "function") {
          cookies.remove(host, PROBE_COOKIE, "/", {});
        }
      } catch {
        // 清不掉也不影响结论
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code =
        /NS_ERROR_[A-Z_]+/.exec(message)?.[0] ?? message.slice(0, 40);
      result.attempts.push({ label: attempt.label, ok: false, code });
    }
  }
  return result;
}

/** 单行摘要，供诊断文件使用 */
export function describeCookieProbe(result: CookieProbeResult): string {
  if (!result.available) return "Services.cookies 不可用";
  if (result.succeeded) return `成功：${result.winner}`;
  // 失败时按错误码归类，便于判断下一步
  const byCode = new Map<string, number>();
  for (const attempt of result.attempts) {
    const code = attempt.code ?? "未知";
    byCode.set(code, (byCode.get(code) ?? 0) + 1);
  }
  const summary = [...byCode.entries()]
    .map(([code, count]) => `${code}×${count}`)
    .join(", ");
  return `全部失败（${result.attempts.length} 种）：${summary}`;
}

/**
 * 探测沙箱里**有哪些 cookie 相关的接口对象可用**。
 *
 * 为什么需要：12 种参数形态全部 `NS_ERROR_ILLEGAL_VALUE`，说明"个数对了、值不对"，
 * 而正确的值很可能必须是一个**真正的 XPCOM 接口对象**（`nsICookie` / `OriginAttributes`），
 * 不是普通 JS 对象。问题在于插件沙箱没有 `Ci`/`Cc`
 * （xpcom/plugins.js:141-156 白名单里只有 `ChromeUtils`、`Services` 等）。
 *
 * `ChromeUtils` 是白名单成员，而它恰好提供了获取接口常量的途径
 * （`ChromeUtils.interfaces` / `ChromeUtils.importESModule`）。先问清楚运行时有什么，
 * 再决定怎么构造参数 —— 盲试已经试了 12 种，该换成"先看清单再动手"。
 */
export function listCookieCapabilities(): string[] {
  const lines: string[] = [];
  const g = globalThis as unknown as Record<string, unknown>;

  for (const name of ["Components", "Cc", "Ci", "Cu", "ChromeUtils"]) {
    const value = g[name];
    lines.push(`${name}=${value === undefined ? "无" : typeof value}`);
  }

  lines.push(
    `Services.cookies.add=${typeof (Services as unknown as { cookies?: { add?: unknown } })?.cookies?.add}`,
  );

  const chromeUtils = g.ChromeUtils as
    | {
        interfaces?: Record<string, unknown>;
        importESModule?: unknown;
        import?: unknown;
      }
    | undefined;

  if (chromeUtils) {
    const interfaces = chromeUtils.interfaces;
    lines.push(`ChromeUtils.interfaces=${interfaces ? "有" : "无"}`);
    if (interfaces) {
      for (const key of [
        "nsICookie",
        "nsICookieManager",
        "nsICookieService",
        "nsIPrincipal",
      ]) {
        lines.push(`  接口 ${key}=${typeof interfaces[key]}`);
      }
    }
  }

  // Services.cookies 自身暴露了哪些成员（可能就有现成的构造途径）
  const cookies = (Services as unknown as { cookies?: Record<string, unknown> })
    ?.cookies;
  if (cookies) {
    const members = Object.keys(cookies).sort();
    lines.push(`Services.cookies 成员：${members.slice(0, 24).join(",")}`);
  }

  // 是否有现成的 originAttributes / partitionKey 构造帮助函数
  for (const name of ["OriginAttributes", "ChromeUtils.originAttributes"]) {
    lines.push(`${name}=${typeof g[name]}`);
  }

  return lines;
}
