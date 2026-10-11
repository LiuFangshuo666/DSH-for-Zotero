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

import { requireRuntimeConfig } from "../dsh/config";
import { mintCookieFromCredentials } from "../dsh/auth";
import { DshClient, fetchModelCatalog, type ModelCatalog } from "../dsh/rpc";
import { appendPanelLog } from "../dsh/runLog";
import {
  setSelectedModel,
  setUserApiKey,
  setUserBaseUrl,
  selectedModel,
  syncApiKeyToCredentials,
  syncBaseUrlToHost,
  userApiKey,
  userBaseUrl,
  validateBaseUrl,
} from "../dsh/modelConfig";

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

function setStatus(win: Window | undefined, text: string): void {
  const node = el<HTMLElement>(win, STATUS_ID);
  if (node) node.textContent = text;
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
  if (!input) return;
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
        `${config.dshHome}/.credentials.yaml`,
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
  void fillModelList(win);
}

/** 供选择模型后立刻联动等级下拉框（`modelId` 的 preference 变化时调用） */
export async function onModelChanged(win: Window | undefined): Promise<void> {
  const list = el<MenulistLike>(win, MODEL_ID);
  if (!list) return;
  const pick = decodeModel(list.value);
  if (pick) setSelectedModel({ ...pick, reasoningEffort: "" });
  await fillEffortList(win, list.value);
}
