/**
 * ## 「已删除」的会话 id（插件侧隐藏表）
 *
 * ## 为什么需要它：dsh **没有删除会话的接口**
 *
 * 真机验证（对运行中的宿主逐个试）：
 *
 * ```text
 *   session/delete  → 404    session/remove  → 404    session/erase → 404
 *   session/archive → 404    session/trash   → 404    session/hide  → 404
 * ```
 *
 * 而历史会话下拉的数据来自 `session/list`（宿主），**不是**插件自己的记录。
 * 所以只删插件记录没用 —— 会话仍会出现在下拉里。
 *
 * ## 为什么不直接删磁盘上的会话文件
 *
 * 曾打算删 `home/sessions/<id>.jsonl`。但实测那个目录**是空的**（0 个文件），
 * 说明 dsh 的落盘布局已经变了，而我并没有把握。
 * **删错文件比不删更糟**，所以这里只做"从插件视图中移除"，并把真相告诉用户：
 * 会话不再出现在下拉里、记录已清掉，但 dsh 侧的数据仍在磁盘上。
 *
 * ## 与 pendingStore 同一套约定
 *
 * 同样的目录、同样的 schema 校验、同样的"坏了就从空开始"，
 * 不因为它是"小文件"就少一道校验 —— 它在数据目录里，谁都能改。
 */

import { appendPanelLog } from "./runLog";

const FILE_NAME = "deleted-sessions.json";

interface DeletedFile {
  schema: "dsh-for-zotero/deleted-sessions/v1";
  version: 1;
  /** 被用户删除（隐藏）的会话 id */
  ids: string[];
}

function emptyFile(): DeletedFile {
  return {
    schema: "dsh-for-zotero/deleted-sessions/v1",
    version: 1,
    ids: [],
  };
}

function filePath(): string | undefined {
  try {
    const dataDir = Zotero.DataDirectory?.dir;
    if (!dataDir) return undefined;
    return PathUtils.join(dataDir, "dsh-for-zotero", FILE_NAME);
  } catch {
    return undefined;
  }
}

/** 读出被隐藏的会话 id 集合（文件不存在/损坏时返回空集，绝不抛错） */
export async function deletedSessionIds(): Promise<Set<string>> {
  const path = filePath();
  if (!path) return new Set();
  try {
    if (!(await IOUtils.exists(path))) return new Set();
    const parsed = JSON.parse(await IOUtils.readUTF8(path)) as unknown;
    const file = parsed as Partial<DeletedFile> | undefined;
    if (
      !file ||
      file.schema !== "dsh-for-zotero/deleted-sessions/v1" ||
      !Array.isArray(file.ids)
    ) {
      appendPanelLog(
        "log",
        "已删除会话文件形状不对（schema 或 ids 不匹配），已忽略并从空开始",
      );
      return new Set();
    }
    return new Set(
      file.ids.filter((id): id is string => typeof id === "string" && !!id),
    );
  } catch (error) {
    appendPanelLog(
      "log",
      `读取已删除会话失败（按空处理）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return new Set();
  }
}

/**
 * 把一个会话 id 记为"已删除"。
 *
 * 写失败**只记日志**，不向调用方抛错：删除这个动作的价值在于"不再出现在列表里"，
 * 而列表过滤同时依赖内存中的集合 —— 落盘失败最多是重启后它又出现一次，
 * 比"点了删除却报错"体验更好。
 */
export async function markSessionDeleted(sessionId: string): Promise<void> {
  const id = String(sessionId ?? "").trim();
  if (!id) return;
  const path = filePath();
  if (!path) return;
  try {
    const ids = await deletedSessionIds();
    if (ids.has(id)) return;
    ids.add(id);
    const file: DeletedFile = {
      schema: "dsh-for-zotero/deleted-sessions/v1",
      version: 1,
      ids: [...ids],
    };
    await IOUtils.makeDirectory(PathUtils.parent(path) ?? ".", {
      ignoreExisting: true,
    });
    await IOUtils.writeUTF8(path, JSON.stringify(file, null, 2));
  } catch (error) {
    appendPanelLog(
      "log",
      `记录已删除会话失败（重启后可能重新出现）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
