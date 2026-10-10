/**
 * 把**模型侧凭据**从本机 dsh 复制到隔离实例。
 *
 * ## 为什么必须做（真机故障）
 *
 * 隔离实例是全新的 DSH_HOME，只有插件为它生成的浏览器会话密钥，
 * **没有任何模型凭据**。于是问答会立刻失败，而错误藏在 `turn/end` 的
 * `reason.error.message` 里：
 *
 *   llm-deepseek: no API key for provider route "deepseek-official";
 *   store DEEPSEEK_API_KEY through the credentials service
 *
 * 表现是界面一直停在"…"（因为既没有正文、也没有把它当作错误处理）。
 *
 * ## 复制的边界（与"隔离"不冲突）
 *
 * 凭据文件里有两类记录，必须区别对待：
 *
 * | 记录 | 含义 | 是否复制 |
 * | --- | --- | --- |
 * | `client-connection/browser-session` | **宿主自身的**会话密钥（cookie 签名用） | ❌ **绝不复制** —— 复制会让两个实例共用同一密钥，违背隔离 |
 * | `deepseek-account-platform/*` | 模型平台账号凭据 | ✅ 复制 —— 这是"用哪个模型账号"，与运行环境隔离无关 |
 * | `refs.DEEPSEEK_API_KEY` | 模型 API key | ✅ 复制 —— 同上 |
 *
 * 也就是说：**运行环境、会话、工作区、cookie 全部隔离；模型账号共用**。
 * 这不矛盾 —— 用户只有一个模型账号，让他在插件里再配一遍没有意义。
 *
 * ## 实现方式
 *
 * 按 YAML 文本块搬运而不是解析 YAML：这两份文件都是我们自己读写的固定形态
 * （`records:` 下每条记录是 `  键:\n    子块`），文本块搬运更稳、也不会
 * 因为某个字段形态变化而整体解析失败。
 */

import { appendPanelLog } from "./runLog";

/** dsh 的浏览器会话记录键：绝不跨实例复制 */
const BROWSER_SESSION_KEY = "client-connection/browser-session";

// ⚠️ 这里原有 `PROVIDER_KEY_PREFIX = "deepseek-account-platform/"`，全仓库无一处使用
// （连注释里都没有）。模型记录的筛选逻辑在 `mergeProviderCredentials` 里按需判断，
// 不需要这个常量 —— 留着只会让人以为筛选依赖它。

/**
 * 从 YAML 文本里取出 `records:` 下某条记录的完整文本块（含其缩进子行）。
 * 返回 undefined 表示没有该记录。
 */
