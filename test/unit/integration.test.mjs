/**
 * 集成测试：在**假的 Zotero + 假的 dsh 环境**里把核心闭环整体跑一遍。
 *
 * 为什么需要：单元测试只覆盖纯逻辑，而最容易出问题的是"模块之间接不上" ——
 * 例如工作区写完后提示词里的路径不对、批量控制器拿不到条目、写回时父条目解析不出来。
 * 这些在真机上排查成本高，但在假环境里可以完整跑通。
 *
 * 假环境提供：`Zotero`（条目/全文缓存/注解保存）、`IOUtils`/`PathUtils`（内存文件系统）、
 * `Services`（env/dirsvc/cookies）、以及一个**假的 fetch**（按 dsh 的线协议回响应）；
 * 并显式屏蔽 WebSocket 与 ChromeWorker，逼出"流式不可用 → 轮询兜底"这条真实路径。
 *
 * ⚠️ 这些测试曾抓到两个只会在真机暴露的 bug：`Ci.nsIFile`（沙箱里没有 `Ci`）与
 * `askOnce` 在流式过早关闭时不回退轮询。改动这两处代码时请务必保持这些测试通过。
 */

import { strict as assert } from "node:assert";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = await import(
  new URL(
    `file://${join(here, ".build", "unit-entry.mjs").replace(/\\/g, "/")}`,
  ).href
);

// ── 假文件系统（内存） ──────────────────────────────────────

function createFakeFs() {
  const files = new Map();
  const dirs = new Set();
  const normalize = (path) => posix.normalize(String(path).replace(/\\/g, "/"));
  const fs = {
    files,
    dirs,
    normalize,
    async makeDirectory(path) {
      let current = normalize(path);
      dirs.add(current);
      while (current && current !== "/" && current !== ".") {
        current = posix.dirname(current);
        if (current === "." || current === "/") break;
        dirs.add(current);
      }
    },
    async exists(path) {
      const norm = normalize(path);
      return files.has(norm) || dirs.has(norm);
    },
    async readUTF8(path) {
      const norm = normalize(path);
      if (!files.has(norm)) throw new Error(`ENOENT: ${norm}`);
      return files.get(norm);
    },
    async writeUTF8(path, content) {
      const norm = normalize(path);
      files.set(norm, String(content));
      await fs.makeDirectory(posix.dirname(norm));
    },
    async remove(path) {
      files.delete(normalize(path));
    },
  };
  return fs;
}

// ── 假 Zotero ───────────────────────────────────────────────

const PDF_TEXT =
  "Abstract\nWe propose a taxonomy for EDA with LLMs.\n\n1 Introduction\nPrior work is limited.\n";

function createFakeZotero() {
  const attachment = {
    id: 101,
    key: "PDFKEY01",
    libraryID: 1,
    isPDFAttachment: () => true,
    parentItemID: 100,
  };
  const parent = {
    id: 100,
    key: "ITEMKEY1",
    libraryID: 1,
    isPDFAttachment: () => false,
    parentItemID: false,
    isRegularItem: () => true,
    getField: (field) => {
      const fields = {
        title: "Enhancing EDA with LLMs",
        publicationTitle: "Journal of Test",
        date: "2026",
        DOI: "10.1000/test",
        url: "https://example.org/a",
        abstractNote: "A taxonomy and analysis of LLMs for EDA.",
      };
      return fields[field] ?? "";
    },
    getCreators: () => [{ firstName: "Ada", lastName: "Lovelace" }],
    getTags: () => [{ tag: "LLM" }],
    getAttachments: () => [101],
    getNotes: () => [],
    addTag(name) {
      const tags = this.__tags ?? (this.__tags = []);
      if (tags.includes(name)) return false;
      tags.push(name);
      return true;
    },
    async saveTx() {
      this.__saved = (this.__saved ?? 0) + 1;
      return this.id;
    },
  };
  const items = new Map([
    [100, parent],
    [101, attachment],
  ]);
  const annotations = [];

  const Zotero = {
    version: "10.0.5",
    initializationPromise: Promise.resolve(),
    unlockPromise: Promise.resolve(),
    uiReadyPromise: Promise.resolve(),
    getMainWindows: () => [],
    getMainWindow: () => undefined,
    debug: () => undefined,
    logError: () => undefined,
    Libraries: { userLibraryID: 1 },
    DataDirectory: { dir: "C:/ZoteroData" },
    Items: {
      get: (id) => items.get(id),
      getByLibraryAndKey: (libraryID, key) => {
        for (const item of items.values()) {
          if (item.libraryID === libraryID && item.key === key) return item;
        }
        return false;
      },
    },
    FullText: {
      getItemCacheFile: () => ({
        path: "C:/ZoteroData/storage/PDFKEY01/.zotero-ft-cache",
      }),
      indexItems: async () => undefined,
      getPages: async () => ({ total: 8 }),
    },
    Annotations: {
      saveFromJSON: async (att, json, saveOptions) => {
        annotations.push({ attachmentID: att.id, json, saveOptions });
        return { id: 900 + annotations.length };
      },
    },
    Utilities: { generateObjectKey: () => "ABCD1234" },
    Prefs: {
      get: () => undefined,
      set: () => undefined,
      clear: () => undefined,
    },
    ItemPaneManager: {
      registerSection: () => "ok",
      unregisterSection: () => true,
    },
    Reader: { registerEventListener: () => undefined },
    MenuManager: { registerMenu: () => "menu", unregisterMenu: () => true },
  };

  return { Zotero, fixtures: { parent, attachment, annotations, items } };
}

