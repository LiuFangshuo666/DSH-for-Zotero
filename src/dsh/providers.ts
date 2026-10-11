/**
 * 自定义模型 provider（第三方 / 自建端点）。
 *
 * # 为什么需要单独一套，而不是复用前面的「API 地址」
 *
 * 前面那个 `baseURL` 是给 **`llm-deepseek` 适配器**换端点用的 —— 它说的是
 * **Anthropic Messages 协议**（见 `llm-deepseek/src/wire-types.ts` 首行），
 * 而且模型目录是 DeepSeek 的。所以：
 *
 * | 端点 | 前面的「API 地址」能用吗 |
 * | --- | --- |
 * | DeepSeek 官方 / 兼容其中转站 | ✅ |
 * | GLM 的 `/api/anthropic` | ⚠️ 协议相合，但模型名与兼容细节要另外告诉它 |
 * | GLM 的 `/api/v1`（OpenAI 兼容） | ❌ 协议不同 |
 *
 * 要接 GLM 的 `/api/v1`、或任何 OpenAI 兼容端点，必须换成**另一个适配器**：
 * `llm-pi-ai`。它支持三种协议，而且 pi-ai 内置了 40+ 个 provider 的适配
 * （含 GLM/Z.ai、Moonshot、Qwen、MiniMax…）。
 *
 * 好消息：`@deepseek-ai/dsh-llm-pi-ai` 与 `@earendil-works/pi-ai`
 * **已经在插件提取的运行时里**，只是隔离实例的 profile 没把它组合进来。
 * 所以这里要做的是：把 `dsh-llm-pi-ai` 加进 profile 的 bundles，
 * 并写好 provider 配置与凭据。
 *
 * # 三方数据各放在哪（分开放，各用各的机制）
 *
 * | 数据 | 去处 | 生效方式 |
 * | --- | --- | --- |
 * | provider 配置 | `<profile>/cordis.patch.yml` 的托管区块 | **重启运行时** |
 * | API Key | `<DSH_HOME>/.credentials.yaml` 的 `refs.<名>` | 凭据服务监听热重载 |
 * | 用户的定义（含 key） | Zotero 偏好（一个 JSON 串） | 设置页保存时 |
 *
 * # ⚠️ 为什么 provider 配置要重启才生效
 *
 * profile 的组合发生在宿主**启动时**（`package.json` 的 `dsh.profile.bundles`
 * 决定加载哪些包）。这件事没有热更新通道 —— 所以启用/增删 provider 必须重启
 * 隔离运行时。代码里把"是否需要重启"做成一个**可判断的状态**，
 * 而不是让用户猜（见 `providersNeedRestart`）。
 */

import { appendPanelLog } from "./runLog";
import { getPref, setPref } from "../utils/prefs";
import { setCredentialRef } from "./modelConfig";

/** pi-ai 支持的协议（与 `llm-pi-ai/src/provider.ts` 的注册表逐字一致） */
export const SUPPORTED_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
] as const;
export type ProviderApi = (typeof SUPPORTED_APIS)[number];

/**
 * 承载自定义 provider 的 dsh 插件包名。
 * 它必须同时出现在 profile 的 `bundles` 与 `cordis.patch.yml` 的条目里。
 */
export const PI_AI_PACKAGE = "@deepseek-ai/dsh-llm-pi-ai";

/** 托管区块的起止标记（重新生成时只替换中间部分） */
export const MANAGED_START = "# ── DSH-for-Zotero: 自定义 provider 起 ──";
export const MANAGED_END = "# ── DSH-for-Zotero: 自定义 provider 止 ──";

/** 一个模型的最小描述 */
export interface ProviderModel {
  /** 端点认识的模型 id（如 `glm-4.7`） */
  id: string;
  /** 界面显示名；留空用 id */
  name?: string;
  /** 上下文窗口（token）；留空用 pi-ai 的默认值 */
  contextWindow?: number;
  /** 单次最大输出（token）；留空用默认值 */
  maxTokens?: number;
}