function extractRecordBlock(text: string, key: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const header = new RegExp(`^\\s{2}${escapeRegExp(key)}\\s*:\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    if (!header.test(lines[i])) continue;
    const block = [lines[i]];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim()) continue;
      // 下一条同级记录（2 空格缩进）或顶层键（0 缩进）即块结束
      if (/^\s{2}\S/.test(line) || /^\S/.test(line)) break;
      block.push(line);
    }
    return block.join("\n");
  }
  return undefined;
}

/** 取出 `refs:` 下某个键的整行文本 */
function extractRefLine(text: string, key: string): string | undefined {
  const lines = text.split(/\r?\n/);
  let inRefs = false;
  for (const line of lines) {
    if (/^refs\s*:\s*$/.test(line)) {
      inRefs = true;
      continue;
    }
    if (inRefs) {
      if (/^\S/.test(line)) break; // 离开 refs 段
      if (new RegExp(`^\\s+${escapeRegExp(key)}\\s*:`).test(line)) return line;
    }
  }
  return undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface CredentialMergeResult {
  /** 实际复制了哪些记录/字段 */
  copied: string[];
  /** 源文件里没有、因此没复制的项 */
  missing: string[];
  /** 是否写入了隔离凭据文件 */
  wrote: boolean;
  error?: string;
}

/**
 * 把源凭据里的模型侧内容合并进目标凭据文件。
 * 幂等：目标里已有同名记录时不重复追加。
 */
export async function mergeProviderCredentials(
  sourcePath: string,
  targetPath: string,
): Promise<CredentialMergeResult> {
  const result: CredentialMergeResult = {
    copied: [],
    missing: [],
    wrote: false,
  };
  try {
    if (!(await IOUtils.exists(sourcePath))) {
      result.error = `源凭据不存在：${sourcePath}`;
      return result;
    }
    const source = await IOUtils.readUTF8(sourcePath);
    const target = (await IOUtils.exists(targetPath))
      ? await IOUtils.readUTF8(targetPath)
      : "version: 1\nrecords:\nrefs:\n";

    let updated = target;
    let changed = false;

    // ① 模型平台记录
    const providerKeys = [
      "deepseek-account-platform/device",
      "deepseek-account-platform/default",
    ];
    for (const key of providerKeys) {
      if (updated.includes(`${key}:`)) continue; // 幂等
      const block = extractRecordBlock(source, key);
      if (!block) {
        result.missing.push(key);
        continue;
      }
      // 追加到 records: 段末尾（用缩进匹配保证层级正确）
      const lines = updated.split(/\r?\n/);
      const recordsAt = lines.findIndex((l) => /^records\s*:\s*$/.test(l));
      if (recordsAt < 0) {
        result.error = "目标凭据里没有 records: 段，结构异常";
        return result;
      }
      // 找到 records 段中最后一条记录的位置（跳过其子行）
      let insertAt = lines.length;
      for (let i = recordsAt + 1; i < lines.length; i++) {
        if (/^\S/.test(lines[i])) {
          insertAt = i;
          break;
        }
      }
      lines.splice(insertAt, 0, block);
      updated = lines.join("\n");
      changed = true;
      result.copied.push(key);
    }

    // ② 模型 API key
    if (!/DEEPSEEK_API_KEY\s*:/.test(updated)) {
      const refLine = extractRefLine(source, "DEEPSEEK_API_KEY");
      if (!refLine) {
        result.missing.push("refs.DEEPSEEK_API_KEY");
      } else {
        const lines = updated.split(/\r?\n/);
        let refsAt = lines.findIndex((l) => /^refs\s*:\s*$/.test(l));
        if (refsAt < 0) {
          // 没有 refs 段就补一个在末尾
          lines.push("refs:", refLine);
          refsAt = lines.length - 2;
        } else {
          lines.splice(refsAt + 1, 0, refLine);
        }
        updated = lines.join("\n");
        changed = true;
        result.copied.push("refs.DEEPSEEK_API_KEY");
      }
    }

    // ③ 明确确认隔离会话密钥**没有**被改动（自检用）
    if (!updated.includes(BROWSER_SESSION_KEY)) {
      result.error = "合并后目标凭据丢失了浏览器会话记录，已放弃写入";
      return result;
    }

    if (changed) {
      await IOUtils.writeUTF8(targetPath, updated);
      result.wrote = true;
    }
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }
}

/** 记一条可读日志（供运行时与设置页调用） */
export function logCredentialMerge(
  result: CredentialMergeResult,
  targetPath: string,
): void {
  if (result.error) {
    appendPanelLog("runtime", `模型凭据合并失败：${result.error}`);
    return;
  }
  if (result.copied.length > 0) {
    appendPanelLog(
      "runtime",
      `已把模型凭据复制到隔离实例：${result.copied.join("、")}（目标 ${targetPath}）；` +
        "浏览器会话密钥保持独立（未复制）",
    );
  }
  if (result.missing.length > 0) {
    appendPanelLog(
      "runtime",
      `源凭据里没有这些项，已跳过：${result.missing.join("、")}。` +
        "请在设置里填入 DEEPSEEK_API_KEY，或在桌面版 Harness 里登录一次。",
    );
  }
}
