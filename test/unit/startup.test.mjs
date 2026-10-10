/**
 * 启动期仿真：把**真实构建产物**加载进假沙箱，像 Zotero 的 bootstrap.js 那样跑一遍启动。
 *
 * 为什么值得单独做：插件的很多注册是"尽力而为"的（面板、划词、菜单），
 * 一旦某一步在真机上抛错，表现往往是**功能静默消失**（菜单不见了、面板不出现），
 * 而控制台里未必看得到。这个仿真能把这类错误逼到测试里。
 *
 * 它已经抓到过：`Ci.nsIFile`（沙箱没有 `Ci`）、以及启动流程中"一步失败拖垮后续注册"。
 * 改动 `src/hooks.ts`、`src/index.ts`、`src/modules/**` 时必须保持本测试通过。
 *
 * 用的是 `scripts/dshforzotero.js`（构建产物），不是源码 —— 这样才能覆盖
 * 打包后的真实形态（例如 IIFE 包装、`_globalThis` 注入、`Zotero.<addonInstance>` 挂载）。
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const buildAddonDir = join(here, "..", "..", ".scaffold", "build", "addon");
const bundlePath = join(buildAddonDir, "content", "scripts", "dshforzotero.js");

/** 建一个足够"像 Zotero"的沙箱，返回可断言的对象 */
function makeSandbox() {
  const log = [];
  const registeredSections = [];
  const registeredReaderEvents = [];
  const registeredMenus = [];

  // zotero-plugin-toolkit 在构造 ZoteroToolkit 时会读 `Zotero.Item.prototype`
  // （FieldHookManager），因此必须提供真正的构造器与原型。
  class FakeItem {
    constructor(id, kind) {
      this.id = id;
      this.key = `KEY${id}`;
      this.libraryID = 1;
      this.kind = kind;
    }
    isPDFAttachment() {
      return this.kind === "pdf";
    }
    isRegularItem() {
      return this.kind === "regular";
    }
    getField() {
      return "题名";
    }
    getCreators() {
      return [];
    }
    getTags() {
      return [];
    }
    getAttachments() {
      return this.kind === "pdf" ? [] : [this.id + 1];
    }
    getNotes() {
      return [];
    }
    addTag() {
      return true;
    }
    async saveTx() {
      return this.id;
    }
  }
  class FakeCollection {
    constructor(id) {
      this.id = id;
      this.key = `COL${id}`;
      this.libraryID = 1;
    }
    getChildItems() {
      return [];
    }
    isCollection() {
      return true;
    }
  }

  const parentItem = new FakeItem(1, "regular");
  Object.defineProperty(parentItem, "parentItemID", {
    value: false,
    enumerable: true,
  });
  const pdfItem = new FakeItem(2, "pdf");
  Object.defineProperty(pdfItem, "parentItemID", {
    value: 1,
    enumerable: true,
  });
  const items = new Map([
    [1, parentItem],
    [2, pdfItem],
  ]);

  /** 极简 DOM 桩：只要够 registerMenu 与面板注册走过即可 */
  let doc; // 先声明，makeElement 需要引用它
  const makeElement = (tag) => {
    const element = {
      tagName: tag,
      children: [],
      attributes: {},
      dataset: {},
      style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(name, value) {
        this.attributes[name] = String(value);
      },
      getAttribute(name) {
        return this.attributes[name] ?? null;
      },
      hasAttribute(name) {
        return name in this.attributes;
      },
      removeAttribute(name) {
        delete this.attributes[name];
      },
      addEventListener() {},
      removeEventListener() {},
      appendChild(child) {
        // DocumentFragment 需要展开其子节点（真实 DOM 的行为）
        if (child && child.__isFragment) {
          this.children.push(...child.children);
          child.children.length = 0;
          return child;
        }
        this.children.push(child);
        return child;
      },
      append(...nodes) {
        for (const node of nodes) this.appendChild(node);
      },
      replaceChildren(...nodes) {
        this.children.length = 0;
        for (const node of nodes) this.appendChild(node);
      },
      removeChild(child) {
        const index = this.children.indexOf(child);
        if (index >= 0) this.children.splice(index, 1);
        return child;
      },
      insertBefore(node) {
        this.children.unshift(node);
        return node;
      },
      contains(node) {
        return this.children.includes(node);
      },
      cloneNode() {
        return makeElement(this.tagName);
      },
      get firstChild() {
        return this.children[0] ?? null;
      },
      get lastChild() {
        return this.children[this.children.length - 1] ?? null;
      },
      get childNodes() {
        return this.children;
      },
      remove() {},
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      ownerDocument: null,
      textContent: "",
      id: "",
    };
    element.ownerDocument = doc;
    return element;
  };

  const toolsPopup = makeElement("menupopup");
  toolsPopup.id = "menu_ToolsPopup";
  // 右键菜单容器也要给出真实元素：会话菜单改为**自插 DOM**，
  // 拿不到容器就会走"找不到右键菜单容器"分支、什么都不插。
  const itemMenuPopup = makeElement("menupopup");
  itemMenuPopup.id = "zotero-itemmenu";
  const collectionMenuPopup = makeElement("menupopup");
  collectionMenuPopup.id = "zotero-collectionmenu";
  // 记录访问过的选择器，便于断言"确实往这两个菜单里插过东西"
  const menuSelectors = [];
  doc = {
    querySelector: (selector) => {
      menuSelectors.push(selector);
      if (selector.includes("zotero-itemmenu")) return itemMenuPopup;
      if (selector.includes("zotero-collectionmenu"))
        return collectionMenuPopup;
      return selector.includes("Tools") || selector.includes("工具")
        ? toolsPopup
        : null;
    },
    querySelectorAll: () => [],
    getElementById: () => null,
    createXULElement: (tag) => makeElement(tag),
    createElement: (tag) => makeElement(tag),
    createElementNS: (ns, tag) => makeElement(tag),
    createDocumentFragment: () => {
      const fragment = makeElement("fragment");
      fragment.__isFragment = true;
      return fragment;
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    head: null,
    documentElement: null,
    defaultView: null,
  };
  doc.__menuSelectors = menuSelectors;
  doc.head = makeElement("head");
  doc.documentElement = makeElement("window");

  const win = {
    document: doc,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    MozXULElement: { insertFTLIfNeeded: () => true },
    ZoteroPane: {
      getSelectedItems: () => [items.get(1)],
      getSelectedCollection: () => undefined,
      getSelectedCollections: () => [],
    },
  };
  doc.defaultView = win;

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    TextEncoder,
    TextDecoder,
    Response,
    fetch: async () => new Response("{}", { status: 200 }),
    // 真实 Zotero 沙箱有可用的 XHR；这里给一个能构造的桩即可
    XMLHttpRequest: class {
      open() {}
      setRequestHeader() {}
      send() {}
    },
    // 沙箱里**没有** WebSocket / ChromeWorker / Ci / Cc / Components —— 与真实插件沙箱一致
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    crypto: globalThis.crypto,
    Services: {
      env: {
        get: (k) => (k === "DSH_HOME" ? "C:/Users/test/.dsh" : undefined),
      },
      dirsvc: { get: () => ({ path: "C:/Users/test" }) },
      wm: { addListener: () => undefined, removeListener: () => undefined },
      prefs: {
        getBoolPref: () => false,
        getIntPref: () => 0,
        getStringPref: () => "",
      },
      strings: { createBundle: () => ({ GetStringFromName: (name) => name }) },
      prompt: { alert: () => undefined, confirm: () => true },
      cookies: {
        add: () => {
          throw new Error("no jar");
        },
        getCookiesFromHost: () => [],
        remove: () => undefined,
      },
      io: {
        newURI: (spec) => ({ spec }),
        // 工具包的 DebugBridge 会往 zotero 协议处理器的 _extensions 上挂东西
        getProtocolHandler: () => ({
          wrappedJSObject: { _extensions: {} },
          QueryInterface: () => ({}),
          getHost: () => "",
        }),
      },
      scriptloader: { loadSubScript: () => undefined },
    },
    PathUtils: {
      join: (...parts) => parts.join("/"),
      parent: (p) => String(p).split("/").slice(0, -1).join("/") || null,
      filename: (p) => String(p).split("/").pop() ?? "",
      normalize: (p) => p,
    },
    IOUtils: {
      exists: async () => false,
      readUTF8: async () => "",
      writeUTF8: async (p) => {
        sandbox.__written.push(p);
      },
      makeDirectory: async () => undefined,
      remove: async () => undefined,
    },
    Localization: class {
      constructor() {}
      formatValueSync() {
        return "";
      }
      formatValue() {
        return Promise.resolve("");
      }
      addResourceIds() {
        return true;
      }
    },
    // zotero-plugin-toolkit 在加载期用 `globalThis.Components?.utils ?? globalThis.ChromeUtils`，
    // 并调用 getGlobalForObject —— 沙箱里没有 Components，所以走 ChromeUtils 这条分支。
    ChromeUtils: {
      defineLazyGetter: (object, name, getter) => {
        try {
          Object.defineProperty(object, name, {
            get: getter,
            configurable: true,
          });
        } catch {
          // 忽略
        }
      },
      import: () => ({}),
      importESModule: () => ({
        AddonManager: { getAddonByID: async () => null },
      }),
      getGlobalForObject: (object) => {
        // 极简实现：返回对象所属的沙箱全局
        return object && typeof object === "object" && object.__global__
          ? object.__global__
          : sandbox;
      },
    },
    // bootstrap.js 用 Components 注册 chrome:// 资源（Zotero 沙箱里有它，插件代码里没有）
    Components: {
      classes: {
        "@mozilla.org/addons/addon-manager-startup;1": {
          getService: () => ({
            registerChrome: () => ({ destruct: () => undefined }),
          }),
        },
      },
      interfaces: { amIAddonManagerStartup: {} },
    },
    Zotero: {
      version: "10.0.5",
      initializationPromise: Promise.resolve(),
      unlockPromise: Promise.resolve(),
      uiReadyPromise: Promise.resolve(),
      debug: (message) => log.push(String(message)),
      logError: (message) => log.push(`ERROR ${message}`),
      getMainWindows: () => [win],
      getMainWindow: () => win,
      getActiveZoteroPane: () => win.ZoteroPane,
      DataDirectory: { dir: "C:/ZoteroData" },
      Libraries: { userLibraryID: 1 },
      Item: FakeItem,
      Collection: FakeCollection,
      Items: {
        get: (id) => items.get(id),
        getByLibraryAndKey: () => false,
      },
      Prefs: {
        get: () => undefined,
        set: () => undefined,
        clear: () => undefined,
      },
      Plugins: {
        addObserver: () => undefined,
        removeObserver: () => undefined,
        resolveURI: (id, uri) => `chrome://${id}${uri}`,
        getPlugin: () => undefined,
        isPluginID: () => false,
      },
      Locale: { getString: (id) => id, getLocale: () => "zh-CN" },
      File: {
        getContentsAsync: async () => "",
        putContentsAsync: async () => undefined,
      },
      FullText: {
        getItemCacheFile: () => undefined,
        indexItems: async () => undefined,
      },
      Annotations: { saveFromJSON: async () => ({ id: 1 }) },
      Utilities: {
        generateObjectKey: () => "KEY00001",
        randomString: (length = 8) => "a".repeat(length),
        getRandomString: (length = 8) => "a".repeat(length),
        throttle: (fn) => fn,
        debounce: (fn) => fn,
        itemToCSLJSON: async () => ({}),
        cleanTags: (tags) => tags,
        camelToHyphen: (value) =>
          String(value).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
        capitalize: (value) => String(value),
      },
      ItemPaneManager: {
        registerSection: (options) => {
          registeredSections.push(options);
          return "ok";
        },
        unregisterSection: () => true,
      },
      Reader: {
        _readers: [],
        registerEventListener: (type, handler, pluginID) => {
          registeredReaderEvents.push({ type, handler, pluginID });
        },
        unregisterEventListener: () => undefined,
      },
      MenuManager: {
        registerMenu: (options) => {
          registeredMenus.push(options);
          return "menu-key";
        },
        unregisterMenu: () => true,
      },
      ftl: { addResourceIds: () => true },
    },
    ZoteroToolkit: undefined,
    __written: [],
    __log: log,
  };
  sandbox._globalThis = sandbox;
  sandbox.globalThis = sandbox;
  // vm 的内建构造器不在沙箱对象自身上；工具包会通过
  // Cu.getGlobalForObject(...).Function 动态造包装函数，所以必须显式挂上。
  Object.assign(sandbox, {
    Function,
    Object,
    Array,
    JSON,
    Math,
    Date,
    Error,
    Promise,
    Map,
    Set,
    WeakMap,
    RegExp,
    Number,
    String,
    Boolean,
    Symbol,
    Proxy,
    Reflect,
    Uint8Array,
    ArrayBuffer,
    DataView,
    Intl,
  });

  // bundle 里有**裸引用** `addon`（见 src/index.ts 与 hooks.ts），
  // 真实环境下由 loadSubScript 的 scope 提供；这里等价地补上。
  sandbox.addon = {
    data: {
      alive: true,
      config: {
        addonName: "DSH-for-Zotero",
        addonID: "dsh-for-zotero@local.dev",
        addonRef: "dshforzotero",
        addonInstance: "DSHForZotero",
        prefsPrefix: "extensions.zotero.dshforzotero",
      },
      env: "production",
      initialized: false,
      ztoolkit: undefined,
    },
    hooks: undefined,
    api: {},
  };

  sandbox.__makeElement = makeElement;
  sandbox.__doc = doc;
  // 便于断言"会话菜单确实往这两个容器里插过东西"
  sandbox.__menuSelectors = menuSelectors;

  return {
    sandbox,
    win,
    registeredSections,
    registeredReaderEvents,
    registeredMenus,
    log,
    toolsPopup,
    sandboxContext: vm.createContext(sandbox),
  };
}

