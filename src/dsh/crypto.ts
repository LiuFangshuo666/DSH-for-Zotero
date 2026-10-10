/**
 * cookie 签名所需的密码学原语。
 *
 * 事实依据（Zotero 10.0.3，见 docs/DSH集成与桥接协议.md §7.4）：
 *  - 插件沙箱注入了 `crypto`（含 `crypto.subtle`）；
 *  - Zotero 自身有 `crypto.subtle.sign("HMAC", …)` 的用例（ArchiveEncryption.sys.mjs:300）；
 *  - 插件沙箱里**没有** `Components`/`Cc`/`Ci`，因此 `nsICryptoHMAC` 那条路不可用。
 */

/** 计算 SHA-256 摘要 */
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return new Uint8Array(digest);
}

/** 计算 HMAC-SHA256 */
export async function hmacSha256(
  keyBytes: Uint8Array,
  message: Uint8Array,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(keyBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    toArrayBuffer(message),
  );
  return new Uint8Array(signature);
}

/**
 * 把 Uint8Array 转成 ArrayBuffer。
 * 某些 Gecko 版本对 `Uint8Array` 视图的接受度不一致，统一转成独立 ArrayBuffer 最稳。
 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** base64url 解码为 32 字节密钥；长度不对返回 undefined */
export function decodeSecret(secretBase64Url: string): Uint8Array | undefined {
  const bytes = decodeSecretBytes(secretBase64Url);
  return bytes && bytes.byteLength === 32 ? bytes : undefined;
}

function decodeSecretBytes(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1)
    return undefined;
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/") + padding;
  let binary: string;
  try {
    binary = atob(normalized);
  } catch {
    return undefined;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
