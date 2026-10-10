/**
 * `$DSH_HOME/.credentials.yaml` 的针对性解析。
 *
 * 为什么不引入 YAML 库：只需要一个字段，而且沙箱里不该为此增加依赖与体积。
 * 解析策略：定位 `records.<key>:` 行 → 在其子块内找 `secret:` 行（按缩进界定块范围）。
 *
 * 文件真实形状（本机实测）：
 * ```yaml
 * version: 1
 * records:
 *   client-connection/browser-session:
 *     kind: grant
 *     payload:
 *       version: 1
 *       secret: <base64url, 32 bytes>
 *   deepseek-account-platform/device:
 *     kind: grant
 *     payload:
 *       id: ...
 * refs:
 *   DEEPSEEK_API_KEY: ...
 * ```
 */

export const BROWSER_SESSION_RECORD = "client-connection/browser-session";

export interface ParsedCredentials {
  /** browser-session 记录的 secret（base64url） */
  secret?: string;
  /** 文件里出现的记录键，便于排障 */
  recordKeys: string[];
  /** 是否写成了带引号的标量 */
  secretWasQuoted: boolean;
}

/** 缩进宽度（空格数；tab 按 1 计） */
function indentOf(line: string): number {
  const match = line.match(/^[ \t]*/);
  return match ? match[0].length : 0;
}

function unquote(value: string): { value: string; quoted: boolean } {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return { value: trimmed.slice(1, -1), quoted: true };
  }
  return { value: trimmed, quoted: false };
}

/**
 * 解析凭据文本，取出 browser-session 的 secret。
 * 纯函数，便于单元测试。
 */
export function parseCredentials(
  text: string,
  recordKey: string = BROWSER_SESSION_RECORD,
): ParsedCredentials {
  const lines = text.split(/\r?\n/);
  const recordKeys: string[] = [];

  // 记录键出现在 records: 块下的较深层级；用"以冒号结尾且缩进 >= 2"近似识别
  for (const line of lines) {
    const m = line.match(/^\s{1,}([A-Za-z0-9._@/-]+)\s*:\s*$/);
    if (m) recordKeys.push(m[1]);
  }

  const escaped = recordKey.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&");
  const recordRe = new RegExp(`^[ \\t]*${escaped}\\s*:\\s*$`);
  const start = lines.findIndex((line) => recordRe.test(line));
  if (start < 0) return { recordKeys, secretWasQuoted: false };

  const recordIndent = indentOf(lines[start]);
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    if (indentOf(line) <= recordIndent) break; // 越出本记录
    const m = line.match(/^[ \t]*secret\s*:\s*(.+?)\s*$/);
    if (m) {
      const { value, quoted } = unquote(m[1]);
      return { secret: value, recordKeys, secretWasQuoted: quoted };
    }
  }
  return { recordKeys, secretWasQuoted: false };
}

/** 从文件系统读取并解析凭据 */
export async function readCredentials(
  path: string,
): Promise<ParsedCredentials & { exists: boolean; error?: string }> {
  try {
    if (!(await IOUtils.exists(path))) {
      return { exists: false, recordKeys: [], secretWasQuoted: false };
    }
    const text = await IOUtils.readUTF8(path);
    return { exists: true, ...parseCredentials(text) };
  } catch (error) {
    return {
      exists: false,
      recordKeys: [],
      secretWasQuoted: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
