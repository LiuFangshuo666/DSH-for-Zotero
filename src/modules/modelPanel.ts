/**
 * 设置页「模型」一节的界面逻辑。
 *
 * # 这一节解决什么问题
 *
 * 隔离实例的模型凭据**一律从本机桌面版 Harness 复制**（见 `credentialMerge.ts`）。
 * 所以没装过桌面版、或装了但没登录/没配 key 的用户**完全用不了插件** ——
 * 而错误藏在 `turn/end` 的 `reason` 里，界面只表现为问答失败：
 *
 * ```text
 *   llm-deepseek: no API key for provider route "deepseek-official" …
 * ```
 *
 * 这里让用户能在 Zotero 里直接填 API Key，并选定模型与推理等级。
 *
 * # ⚠️ 下拉框的候选值为什么必须动态取
 *
 * 可选模型与推理等级**由模型自己声明**（dsh 侧由适配器提供）。
 * 在设置页写死一份的后果不是"显示不全新等级"，而是**给出宿主不接受的取值** ——
 * 用户选了、保存了、然后什么都没发生（`selectModel` 抛错被我们吞掉并只记日志）。
 * 所以候选值一律来自 `session/modelCatalog`，取不到就**如实说明**而不是给一份假清单。
 *
 * # 取不到目录时的表现（刻意设计）
 *
 * 运行时没起来 / 没凭据时，`modelCatalog` 会失败。此时：
 *  - 不显示任何候选项（避免用户选到无效值）；
 *  - 在状态行里说明原因与下一步怎么做。
 */

import { requireRuntimeConfig, resolveRuntimeConfig } from "../dsh/config";
import { mintCookieFromCredentials } from "../dsh/auth";
import { DshClient, fetchModelCatalog, type ModelCatalog } from "../dsh/rpc";
import { appendPanelLog } from "../dsh/runLog";
import {
  setUserApiKey,
  setUserBaseUrl,
  selectedModel,
  syncApiKeyToCredentials,
  syncBaseUrlToHost,
  userApiKey,
  userBaseUrl,
  validateBaseUrl,
} from "../dsh/modelConfig";
import {
  applyProviders,
  compositionNeedsRestart,
  readProviders,
  validateProvider,
  writeProviders,
  type ProviderDefinition,
} from "../dsh/providers";
import { resolveRuntimePaths } from "../dsh/isolatedPaths";

/**
 * 宽松的下拉框类型。
 *
 * ⚠️ 为什么不写 `XUL.MenulistElement`：`zotero-types` 的 `XUL` 命名空间里
 * **没有**这个成员（编译不过）。而我们真正用到的只有 `menupopup`、`value`、
 * `firstChild` 这几个成员，自己声明一个最小接口即可 ——
 * 比去补一个第三方类型声明更简单，也不会随它升级而失效。
 */
interface MenulistLike extends Element {
  menupopup?: Element | null;
  value: string;
}

const REF = "dshforzotero";
const MODEL_ID = `${REF}-model-id`;
const EFFORT_ID = `${REF}-model-effort`;
const KEY_ID = `${REF}-model-api-key`;
const BASE_URL_ID = `${REF}-model-base-url`;
const STATUS_ID = `${REF}-model-status`;

/** 最近一次取到的目录（供选择模型后填充等级，避免每次再取一遍） */
let cachedCatalog: ModelCatalog | undefined;

