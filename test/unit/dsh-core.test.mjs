/**
 * 纯逻辑单元测试（在 Node 里跑，不需要 Zotero）。
 *
 * 被测代码来自 `test/unit/entry.ts` 经 esbuild 打包出的 ESM 产物，也就是**真正的源码**，
 * 不是复制品。base64url 与 HMAC-SHA256 的结果都与 Node 的 Buffer/crypto 交叉验证。
 *
 * 运行：npm run test:unit（会先打包再跑断言）
 */

import { strict as assert } from "node:assert";
import { createHash, createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, ".build", "unit-entry.mjs");

assert.ok(
  existsSync(bundlePath),
  `找不到测试产物 ${bundlePath}；请用 npm run test:unit（它会先打包）`,
);

const dsh = await import(
  new URL(`file://${bundlePath.replace(/\\/g, "/")}`).href
);

describe("base64url（与 Node 交叉验证）", function () {
  it("编码结果与 Node 的 base64url 一致", function () {
    for (const size of [0, 1, 2, 3, 31, 32, 33, 64, 1000]) {
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) bytes[i] = (i * 37 + 11) % 256;
      assert.equal(
        dsh.encodeBase64Url(bytes),
        Buffer.from(bytes).toString("base64url"),
        `size=${size}`,
      );
    }
  });

  it("字符串编码按 UTF-8 处理", function () {
    const text = "桥接成功 dsh-测试";
    assert.equal(
      dsh.encodeBase64UrlString(text),
      Buffer.from(text, "utf8").toString("base64url"),
    );
  });

  it("解码可往返，且拒绝非法输入", function () {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const encoded = dsh.encodeBase64Url(bytes);
    assert.deepEqual(
      Array.from(dsh.decodeBase64Url(encoded)),
      Array.from(bytes),
    );
    assert.equal(
      dsh.decodeBase64Url("abc!"),
      undefined,
      "含非法字符应返回 undefined",
    );
    assert.equal(
      dsh.decodeBase64Url("a"),
      undefined,
      "长度模 4 为 1 应返回 undefined",
    );
  });
});

describe("凭据文件解析", function () {
  const sample = [
    "version: 1",
    "records:",
    "  client-connection/browser-session:",
    "    kind: grant",
    "    payload:",
    "      version: 1",
    "      secret: kvYh1bFjdU3nkrzivXsCbhdqp7iUvTwl0mNqRsTuVwX",
    "  deepseek-account-platform/device:",
    "    kind: grant",
    "    payload:",
    "      id: 0b410a71-fe9e-4e46-b831-6ad9717e9dfb",
    "refs:",
    "  DEEPSEEK_API_KEY: some-key",
  ].join("\n");

  it("取出 browser-session 的 secret，不误取后续记录", function () {
    const parsed = dsh.parseCredentials(sample);
    assert.equal(parsed.secret, "kvYh1bFjdU3nkrzivXsCbhdqp7iUvTwl0mNqRsTuVwX");
    assert.equal(parsed.secretWasQuoted, false);
    assert.ok(parsed.recordKeys.includes("client-connection/browser-session"));
    assert.ok(parsed.recordKeys.includes("deepseek-account-platform/device"));
  });

  it("支持带引号的标量", function () {
    const quoted = sample.replace(
      "secret: kvYh1bFjdU3nkrzivXsCbhdqp7iUvTwl0mNqRsTuVwX",
      'secret: "kvYh1bFjdU3nkrzivXsCbhdqp7iUvTwl0mNqRsTuVwX"',
    );
    const parsed = dsh.parseCredentials(quoted);
    assert.equal(parsed.secret, "kvYh1bFjdU3nkrzivXsCbhdqp7iUvTwl0mNqRsTuVwX");
    assert.equal(parsed.secretWasQuoted, true);
  });

  it("记录不存在时返回空结果而不是抛错", function () {
    const parsed = dsh.parseCredentials(
      "version: 1\nrecords:\n  other:\n    kind: grant\n",
    );
    assert.equal(parsed.secret, undefined);
  });
});

describe("cookie 签名（与 Node 交叉验证）", function () {
  const secretB64 = Buffer.from(
    Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256),
  ).toString("base64url");
  const authority = "127.0.0.1:19387";

  it("secret 解码为 32 字节，长度不符则拒绝", function () {
    const secret = dsh.decodeSecret(secretB64);
    assert.ok(secret, "应能解码");
    assert.equal(secret.length, 32);
    assert.equal(dsh.decodeSecret("AAAA"), undefined);
  });

  it("cookie 名 = dsh-auth-<b64url(sha256(authority))>", async function () {
    const expected =
      "dsh-auth-" +
      createHash("sha256").update(authority).digest().toString("base64url");
    assert.equal(await dsh.cookieNameFor(authority), expected);
  });

  it("HMAC-SHA256 与 Node 结果一致", async function () {
    const key = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
    const message = new TextEncoder().encode("v1.payload.body");
    const actual = await dsh.hmacSha256(key, message);
    const expected = createHmac("sha256", Buffer.from(key))
      .update(Buffer.from(message))
      .digest();
    assert.equal(Buffer.from(actual).toString("hex"), expected.toString("hex"));
  });

  it("签出的 cookie 可按 dsh 算法独立复算（v1.<body>.<sig>）", async function () {
    const secret = dsh.decodeSecret(secretB64);
    const name = await dsh.cookieNameFor(authority);
    const issuedAt = 1_700_000_000_000;
    const expiresAt = issuedAt + 30 * 24 * 3600 * 1000;
    const parts = dsh.buildCookieParts(authority, name, issuedAt, expiresAt);
    const value = await dsh.signCookieValue(secret, parts);

    const [version, body, sig] = value.split(".");
    assert.equal(version, "v1");
    assert.equal(body, parts.body);

    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    assert.deepEqual(payload, { version: 1, authority, issuedAt, expiresAt });

    const expectedSig = createHmac("sha256", Buffer.from(secret))
      .update(body)
      .digest()
      .toString("base64url");
    assert.equal(sig, expectedSig);
  });
});

// ⚠️ 这里原有 `describe("启动 URL 取 token")`：它测的
// `extractTokenFromLaunchUrl` 只服务于已删除的共享模式，
// 函数与测试一并移除。
