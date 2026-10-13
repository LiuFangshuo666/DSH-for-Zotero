/**
 * DSH 自检：把桥接链路逐段跑一遍并如实报告结果。
 *
 * 为什么需要它：dsh 处于 developer preview 且明示会有破坏性变更，`/api` 面也没有稳定性承诺。
 * 一个能一键跑完"配置→凭据→签名→cookie→RPC→流式"的命令，既是首次安装的引导，
 * 也是升级 dsh 后定位破坏点的抓手（复核清单见 docs/DSH集成与桥接协议.md §9）。
 *
 * 输出原则：**只报告实测到的内容**，未验证的项明确标注为 UNVERIFIED，不粉饰。
 */

import {
  inspectJarForDshCookie,
  lastCookieJarSignature,
  mintCookieFromCredentials,
} from "./auth";
import {
  credentialsPath,
  requireRuntimeConfig,
  type DshRuntimeConfig,
} from "./config";
import { readCredentials } from "./credentials";
import { syncDshSide } from "./install";
import { inspectInstallState } from "./skill";
import { DshClient, listSessions, DshRpcError } from "./rpc";
import { appendRunRecord } from "./runLog";
import { openFollowStream, workerCandidates } from "./stream";
import { getPref } from "../utils/prefs";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface SelfCheckOptions {
  /** 是否做 WebSocket 流式实测（会建立连接，数秒后自动关闭） */
  testStream?: boolean;
  /** 流式实测等待开场帧的毫秒数 */
  streamWindowMs?: number;
  /** 逐项回调，便于实时展示 */
  onResult?: (result: CheckResult) => void;
  /**
   * 触发方式，只用于取证记录（auto = 启动时自动跑；manual = 菜单点开）。
   * 真机上出现过两条路径结果不同，必须能区分。
   */
  trigger?: "auto" | "manual";
}

const ICON: Record<CheckStatus, string> = {
  ok: "✅",
  warn: "⚠️",
  fail: "❌",
  skip: "⏭️",
};

export function formatResults(results: CheckResult[]): string {
  return results
    .map((r) => `${ICON[r.status]} ${r.name}\n    ${r.detail}`)
    .join("\n");
}

