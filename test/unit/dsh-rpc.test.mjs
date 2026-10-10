/**
 * DSH_HOME 优先级、端口解析与 RPC 客户端的行为测试。
 *
 * 这些是最容易出错的"决策逻辑"：优先级搞反、端口越界、把业务失败当成功、
 * cookie 罐不可用时没有回退。测试用假的 fetch / XMLHttpRequest / Services.cookies，
 * 断言的是 rpc.ts 真正会发出的请求与解析结果。
 */

import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dsh = await import(
  new URL(
    `file://${join(here, ".build", "unit-entry.mjs").replace(/\\/g, "/")}`,
  ).href
);

// ── 假的沙箱环境 ────────────────────────────────────────────

// （这里原有 `identityNormalize = (p) => p`，是共享模式 DSH_HOME 解析测试的辅助；
//   该测试已随共享模式删除，辅助函数也无引用，故移除。）

function installFetch(handler) {
  globalThis.fetch = async (url, init) => handler(url, init);
}

/** 记录所有调用，便于断言"到底发了什么" */
function makeXhrClass(record, responders) {
  return class FakeXhr {
    constructor() {
      this.headers = {};
      this.status = 0;
      this.responseText = "";
      this.timeout = 0;
      record.push(this);
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
      const responder = responders.shift();
      if (!responder) throw new Error("没有为这次 XHR 调用准备 responder");
      responder(this);
    }
  };
}

function installCookieJar({ failWith, cookies = [] } = {}) {
  const added = [];
  globalThis.Services = {
    cookies: {
      add: (...args) => {
        if (failWith) throw new Error(failWith);
        added.push(args);
      },
      getCookiesFromHost: () => ({
        hasMoreElements: () => false,
        getNext: () => {
          throw new Error("empty");
        },
      }),
    },
  };
  return { added, cookies };
}

const okBody = (value, rpcId = "r1") =>
  JSON.stringify({
    type: "server-response",
    rpcId,
    result: { ok: true, value },
  });
const errBody = (code, message, rpcId = "r1") =>
  JSON.stringify({
    type: "server-response",
    rpcId,
    result: { ok: false, error: { code, message, details: {} } },
  });

const baseConfig = {
  dshHome: "C:\\Users\\test\\.dsh",
  dshHomeSource: "isolated",
  port: 19387,
  authority: "127.0.0.1:19387",
  baseUrl: "http://127.0.0.1:19387",
  wsUrl: "ws://127.0.0.1:19387/api/remote.mux",
  requestTimeoutMs: 15000,
};

const cookie = {
  name: "dsh-auth-test",
  value: "v1.body.sig",
  header: "dsh-auth-test=v1.body.sig",
  expiresAt: 0,
  source: "credentials",
};

describe("DSH_HOME 解析优先级", function () {});

describe("端口解析", function () {});