function el<T extends Element>(
  win: Window | undefined,
  id: string,
): T | undefined {
  try {
    return (win?.document?.getElementById(id) as T | null) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 写模型一节的状态行。
 *
 * ## 为什么前面加一个时间戳
 *
 * 真机反馈"点任何按键都没有文字"。状态行确实在更新（id 修好之后），
 * 但**两段文字看起来很像**时，用户无法判断"它到底变了没有" ——
 * 于是仍然报"没反应"。
 *
 * 加上 `HH:MM:SS` 之后，点一次就会看到一个**明显不同**的时间，
 * 这是最便宜的"它活着"的证据。同时诊断文件里也留着时间线。
 */
function setStatus(win: Window | undefined, text: string): void {
  const stamp = new Date().toLocaleTimeString();
  const node = el<HTMLElement>(win, STATUS_ID);
  if (node) node.textContent = `[${stamp}] ${text}`;
  appendPanelLog("runtime", `模型设置：${text}`);
}

/** 建一个已认证的客户端；运行时未就绪返回 undefined */
async function connect(): Promise<DshClient | undefined> {
  const config = requireRuntimeConfig();
  const minted = await mintCookieFromCredentials(config);
  if (!minted.cookie) return undefined;
  return new DshClient({
    config,
    cookie: minted.cookie,
    refreshCookie: async () => (await mintCookieFromCredentials(config)).cookie,
  });
}

/** 取模型目录（失败时返回原因，而不是抛给界面） */
async function loadCatalog(): Promise<
  { ok: true; catalog: ModelCatalog } | { ok: false; reason: string }
> {
  try {
    const client = await connect();
    if (!client) {
      return {
        ok: false,
        reason: "隔离运行时尚未就绪 —— 请先在「隔离运行时」一节准备并启动。",
      };
    }
    const result = await fetchModelCatalog(client);
    const catalog = result.value;
    if (!catalog || !Array.isArray(catalog.groups)) {
      return { ok: false, reason: "宿主返回的模型目录形状不对。" };
    }
    cachedCatalog = catalog;
    return { ok: true, catalog };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `取模型目录失败：${message}` };
  }
}

/**
 * 模型下拉框的 `modelId` 存的是**模型 id**，但同一个模型可能出现在不同 provider 下，
 * 而 `selectModel` 需要 provider + model 两个值。所以把两者编码进 value：
 * `<provider>|<model>`，显示的是 `provider / 模型名`。
 */
function encodeModel(provider: string, model: string): string {
  return `${provider}|${model}`;
}

function decodeModel(
  value: string,
): { provider: string; model: string } | undefined {
  const at = value.indexOf("|");
  if (at <= 0) return undefined;
  return { provider: value.slice(0, at), model: value.slice(at + 1) };
}

/** 填充模型下拉框，并把选择恢复成"用户上次选的" */
async function fillModelList(win: Window | undefined): Promise<void> {
  const list = el<MenulistLike>(win, MODEL_ID);
  if (!list) return;

  const result = await loadCatalog();
  const popup = list.menupopup;
  if (popup) while (popup.firstChild) popup.removeChild(popup.firstChild);

  if (!result.ok) {
    // ⚠️ 取不到目录时**不放任何候选项**：给一份猜的清单会让用户选到宿主不接受的值，
    // 而那种失败是静默的。这里如实说明原因与下一步。
    setStatus(win, result.reason);
    return;
  }

  const { catalog } = result;
  let count = 0;
  for (const group of catalog.groups) {
    for (const model of group.models) {
      const item = win!.document.createXULElement("menuitem");
      item.setAttribute("label", `${group.name} / ${model.name}`);
      item.setAttribute("value", encodeModel(group.id, model.id));
      popup?.appendChild(item);
      count += 1;
    }
  }

  // 恢复上次的选择（把存下来的 provider|model 映射到某个 item 的 value）
  const current = selectedModel();
  const wanted = current ? encodeModel(current.provider, current.model) : "";
  if (wanted) list.value = wanted;

  const failures = catalog.failures ?? [];
  const parts = [
    `已加载 ${count} 个可选模型（${catalog.groups.length} 个 provider）`,
  ];
  if (failures.length > 0) {
    // provider 加载失败通常就是"没有凭据"—— 这正是用户最需要看到的线索
    parts.push(
      `其中 ${failures.length} 个 provider 不可用：` +
        failures.map((f) => `${f.name}（${f.message}）`).join("；"),
    );
  }
  if (count === 0) {
    parts.push("没有可用模型 —— 多半是还没配 API Key。填上 Key 后点「刷新」。");
  }
  setStatus(win, parts.join("；"));
  void fillEffortList(win, list.value);
}

/**
 * 按当前选中的模型填充推理等级下拉框。
 *
 * 等级列表**来自模型自己的声明**；空值表示"用模型默认等级"，
 * 所以第一项固定是"（默认）"，它不是装饰 —— 没有它用户就没法表达"不改这一项"。
 */
async function fillEffortList(
  win: Window | undefined,
  modelValue: string,
): Promise<void> {
  const list = el<MenulistLike>(win, EFFORT_ID);
  if (!list) return;
  const popup = list.menupopup;
  if (popup) while (popup.firstChild) popup.removeChild(popup.firstChild);

  const pick = decodeModel(modelValue);
  let efforts: Array<{ id: string; name: string; description?: string }> = [];
  let defaultEffort: string | undefined;
  if (pick) {
    for (const group of cachedCatalog?.groups ?? []) {
      if (group.id !== pick.provider) continue;
      const model = group.models.find((m) => m.id === pick.model);
      efforts = model?.reasoning?.efforts ? [...model.reasoning.efforts] : [];
      defaultEffort = model?.reasoning?.defaultEffort;
      break;
    }
  }

  const keep = el<MenulistLike>(win, EFFORT_ID)?.value ?? "";

  const addItem = (label: string, value: string) => {
    const item = win!.document.createXULElement("menuitem");
    item.setAttribute("label", label);
    item.setAttribute("value", value);
    popup?.appendChild(item);
  };
  addItem(
    defaultEffort ? `（模型默认：${defaultEffort}）` : "（模型默认）",
    "",
  );
  for (const e of efforts) {
    addItem(e.description ? `${e.name} —— ${e.description}` : e.name, e.id);
  }

  // 恢复用户原来的选择（若该模型不支持它，回到"默认"—— 避免留下一个无效值）
  const valid = efforts.some((e) => e.id === keep);
  list.value = valid ? keep : "";

  if (efforts.length === 0) {
    setStatus(
      win,
      "当前模型没有声明可选推理等级（该模型可能不支持调节），将使用宿主默认。",
    );
  }
}

/**
 * 设置页：点「保存」把 API Key 与**端点地址**写进偏好并同步到隔离运行时。
 *
 * ## 两者一起保存是有意的
 *
 * 换第三方中转站时，**地址与 key 通常要同时换**（旧 key 在新端点上无效）。
 * 分两次保存会让中间出现"新地址 + 旧 key"或反之的失败状态，
 * 而那种失败看起来像"中转站不能用"，排查方向完全跑偏。
 */
export async function saveApiKey(win: Window | undefined): Promise<void> {
  const input = el<HTMLInputElement>(win, KEY_ID);
  if (!input) {
    // ⚠️ 不能静默 return —— 那正是"按键点了没反应"。
    const detail = win
      ? `找不到 API Key 输入框（id=${KEY_ID}）—— 设置页可能版本不匹配，请重装插件。`
      : "设置页窗口已关闭。";
    appendPanelLog("runtime", `模型设置：保存失败 —— ${detail}`);
    setStatus(win, detail);
    return;
  }
  const value = input.value.trim();
  setUserApiKey(value);

  const urlInput = el<HTMLInputElement>(win, BASE_URL_ID);
  const urlValue = urlInput ? urlInput.value.trim() : "";
  setUserBaseUrl(urlValue);

  // 地址不合法就**到此为止**：不写进宿主，也不假装成功 ——
  // 否则用户会拿到一个"保存成功但问答失败"的状态。
  const urlInvalid = urlValue ? validateBaseUrl(urlValue) : undefined;
  if (urlInvalid) {
    setStatus(win, `端点地址无效，未写入：${urlInvalid}`);
    return;
  }

  if (!value && !urlValue) {
    setStatus(
      win,
      "已清空 API Key 与端点 —— 之后沿用桌面版 Harness 的凭据与 DeepSeek 官方地址。",
    );
    return;
  }

  // 立刻尝试写入隔离实例：宿主在跑的话，凭据服务监听文件变化、
  // 设置服务直接热应用，两者都不需要重启运行时。
  try {
    const config = requireRuntimeConfig();
    const parts: string[] = [];
    if (value) {
      const result = await syncApiKeyToCredentials(
        PathUtils.join(config.dshHome, ".credentials.yaml"),
      );
      parts.push(result.detail);
    }
    if (urlValue) {
      const client = await connect();
      if (client) {
        const result = await syncBaseUrlToHost(client);
        parts.push(result.detail);
      } else {
        parts.push("端点已保存，但隔离运行时未就绪，暂未应用。");
      }
    }
    setStatus(win, parts.join("　"));
  } catch {
    // 运行时没起来：两项都已存进偏好，下次准备/启动运行时会被写进去
    setStatus(win, "已保存。隔离运行时还没就绪 —— 启动时它会自动写入。");
  }
}

/** 设置页事件入口：`model-sync` / `model-refresh` / `model-save-key` */
export async function handleModelPrefsEvent(
  type: string,
  data: { window?: Window; target?: Element },
): Promise<void> {
  const win = data.window;
  switch (type) {
    case "model-sync":
      // 两个下拉框都绑了这个事件；用 id 区分，避免互相触发时重复拉取目录。
      if (data.target instanceof Element && data.target.id === MODEL_ID) {
        await fillModelList(win);
      } else if (
        data.target instanceof Element &&
        data.target.id === EFFORT_ID &&
        cachedCatalog === undefined
      ) {
        // 等级依赖目录；没有缓存就先取一次
        await fillModelList(win);
      }
      break;
    case "model-refresh":
      // 用户显式点了刷新：清掉缓存，强制重新取（刚填完 Key 时正需要）
      cachedCatalog = undefined;
      await fillModelList(win);
      break;
    case "model-save-key":
      await saveApiKey(win);
      break;
    default:
      break;
  }
}

/** 设置页载入时：回填已保存的 Key 与端点，并尝试填充下拉框 */
export function initModelSection(win: Window | undefined): void {
  const input = el<HTMLInputElement>(win, KEY_ID);
  if (input) input.value = userApiKey() ?? "";
  const urlInput = el<HTMLInputElement>(win, BASE_URL_ID);
  if (urlInput) urlInput.value = userBaseUrl() ?? "";
  // 运行时未就绪时**不要**只报一句失败就完事 —— 挂上等待与自动重试。
  // 真机上"按键没反应"就是这一步没做：用户看到的是空列表 + 一句只写进日志的错。
  let ready = false;
  try {
    ready = Boolean(resolveRuntimeConfig()?.port);
  } catch {
    ready = false;
  }
  if (ready) {
    void fillModelList(win);
  } else {
    scheduleReadyRefresh(win);
  }
}

// ── 运行时未就绪时的自愈 ───────────────────────────────────────

/** 等待上限：首次启动要提取约 330 MB，给足时间 */
const READY_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const READY_POLL_INTERVAL_MS = 3000;

/**
 * 运行时还没就绪时，**自己等**，而不是让用户对着一个死界面反复点。
 *
 * ## 真机反馈（"模型一节的按键都看不出效果"）的真正原因
 *
 * 日志（`dsh-for-zotero-panel.txt`）显示：用户在 Zotero 启动后**立刻**打开设置，
 * 而隔离运行时那时仍在准备/启动中。`resolveRuntimeConfig()` 只在
 * `phase === "running"` 时返回配置，于是：
 *
 *  - 模型列表取不到 → 下拉框是空的；
 *  - 「保存并写入」抛"运行时尚未就绪" → 只写进日志文件；
 *  - 「刷新列表」同样。
 *
 * 用户看到的就是"点了没反应"。**这不是运行时的错，是界面没把等待状态讲清楚、
 * 也没自己重试。** 所以这里补上：
 *
 *  1. 未就绪时先在状态行说明"正在准备/启动，好了会自动加载"；
 *  2. 后台轮询等待（最长 30 分钟），就绪后自动填充并重查 provider 状态。
 *
 * 轮询而不是订阅：`RuntimeManager` 在 `hooks.ts` 里，从这里引它会造成循环依赖。
 * 而"每秒查一次状态"本来就够用 —— 用户感知不到差别。
 */
export function scheduleReadyRefresh(win: Window | undefined): void {
  const started = Date.now();
  let announced = false;
  const tick = () => {
    const elapsed = Date.now() - started;
    let port: number | undefined;
    try {
      port = resolveRuntimeConfig()?.port;
    } catch {
      port = undefined;
    }
    if (port) {
      // 就绪：自动填充，并重查"是否需要重启"
      void fillModelList(win);
      void refreshProvidersStatus(win);
      return;
    }
    if (elapsed > READY_WAIT_TIMEOUT_MS) {
      setStatus(
        win,
        "等了 30 分钟仍未就绪 —— 请到「隔离运行时」一节查看状态与诊断日志。",
      );
      return;
    }
    if (!announced) {
      announced = true;
      setStatus(
        win,
        "隔离运行时还在准备/启动中 —— 就绪后这一节会**自动加载**，不用反复点「刷新列表」。",
      );
    }
    setTimeout(tick, READY_POLL_INTERVAL_MS);
  };
  tick();
}

// ── 自定义 provider ────────────────────────────────────────────

const PROVIDERS_ID = `${REF}-custom-providers`;
const PROVIDERS_STATUS_ID = `${REF}-providers-status`;

/** 写自定义 provider 一节的状态行（同样加时间戳，理由见 setStatus） */
function setProvidersStatus(win: Window | undefined, text: string): void {
  const stamp = new Date().toLocaleTimeString();
  const node = el<HTMLElement>(win, PROVIDERS_STATUS_ID);
  if (node) node.textContent = `[${stamp}] ${text}`;
  appendPanelLog("runtime", `自定义 provider：${text}`);
}

/** 给用户的示例（同时起"这份 JSON 长什么样"的文档作用） */
const PROVIDER_EXAMPLE = JSON.stringify(
  [
    {
      route: "glm",
      api: "openai-completions",
      baseURL: "https://open.bigmodel.cn/api/v1",
      apiKey: "在这里填该端点的 API Key",
      displayName: "智谱 GLM",
      models: [
        { id: "glm-4.7", name: "GLM-4.7" },
        { id: "glm-4.5-air", name: "GLM-4.5-Air" },
      ],
    },
  ],
  null,
  2,
);

/** 设置页载入：回填已保存的定义，并显示"是否需要重启" */
export function initProvidersSection(win: Window | undefined): void {
  const box = el<HTMLTextAreaElement>(win, PROVIDERS_ID);
  if (!box) {
    appendPanelLog(
      "runtime",
      `设置页载入：找不到自定义 provider 输入框（id=${PROVIDERS_ID}）`,
    );
    return;
  }
  // 回填时**用格式化后的 JSON**：原始偏好多是压缩成一行的，
  // 直接显示会变成一条难读的长行，而这是要给人编辑的。
  try {
    box.value = JSON.stringify(readProviders(), null, 2);
  } catch (error) {
    // 偏好被手工改坏时 `readProviders` 已有兜底，这里防的是别的意外 ——
    // 无论如何都要让输入框**可编辑**，否则用户连改回去都做不到。
    box.value = "[]";
    appendPanelLog(
      "runtime",
      `读取自定义 provider 失败（已置空以便你改回）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  void refreshProvidersStatus(win);
}

/** 对比磁盘与用户定义，给出"是否需要重启"的结论 */
async function refreshProvidersStatus(win: Window | undefined): Promise<void> {
  try {
    const paths = resolveRuntimePaths();
    if (!paths) {
      setProvidersStatus(win, "（无法定位隔离实例的 profile 目录）");
      return;
    }
    const readOr = async (p: string) =>
      (await IOUtils.exists(p)) ? await IOUtils.readUTF8(p) : "";
    const stale = compositionNeedsRestart(
      await readOr(PathUtils.join(paths.profile, "package.json")),
      await readOr(PathUtils.join(paths.profile, "cordis.patch.yml")),
      readProviders(),
    );
    setProvidersStatus(
      win,
      stale
        ? "⚠️ 配置已改但**尚未生效** —— 请到上面的「隔离运行时」一节点「停止」再「启动」。"
        : "已生效。",
    );
  } catch {
    setProvidersStatus(win, "（隔离运行时未就绪，保存后在下次启动时生效）");
  }
}

/** 插入示例，方便用户改而不是从零写 */
export function insertProviderExample(win: Window | undefined): void {
  const box = el<HTMLTextAreaElement>(win, PROVIDERS_ID);
  if (!box) return;
  box.value = PROVIDER_EXAMPLE;
  setProvidersStatus(
    win,
    "已填入示例 —— 请把 baseURL、apiKey 与 models 改成你自己的，再点保存。",
  );
}

/**
 * 保存并应用自定义 provider。
 *
 * ## 校验在**写盘之前**做完整
 *
 * 逐条校验并把**具体哪一条、哪个字段**说清楚。原因很实际：这个配置的失败
 * 出现在宿主启动阶段（组合 profile 时），那时用户看到的是一句
 * "启动失败"，与"我第 3 个 provider 的 baseURL 写错了"之间的距离非常远。
 */
export async function saveProviders(win: Window | undefined): Promise<void> {
  const box = el<HTMLTextAreaElement>(win, PROVIDERS_ID);
  if (!box) {
    // ⚠️ 不能 `if (!box) return;` —— 那样按钮"点了没反应"，
    // 而用户完全无从判断（这正是"按键点了没反应"的一类成因）。
    const detail = win
      ? `找不到输入框（id=${PROVIDERS_ID}）—— 设置页可能版本不匹配，请重装插件。`
      : "设置页窗口已关闭。";
    appendPanelLog("runtime", `自定义 provider：保存失败 —— ${detail}`);
    setProvidersStatus(win, detail);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(box.value.trim() || "[]");
  } catch (error) {
    setProvidersStatus(
      win,
      `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  if (!Array.isArray(parsed)) {
    setProvidersStatus(
      win,
      "顶层必须是数组（`[…]`），里面每个对象是一个 provider。",
    );
    return;
  }

  // 逐条校验；把重复路由也一并查出来（validateProvider 需要"已有的其它路由"）
  const defs: ProviderDefinition[] = [];
  for (const [i, raw] of parsed.entries()) {
    const label = `第 ${i + 1} 条`;
    if (typeof raw !== "object" || raw === null) {
      setProvidersStatus(win, `${label}不是对象。`);
      return;
    }
    const def = raw as ProviderDefinition;
    const others = [
      ...defs.map((d) => d.route),
      ...parsed
        .slice(i + 1)
        .map((r) => (r as ProviderDefinition)?.route)
        .filter((r): r is string => typeof r === "string"),
    ];
    const invalid = validateProvider(def, others);
    if (invalid) {
      setProvidersStatus(
        win,
        `${label}（route=${def.route || "未填"}）：${invalid}`,
      );
      return;
    }
    defs.push(def);
  }

  writeProviders(defs);
  // 立刻写盘（配置 + 凭据），并把"是否需要重启"如实告诉用户
  try {
    const paths = resolveRuntimePaths();
    if (!paths) {
      setProvidersStatus(win, "已保存，但无法定位 profile 目录，未应用。");
      return;
    }
    const applied = await applyProviders({
      profileDir: paths.profile,
      credentialsFile: PathUtils.join(paths.home, ".credentials.yaml"),
    });
    setProvidersStatus(win, applied.detail);
  } catch {
    setProvidersStatus(
      win,
      "已保存。隔离运行时未就绪 —— 启动时它会写入 profile 与凭据。",
    );
  }
}
