/**
 * Base64URL 编解码。
 *
 * 为什么手写：Zotero 插件沙箱里没有 Node 的 Buffer，也没有现成的 base64url 编码器。
 * `Zotero.Utilities.Internal.Base64` 是标准字母表且对字符串输入做 UTF-8 编码，
 * 不能用于"对原始字节做签名"的场景（见 docs 中 Zotero 侧核实结论）。
 *
 * 可用原语：btoa / atob（沙箱白名单内）。
 */

/** 把字节数组编码为 base64url（无 padding） */
export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000; // 避免超长参数导致栈溢出
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** 把 UTF-8 字符串编码为 base64url */
export function encodeBase64UrlString(text: string): string {
  return encodeBase64Url(new TextEncoder().encode(text));
}

/** 解码 base64url 为字节数组；非法输入返回 undefined */
export function decodeBase64Url(value: string): Uint8Array | undefined {
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
  // 往返校验，避免 atob 接受宽松输入
  return encodeBase64Url(out) === value ? out : undefined;
}

/** Decode a base64url string to UTF-8 text */
export function decodeBase64UrlToString(value: string): string | undefined {
  const bytes = decodeBase64Url(value);
  if (!bytes) return undefined;
  return new TextDecoder().decode(bytes);
}