/** 加载真实产物（等价于 bootstrap.js 的 loadSubScript） */
function loadBundle(context, sandbox) {
  const code = readFileSync(bundlePath, "utf8");
  vm.runInContext(code, context, { filename: "dshforzotero.js" });
  return sandbox;
}

/**
 * 直接执行**真实的 `addon/bootstrap.js`**（构建产物里的那份）来验证启动链路。
 *
 * 为什么必须这样测：`hooks.ts` 顶层有裸引用 `addon`（例如 `new SelectionToolbar(addon…)`），
 * 它在**模块加载期**执行，且发生在 `Zotero.<instance> = addon` 赋值**之前**。
 * 真机上这个裸标识符由 bootstrap 的 ctx 提供 —— 如果 bootstrap 没提供，
 * 就会 `ReferenceError: addon is not defined`，插件"显示 active 却什么都不工作"
 * （Zotero 的 _callMethod 吞异常，见 xpcom/plugins.js:264-267）。
 *
 * 这个仿真把"真机语义"编码进来：
 *  - `loadSubScript` 会**真的执行产物**（而非空实现）；
 *  - 执行产物前，检查作用域里是否已存在 `addon` / `ztoolkit` 两个标识符 —— 缺了就报错，
 *    与真机行为一致。
 */
function makeBootstrapHarness() {
  const { sandbox, sandboxContext, ...rest } = makeSandbox();
  const bundleSource = readFileSync(bundlePath, "utf8");
  const observations = {
    missingIdentifiers: [],
    identifiers: [],
    loadedProduct: false,
  };

  // bootstrap.js 里的 `globalThis` 就是沙箱全局
  sandbox.globalThis = sandbox;
  sandbox.rootURI = "file:///fake/extensions/dsh-for-zotero@local.dev.xpi!/";

  // 仿真里不关心 uri/target（真实环境由 loadSubScript 的 scope 提供）
  sandbox.Services.scriptloader.loadSubScript = () => {
    // 真机语义：产物里对 `addon` / `ztoolkit` 是**裸引用**（模块加载期就会求值），
    // 因此执行产物之前，作用域里必须已经存在这两个标识符。
    // 注意 `addon` 是惰性 getter，这里用 `in` 判断"标识符已声明"，
    // 但 getter 真正取值必须等到 `_globalThis.addon` 被赋值之后。
    for (const name of ["addon", "ztoolkit"]) {
      if (!(name in sandbox)) observations.missingIdentifiers.push(name);
      else observations.identifiers.push(name);
    }
    try {
      vm.runInContext(bundleSource, sandboxContext, {
        filename: "dshforzotero.js",
      });
      observations.loadedProduct = true;
    } catch (error) {
      // 产物在**模块加载期**就抛错时，Zotero 的 _callMethod 会吞掉它，
      // 表现只有"active 但什么都不工作"。这里必须把真实异常留证。
      observations.loadError = error;
      throw error;
    }
  };

  const bootstrapSource = readFileSync(
    join(buildAddonDir, "bootstrap.js"),
    "utf8",
  )
    .replace(/__addonRef__/g, "dshforzotero")
    .replace(/__addonInstance__/g, "DSHForZotero");
  vm.runInContext(bootstrapSource, sandboxContext, {
    filename: "bootstrap.js",
  });

  return { sandbox, sandboxContext, observations, ...rest };
}