function errorText(error: unknown): string {
  if (error instanceof DshRpcError) {
    return `${error.code}: ${error.message}${error.httpStatus ? `（HTTP ${error.httpStatus}）` : ""}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * 运行自检。返回逐项结果；不抛异常（除极端情况），失败也作为结果返回。
 */
export async function runSelfCheck(
  options: SelfCheckOptions = {},
): Promise<CheckResult[]> {
  const trigger: "auto" | "manual" = options.trigger ?? "manual";
  const results: CheckResult[] = [];
  const push = (name: string, status: CheckStatus, detail: string) => {
    const result: CheckResult = { name, status, detail };
    results.push(result);
    try {
      options.onResult?.(result);
    } catch {
      // 展示回调失败不应影响自检
    }
  };

  // ── 1. Zotero 环境与沙箱能力 ─────────────────────────────
  const sandbox: string[] = [];
  const has = (name: string) =>
    typeof (globalThis as Record<string, unknown>)[name] !== "undefined";
  sandbox.push(`Zotero ${Zotero.version}`);
  sandbox.push(
    `crypto.subtle ${has("crypto") && typeof crypto.subtle !== "undefined" ? "可用" : "不可用"}`,
  );
  sandbox.push(`fetch ${has("fetch") ? "可用" : "不可用"}`);
  sandbox.push(`XMLHttpRequest ${has("XMLHttpRequest") ? "可用" : "不可用"}`);
  sandbox.push(
    `WebSocket（沙箱） ${has("WebSocket") ? "可用" : "不可用（预期，走 worker）"}`,
  );
  sandbox.push(`ChromeWorker ${has("ChromeWorker") ? "可用" : "不可用"}`);
  sandbox.push(
    `Services.cookies ${typeof Services?.cookies !== "undefined" ? "可用" : "不可用"}`,
  );
  const capabilityOk =
    has("fetch") && has("crypto") && typeof crypto.subtle !== "undefined";
  push(
    "Zotero 环境与沙箱能力",
    capabilityOk ? "ok" : "fail",
    sandbox.join("；"),
  );

  // ── 1b. ⚠️ Zotero 本地 HTTP API：一条**绕过插件确认**的写库通道 ──
  //
  // ## 为什么必须在这里说清楚（真机事故）
  //
  // 用户反馈："此分类下某些论文的条目没有全文附件，请逐一补充。"
  // 当时插件**没有"给已存在条目挂全文"的 op**，Agent 于是往下找了一层，
  // 发现 Zotero 自己的本地 HTTP API 可以直接写库：
  //
  // ```text
  //   http://127.0.0.1:23119/api/users/0/items/<key>/file  →  存附件、建条目
  // ```
  //
  // 它在一个**后台进程**里用它批量写了 75 个附件 —— 全程没有经过插件的
  // 待确认流程，界面上也看不到任何提示，用户是在翻 storage 目录时才发现的。
  //
  // ## 这个检查的性质：**告知，不是拦截**
  //
  // 那是 **Zotero 自己的功能**（供浏览器连接器与第三方工具使用），
  // 由 Zotero 的偏好控制。插件**不应该**替用户去改它 —— 关了会连带影响
  // 浏览器抓取等正常功能。所以这里只做一件事：**把这条通道说清楚**，
  // 让用户知道"插件的确认边界不覆盖它"。
  //
  // 真正收窄边界的办法是**把 op 给够**（已加 `attachPdf`），
  // 让 Agent 没有理由绕路 —— 这比关掉一条 Zotero 功能更对。
  try {
    const localApiEnabled = Boolean(
      Zotero.Prefs.get("httpServer.localAPI.enabled"),
    );
    const serverEnabled = Boolean(Zotero.Prefs.get("httpServer.enabled"));
    if (localApiEnabled && serverEnabled) {
      push(
        "Zotero 本地 API（写库旁路）",
        "warn",
        `本地 HTTP API **已开启**（httpServer.enabled=true，localAPI.enabled=true）。` +
          `这意味着 Agent 可以不经过本插件的待确认流程、直接调用 ` +
          `http://127.0.0.1:${Zotero.Prefs.get("httpServer.port") ?? 23119}/api/ 写你的文库 —— ` +
          `不仅限于本插件的 op。真机上已发生过一次（后台进程批量写入 75 个附件，无确认、无提示）。` +
          `本插件的「读+写自由，仅删除需确认」**只约束经过插件的操作**。` +
          `如需收紧：Zotero 设置 → 高级 → 取消「允许本机其他应用与 Zotero 通信」` +
          `（会同时影响浏览器抓取等依赖它的功能，请自行取舍）。`,
      );
    } else {
      push(
        "Zotero 本地 API（写库旁路）",
        "ok",
        `本地 HTTP API 未开启 —— Agent 无法绕过本插件的确认流程直接写库。`,
      );
    }
  } catch (error) {
    push(
      "Zotero 本地 API（写库旁路）",
      "skip",
      `读取偏好失败，无法判断：${errorText(error)}`,
    );
  }

  // ── 2. 运行期配置 ───────────────────────────────────────
  let config: DshRuntimeConfig;
  try {
    config = requireRuntimeConfig();
  } catch (error) {
    push("解析 DSH 配置", "fail", errorText(error));
    return results;
  }
  push(
    "解析 DSH 配置",
    "ok",
    // ⚠️ 这里原先还打印「认证方式=${config.authMode}」。隔离模式下认证只有一条路
    // （读凭据自签），没有可选方式 —— 那个字段已删，这一项也就不该再出现。
    `DSH_HOME=${config.dshHome}（来源：${config.dshHomeSource}）；authority=${config.authority}`,
  );

  // ── 3. 凭据文件 ─────────────────────────────────────────
  const credPath = credentialsPath(config.dshHome);
  const creds = await readCredentials(credPath);
  if (!creds.exists) {
    push(
      "读取凭据文件",
      "fail",
      `${credPath} 不存在或不可读${creds.error ? `（${creds.error}）` : ""}；请确认 DSH_HOME 是否正确、dsh 是否至少启动过一次`,
    );
  } else if (!creds.secret) {
    push(
      "读取凭据文件",
      "fail",
      `文件存在，但没有 client-connection/browser-session 的 secret。发现的记录键：${creds.recordKeys.join(", ") || "(无)"}`,
    );
  } else {
    push(
      "读取凭据文件",
      "ok",
      `${credPath}；secret 长度 ${creds.secret.length}${creds.secretWasQuoted ? "（带引号）" : ""}`,
    );
  }

  // ── 4. cookie 签名 ──────────────────────────────────────
  let client: DshClient | undefined;
  if (creds.secret) {
    try {
      const minted = await mintCookieFromCredentials(config);
      if (!minted.cookie) {
        push(
          "自签 cookie",
          "fail",
          `${minted.error ?? "未知原因"} ${JSON.stringify(minted.details ?? {})}`,
        );
      } else {
        const c = minted.cookie;
        push(
          "自签 cookie",
          "ok",
          `cookie 名 ${c.name}；值长度 ${c.value.length}；时间戳单位=${c.value.length > 168 ? "毫秒" : "非毫秒(可疑)"}（HMAC-SHA256 签名成功）`,
        );
        client = new DshClient({
          config,
          cookie: c,
          // 宿主重启会换密钥，旧 cookie 一律 401；自检也走自愈，避免把"cookie 陈旧"误报成"认证失败"
          refreshCookie: async () => {
            const again = await mintCookieFromCredentials(config);
            return again.cookie;
          },
        });
      }
    } catch (error) {
      push("自签 cookie", "fail", errorText(error));
    }
  } else {
    // ⚠️ 这里原有一个 `else if (config.launchUrl)` 分支（"用粘贴的启动 URL 换 cookie"）。
    //
    // 它**不可达**：共享模式删除后，`config.ts` 在隔离分支里**硬编码 `launchUrl: ""`**，
    // 而全仓库没有任何地方给 `config.launchUrl` 赋过非空值 —— 也就是说
    // 「token 换 cookie」这一项**永远不会出现在自检结果里**。
    // 一个永远不会出现的检查项只会让人以为"检查过了没问题"，故连同它的两条提示一起删除。
    push(
      "自签 cookie",
      "skip",
      "凭据不可用，跳过（隔离运行时下认证只有这一条路径，不再有 token 回退）",
    );
  }

  // ── 5. cookie 投递通道 ──────────────────────────────────
  if (client) {
    const prepared = client.prepare();
    const signature = lastCookieJarSignature();
    push(
      "cookie 投递通道",
      prepared.delivery === "cookie-jar" ? "ok" : "warn",
      prepared.delivery === "cookie-jar"
        ? `已写入 cookie 罐（fetch 与 WebSocket 握手都会自动携带）${signature ? `；生效签名：${signature}` : ""}`
        : `cookie 罐不可用，回退 XHR 显式设 Cookie 头（RPC 已实测可用，但 WebSocket 握手需要 cookie 罐）${
            prepared.jarError ? `\n    ${prepared.jarError}` : ""
          }`,
    );
  }

  // ── 6. 请求要素（诊断）──────────────────────────────────
  // 真机上出现过"外部脚本用同一份凭据是 200、插件自己却是 401"。
  // 此时唯一能定位的办法是把插件**实际发出的**请求要素摊开比对，继续推断没有意义。
  let requestDetail: ReturnType<DshClient["describeRequest"]> | undefined;
  if (client) {
    try {
      const d = client.describeRequest();
      requestDetail = d;
      push(
        "请求要素（诊断）",
        "skip",
        `URL=${d.baseUrl}/api/…；authority=${d.authority}；cookie 名=${d.cookieName}；` +
          `值长度=${d.cookieValueLength}；Cookie 头长度=${d.cookieHeaderLength}；` +
          `载荷字段=[${d.payloadKeys.join(",")}]；issuedAt 位数=${d.issuedAtDigits}，expiresAt 位数=${d.expiresAtDigits}`,
      );
    } catch (error) {
      push("请求要素（诊断）", "warn", errorText(error));
    }
  }

  // ── 7. RPC：session/list ────────────────────────────────
  if (client) {
    const started = Date.now();
    try {
      const result = await listSessions(client);
      const items = result.value?.items ?? [];
      const elapsed = Date.now() - started;
      push(
        "RPC session/list",
        "ok",
        `HTTP ${result.httpStatus}，通道 ${result.delivery}，耗时 ${elapsed}ms，会话数 ${items.length}` +
          (items.length
            ? `；示例：${items
                .slice(0, 2)
                .map((s) => `${s.sessionId}${s.cwd ? ` @${s.cwd}` : ""}`)
                .join(" | ")}`
            : ""),
      );
      if (requestDetail) {
        void appendRunRecord({
          trigger,
          ...requestDetail,
          rpcOutcome: `HTTP ${result.httpStatus}`,
          delivery: result.delivery,
          elapsedMs: elapsed,
        });
      }
    } catch (error) {
      const elapsed = Date.now() - started;
      const text = errorText(error);
      const hint =
        text.includes("401") || text.includes("unauthorized")
          ? "（认证未通过：cookie 未生效或密钥已轮换）"
          : text.includes("403")
            ? "（信任检查拒绝：Host/Origin 不匹配）"
            : text.includes("network")
              ? "（端口不可达：dsh 没在跑？）"
              : "";
      push("RPC session/list", "fail", `${text}${hint}`);
      if (requestDetail) {
        void appendRunRecord({
          trigger,
          ...requestDetail,
          rpcOutcome: `FAIL ${text.slice(0, 60)}`,
          delivery: client.currentDelivery,
          elapsedMs: elapsed,
        });
      }
    }

    // cookie 罐实况（只读探测）：直接回答"cookie 到底写进去了没有"
    const jar = inspectJarForDshCookie(config);
    push(
      "cookie 罐实况",
      jar.found ? "ok" : jar.readable ? "warn" : "warn",
      jar.readable
        ? jar.found
          ? `已存在 ${jar.names.length} 条 dsh-auth cookie（WebSocket 握手可自动携带）`
          : "读得到 cookie 罐，但里面没有 dsh-auth cookie（若 RPC 仍成功，说明走的是显式 Cookie 头通道）"
        : `无法读取 cookie 罐：${jar.error ?? "未知原因"}（将依赖显式 Cookie 头通道）`,
    );
  }

  // ── 7. WebSocket 流式通道 ───────────────────────────────
  if (!options.testStream) {
    push(
      "WebSocket 流式通道",
      "skip",
      // ⚠️ 这里原先写「可用 --stream 打开」—— 但**没有那个命令行入口**。
      // 流式实测是设置页的按钮（`onPrefsEvent("selfcheck-stream")`），
      // 照旧文案会让用户去找一个不存在的东西。
      "本次未启用流式实测（可在 设置 → DSH-for-Zotero → 自检 点「含流式实测」）",
    );
  } else if (!client) {
    push("WebSocket 流式通道", "skip", "认证未就绪，跳过流式实测");
  } else {
    const sessionId = await pickSessionForStreamTest(client);
    if (!sessionId) {
      push(
        "WebSocket 流式通道",
        "warn",
        "没有可用会话做 follow 实测（可以先创建一条会话再试）",
      );
    } else {
      const outcome = await testStream(
        config,
        sessionId,
        options.streamWindowMs ?? 10000,
      );
      push("WebSocket 流式通道", outcome.status, outcome.detail);
      if (outcome.status !== "ok") {
        push(
          "WebSocket 候选地址",
          "warn",
          `worker 脚本候选：${workerCandidates().join(" , ")}`,
        );
      }
    }
  }

  // ── 8. dsh 侧内容同步（伴读 skill / 常驻指令）───────────
  // 说明：这里按设置项做**双向同步**（开=安装、关=移除），所以"改设置 → 跑自检"
  // 就能确认 dsh 侧处于预期状态，用户不必手动删文件。默认两个开关都是关的。
  const wantSkill = getPref("installSkill" as never) === true;
  const wantAgents = getPref("installAgentInstructions" as never) === true;
  try {
    const state = await inspectInstallState(config.dshHome);
    if (!wantSkill && !wantAgents) {
      push(
        "dsh 侧内容",
        state.skillInstalled || state.agentsInstalled ? "warn" : "skip",
        state.skillInstalled || state.agentsInstalled
          ? `检测到先前安装的内容（skill：${state.skillInstalled ? "有" : "无"}，AGENTS.md 块：${
              state.agentsInstalled ? "有" : "无"
            }），但设置里两个开关都是关的 —— 本次不会改动它们。`
          : "未启用（设置 → DSH-for-Zotero → 高级：可安装伴读 skill 与常驻指令）",
      );
    } else {
      const outcome = await syncDshSide({
        dshHome: config.dshHome,
        wantSkill,
        wantAgents,
      });
      const describe = (
        label: string,
        result: { action: string; path: string; bytes: number } | undefined,
      ) =>
        result
          ? `${label}：${describeAction(result.action)}（${result.path}${result.bytes ? `，${result.bytes} 字符` : ""}）`
          : `${label}：无需改动`;
      const detail = [
        describe("伴读 skill", outcome.skill),
        describe("常驻指令", outcome.agents),
      ];
      if (outcome.errors.length)
        detail.push(`错误：${outcome.errors.join("；")}`);
      push(
        "dsh 侧内容",
        outcome.errors.length ? "fail" : "ok",
        detail.join("；"),
      );
    }
  } catch (error) {
    push("dsh 侧内容", "fail", errorText(error));
  }

  // ── 9. 收尾 ─────────────────────────────────────────────
  client?.dispose();
  return results;
}

function describeAction(action: string): string {
  switch (action) {
    case "created":
      return "已创建";
    case "updated":
      return "已更新";
    case "removed":
      return "已移除";
    case "unchanged":
      return "已是目标状态，未改动";
    default:
      return action;
  }
}

/** 挑一条会话用于 follow 实测：优先正在运行的，其次任意一条 */
async function pickSessionForStreamTest(
  client: DshClient,
): Promise<string | undefined> {
  try {
    const result = await listSessions(client);
    const items = result.value?.items ?? [];
    return (items.find((s) => s.running) ?? items[0])?.sessionId;
  } catch {
    return undefined;
  }
}

/** 建立 follow 流，等开场帧（snapshot/event），然后取消 */
async function testStream(
  config: DshRuntimeConfig,
  sessionId: string,
  windowMs: number,
): Promise<{ status: CheckStatus; detail: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let frameSummary = "";
    const seen: Record<string, number> = {};
    let transport = "unavailable";

    const done = (status: CheckStatus, detail: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        handle?.close();
      } catch {
        // 忽略
      }
      resolve({ status, detail });
    };

    const handle = openFollowStream(config, {
      sessionId,
      assistantStream: true,
      openTimeoutMs: 8000,
      onFrame: (frame) => {
        const kind =
          frame.type === "item"
            ? ((frame.value as { type?: string } | undefined)?.type ?? "item")
            : (frame.type ?? "unknown");
        seen[kind] = (seen[kind] ?? 0) + 1;
        frameSummary = Object.entries(seen)
          .map(([k, v]) => `${k}×${v}`)
          .join(", ");
        if (kind === "snapshot") {
          done(
            "ok",
            `载体 ${transport}；已收到开场 snapshot 帧（帧统计：${frameSummary}）`,
          );
        }
        if (frame.type === "transport-error") {
          done("fail", `${transport}：${frame.error?.message ?? "连接错误"}`);
        }
      },
      onClose: (info) => {
        transport = info.transport;
        if (!settled)
          done("fail", `载体 ${info.transport} 已关闭：${info.reason}`);
      },
    });

    transport = handle.transport;
    if (handle.error) {
      done("fail", `三条载体都不可用：${handle.error}`);
      return;
    }

    const timer = setTimeout(() => {
      done(
        seen.snapshot || Object.keys(seen).length ? "warn" : "fail",
        `载体 ${transport}；${windowMs}ms 内未收到开场帧（帧统计：${frameSummary || "无"}）`,
      );
    }, windowMs);
  });
}