/** 用户定义的一个 provider */
export interface ProviderDefinition {
  /**
   * 路由名。它会成为 dsh 里的 provider id（模型选择器里显示的就是它），
   * 也是凭据引用名的一部分，所以必须稳定、且只含安全字符。
   */
  route: string;
  /** 协议 */
  api: ProviderApi;
  /** API 根地址（不含查询参数与 #） */
  baseURL: string;
  /** API Key（明文存在 Zotero 偏好里；与 dsh 自身做法一致） */
  apiKey?: string;
  /** 界面显示名 */
  displayName?: string;
  /** 该端点可用的模型 */
  models: ProviderModel[];
}

/** 路由名允许的字符：小写字母、数字、连字符 —— 它会出现在凭据引用名里 */
const ROUTE_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * 路由名 → 凭据引用名。
 *
 * ## 为什么必须转换而不是直接用路由名
 *
 * 凭据引用有个硬性约束：**POSIX 标识符**（`[A-Za-z_][A-Za-z0-9_]*`），
 * 不能有连字符（见 dsh 的 `credentialRef` 与 credentials-local 的校验）。
 * 而路由名按惯例是连字符形式（`my-relay`）—— 直接拿来当引用名会被拒绝，
 * 而且失败发生在凭据写入时，症状是"key 存不进去"。
 *
 * 所以统一转成 `DSH_PI_AI_` 前缀 + 转义后的路由名，保证两边都能用。
 */
export function credentialRefForRoute(route: string): string {
  return `DSH_PI_AI_${route.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/** 校验一个 provider 定义；返回 `undefined` 表示合法 */
export function validateProvider(
  def: ProviderDefinition,
  existingRoutes: string[] = [],
): string | undefined {
  if (!ROUTE_RE.test(def.route)) {
    return "路由名只能用小写字母、数字与连字符，且以字母或数字开头（它同时是模型选择器里显示的 provider 名）";
  }
  if (existingRoutes.includes(def.route)) {
    return `路由名「${def.route}」已被另一个 provider 使用`;
  }
  if (!SUPPORTED_APIS.includes(def.api)) {
    return `协议必须是 ${SUPPORTED_APIS.join(" / ")} 之一`;
  }
  const urlError = validateEndpointUrl(def.baseURL);
  if (urlError) return urlError;
  if (def.models.length === 0) {
    return "至少要写一个模型 id —— 端点不认识空清单，模型选择器里也会没有可选项";
  }
  const seen = new Set<string>();
  for (const m of def.models) {
    if (!m.id.trim()) return "模型 id 不能为空";
    if (seen.has(m.id)) return `模型 id「${m.id}」重复`;
    seen.add(m.id);
  }
  return undefined;
}

/**
 * 端点地址校验。
 *
 * 规则与 dsh 的 baseURL 校验**同源**（http/https、无凭据、无查询、无片段），
 * 这样"通过校验"就意味着宿主不会拒绝 —— 否则失败会出现在轮次里，
 * 用户看到的是"问答坏了"而不是"地址不对"。
 */
export function validateEndpointUrl(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return "不是合法的 URL（示例：https://open.bigmodel.cn/api/v1）";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `协议必须是 http 或 https（现在是 ${parsed.protocol}）`;
  }
  if (parsed.username || parsed.password) {
    return "地址里不能带用户名/密码 —— 凭据请填在 API Key 那一栏";
  }
  if (parsed.search) return "地址里不能带查询参数（?…）";
  if (parsed.hash) return "地址里不能带 # 片段";
  return undefined;
}

// ── 偏好的读写（provider 定义存成一个 JSON 串）──────────────────

/**
 * 读用户定义的 providers。
 *
 * ⚠️ 解析失败一律返回空数组，并**记一条日志** —— 偏好是纯文本，可能被手工改坏。
 * 静默吞掉会让"设置页显示为空"与"确实没配"无法区分。
 */
export function readProviders(): ProviderDefinition[] {
  let raw: string;
  try {
    const value = getPref("customProviders");
    raw = typeof value === "string" ? value : "";
  } catch {
    return [];
  }
  if (!raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      appendPanelLog("runtime", "自定义 provider 偏好不是数组，已按空处理");
      return [];
    }
    return parsed.filter(isProviderShape).map(normalizeProvider);
  } catch (error) {
    appendPanelLog(
      "runtime",
      `自定义 provider 偏好解析失败（按空处理）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}