describe("启动期仿真（真实构建产物 + 假 Zotero 沙箱）", function () {
  this.timeout(20000);

  it("[回归] 真实 bootstrap 流程下，产物的裸标识符 addon/ztoolkit 都被提供", async function () {
    // 对应真机失败：bootstrap 的 ctx 若没有 `addon` 标识符，产物在模块加载期
    // 就抛 ReferenceError，Zotero.<instance> 永不赋值，插件静默失效。
    const { sandbox, observations } = makeBootstrapHarness();

    assert.equal(
      observations.missingIdentifiers.length,
      0,
      `loadSubScript 执行时缺少裸标识符：${observations.missingIdentifiers.join(", ")}`,
    );

    // 真正跑一遍 Zotero 会做的调用
    const params = {
      id: "dsh-for-zotero@local.dev",
      version: "0.1.0",
      rootURI: sandbox.rootURI,
    };
    await sandbox.startup(params, 1);

    assert.equal(observations.loadedProduct, true, "应加载过产物");
    assert.ok(
      sandbox.Zotero.DSHForZotero,
      `产物应挂上 Zotero.DSHForZotero；加载期错误=${
        observations.loadError
          ? (observations.loadError.stack ?? observations.loadError.message)
          : "无（说明是 startup 阶段抛的）"
      }`,
    );
    assert.equal(
      typeof sandbox.Zotero.DSHForZotero.hooks.onStartup,
      "function",
    );
  });

  it("产物可被加载，并挂上 Zotero.DSHForZotero", async function () {
    const { sandbox, sandboxContext } = makeSandbox();
    loadBundle(sandboxContext, sandbox);
    assert.ok(sandbox.Zotero.DSHForZotero, "应挂载 Zotero.DSHForZotero");
    assert.equal(
      typeof sandbox.Zotero.DSHForZotero.hooks.onStartup,
      "function",
    );
    assert.equal(
      typeof sandbox.Zotero.DSHForZotero.hooks.onMainWindowLoad,
      "function",
    );
    assert.equal(
      typeof sandbox.Zotero.DSHForZotero.hooks.onShutdown,
      "function",
    );
  });

  it("onStartup 不抛错，注册阅读器面板、会话右键菜单与划词监听", async function () {
    const {
      sandbox,
      sandboxContext,
      registeredSections,
      registeredReaderEvents,
      registeredMenus,
    } = makeSandbox();
    loadBundle(sandboxContext, sandbox);
    await sandbox.Zotero.DSHForZotero.hooks.onStartup();

    // 会话面板（侧栏）已按用户要求**移除**：文献库界面不再显示侧栏。
    // 新建会话改由右键菜单承担（条目 / 分类各一个 target）。
    // 阅读器面板保留 —— 那是划词伴读的入口，与文献库侧栏无关。
    const ids = registeredSections.map((s) => s.paneID);
    assert.ok(
      ids.includes("dshforzotero-reader"),
      `应有阅读器面板，实际 ${ids.join(", ")}`,
    );
    assert.ok(
      !ids.includes("dshforzotero-sessions"),
      `不应再注册会话侧栏（用户要求文献库界面不显示侧栏），实际 ${ids.join(", ")}`,
    );

    const section = registeredSections.find(
      (s) => s.paneID === "dshforzotero-reader",
    );
    assert.equal(section.pluginID, "dsh-for-zotero@local.dev");
    assert.ok(section.header?.l10nID, "面板应有 l10nID");
    assert.equal(typeof section.onRender, "function");

    // icon 是**必填**：pluginAPIBase._validateObject 对非 optional 字段缺值即抛
    // `Option must have header["icon"]`，注册抛错后 section 永远不会出现
    // —— 真机故障（"条目面板没有 DSH 会话"）正是漏了这两个 icon。
    assert.ok(section.header?.icon, "阅读器面板的 header 必须有 icon");
    assert.ok(section.sidenav?.icon, "阅读器面板的 sidenav 必须有 icon");

    // 会话菜单**不再走 MenuManager**（它不认 label、类名又是随机 _key，
    // 实测三种定位方式全失败、且补 label 后仍点了没反应）。
    // 改为在菜单容器里自插 DOM —— 假沙箱的 document.querySelector 桩会记录访问过的选择器。
    const selectors = (sandbox.__menuSelectors ?? []).join(",");
    assert.ok(
      selectors.includes("#zotero-itemmenu"),
      `应往条目右键菜单里插条目，实际访问过的选择器：${selectors || "（无）"}`,
    );
    assert.ok(
      selectors.includes("#zotero-collectionmenu"),
      `应往分类右键菜单里插条目（独立会话的入口），实际：${selectors || "（无）"}`,
    );
    // 也不该再注册 MenuManager 菜单
    const sessionMenus = registeredMenus.filter((m) =>
      String(m.menuID ?? "").includes("sessions"),
    );
    assert.equal(
      sessionMenus.length,
      0,
      `不应再用 MenuManager 注册会话菜单，实际注册了 ${sessionMenus.length} 个`,
    );

    // 工具包自身也会注册阅读器事件，因此按类型筛选，只断言我们那一个
    const ours = registeredReaderEvents.filter(
      (e) => e.type === "renderTextSelectionPopup",
    );
    assert.equal(ours.length, 1, `应注册一个划词事件监听，实际 ${ours.length}`);
    assert.equal(ours[0].pluginID, "dsh-for-zotero@local.dev");
    assert.equal(typeof ours[0].handler, "function");
  });

  it("**不再**往工具菜单里插任何东西（用户要求：自检搬进设置页）", async function () {
    const { sandbox, sandboxContext, registeredMenus, toolsPopup } =
      makeSandbox();
    loadBundle(sandboxContext, sandbox);
    await sandbox.Zotero.DSHForZotero.hooks.onStartup();

    // 菜单注册：一项都不该有
    assert.equal(
      registeredMenus.length,
      0,
      `不应再注册任何菜单，实际注册了 ${registeredMenus.length} 个：` +
        registeredMenus.map((m) => m.menuID).join(", "),
    );
    // DOM 也不该被插入东西（原先有个"DOM 兜底"往工具菜单塞三项）
    const labels = toolsPopup.children
      .map((child) => child.getAttribute?.("label"))
      .filter((label) => typeof label === "string" && label.length > 0);
    assert.deepEqual(
      labels,
      [],
      `工具菜单里不应出现任何本插件的项，实际：${JSON.stringify(labels)}`,
    );
  });

  it("自检入口改由设置页按钮触发（三个事件都能跑通）", async function () {
    const { sandbox, sandboxContext } = makeSandbox();
    loadBundle(sandboxContext, sandbox);
    // 设置页按钮通过 onPrefsEvent 触发；不依赖真实窗口（win 传 undefined 只落盘）
    for (const type of ["selfcheck", "selfcheck-stream", "deep-probe"]) {
      await assert.doesNotReject(
        () => sandbox.Zotero.DSHForZotero.hooks.onPrefsEvent(type, {}),
        `${type} 事件不应抛错`,
      );
    }
  });

  it("onShutdown 不抛错，并移除插件实例", async function () {
    const { sandbox, sandboxContext } = makeSandbox();
    loadBundle(sandboxContext, sandbox);
    await sandbox.Zotero.DSHForZotero.hooks.onStartup();
    await sandbox.Zotero.DSHForZotero.hooks.onShutdown();
    assert.equal(
      sandbox.Zotero.DSHForZotero,
      undefined,
      "应删除 Zotero.DSHForZotero",
    );
  });

  it("面板 onRender 能构建出界面（不依赖真实阅读器窗口）", async function () {
    const { sandbox, sandboxContext, registeredSections } = makeSandbox();
    loadBundle(sandboxContext, sandbox);
    await sandbox.Zotero.DSHForZotero.hooks.onStartup();

    const section = registeredSections[0];
    // 面板渲染会往 body 里塞元素；假 DOM 已支持 createXULElement/appendChild
    const body = sandbox.__makeElement("div");
    const bodyDoc = body.ownerDocument;
    let threw;
    try {
      await section.onRender({
        body,
        doc: bodyDoc,
        item: sandbox.Zotero.Items.get(2),
        tabType: "reader",
      });
    } catch (error) {
      threw = error;
    }
    assert.equal(
      threw,
      undefined,
      `面板渲染不应抛错：${threw instanceof Error ? threw.message : String(threw)}`,
    );
    assert.ok(body.children.length > 0, "面板应往 body 里加入控件");
  });

  it("划词事件会往官方弹窗里追加四个按钮（用真实产物触发真实 handler）", async function () {
    const { sandbox, sandboxContext, registeredReaderEvents, win } =
      makeSandbox();
    loadBundle(sandboxContext, sandbox);
    await sandbox.Zotero.DSHForZotero.hooks.onStartup();

    const entry = registeredReaderEvents.find(
      (e) => e.type === "renderTextSelectionPopup",
    );
    assert.ok(entry, "应注册 renderTextSelectionPopup 监听");

    // 复刻官方示例的事件对象形状（xpcom/reader.js:2743-2749 的 @example）：
    //   let { reader, doc, params, append } = event;  params.annotation.text 是选中文本
    const appended = [];
    const doc = sandbox.__doc;
    const event = {
      reader: { itemID: 2 },
      doc,
      params: { annotation: { text: "被选中的原文", pageIndex: 3 } },
      append: (...nodes) => appended.push(...nodes),
    };

    entry.handler(event);

    assert.equal(appended.length, 1, "应追加一个容器");
    const container = appended[0];
    const buttons = container.children.filter((c) => c.tagName === "button");
    assert.equal(buttons.length, 4, `应有四个预设按钮，实际 ${buttons.length}`);
    assert.deepEqual(
      buttons.map((b) => b.textContent),
      ["解释", "翻译", "通俗化", "追问"],
    );
    for (const button of buttons) {
      assert.ok(button.title.length > 0, "按钮应有悬停说明");
    }
    // 没有打开面板时（没有 selection sink）按钮应禁用并说明原因，而不是静默无效
    assert.equal(buttons[0].disabled, true, "未打开面板时应禁用");
    void win;
  });

  it("窗口尚未就绪时也不会抛错（面板/菜单拿不到窗口应安全退出）", async function () {
    const { sandbox, sandboxContext } = makeSandbox();
    sandbox.Zotero.getMainWindows = () => [];
    loadBundle(sandboxContext, sandbox);
    await sandbox.Zotero.DSHForZotero.hooks.onStartup();
    assert.ok(true, "不应抛错");
  });

  it("缺少 Zotero.ftl 时仍能启动（自检改走设置页后不再依赖 Fluent）", async function () {
    const { sandbox, sandboxContext, registeredSections } = makeSandbox();
    delete sandbox.Zotero.ftl;
    loadBundle(sandboxContext, sandbox);
    await sandbox.Zotero.DSHForZotero.hooks.onStartup();
    // 自检入口现在是设置页按钮（走 onPrefsEvent），菜单那条 Fluent 依赖路径已整体移除。
    // 这里只要求"没有 Fluent 也能正常启动"。
    assert.ok(
      registeredSections.length >= 1,
      `没有 Zotero.ftl 也要能启动并注册阅读器面板，实际注册 ${registeredSections.length} 个`,
    );
  });
});
