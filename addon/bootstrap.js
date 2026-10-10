/**
 * Most of this code is from Zotero team's official Make It Red example[1]
 * or the Zotero 7 documentation[2].
 * [1] https://github.com/zotero/make-it-red
 * [2] https://www.zotero.org/support/dev/zotero_7_for_developers
 */

var chromeHandle;

function install(data, reason) {}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  var aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "__addonRef__", rootURI + "content/"],
  ]);

  /**
   * Global variables for plugin code.
   * The `_globalThis` is the global root variable of the plugin sandbox environment
   * and all child variables assigned to it is globally accessible.
   * See `src/index.ts` for details.
   */
  const ctx = { rootURI };
  // ⚠️ 必须指向**真正的沙箱全局**，而不是 ctx 自身。
  // 打包产物在模块加载期就会写 `_globalThis.addon = new Addon()`，
  // 若 _globalThis 指的是 ctx，`addon` 只会成为 ctx 的一个属性 ——
  // 而产物里对 `addon` 的**裸引用**要找的是真正的全局标识符，取不到就会抛错。
  ctx._globalThis = globalThis;

  /**
   * ⚠️ 为什么要在**全局对象**上定义 addon / ztoolkit（真机实测，2026-10-02）
   *
   * 打包产物在模块加载期就可能引用裸标识符 `addon`（`src/hooks.ts` 顶层的
   * `new SelectionToolbar(addon…)` 曾是这种写法；现已改为惰性构造）。
   * 而 `_globalThis.addon = new Addon()` 的赋值发生在模块求值**之后**，
   * 一旦加载期引用到它就会抛 `ReferenceError: addon is not defined`，
   * 导致 `Zotero.<addonInstance>` 永不赋值、插件静默失效
   * （Zotero 的 _callMethod 吞异常，见 xpcom/plugins.js:264-267，
   *  插件在 extensions.json 里仍显示 active: true）。
   *
   * 修法：在全局对象上放一对**可读可写的访问器**。
   *  - 有 getter：让 `addon` 成为真正的全局标识符（位置无关）；
   *  - **必须有 setter**：产物自己会执行 `_globalThis.addon = new Addon()`，
   *    只有 getter 会报 `TypeError: setting getter-only property "addon"`（踩过）。
   */
  const globalScope = globalThis;
  if (!Object.getOwnPropertyDescriptor(globalScope, "addon")) {
    let addonValue;
    Object.defineProperty(globalScope, "addon", {
      configurable: true,
      get: () => addonValue,
      set: (value) => {
        addonValue = value;
      },
    });
  }
  if (!Object.getOwnPropertyDescriptor(globalScope, "ztoolkit")) {
    Object.defineProperty(globalScope, "ztoolkit", {
      configurable: true,
      // ztoolkit 由产物用 defineGlobal 自行定义（若已定义则上面不会走到这里）
      get: () => globalScope.addon?.data?.ztoolkit,
    });
  }

  Services.scriptloader.loadSubScript(
    `${rootURI}/content/scripts/__addonRef__.js`,
    ctx,
  );
  await Zotero.__addonInstance__.hooks.onStartup();
}

async function onMainWindowLoad({ window }, reason) {
  await Zotero.__addonInstance__?.hooks.onMainWindowLoad(window);
}

async function onMainWindowUnload({ window }, reason) {
  await Zotero.__addonInstance__?.hooks.onMainWindowUnload(window);
}

async function shutdown({ id, version, resourceURI, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }

  await Zotero.__addonInstance__?.hooks.onShutdown();

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

async function uninstall(data, reason) {}