function isProviderShape(value: unknown): value is ProviderDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ProviderDefinition).route === "string" &&
    typeof (value as ProviderDefinition).baseURL === "string"
  );
}

/** 补齐可选字段，避免下游到处判 undefined */
function normalizeProvider(def: ProviderDefinition): ProviderDefinition {
  return {
    route: def.route,
    api: SUPPORTED_APIS.includes(def.api) ? def.api : "openai-completions",
    baseURL: def.baseURL,
    apiKey: def.apiKey ?? "",
    displayName: def.displayName ?? "",
    models: (Array.isArray(def.models) ? def.models : []).map((m) => ({
      id: String(m.id ?? ""),
      name: m.name ? String(m.name) : undefined,
      contextWindow: Number.isFinite(m.contextWindow)
        ? Number(m.contextWindow)
        : undefined,
      maxTokens: Number.isFinite(m.maxTokens) ? Number(m.maxTokens) : undefined,
    })),
  };
}

export function writeProviders(defs: ProviderDefinition[]): void {
  setPref("customProviders", JSON.stringify(defs));
}

// ── 生成 profile 的两处产物（纯函数，可单测）────────────────────

/**
 * YAML 标量：只在**真的会改变语义**时加引号。
 *
 * ## 判据（不是"看起来不安全就加引号"）
 *
 * YAML 的纯量标量里，只有这几种情况需要引号：
 *  - 含 `": "`（冒号+空格）或结尾是 `:` —— 会被当成映射的键；
 *  - 含 `" #"`（空格+井号）—— `#` 会被当成注释起点；
 *  - 以 `#`、`&`、`*`、`!`、`|`、`>`、`{`、`[`、`"`、`'` 等指示符**开头**；
 *  - 整体是 `true`/`false`/`null`/`~`/数字 —— 否则会被解析成非字符串。
 *
 * ⚠️ 早先的写法是"只要含非 `[A-Za-z0-9._/-]` 就加引号"，于是
 * `https://…` 这种既有 `:` 又有 `/` 的**地址**全被引起来 —— 语义没错，
 * 但让生成结果与"预期形状"对不上，排查时容易误以为写错了。
 * 现在按真实规则判断，地址保持原样。
 */
