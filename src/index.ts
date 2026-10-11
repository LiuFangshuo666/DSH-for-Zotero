import { BasicTool } from "zotero-plugin-toolkit";
import Addon from "./addon";
import { config } from "../package.json";

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
function writeBootstrapSelfCheck(): void {
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

  // 写盘：失败也不能影响启动（所以在最外层再兜一次）。
  //
  // ⚠️ 刻意**不用** `Zotero.DataDirectory.dir` —— 它是个 getter，
  // 在"数据目录尚未初始化"时会**抛异常**（见 Zotero 的 dataDirectory.js）。
  // 而这里要保证"无论如何都能留下一份可读的证据"，所以用与全项目一致的
  // 偏好取法（`Zotero.Prefs.get` + `dataDir`），它在本项目里已被反复验证可用。
  writeDiagnostic(lines);
}

/**
 * 把诊断行追加到插件数据目录下的一个文本文件（供用户贴出来定位问题）。
 *
 * 独立成函数：启动自检与设置页诊断都要用，写到**同一个文件**里，
 * 这样用户只需提供一个路径。
 */
function writeDiagnostic(lines: string[]): void {
  void (async () => {
    try {
      const dataDir = String(
        (Zotero.Prefs.get("dataDir", true) as string | undefined) ?? "",
      );
      if (!dataDir) return;
      const dir = PathUtils.join(dataDir, "dsh-for-zotero");
      await IOUtils.makeDirectory(dir, { ignoreExisting: true });
      const path = PathUtils.join(dir, "diagnostics.txt");
      const prev = (await IOUtils.exists(path))
        ? await IOUtils.readUTF8(path)
        : "";
      // 只留最近若干段，避免无限增长
      const kept = prev.split("----").slice(-6).join("----");
      await IOUtils.writeUTF8(path, `${kept}----\n${lines.join("\n")}\n`);
    } catch {
      // 写不进去不影响功能
    }
  })();
}

/** 供设置页复用：把一段诊断写进同一个文件 */
export { writeDiagnostic };

// @ts-expect-error - Plugin instance is not typed
if (!basicTool.getGlobal("Zotero")[config.addonInstance]) {
  _globalThis.addon = new Addon();
  defineGlobal("ztoolkit", () => {
    return _globalThis.addon.data.ztoolkit;
  });
  // @ts-expect-error - Plugin instance is not typed
  Zotero[config.addonInstance] = addon;
}

writeBootstrapSelfCheck();

function defineGlobal(name: Parameters<BasicTool["getGlobal"]>[0]): void;
function defineGlobal(name: string, getter: () => any): void;
function defineGlobal(name: string, getter?: () => any) {
  Object.defineProperty(_globalThis, name, {
    get() {
      return getter ? getter() : basicTool.getGlobal(name);
    },
  });
}
