import { BasicTool } from "zotero-plugin-toolkit";
import Addon from "./addon";
import { config } from "../package.json";
import { appendDiagnostic } from "./dsh/runLog";

const basicTool = new BasicTool();

/**
 * 引导自检：把"设置页能不能用"这件事**落盘**。
 *
 * ## 为什么需要它（真机反馈"模型一节的按键都看不出效果"）
 *
 * 设置页的 `oncommand` 全都是这个形状：
 *
 * ```text
 *   Zotero.DSHForZotero.hooks.onPrefsEvent('model-save-key', { window })
 * ```
 *
 * 它们依赖三件事同时成立：
 *  1. `Zotero.DSHForZotero` 这个全局对象存在；
 *  2. 它有 `hooks.onPrefsEvent`；
 *  3. 事件名在 `dispatchPrefsEvent` 里有对应 `case`。
 *
 * 任何一条不成立，表现**完全一样**：点下去什么都不发生 ——
 * 没有报错、没有提示，用户只能描述成"点了没反应"。
 * 而插件跑在沙箱里，`ztoolkit.log` 的输出用户看不到（要开浏览器工具箱）。
 *
 * 所以这里把三件事的结论写进一个文本文件，用户只要把文件内容发出来，
 * 就能立刻定位断在哪一环。这比"请开调试窗口找 Console"现实得多。
 */
export function writeBootstrapSelfCheck(): void {
  const lines: string[] = [];
  const ok = (v: boolean) => (v ? "OK" : "**缺失**");
  try {
    // ① 全局对象
    const instance = (Zotero as unknown as Record<string, unknown>)[
      config.addonInstance
    ] as { hooks?: Record<string, unknown> } | undefined;
    lines.push(`addonInstance      = ${config.addonInstance}`);
    lines.push(`Zotero[instance]   = ${ok(Boolean(instance))}`);
    // ② hooks.onPrefsEvent
    const hasPrefs = typeof instance?.hooks?.onPrefsEvent === "function";
    lines.push(`hooks.onPrefsEvent = ${ok(hasPrefs)}`);
    if (!hasPrefs) {
      lines.push(
        "  → 设置页的所有按钮都会「点了没反应」（oncommand 取不到这个函数）。",
      );
    }
    // ③ addon 是否绑定在全局（第 9 行那个 `if` 没进的话就没有）
    const globalAddon = (globalThis as unknown as { addon?: unknown }).addon;
    lines.push(`globalThis.addon   = ${ok(Boolean(globalAddon))}`);
    lines.push(`addonID            = ${config.addonID}`);
    lines.push(`addonRef           = ${config.addonRef}`);
    lines.push(`时间               = ${new Date().toISOString()}`);
  } catch (error) {
    lines.push(
      `自检本身抛错：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  lines.push("");

  // 写盘：失败也不能影响启动。
  appendDiagnostic("插件启动", lines);
}

// @ts-expect-error - Plugin instance is not typed
if (!basicTool.getGlobal("Zotero")[config.addonInstance]) {
  _globalThis.addon = new Addon();
  defineGlobal("ztoolkit", () => {
    return _globalThis.addon.data.ztoolkit;
  });
  // @ts-expect-error - Plugin instance is not typed
  Zotero[config.addonInstance] = addon;
}

function defineGlobal(name: Parameters<BasicTool["getGlobal"]>[0]): void;
function defineGlobal(name: string, getter: () => any): void;
function defineGlobal(name: string, getter?: () => any) {
  Object.defineProperty(_globalThis, name, {
    get() {
      return getter ? getter() : basicTool.getGlobal(name);
    },
  });
}
