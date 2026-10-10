/**
 * 划词工具条：往**官方**的选区弹窗里追加按钮。
 *
 * 依据（Zotero 10 源码核实，见 docs/设计文档-DSH-for-Zotero.md §3.4）：
 *  - 没有 `getSelectedText()`；官方提供事件
 *    `Zotero.Reader.registerEventListener('renderTextSelectionPopup', handler, pluginID)`
 *    （`xpcom/reader.js:2733-2761`），事件对象是 `{ reader, doc, params, append }`；
 *  - 选中文本在 `params.annotation.text`；
 *  - `doc` 是**阅读器 iframe 内的 document**，`append(node)` 把节点插进弹窗；
 *  - 第三参传插件 ID 后，插件卸载时 Zotero 会自动清理监听（`:2774`）。
 *
 * 因此不需要自绘浮层、也不用操心定位与避让。
 *
 * ⚠️ 待实机确认：`params.annotation` 里除 `text` 外的字段（页码名）。这里做了宽松探测，
 * 取不到页码就按"无页码"处理。
 */

import { askWithSelectionAny, selectionSinkCount } from "../chat/transport";

export interface SelectionPreset {
  id: string;
  label: string;
  /** 作为"问题"送进会话的指令 */
  instruction: string;
}

export const BUILTIN_PRESETS: SelectionPreset[] = [
  {
    id: "explain",
    label: "解释",
    instruction: "请解释这段原文的含义，并说明它在全文中的作用。",
  },
  {
    id: "translate",
    label: "翻译",
    instruction: "请把这段原文翻译成中文，专业术语保留英文原词。",
  },
  {
    id: "plain",
    label: "通俗化",
    instruction: "请用通俗的语言重述这段原文，假设读者是刚入门的研究生。",
  },
  {
    id: "ask",
    label: "追问",
    instruction: "关于这段原文，请指出其中值得追问或可能存在问题的点。",
  },
];

/**
 * 阅读器里选中文字时弹出的工具条。
 *
 * 每条预设把"选中的原文 + 一段固定指令"发给当前条目会话，回答直接显示在阅读器面板里。
 * 预设清单是**数据**（`BUILTIN_PRESETS`）：加一条动作不必改逻辑，只加一个对象。
 *
 * ## 注册机制
 *
 * 走官方的 `Zotero.Reader.registerEventListener("renderTextSelectionPopup", …)`，
 * 用它给的回调参数（`doc` / `params.annotation.text` / `append`）往弹窗里追加按钮。
 * 注册**以 pluginID 为键、幂等**：重复调用直接返回，不会挂出重复的事件处理器。
 *
 * ## ⚠️ 这是本项目**实测最少**的一条路径
 *
 * 划词弹窗依赖阅读器的真实渲染流程，单元测试覆盖不到。**改动这里之后务必在真机上
 * 手动验证一次**（打开 PDF → 划一段 → 看工具条是否出现、点下去是否有回答）。
 * 交接文档把它列在"未在真机确认"清单里，不要因为代码看起来对就当作已验证。
 */
export class SelectionToolbar {
  private registered = false;
  private readonly pluginID: string;
  private readonly presets: SelectionPreset[];

  constructor(pluginID: string, presets: SelectionPreset[] = BUILTIN_PRESETS) {
    this.pluginID = pluginID;
    this.presets = presets;
  }

  register(): void {
    if (this.registered) return;
    try {
      Zotero.Reader.registerEventListener(
        "renderTextSelectionPopup",
        (event: {
          reader?: { itemID?: number };
          doc?: Document;
          params?: {
            annotation?: {
              text?: string;
              pageIndex?: number;
              pageLabel?: string;
            };
          };
          append?: (...nodes: Element[]) => void;
        }) => {
          this.onRenderPopup(event);
        },
        this.pluginID,
      );
      this.registered = true;
      ztoolkit.log("[DSH] 划词工具条已注册");
    } catch (error) {
      ztoolkit.log("[DSH] 注册划词工具条失败", error);
    }
  }