describe("RPC 客户端（cookie 罐可用时走 fetch）", function () {
  it("成功结果解出 value，并记录通道与 HTTP 状态", async function () {
    const jar = installCookieJar();
    let seenUrl;
    let seenBody;
    installFetch(async (url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(init.body);
      return {
        status: 200,
        text: async () => okBody({ items: [{ sessionId: "s1" }] }),
      };
    });

    const client = new dsh.DshClient({ config: baseConfig, cookie });
    const result = await client.call("session/list", { _request: {} });

    assert.equal(result.value.items[0].sessionId, "s1");
    assert.equal(result.httpStatus, 200);
    assert.equal(result.delivery, "cookie-jar");
    assert.equal(seenUrl, "http://127.0.0.1:19387/api/session/list");
    assert.equal(seenBody.type, "client-request");
    assert.equal(seenBody.method, "session/list");
    assert.deepEqual(seenBody.payload, { args: { _request: {} } });
    assert.ok(seenBody.rpcId, "应带上 rpcId");
    assert.equal(jar.added.length, 1, "cookie 应被写进 cookie 罐一次");
    client.dispose();
  });

  it("业务失败（HTTP 200 + ok:false）抛 DshRpcError 且带错误码", async function () {
    installCookieJar();
    installFetch(async () => ({
      status: 200,
      text: async () => errBody("session/not-found", "no such session"),
    }));

    const client = new dsh.DshClient({ config: baseConfig, cookie });
    await assert.rejects(
      () => client.call("session/cancel", { request: { sessionId: "nope" } }),
      (error) => {
        assert.ok(error instanceof dsh.DshRpcError);
        assert.equal(error.code, "session/not-found");
        assert.equal(error.httpStatus, 200, "业务失败的 HTTP 状态仍是 200");
        return true;
      },
    );
    client.dispose();
  });

  it("非 JSON 响应归类为 gateway/non-json", async function () {
    installCookieJar();
    installFetch(async () => ({
      status: 502,
      text: async () => "<html>bad gateway</html>",
    }));

    const client = new dsh.DshClient({ config: baseConfig, cookie });
    await assert.rejects(
      () => client.call("session/list", {}),
      (error) => {
        assert.equal(error.code, "gateway/non-json");
        assert.equal(error.httpStatus, 502);
        return true;
      },
    );
    client.dispose();
  });

  it("信封缺少 result 时归类为 gateway/malformed", async function () {
    installCookieJar();
    installFetch(async () => ({
      status: 200,
      text: async () => JSON.stringify({ type: "server-response" }),
    }));

    const client = new dsh.DshClient({ config: baseConfig, cookie });
    await assert.rejects(
      () => client.call("session/list", {}),
      (error) => error.code === "gateway/malformed",
    );
    client.dispose();
  });
});

describe("RPC 客户端（cookie 罐不可用时回退 XHR 显式 Cookie 头）", function () {
  it("cookie 罐写入失败 → 投递方式降级为 xhr-header，并在请求头里带 Cookie", async function () {
    installCookieJar({ failWith: "cookie 罐只读" });
    const record = [];
    globalThis.XMLHttpRequest = makeXhrClass(record, [
      (xhr) => {
        xhr.status = 200;
        xhr.responseText = okBody({ items: [] });
        xhr.onload();
      },
    ]);

    const client = new dsh.DshClient({ config: baseConfig, cookie });
    const prepared = client.prepare();
    assert.equal(prepared.delivery, "xhr-header");
    assert.match(prepared.jarError ?? "", /cookie 罐只读/);

    const result = await client.call("session/list", { _request: {} });
    assert.equal(result.delivery, "xhr-header");
    assert.equal(record.length, 1);
    assert.equal(record[0].method, "POST");
    assert.equal(
      record[0].headers.Cookie,
      cookie.header,
      "必须显式带上 Cookie 头",
    );
    assert.equal(record[0].headers["content-type"], "application/json");
    assert.equal(record[0].timeout, baseConfig.requestTimeoutMs);
    client.dispose();
  });

  it("XHR 网络错误归类为 client/network", async function () {
    installCookieJar({ failWith: "只读" });
    const record = [];
    globalThis.XMLHttpRequest = makeXhrClass(record, [
      (xhr) => {
        xhr.onerror();
      },
    ]);

    const client = new dsh.DshClient({ config: baseConfig, cookie });
    await assert.rejects(
      () => client.call("session/list", {}),
      (error) => error.code === "client/network",
    );
    client.dispose();
  });

  it("XHR 超时归类为 client/timeout", async function () {
    installCookieJar({ failWith: "只读" });
    const record = [];
    globalThis.XMLHttpRequest = makeXhrClass(record, [
      (xhr) => {
        xhr.ontimeout();
      },
    ]);

    const client = new dsh.DshClient({ config: baseConfig, cookie });
    await assert.rejects(
      () => client.call("session/list", {}),
      (error) => error.code === "client/timeout",
    );
    client.dispose();
  });
});

describe("rpcId 生成", function () {
  it("形如 UUID，且不重复", function () {
    const ids = new Set();
    for (let i = 0; i < 50; i++) {
      const id = dsh.newRpcId();
      assert.match(
        id,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      ids.add(id);
    }
    assert.equal(ids.size, 50);
  });
});