// ── 假 fetch（按 dsh 线协议回响应） ──────────────────────────

function installFakeDsh(options = {}) {
  const calls = [];
  const textToReturn = options.text ?? "结论是 A。";
  /**
   * 供 session/page 返回：与真实 dsh 保持一致的结构。
   *
   * 真实记录是 `{ type:"event", event:{ type, seq, data } }`，正文在
   * `assistant/message` 的 `data.message.content[]` 里，且**只应取 `type:"text"` 的块**
   * （`reasoning` 是模型思考，不能显示）。这里刻意放一个 reasoning 块，用来保证
   * 实现不会把思考内容当正文显示出去。
   */
  const pageValue = () => ({
    records: [
      {
        type: "event",
        event: { type: "turn/start", seq: 4, data: {} },
      },
      {
        type: "event",
        event: {
          type: "user/message",
          seq: 5,
          data: {
            content: [{ type: "text", text: "第一轮的提问" }],
            source: { kind: "user" },
          },
        },
      },
      {
        type: "event",
        event: {
          type: "user/message",
          seq: 6,
          data: {
            content: [
              {
                type: "text",
                // 真实形态：**没有尖括号**（先前按 `^<…` 过滤会漏掉它）
                text: "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.",
              },
            ],
            source: { kind: "runtime-context", form: "snapshot" },
          },
        },
      },
      {
        type: "event",
        event: {
          type: "user/message",
          seq: 7,
          data: {
            content: [
              {
                type: "text",
                text: "<system-reminder>\nA skill is …\n</system-reminder>",
              },
            ],
            source: { kind: "skill-catalog", form: "catalog" },
          },
        },
      },
      {
        type: "event",
        event: {
          type: "assistant/message",
          seq: 8,
          data: {
            message: {
              role: "assistant",
              content: options.turnEndsWithError
                ? // 真实形态：错误轮次**没有 assistant/message 正文**（真机实测
                  // 无模型凭据时只有 turn/end 的 reason，没有正文块）
                  [{ type: "reasoning", text: "内部思考：不应该出现在界面上" }]
                : [
                    { type: "reasoning", text: "内部思考：不应该出现在界面上" },
                    { type: "text", text: textToReturn },
                  ],
            },
          },
        },
      },
      {
        type: "event",
        event: {
          type: "turn/end",
          seq: 9,
          // 真实形态：reason.kind === "error" 时错误信息在 reason.error.message
          data: options.turnEndsWithError
            ? {
                turn: 1,
                reason: {
                  kind: "error",
                  error: { message: options.turnEndsWithError },
                },
              }
            : { turn: 1, reason: { kind: "completed" } },
        },
      },
    ],
  });
  const valueFor = (method) => {
    switch (method) {
      case "session/list":
        return {
          items: [{ sessionId: "session-x", cwd: options.cwd ?? "C:/ws" }],
        };
      case "session/create":
        return { sessionId: options.recreatedSessionId ?? "session-recreated" };
      case "session/prompt": {
        // 模拟"会话已不存在"：第一次 prompt 报 session/not-found，之后正常
        if (options.failFirstPromptWithNotFound && !options.__promptFailed) {
          options.__promptFailed = true;
          return {
            __error: {
              code: "session/not-found",
              message: 'session "x" not found',
            },
          };
        }
        return { accepted: true };
      }
      case "session/cancel":
        return { accepted: true };
      case "session/projections":
        // 真实 dsh：turnOutline.response 是**被截断的摘要**（实测约 120 字符上限），
        // 因此这里故意返回一段短摘要，用来保证实现不会拿它当正文。
        return {
          asOfSeq: 26,
          values: {
            turnOutline: [
              {
                turn: 1,
                seq: 4,
                prompt: "问题",
                response: "摘要（被截断，不是正文）",
              },
            ],
          },
        };
      case "session/page":
        return pageValue();
      default:
        return undefined;
    }
  };

  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/api/")[1] ?? "";
    calls.push({
      method,
      via: "fetch",
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    const value = valueFor(method);
    if (!value) return new Response("not found", { status: 404 });
    // 业务失败仍是 HTTP 200，错误放在 result.ok=false —— 与 dsh 真实行为一致
    if (value.__error) {
      return new Response(
        JSON.stringify({
          type: "server-response",
          rpcId: "r1",
          result: { ok: false, error: value.__error },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        type: "server-response",
        rpcId: "r1",
        result: { ok: true, value },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  // 真实 Zotero 里一定有 XHR；cookie 罐不可用时 RPC 会走它（显式 Cookie 头）
  globalThis.XMLHttpRequest = class {
    constructor() {
      this.headers = {};
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name, value) {
      this.headers[name] = value;
    }
    send(body) {
      this.body = body;
      const method = String(this.url).split("/api/")[1];
      // 记录 body：断言"重建沿用同一工作区"需要读 request.cwd
      calls.push({
        method,
        via: "xhr",
        body: body ? JSON.parse(body) : undefined,
      });
      const value = valueFor(method);
      if (!value) {
        this.status = 404;
        this.responseText = "not found";
      } else if (value.__error) {
        // 业务失败仍是 HTTP 200，错误在 result.ok=false —— 与 dsh 真实行为一致。
        // 插件在 cookie 罐不可用时走 XHR，所以这条分支是测试自愈逻辑的必经之路。
        this.status = 200;
        this.responseText = JSON.stringify({
          type: "server-response",
          rpcId: "r1",
          result: { ok: false, error: value.__error },
        });
      } else {
        this.status = 200;
        this.responseText = JSON.stringify({
          type: "server-response",
          rpcId: "r1",
          result: { ok: true, value },
        });
      }
      this.onload();
    }
  };

  return calls;
}

// ── 组装沙箱 ────────────────────────────────────────────────

async function installSandbox(options = {}) {
  const fs = createFakeFs();
  const { Zotero, fixtures } = createFakeZotero();
  const calls = installFakeDsh(options);

  // ⚠️ 凭据要写在**隔离实例的 DSH_HOME** 下。
  //
  // 这里原先写 `C:/Users/test/.dsh` —— 那是**共享模式**（桌面版 Harness）的 HOME。
  // 共享模式已按用户要求删除，插件的 HOME 固定为
  // `<数据目录>/dsh-for-zotero/home`（见 isolatedPaths.ts），所以凭据也在那里。
  // 这些测试此前一直用共享模式的路径，说明它们验证的是一条用户走不到的路径。
  const isolatedHome = "C:/ZoteroData/dsh-for-zotero/home";
  fs.files.set(
    `${isolatedHome}/.credentials.yaml`,
    [
      "version: 1",
      "records:",
      "  client-connection/browser-session:",
      "    kind: grant",
      "    payload:",
      "      version: 1",
      "      secret: kvYh1bFjdU3nkrzivXsCbhdqp7iUvTwl0mNqRsTuVwX",
    ].join("\n"),
  );
  fs.dirs.add(isolatedHome);
  fs.files.set("C:/ZoteroData/storage/PDFKEY01/.zotero-ft-cache", PDF_TEXT);
  fs.dirs.add("C:/ZoteroData/storage/PDFKEY01");

  Object.assign(globalThis, {
    Zotero,
    IOUtils: {
      exists: (p) => fs.exists(p),
      readUTF8: (p) => fs.readUTF8(p),
      writeUTF8: (p, c) => fs.writeUTF8(p, c),
      makeDirectory: (p) => fs.makeDirectory(p),
      remove: (p) => fs.remove(p),
      writeJSON: async (p, v) => fs.writeUTF8(p, JSON.stringify(v)),
    },
    PathUtils: {
      join: (...parts) =>
        posix.join(...parts.map((p) => String(p).replace(/\\/g, "/"))),
      parent: (p) => posix.dirname(String(p).replace(/\\/g, "/")),
      filename: (p) => posix.basename(String(p).replace(/\\/g, "/")),
      normalize: (p) => posix.normalize(String(p).replace(/\\/g, "/")),
    },
    Services: {
      env: {
        get: (name) => (name === "DSH_HOME" ? "C:/Users/test/.dsh" : undefined),
      },
      dirsvc: { get: () => ({ path: "C:/Users/test" }) },
      cookies: {
        // 模拟沙箱里的真实情况：cookie 罐写入失败（签名不匹配），必须走显式 Cookie 头
        add: () => {
          throw new Error("模拟：cookie 罐不可用");
        },
        getCookiesFromHost: () => [],
        remove: () => undefined,
      },
    },
    ztoolkit: {
      log: () => undefined,
      ProgressWindow: class {
        createLine() {
          return this;
        }
        show() {
          return this;
        }
        changeLine() {
          return this;
        }
        startCloseTimer() {
          return this;
        }
      },
      Clipboard: class {
        addText() {
          return this;
        }
        copy() {
          return true;
        }
      },
      Dialog: class {
        addCell() {
          return this;
        }
        addButton() {
          return this;
        }
        setDialogData() {
          return this;
        }
        open() {
          return this;
        }
      },
    },
    __prefs: new Map([
      // ⚠️ 共享模式已删除（用户要求只允许隔离使用）。那一组偏好
      // （dshPort / authMode / dshHome / launchUrl / useIsolatedRuntime —— 全部已随共享模式删除）
      // 已从 prefs.js 移除，这里也不再 mock。
      ["extensions.zotero.dshforzotero.isolatedPort", 19400],
      ["extensions.zotero.dshforzotero.requestTimeoutMs", 5000],
      ["extensions.zotero.dshforzotero.chunkBytes", 40960],
      ["extensions.zotero.dshforzotero.answerLanguage", "zh-CN"],
      ["extensions.zotero.dshforzotero.highlightColor", "#ffd400"],
      ["extensions.zotero.dshforzotero.installSkill", false],
      ["extensions.zotero.dshforzotero.installAgentInstructions", false],
    ]),
  });

  Zotero.Prefs.get = (name) =>
    globalThis.__prefs.get(`extensions.zotero.${name}`);

  // 屏蔽 WebSocket / ChromeWorker：Node 24 自带全局 WebSocket，
  // 不屏蔽会真的去连本地端口，测试就依赖环境了。
  const savedWebSocket = globalThis.WebSocket;
  const savedChromeWorker = globalThis.ChromeWorker;
  globalThis.WebSocket = undefined;
  globalThis.ChromeWorker = undefined;

  globalThis.addon = {
    data: {
      config: {
        addonName: "DSH-for-Zotero",
        addonID: "dsh-for-zotero@zotero.cn",
        addonRef: "dshforzotero",
        addonInstance: "DSHForZotero",
        prefsPrefix: "extensions.zotero.dshforzotero",
      },
      // ⚠️ **必须 mock 隔离运行时**。
      //
      // 插件现在只支持隔离模式（共享模式已按用户要求删除）：
      // `resolveRuntimeConfig()` 在宿主未就绪时返回 `undefined`，
      // 调用方据此明确报"运行时未就绪"，**不再回退到桌面版 dsh**。
      //
      // 这里以前没有这个 mock，于是 `resolveIsolatedEndpoint()` 恒返回 undefined，
      // 测试走的其实是**已删除的共享模式**分支 —— 也就是说这些集成测试一直在验证
      // 一条用户不会走到的路径。删掉共享模式后它们全部失败，正好暴露了这一点。
      runtime: {
        getStatus: () => ({ phase: "running", port: 19400 }),
      },
    },
  };

  return {
    fs,
    zotero: Zotero,
    fixtures,
    calls,
    savedWebSocket,
    savedChromeWorker,
  };
}

const TEST_CONFIG = {
  dshHome: "C:/Users/test/.dsh",
  workspaceRoot: "C:/Users/test/.dsh/dsh-for-zotero",
  port: 19387,
  authority: "127.0.0.1:19387",
  baseUrl: "http://127.0.0.1:19387",
  wsUrl: "ws://127.0.0.1:19387/api/remote.mux",
  requestTimeoutMs: 5000,
  // ⚠️ 这里原有 `authMode` / `launchUrl` / `dshHomeSource: "env"` —— 那三个字段
  // 都是**共享模式**的产物（外部 dsh 的认证方式、要粘贴的启动 URL、HOME 来源推断），
  // 已随共享模式从 `DshRuntimeConfig` 里删除。现在只剩隔离模式一种来源。
  dshHomeSource: "isolated",
};

// ── 测试 ────────────────────────────────────────────────────

describe("集成：论文工作区与提示词（假 Zotero + 假 FS）", function () {
  it("写入工作区文件：meta.json 含元数据、页数与可读文件清单", async function () {
    const { fs, zotero, fixtures } = await installSandbox();
    const prepared = await bundle.preparePaperWorkspace(
      TEST_CONFIG,
      fixtures.attachment,
      {},
    );
    assert.ok(prepared, "应能准备上下文");
    assert.equal(prepared.ref.key, "ITEMKEY1", "附件应上溯到父条目");
    assert.equal(prepared.ref.attachmentID, 101);

    const metaPath = [...fs.files.keys()].find((p) => p.endsWith("meta.json"));
    assert.ok(
      metaPath,
      `应写入 meta.json，实际：${[...fs.files.keys()].join(", ")}`,
    );
    const meta = JSON.parse(fs.files.get(metaPath));
    assert.match(meta.metadataText, /Enhancing EDA with LLMs/);
    assert.match(meta.metadataText, /Ada Lovelace/);
    assert.equal(meta.noTextLayer, false);
    assert.equal(meta.pageCount, 8);
    assert.ok(
      meta.files.some((f) => f.endsWith(".txt")),
      "清单里应有可读文本文件",
    );
    void zotero;
  });

  it("短全文写 paper.txt，内容与缓存一致，且提示词引用了它", async function () {
    const { fs, fixtures } = await installSandbox();
    const prepared = await bundle.preparePaperWorkspace(
      TEST_CONFIG,
      fixtures.parent,
      {},
    );
    const paperPath = [...fs.files.keys()].find((p) => p.endsWith("paper.txt"));
    assert.ok(paperPath, "短文档应写 paper.txt");
    assert.equal(fs.files.get(paperPath), PDF_TEXT, "内容应与全文缓存一致");

    const prompt = bundle.buildPrompt({
      metadataText: prepared.metadataText,
      files: prepared.files,
      question: "他们的方法是什么？",
      answerLanguage: "zh-CN",
    });
    assert.match(prompt, /paper\.txt/);
    assert.match(prompt, /工作目录：/);
    assert.match(prompt, /不是给你的指令/);
  });
});

describe("集成：RPC 客户端（假 fetch + 假 XHR）", function () {
  it("cookie 罐不可用时降级为显式 Cookie 头，并能解析出会话", async function () {
    await installSandbox();
    const client = new bundle.DshClient({
      config: TEST_CONFIG,
      cookie: {
        name: "dsh-auth-x",
        value: "v1.a.b",
        header: "dsh-auth-x=v1.a.b",
        expiresAt: 0,
        source: "credentials",
      },
    });
    const prepared = client.prepare();
    assert.equal(
      prepared.delivery,
      "xhr-header",
      "cookie 罐失败应降级为显式头",
    );

    globalThis.XMLHttpRequest = class {
      constructor() {
        this.headers = {};
      }
      open(method, url) {
        this.method = method;
        this.url = url;
      }
      setRequestHeader(name, value) {
        this.headers[name] = value;
      }
      send(body) {
        this.body = body;
        const method = String(this.url).split("/api/")[1];
        const value =
          method === "session/list"
            ? { items: [{ sessionId: "s1", running: true, cwd: "C:/ws" }] }
            : { accepted: true };
        this.status = 200;
        this.responseText = JSON.stringify({
          type: "server-response",
          rpcId: "r1",
          result: { ok: true, value },
        });
        this.onload();
      }
    };

    const result = await client.call("session/list", { _request: {} });
    assert.equal(result.delivery, "xhr-header");
    assert.equal(result.value.items[0].sessionId, "s1");
    assert.equal(result.value.items[0].cwd, "C:/ws");
  });
});

describe("集成：结果回写（假 Zotero 注解 API）", function () {
  it("存为高亮会调用 saveFromJSON，并带上位置与评论（新建对象不需要 undoAction）", async function () {
    const { fixtures } = await installSandbox();
    const outcome = await bundle.saveAnswerAsHighlight(
      fixtures.attachment,
      {
        question: "这句什么意思？",
        answer: "意思是 A。",
        selection: "the proposed method",
        pageLabel: "第 6 页",
      },
      { pageIndex: 5, rects: [[10, 20, 30, 40]] },
      { color: "#ffd400" },
    );
    assert.equal(outcome.annotationID, 901);
    const saved = fixtures.annotations[0];
    assert.equal(saved.attachmentID, 101);
    assert.equal(saved.json.type, "highlight");
    assert.equal(saved.json.text, "the proposed method");
    assert.match(saved.json.comment, /这句什么意思？/);
    assert.match(saved.json.comment, /意思是 A。/);
    assert.equal(saved.json.pageLabel, "第 6 页");
    assert.deepEqual(saved.json.position, {
      pageIndex: 5,
      rects: [[10, 20, 30, 40]],
    });
    // 新注解是 isNew：不进撤销栈，因此**不应**要求 undoAction
    assert.equal(saved.saveOptions.undoAction, undefined);
    assert.equal(
      saved.saveOptions.skipSelect,
      true,
      "skipSelect 仍然要传，避免抢走用户选择",
    );
  });

  it("存为笔记会创建 note 条目并挂到父条目下", async function () {
    const { fixtures } = await installSandbox();
    const created = [];
    globalThis.Zotero.Item = class {
      constructor(type) {
        this.type = type;
        this.id = 500 + created.length;
      }
      setNote(html) {
        this.note = html;
      }
      getNote() {
        return this.note;
      }
      getNoteTitle() {
        return "";
      }
      addTag(name) {
        this.tag = name;
        return true;
      }
      async saveTx(options) {
        this.saveOptions = options;
        created.push(this);
        return this.id;
      }
    };
    // 签名已改为 (payload, options)：options 里带 parent（条目会话）
    const outcome = await bundle.saveAnswerAsNote(
      { question: "Q", answer: "A", pageLabel: "第 2 页" },
      {
        mode: "new",
        parent: fixtures.parent,
        now: new Date("2026-10-02T12:00:00Z"),
      },
    );
    assert.equal(outcome.created, true);
    assert.equal(created.length, 1);
    const note = created[0];
    assert.equal(note.type, "note");
    assert.equal(note.parentID, 100);
    assert.equal(note.libraryID, 1);
    // ⚠️ 用户反馈两点后调整的结构：
    //  1. "记录的是用户的消息，而非 DSH 的回答" —— 原先把提问放在 <h2>（最醒目位置），
    //     主次颠倒；现在**回答是主体**，提问降为引用块；
    //  2. "标题不醒目" —— 笔记里加了醒目的来源标记。
    assert.match(note.note, /DSH 回答/, "笔记要有醒目的来源标记");
    assert.match(note.note, /A/, "回答必须出现在笔记里");
    assert.match(note.note, /问：Q/, "提问作为上下文保留，但用引用块弱化");
    assert.ok(
      !/<h2>Q<\/h2>/.test(note.note),
      "提问**不应**再占 <h2> 这个最醒目位置（那是主次颠倒）",
    );
    assert.match(note.note, /第 2 页/);
    assert.match(note.note, /估算值/);
    // 新建笔记是 isNew：不产生 stageChange，因此**不需要** undoAction
    // （xpcom/undoHistory.js：Only tracks modifications to existing objects）
    assert.equal(
      note.saveOptions?.undoAction,
      undefined,
      "新建对象不应要求 undoAction；只有修改已有对象才需要",
    );
  });

  it("独立会话存为笔记时落到**该分类**下（用户要求），而不是文学库根", async function () {
    await installSandbox();
    const created = [];
    const addedToCollection = [];
    globalThis.Zotero.Item = class {
      constructor(type) {
        this.type = type;
        this.id = 600 + created.length;
      }
      setNote(html) {
        this.note = html;
      }
      getNote() {
        return this.note;
      }
      getNoteTitle() {
        return "";
      }
      addTag(name) {
        this.tag = name;
        return true;
      }
      addToCollection(id) {
        addedToCollection.push(id);
        return true;
      }
      async saveTx(options) {
        this.saveOptions = options;
        if (!created.includes(this)) created.push(this);
        return this.id;
      }
    };
    // 独立会话没有父条目：Zotero 里分类不是条目、不能当父级，
    // 所以唯一可行形态是"顶层笔记 + addToCollection"
    const outcome = await bundle.saveAnswerAsNote(
      { question: "对比这几篇", answer: "三篇的差异是……" },
      { mode: "new", collectionID: 77, libraryID: 1 },
    );

    assert.equal(outcome.created, true);
    const note = created[0];
    assert.equal(note.type, "note");
    assert.equal(
      note.parentID,
      undefined,
      "独立会话的笔记是顶层条目，没有父级",
    );
    assert.equal(note.libraryID, 1);
    assert.deepEqual(
      addedToCollection,
      [77],
      "必须加进该分类，否则用户在自己的分类里找不到",
    );
    assert.match(note.note, /对比这几篇/);
    assert.equal(
      note.saveOptions?.undoAction,
      undefined,
      "新建对象不需要 undoAction（isNew 不进撤销栈）",
    );
  });

  it("追加模式修改已有笔记时**必须**带 undoAction，否则会被静默丢弃", async function () {
    const { fixtures } = await installSandbox();
    const existing = {
      id: 700,
      type: "note",
      note: "<p>已有内容</p>",
      setNote(html) {
        this.note = html;
      },
      getNote() {
        return this.note;
      },
      getNoteTitle: () =>
        bundle.buildNoteTitle(new Date("2026-10-02T12:00:00Z")),
      async saveTx(options) {
        this.saveOptions = options;
        return this.id;
      },
    };
    fixtures.parent.getNotes = () => [700];
    globalThis.Zotero.Items.get = (id) =>
      id === 700 ? existing : fixtures.items.get(id);

    const outcome = await bundle.saveAnswerAsNote(
      { question: "追问", answer: "补充回答" },
      {
        mode: "append",
        parent: fixtures.parent,
        now: new Date("2026-10-02T12:00:00Z"),
      },
    );
    assert.equal(outcome.created, false, "应追加到已有笔记");
    assert.equal(outcome.noteID, 700);
    assert.match(existing.note, /已有内容/, "原有内容必须保留");
    assert.match(existing.note, /补充回答/);
    assert.equal(
      existing.saveOptions.undoAction,
      "undo-action-edit-note",
      "修改已有对象必须带真实存在的 Fluent 消息 ID",
    );
  });
});

describe("集成：面板轮询拿到完整正文（真机两次故障的回归）", function () {
  /**
   * 这条测试守的是一个**真实且反复出现**的故障：
   * 面板把回答显示出来，靠的是流式不可用时的轮询兜底。而正文的获取链条是
   *
   *   session/projections → asOfSeq → 用它作 throughSeq 调 session/page
   *   → 从 assistant/message 的 message.content[] 里取 type === "text" 的块
   *
   * 曾经两次写错：一次读 `session/page` 的 records（形状不对），
   * 一次读 `session/projections` 的 `turnOutline.response`（那是**被截断的摘要**）。
   * 两种错法都会让面板空白、按钮永远禁用，而模型其实已经回答了。
   */
  it("轮询会发出完整正文（不含思考块），并在 turn/end 后结束", async function () {
    const answer = "这是完整的回答正文。";
    const { sandbox } = await installSandbox({ text: answer });
    void sandbox;

    // 让流式必然不可用：没有 WebSocket、也没有 ChromeWorker
    const savedWs = globalThis.WebSocket;
    const savedWorker = globalThis.ChromeWorker;
    delete globalThis.WebSocket;
    delete globalThis.ChromeWorker;

    try {
      const events = [];
      const transport = new bundle.ChatTransport({
        emit: (event) => events.push(event),
        log: () => undefined,
        getSessionId: () => undefined,
        rememberSession: () => undefined,
        workspaceDir: () => "C:/ws",
      });

      await transport.ask({ itemKey: "ITEM1", prompt: "问题" });

      // 轮询节奏是 150/300/700ms，给它足够时间跑完
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (events.some((e) => e.kind === "assistant-end")) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      const deltas = events.filter((e) => e.kind === "assistant-delta");
      const assembled = deltas.map((e) => e.chunk.text).join("");
      assert.equal(
        assembled,
        answer,
        `轮询拼出的正文应为完整回答，实际「${assembled}」`,
      );
      assert.ok(
        !assembled.includes("内部思考"),
        "reasoning 块绝不能出现在正文里",
      );
      assert.ok(
        events.some(
          (e) => e.kind === "assistant-end" && e.outcome === "committed",
        ),
        `turn/end 后应发出 assistant-end（否则面板按钮永远禁用）；实际事件：${events.map((e) => e.kind).join(",")}`,
      );
      assert.ok(
        !events.some((e) => e.kind === "fault"),
        `不应报错：${JSON.stringify(events.filter((e) => e.kind === "fault"))}`,
      );
      transport.dispose();
    } finally {
      if (savedWs) globalThis.WebSocket = savedWs;
      if (savedWorker) globalThis.ChromeWorker = savedWorker;
    }
  });

  it("loadHistory 取回对话轮次，并过滤掉运行时注入的上下文", async function () {
    await installSandbox({ text: "第一轮的回答" });
    const transport = new bundle.ChatTransport({
      emit: () => undefined,
      log: () => undefined,
      getSessionId: () => "session-x",
      rememberSession: () => undefined,
      workspaceDir: () => "C:/ws",
    });
    const turns = await transport.loadHistory("ITEM1");
    assert.equal(turns.length, 1, `应有一轮，实际 ${JSON.stringify(turns)}`);
    assert.equal(turns[0].prompt, "第一轮的提问");
    assert.equal(turns[0].response, "第一轮的回答");
    assert.ok(
      !JSON.stringify(turns).includes("runtime context"),
      "运行时注入的上下文不应作为对话历史（它没有尖括号，不能靠文本特征过滤）",
    );
    assert.ok(
      !JSON.stringify(turns).includes("system-reminder"),
      "skill 清单不应作为对话历史",
    );
    assert.ok(!JSON.stringify(turns).includes("内部思考"), "思考内容不应出现");
    transport.dispose();
  });

  it("getSessionId 返回 undefined 时，显式传会话 id 仍能读到历史", async function () {
    // 真机故障："重启 Zotero 后点进会话不显示历史"，且日志里没有任何报错。
    // 原因是会话查看器用**常驻 transport**，它的 getSessionId 返回 undefined
    // （它服务多条会话，没有"当前会话"概念），于是 loadHistory 里
    // `sessionId` 为假值 → **静默返回空数组**。
    // 修法：loadHistory 接受显式会话 id。这条测试保证它不会再退化成静默空数组。
    await installSandbox({ text: "第一轮的回答" });
    const transport = new bundle.ChatTransport({
      emit: () => undefined,
      log: () => undefined,
      // 常驻 transport 的语义：没有"当前会话"
      getSessionId: () => undefined,
      rememberSession: () => undefined,
      workspaceDir: () => "C:/ws",
    });

    // 不传显式 id 时应为空（这是旧行为，保留但不该被依赖）
    const withoutId = await transport.loadHistory("ITEM1");
    assert.deepEqual(
      withoutId,
      [],
      "没有会话 id 时返回空是预期（也正是曾经的故障点）",
    );

    // 传显式 id 时必须真的读到内容
    const turns = await transport.loadHistory("ITEM1", "session-x");
    assert.equal(
      turns.length,
      1,
      `显式指定会话 id 时应读到历史，实际 ${JSON.stringify(turns)}`,
    );
    assert.equal(turns[0].prompt, "第一轮的提问");
    assert.equal(turns[0].response, "第一轮的回答");
    transport.dispose();
  });

  it("会话不存在时用同一工作区自愈重建（真机：宿主重启导致 session not found）", async function () {
    // 真机故障：会话建在一个后来被结束的宿主上，再提问报
    // `session "…" not found`。dsh 的会话存活在宿主进程里，宿主重启就会丢，
    // 因此插件必须能自愈 —— 用**同一工作区**重建，并把新 id 回报给调用方持久化。
    const { calls } = await installSandbox({
      text: "自愈后的回答",
      failFirstPromptWithNotFound: true,
    });
    /** 记录第一次 prompt 的原始响应，便于断言失败时定位 */
    let firstPromptResult;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const response = await originalFetch(url, init);
      if (
        String(url).endsWith("/api/session/prompt") &&
        firstPromptResult === undefined
      ) {
        firstPromptResult = await response.clone().text();
      }
      return response;
    };
    const transport = new bundle.ChatTransport({
      emit: () => undefined,
      log: () => undefined,
      getSessionId: () => undefined,
      rememberSession: () => undefined,
      workspaceDir: () => "C:/ws",
    });

    let replacedWith;
    const answer = await transport.askInSession({
      sessionId: "session-stale",
      prompt: "问题",
      workspace: "C:/ws/item-ABC",
      onSessionReplaced: (id) => {
        replacedWith = id;
      },
    });

    assert.equal(
      answer,
      "自愈后的回答",
      `应拿到重建后会话的回答，实际「${answer}」`,
    );
    assert.ok(
      replacedWith,
      `必须回报新会话 id，否则记录仍指向不存在的会话；调用序列=${calls
        .map((c) => c.method)
        .join(",")}；首个 prompt 响应=${JSON.stringify(firstPromptResult)}`,
    );
    // 重建必须用同一工作区，否则"条目会话的工作区 = 该条目"就断了
    const created = calls.filter((c) => c.method === "session/create");
    assert.ok(created.length >= 1, "应调用 session/create 重建会话");
    assert.equal(
      created[created.length - 1].body?.payload?.args?.request?.cwd,
      "C:/ws/item-ABC",
      "重建必须沿用同一工作区",
    );
    transport.dispose();
  });

  it("turn/end 带错误时必须立刻报出，而不是空转到超时（真机：没有模型凭据）", async function () {
    // 真机故障：隔离实例没有模型 API key，宿主**立刻**回一个 turn/end，
    // 但 reason.kind === "error"、正文为空。原先只判"有文本才算完成"，
    // 于是界面一直停在"…"，一直到 180 秒超时才报一句无信息量的"生成超时"。
    const { sandbox } = await installSandbox({
      turnEndsWithError: "llm-deepseek: no API key",
    });
    void sandbox;
    const transport = new bundle.ChatTransport({
      emit: () => undefined,
      log: () => undefined,
      getSessionId: () => undefined,
      rememberSession: () => undefined,
      workspaceDir: () => "C:/ws",
    });

    const started = Date.now();
    let message = "";
    try {
      await transport.askInSession({
        sessionId: "session-x",
        prompt: "问题",
        timeoutMs: 30_000,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    const elapsed = Date.now() - started;

    assert.match(
      message,
      /no API key/,
      `应把宿主的错误原因带出来，实际「${message}」`,
    );
    assert.ok(
      elapsed < 10_000,
      `应立刻失败而不是等到超时，实际耗时 ${elapsed}ms`,
    );
    transport.dispose();
  });
});