  private onRenderPopup(event: {
    reader?: { itemID?: number };
    doc?: Document;
    params?: {
      annotation?: { text?: string; pageIndex?: number; pageLabel?: string };
    };
    append?: (...nodes: Element[]) => void;
  }): void {
    const doc = event.doc;
    const append = event.append;
    const text = event.params?.annotation?.text?.trim();
    if (!doc || typeof append !== "function" || !text) return;

    const itemKey = this.resolveItemKey(event.reader?.itemID);
    const pageIndex = this.resolvePageIndex(event.params?.annotation);
    const rects = this.resolveRects(event.params?.annotation);

    const container = doc.createElement("div");
    container.style.display = "flex";
    container.style.gap = "4px";
    container.style.alignItems = "center";
    container.style.padding = "2px 0";

    const disabled = !itemKey || selectionSinkCount() === 0;
    const reason = !itemKey
      ? "无法确定所属文献"
      : selectionSinkCount() === 0
        ? "请先打开该文献的 DSH 伴读面板"
        : "";

    for (const preset of this.presets) {
      const button = doc.createElement("button");
      button.textContent = preset.label;
      button.title = reason || preset.instruction;
      button.disabled = disabled;
      if (disabled) {
        button.style.opacity = "0.5";
      }
      button.addEventListener("click", () => {
        void this.runPreset(itemKey, text, pageIndex, rects, preset, button);
      });
      container.append(button);
    }

    if (!itemKey && reason) {
      const hint = doc.createElement("span");
      hint.textContent = reason;
      hint.style.opacity = "0.7";
      hint.style.fontSize = "11px";
      container.append(hint);
    }

    try {
      append(container);
    } catch (error) {
      ztoolkit.log("[DSH] 追加划词按钮失败", error);
    }
  }

  private async runPreset(
    itemKey: string | undefined,
    text: string,
    pageIndex: number | undefined,
    rects: number[][] | undefined,
    preset: SelectionPreset,
    button: HTMLButtonElement,
  ): Promise<void> {
    if (!itemKey) return;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "…";
    try {
      const outcome = await askWithSelectionAny(
        itemKey,
        text,
        pageIndex,
        preset.instruction,
        rects,
      );
      if (outcome === "no-panel") {
        button.textContent = "请先打开面板";
        ztoolkit.log("[DSH] 划词提问失败：该文献没有打开的面板");
      } else {
        button.textContent = "已发送";
      }
    } catch (error) {
      button.textContent = "失败";
      ztoolkit.log("[DSH] 划词提问异常", error);
    } finally {
      setTimeout(() => {
        button.textContent = original;
        button.disabled = false;
      }, 1500);
    }
  }

  /** 阅读器实例的 itemID → 文献 itemKey（附件要上溯到父条目） */
  private resolveItemKey(itemID?: number): string | undefined {
    if (!itemID) return undefined;
    try {
      const item = Zotero.Items.get(itemID);
      if (!item) return undefined;
      const parentID = (item as unknown as { parentItemID?: number | false })
        .parentItemID;
      const owner = parentID ? (Zotero.Items.get(parentID) ?? item) : item;
      return owner.key;
    } catch (error) {
      ztoolkit.log("[DSH] 解析文献 key 失败", error);
      return undefined;
    }
  }

  /** 从选区载荷里尽量取页码（字段名待实机确认，故做宽松探测） */
  private resolvePageIndex(annotation?: {
    pageIndex?: number;
    pageLabel?: string;
    [key: string]: unknown;
  }): number | undefined {
    if (!annotation) return undefined;
    if (typeof annotation.pageIndex === "number") return annotation.pageIndex;
    for (const key of ["page", "pageNumber", "pageIdx", "pageIndex0"]) {
      const value = annotation[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        // pageNumber 常见为 1 基
        return key === "pageNumber" ? value - 1 : value;
      }
    }
    return undefined;
  }

  /**
   * 从选区载荷里取注释矩形（存为高亮必需）。
   * 字段名待实机确认：Zotero 的注释位置是 `{ pageIndex, rects: [[x1,y1,x2,y2], …] }`，
   * 选区弹窗的载荷不一定直接给 rects，故做宽松探测；取不到时"存为高亮"会被禁用。
   */
  private resolveRects(annotation?: {
    [key: string]: unknown;
  }): number[][] | undefined {
    if (!annotation) return undefined;
    const candidates = [annotation.rects, annotation.position, annotation.rect];
    for (const candidate of candidates) {
      const rects = this.normalizeRects(candidate);
      if (rects) return rects;
    }
    return undefined;
  }

  private normalizeRects(value: unknown): number[][] | undefined {
    if (!value) return undefined;
    // 直接就是 rects 数组
    if (Array.isArray(value) && value.length > 0 && Array.isArray(value[0])) {
      const rects = (value as unknown[]).filter(
        (r): r is number[] =>
          Array.isArray(r) &&
          r.length >= 4 &&
          r.every((n) => typeof n === "number"),
      );
      return rects.length ? rects : undefined;
    }
    // position 对象
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const nested = (value as { rects?: unknown }).rects;
      if (Array.isArray(nested)) return this.normalizeRects(nested);
    }
    return undefined;
  }
}
