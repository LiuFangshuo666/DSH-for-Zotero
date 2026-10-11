/**
 * 模型配置：在 Zotero 里直接指定 **API Key** 与 **推理等级**。
 *
 * # 为什么需要（这不是"多一个设置项"，而是补一个真实缺口）
 *
 * 隔离实例的模型凭据一律**从本机桌面版 Harness 复制**（见 `credentialMerge.ts`）。
 * 于是没装过桌面版、或装了但没登录/没配 key 的用户，**插件完全用不了** ——
 * 而错误藏在 `turn/end` 的 `reason` 里，界面只表现为问答失败：
 *
 * ```text
 *   llm-deepseek: no API key for provider route "deepseek-official";
 *   store DEEPSEEK_API_KEY through the credentials service
 * ```
 *
 * 所以这里让用户**在 Zotero 里直接填**。规则很简单，但要写清楚：
 *
 * | 用户在设置页填了 | 用哪个 |
 * | --- | --- |
 * | 填了 API key | **用他的**（覆盖从桌面版继承来的值） |
 * | 没填 | 沿用桌面版（保持原行为，不打扰已配好的用户） |
 *
 * # API key 写到哪、什么时候生效
 *
 * 写进隔离实例的 `.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY`
 * —— 这是 dsh 侧 `llm-deepseek-api-key` 适配器**首选**的读取位置
 * （它先问凭据服务，环境变量只是回退）。
 *
 * ⚠️ 该文件由**宿主启动时创建**，所以：
 *  - 文件还不存在时写不了 —— 这不是错误，而是"宿主还没起来"，等下次启动合并时会写；
 *  - 文件存在时写入后，宿主的 `credentials-local` 会**监听文件变化并热重载**，
 *    因此不必重启运行时。
 *
 * # 推理等级为什么不写死选项
 *
 * 可选等级**由模型自己声明**（dsh 侧由适配器提供；实测 `deepseek-official` 是
 * `off`/`low`/`high`/`max`，默认 `high` —— 但这个结论来自 dsh 源码，不该由插件固化）。
 * 设置页的候选值一律从 `session/modelCatalog` **动态读取**；
 * 传一个宿主不接受的等级会抛错，而那种失败是静默的（用户只看到"没生效"）。
 */

import { appendPanelLog } from "./runLog";
import { getPref, setPref } from "../utils/prefs";

/** `refs` 里模型 API key 的引用名（dsh 侧 `apiKeyEnv` 的默认值） */
export const API_KEY_REF = "DEEPSEEK_API_KEY";