function yamlScalar(value: string): string {
  const needsQuote =
    value.length === 0 ||
    /: |:$/.test(value) ||
    / #/.test(value) ||
    /^[#&*!|>{["'%@`-]/.test(value) ||
    /^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(value) ||
    /^\s|\s$/.test(value);
  if (!needsQuote) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * 生成 `cordis.patch.yml` 里的托管区块。
 *
 * ## 形状与理由
 *
 * ```yaml
 * - id: llm-pi-ai
 *   name: "@deepseek-ai/dsh-llm-pi-ai"
 *   config:
 *     providers:
 *       <路由名>:
 *         api: openai-completions
 *         baseURL: https://…/api/v1
 *         apiKeyEnv: DSH_PI_AI_<路由名>
 *         displayName: …
 *         models:
 *           - id: glm-4.7
 *             name: GLM-4.7
 *             contextWindow: 200000
 * ```
 *
 * `apiKeyEnv` 指向**凭据引用名**而不是密钥本身 —— 密钥写进
 * `.credentials.yaml`（dsh 自己的做法），配置里只留引用名。
 * 这样配置文件可以安全地被复制/贴出来排查。
 *
 * 没有 provider 时返回**空串**（调用方据此把整个区块删掉，
 * 而不是留下一个空的 `providers: {}` 条目 —— 那会让宿主加载一个
 * 没有任何路由的适配器）。
 */
export function buildProviderPatch(defs: ProviderDefinition[]): string {
  if (defs.length === 0) return "";
  const lines: string[] = [
    `- id: llm-pi-ai`,
    `  name: "${PI_AI_PACKAGE}"`,
    `  config:`,
    `    providers:`,
  ];
  for (const def of defs) {
    lines.push(`      ${yamlScalar(def.route)}:`);
    lines.push(`        api: ${def.api}`);
    lines.push(`        baseURL: ${yamlScalar(def.baseURL)}`);
    lines.push(`        apiKeyEnv: ${credentialRefForRoute(def.route)}`);
    if (def.displayName?.trim()) {
      lines.push(`        displayName: ${yamlScalar(def.displayName.trim())}`);
    }
    lines.push(`        models:`);
    for (const m of def.models) {
      lines.push(`          - id: ${yamlScalar(m.id)}`);
      if (m.name?.trim())
        lines.push(`            name: ${yamlScalar(m.name.trim())}`);
      if (m.contextWindow)
        lines.push(`            contextWindow: ${m.contextWindow}`);
      if (m.maxTokens) lines.push(`            maxTokens: ${m.maxTokens}`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * 把托管区块**并入**原有 patch 文件内容。
 *
 * 只替换两个标记之间的部分，用户自己的条目一律原样保留 ——
 * 这个文件是 dsh 的组合层，用户可能在别处加过东西，
 * 整文件重写会把它们抹掉（本项目在别处踩过同类问题的教训）。
 */
export function mergeManagedBlock(existing: string, block: string): string {
  const start = existing.indexOf(MANAGED_START);
  const end = existing.indexOf(MANAGED_END);
  const hasBlock = start >= 0 && end > start;

  const payload = block.trim().length > 0 ? `${block.trimEnd()}\n` : "";
  const wrapper =
    payload.length > 0 ? `${MANAGED_START}\n${payload}${MANAGED_END}\n` : "";

  if (hasBlock) {
    const before = existing.slice(0, start);
    const after = existing.slice(end + MANAGED_END.length);
    // 去掉紧随其后的换行，避免重复累积空行
    return `${before}${wrapper}${after.replace(/^\n+/, "")}`;
  }
  if (wrapper.length === 0) return existing;
  const base =
    existing.endsWith("\n") || existing.length === 0
      ? existing
      : `${existing}\n`;
  return `${base}${wrapper}`;
}

/** 从 patch 文件内容里取出托管区块（没有则空串）—— 自检用 */
export function extractManagedBlock(existing: string): string {
  const start = existing.indexOf(MANAGED_START);
  const end = existing.indexOf(MANAGED_END);
  if (start < 0 || end <= start) return "";
  return existing.slice(start + MANAGED_START.length, end).trim();
}

/**
 * profile 的 `package.json` 内容：确保 `dsh-llm-pi-ai` 在 bundles 里。
 *
 * 只在需要时添加/移除，保持其他内容不变。`bundles` 决定宿主启动时组合哪些包,
 * 所以这个改动**必须重启**才生效。
 */
export function ensurePiAiBundle(
  packageJsonText: string,
  want: boolean,
): { text: string; changed: boolean } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(packageJsonText) as Record<string, unknown>;
  } catch {
    return { text: packageJsonText, changed: false };
  }
  const dsh = (parsed.dsh ?? {}) as Record<string, unknown>;
  const profile = (dsh.profile ?? {}) as Record<string, unknown>;
  const bundles = Array.isArray(profile.bundles)
    ? (profile.bundles as unknown[]).map(String)
    : [];
  const has = bundles.includes(PI_AI_PACKAGE);
  if (want === has) return { text: packageJsonText, changed: false };

  const next = want
    ? [...bundles, PI_AI_PACKAGE]
    : bundles.filter((b) => b !== PI_AI_PACKAGE);
  profile.bundles = next;
  dsh.profile = profile;
  parsed.dsh = dsh;
  return { text: `${JSON.stringify(parsed, null, 2)}\n`, changed: true };
}

/**
 * 把偏好里的 provider 列表写进运行时的 profile 与凭据。
 *
 * ## 两处产物、两种生效方式
 *
 *  - `cordis.patch.yml` + `package.json`：**组合层**，改动要重启运行时；
 *  - `.credentials.yaml` 的 `refs.<名>`：凭据服务监听热重载。
 *
 * 所以"启用了新 provider"这件事必须让用户重启一次 —— 返回值里如实说明。
 */
export interface ApplyProvidersResult {
  /** 是否改动了需要重启才生效的文件 */
  needsRestart: boolean;
  /** 写入了几个 provider 的凭据 */
  credentials: number;
  /** 面向用户的一句话结论 */
  detail: string;
}

export async function applyProviders(paths: {
  profileDir: string;
  credentialsFile: string;
}): Promise<ApplyProvidersResult> {
  const defs = readProviders();
  let changedComposition = false;
  let credentials = 0;

  try {
    // ① 组合层：package.json 的 bundles + patch 文件的托管区块
    //
    // ⚠️ 路径必须用 `PathUtils.join` 拼，**不能**用模板字符串写
    // `${dir}/package.json` —— 那会得到 `…\plugin/package.json`（反斜杠 + 正斜杠混用），
    // 而 Gecko 的 `IOUtils.exists` 直接抛
    // `NS_ERROR_FILE_UNRECOGNIZED_PATH`：**整个 provider 写入全盘失败**。
    // 真机日志里正是这条（`Could not determine if …\plugin/package.json exists`）。
    const pkgPath = PathUtils.join(paths.profileDir, "package.json");
    if (await IOUtils.exists(pkgPath)) {
      const before = await IOUtils.readUTF8(pkgPath);
      const { text, changed } = ensurePiAiBundle(before, defs.length > 0);
      if (changed) {
        await IOUtils.writeUTF8(pkgPath, text);
        changedComposition = true;
      }
    }

    const patchPath = PathUtils.join(paths.profileDir, "cordis.patch.yml");
    if (await IOUtils.exists(patchPath)) {
      const before = await IOUtils.readUTF8(patchPath);
      const after = mergeManagedBlock(before, buildProviderPatch(defs));
      if (after !== before) {
        await IOUtils.writeUTF8(patchPath, after);
        changedComposition = true;
      }
    }

    // ② 凭据：每个 provider 一个引用名，互不覆盖
    if (defs.length > 0 && (await IOUtils.exists(paths.credentialsFile))) {
      let text = await IOUtils.readUTF8(paths.credentialsFile);
      let touched = false;
      for (const def of defs) {
        const key = def.apiKey?.trim();
        if (!key) continue;
        const next = setCredentialRef(
          text,
          credentialRefForRoute(def.route),
          key,
        );
        if (next === undefined) {
          // 没有 refs 段：结构异常，如实说出来而不是硬塞
          appendPanelLog(
            "runtime",
            `凭据文件里没有 refs 段，${def.route} 的 API Key 未能写入`,
          );
          continue;
        }
        if (next !== text) {
          text = next;
          touched = true;
        }
        credentials += 1;
      }
      if (touched) await IOUtils.writeUTF8(paths.credentialsFile, text);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendPanelLog("runtime", `应用自定义 provider 失败：${message}`);
    return {
      needsRestart: changedComposition,
      credentials,
      detail: `应用自定义 provider 失败：${message}`,
    };
  }

  const lines: string[] = [];
  if (defs.length === 0) {
    lines.push("未配置自定义 provider。");
  } else {
    lines.push(
      `已写入 ${defs.length} 个 provider（${defs
        .map((d) => d.route)
        .join("、")}），凭据 ${credentials} 条。`,
    );
  }
  if (changedComposition) {
    lines.push(
      "⚠️ provider 列表变化需要**重启隔离运行时**才生效（profile 的组合发生在宿主启动时）。",
    );
  }
  appendPanelLog("runtime", `自定义 provider：${lines.join(" ")}`);
  return {
    needsRestart: changedComposition,
    credentials,
    detail: lines.join(" "),
  };
}

/**
 * 判断"磁盘上的组合"与"用户当前的定义"是否已经一致。
 *
 * 设置页据此显示"需要重启"，而不是让用户对着一个没有生效的配置猜。
 * 只比"有没有 pi-ai 包 + 托管区块内容"，不比整文件。
 */
export function compositionNeedsRestart(
  packageJsonText: string,
  patchText: string,
  defs: ProviderDefinition[],
): boolean {
  const wantBundle = defs.length > 0;
  let hasBundle = false;
  try {
    const parsed = JSON.parse(packageJsonText) as {
      dsh?: { profile?: { bundles?: unknown[] } };
    };
    hasBundle = (parsed.dsh?.profile?.bundles ?? [])
      .map(String)
      .includes(PI_AI_PACKAGE);
  } catch {
    hasBundle = false;
  }
  if (wantBundle !== hasBundle) return true;
  return extractManagedBlock(patchText) !== buildProviderPatch(defs).trim();
}