/** 用户在设置页填的 API key；没填返回 undefined（空串与纯空白都算没填） */
export function userApiKey(): string | undefined {
  try {
    // ⚠️ 不要写 `getPref("modelApiKey" as never)`：那个强制转换让返回值变成
    // `never`，随后 `typeof raw !== "string"` 会把类型收窄成 `never`，
    // `.trim()` 直接编译不过（本项目刚踩过）。
    const raw = getPref("modelApiKey");
    if (typeof raw !== "string") return undefined;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/** 设置页用：写入或清除 API key */
export function setUserApiKey(value: string): void {
  setPref("modelApiKey", value.trim());
}

// ── 模型 / 推理等级偏好 ────────────────────────────────────────

export interface ModelChoice {
  provider: string;
  model: string;
  /** 空串表示"用模型的默认等级" */
  reasoningEffort: string;
}

function prefString(
  key: "modelProvider" | "modelId" | "modelReasoningEffort",
): string {
  try {
    const raw = getPref(key);
    return typeof raw === "string" ? raw.trim() : "";
  } catch {
    return "";
  }
}

/** 用户在设置页选的模型；未选完（缺 provider 或 model）时返回 undefined */
export function selectedModel(): ModelChoice | undefined {
  const provider = prefString("modelProvider");
  const model = prefString("modelId");
  if (!provider || !model) return undefined;
  return {
    provider,
    model,
    reasoningEffort: prefString("modelReasoningEffort"),
  };
}

export function setSelectedModel(choice: ModelChoice): void {
  setPref("modelProvider", choice.provider);
  setPref("modelId", choice.model);
  setPref("modelReasoningEffort", choice.reasoningEffort);
}

// ── 凭据文件操作（纯文本，可单测）──────────────────────────────
//
// 与 `credentialMerge.ts` 同样的理由：这个文件的形态是我们自己维护的固定结构，
// 按行替换比 YAML 解析更稳，也不会因为某个无关字段形态变化而整体失败。

/** 转义正则元字符 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 在凭据文本里设置 `refs.<key>` 的值。
 *
 * 返回 `undefined` 表示**没有 `refs:` 段** —— 调用方应视为结构异常并放弃写入，
 * 而不是硬塞一行（那会写出层级错误的 YAML，宿主读不了，而症状是"key 没生效"）。
 */
export function setCredentialRef(
  text: string,
  key: string,
  value: string,
): string | undefined {
  const lines = text.split(/\r?\n/);
  const refsAt = lines.findIndex((l) => /^refs\s*:\s*$/.test(l));
  if (refsAt < 0) return undefined;

  const matcher = new RegExp(`^(\\s+)${escapeRegExp(key)}\\s*:`);
  for (let i = refsAt + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break; // 离开 refs 段
    const m = matcher.exec(lines[i]);
    if (m) {
      lines[i] = `${m[1]}${key}: ${value}`;
      return lines.join("\n");
    }
  }
  // refs 段里还没有这一项 → 插在段首
  lines.splice(refsAt + 1, 0, `  ${key}: ${value}`);
  return lines.join("\n");
}

/**
 * 读凭据文件里 `refs.<key>` 的**是否存在且非空**（不返回值，避免把密钥写进日志）。
 *
 * 自检用：它要能回答“当前到底有没有 key”，而不必暴露 key 本身。
 *
 * ⚠️ 必须把**空串**判为“没有”：写 `DEEPSEEK_API_KEY: ""` 与不写这一行，
 * 对宿主来说都是“没有 key”，但表面上却“有一行” —— 自检若据此报“已配置”，
 * 用户会拿着一个其实没配好的状态去排查别处。
 * （判断时要去掉一层引号：`""` 里有两个引号字符，用 `\S` 判断会误判为有值 ——
 * 这条断言的第一版就是这么错的。）
 */
export function hasCredentialRef(text: string, key: string): boolean {
  const lines = text.split(/\r?\n/);
  const refsAt = lines.findIndex((l) => /^refs\s*:\s*$/.test(l));
  if (refsAt < 0) return false;
  const matcher = new RegExp(`^\\s+${escapeRegExp(key)}\\s*:\\s*(.*)$`);
  for (let i = refsAt + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break;
    const m = matcher.exec(lines[i]);
    if (!m) continue;
    const value = m[1]
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2")
      .trim();
    return value.length > 0;
  }
  return false;
}

// ── 把 API key 写进隔离实例 ───────────────────────────────────

/** API key 写入的结果（供设置页与自检显示，不包含密钥内容） */
export interface KeySyncResult {
  /** 是否真的写了 */
  wrote: boolean;
  /** 面向用户的一句话结论 */
  detail: string;
}

/**
 * 把设置页里的 API key 同步到隔离实例的凭据文件。
 *
 * 由两处调用：运行时准备阶段（与从桌面版复制凭据同一时机）与设置页保存时。
 *
 * ⚠️ 文件不存在**不是错误**：它由宿主启动时创建。此时如实说明"宿主还没起来、
 * 下次启动会写入"，而不是报一个用户无法处理的失败。
 */
export async function syncApiKeyToCredentials(
  credentialsFilePath: string,
): Promise<KeySyncResult> {
  const key = userApiKey();
  if (!key) {
    return {
      wrote: false,
      detail: "未在设置页填写 API Key（沿用桌面版 Harness 的凭据）",
    };
  }
  try {
    if (!(await IOUtils.exists(credentialsFilePath))) {
      return {
        wrote: false,
        detail:
          "隔离宿主的凭据文件还没生成（宿主尚未启动过）—— " +
          "已记录你的 API Key，下次启动时会写入。",
      };
    }
    const before = await IOUtils.readUTF8(credentialsFilePath);
    const after = setCredentialRef(before, API_KEY_REF, key);
    if (after === undefined) {
      appendPanelLog(
        "runtime",
        `凭据文件里没有 refs 段，无法写入 API Key：${credentialsFilePath}`,
      );
      return {
        wrote: false,
        detail: "凭据文件结构异常（没有 refs 段），未能写入 API Key。",
      };
    }
    if (after === before) {
      return { wrote: false, detail: "API Key 已是当前值，无需改写。" };
    }
    await IOUtils.writeUTF8(credentialsFilePath, after);
    appendPanelLog(
      "runtime",
      `已把设置页填写的 API Key 写入隔离凭据（${API_KEY_REF}）`,
    );
    return {
      wrote: true,
      detail:
        "已写入隔离实例的凭据。宿主的凭据服务会监听文件变化并热重载，" +
        "通常无需重启插件。",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendPanelLog("runtime", `写入 API Key 失败：${message}`);
    return { wrote: false, detail: `写入 API Key 失败：${message}` };
  }
}
