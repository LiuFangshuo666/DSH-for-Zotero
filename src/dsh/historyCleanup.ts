/**
 * ## 清理历史缓存
 *
 * 删除"指向已经不存在的东西"的会话记录与工作区目录：
 *
 *  1. 条目/分类**已不存在**（含在回收站里）→ 删它的会话记录；
 *  2. 侧栏里**已删除**的会话 → 记录已不在，但它留下的工作区目录要清；
 *  3. 某个工作区目录**已经没有任何会话**对应 → 整目录删掉。
 *
 * ## 为什么要有这个功能
 *
 * 用户会删文献、清空回收站、删会话。而插件的数据目录只增不减：
 * `sessions.json` 里留着指向旧条目的记录，`dsh-for-zotero/item-XXXX/` 里留着
 * 那些条目的材料。时间一长，磁盘上全是没有主人的残骸，而且**界面上看不出来**。
 *
 * ## 安全边界（这个功能是破坏性的，所以边界写死）
 *
 * - 只删**插件数据目录**内、且名字严格匹配 `item-*` / `collection-*` 的工作区目录；
 * - 预览与执行**分成两步**：先把"将要删什么"列出来给用户看，确认后才动手；
 * - 空的 `scopeKey`（文库根分类会话）**永不删** —— 它不分具体条目；
 * - 回收站里的条目按"不存在"处理，这正是用户要求的语义。
 */

import { requireRuntimeConfig } from "./config";
import {
  workspaceFor,
  sessionStore,
  type SessionKind,
  type SessionRecord,
} from "./session";
import { deletedSessionIds } from "./deletedSessions";
import { pendingStore } from "./pendingStore";
import { appendPanelLog } from "./runLog";

/** 记录为什么被判定为可删 */
export type CleanupReason =
  /** 指向的条目/分类已经不在库里 */
  | "scope-missing"
  /** 指向的条目在回收站里 */
  | "scope-trashed"
  /** 用户在侧栏里删除了这条会话 */
  | "sidebar-deleted";

export interface DoomedRecord {
  sessionId: string;
  title: string;
  kind: SessionKind;
  reason: CleanupReason;
}

export interface CleanupPlan {
  /** 要删除的会话记录 */
  doomed: DoomedRecord[];
  /** 保留的记录数（仅用于展示） */
  keptCount: number;
  /** 要整目录删除的工作区（绝对路径） */
  workspaceDirs: string[];
  /** 这些目录为什么被删（并行数组，便于展示） */
  workspaceReason: string[];
  /** 会被一并清掉的待确认项数量 */
  pendingDropped: number;
}

export interface CleanupResult {
  removedRecords: number;
  removedDirs: number;
  removedPending: number;
  failures: string[];
}

/**
 * 纯函数：判断每条记录该留还是该删。
 *
 * 抽出来是因为**这是整个功能里唯一"有判断"的部分** —— 删除动作本身很笨，
 * 判断错了就是删了不该删的东西。所以它可以脱离 Zotero/文件系统单测。
 *
 * @param records 现有会话记录
 * @param live 仍然存在的条目 key / 分类 key
 * @param trashed 在回收站里的条目 key
 * @param hidden 侧栏里删除过的会话 id
 */
export function classifyRecords(input: {
  records: SessionRecord[];
  live: { itemKeys: Set<string>; collectionKeys: Set<string> };
  trashed: Set<string>;
  hidden: Set<string>;
}): { doomed: DoomedRecord[]; keep: SessionRecord[] } {
  const doomed: DoomedRecord[] = [];
  const keep: SessionRecord[] = [];

  for (const record of input.records) {
    const base = {
      sessionId: record.sessionId,
      title: record.title || record.scopeTitle || record.sessionId,
      kind: record.kind,
    };

    // ① 侧栏里删过的会话：记录还在（删除时可能没删掉）也要清掉
    if (input.hidden.has(record.sessionId)) {
      doomed.push({ ...base, reason: "sidebar-deleted" });
      continue;
    }

    // ② 分类会话的 scopeKey 为空 = "我的文库"根，不对应任何具体分类，永不删
    if (record.kind === "collection" && !record.scopeKey) {
      keep.push(record);
      continue;
    }

    if (record.kind === "item") {
      if (input.trashed.has(record.scopeKey)) {
        doomed.push({ ...base, reason: "scope-trashed" });
        continue;
      }
      if (!input.live.itemKeys.has(record.scopeKey)) {
        doomed.push({ ...base, reason: "scope-missing" });
        continue;
      }
      keep.push(record);
      continue;
    }

    if (!input.live.collectionKeys.has(record.scopeKey)) {
      doomed.push({ ...base, reason: "scope-missing" });
      continue;
    }
    keep.push(record);
  }

  return { doomed, keep };
}

/** 从 Zotero 侧收集"还活着"的条目/分类 key */
function gatherLiveScopes(records: SessionRecord[]): {
  live: { itemKeys: Set<string>; collectionKeys: Set<string> };
  trashed: Set<string>;
} {
  const itemKeys = new Set<string>();
  const collectionKeys = new Set<string>();
  const trashed = new Set<string>();

  const items = (
    Zotero as unknown as {
      Items: {
        getByLibraryAndKey: (
          libraryID: number,
          key: string,
        ) => { deleted?: boolean } | false | undefined;
      };
    }
  ).Items;
  const collections = (
    Zotero as unknown as {
      Collections: {
        getByLibraryAndKey: (
          libraryID: number,
          key: string,
        ) => object | false | undefined;
      };
    }
  ).Collections;

  for (const record of records) {
    try {
      if (record.kind === "item") {
        const item = items.getByLibraryAndKey(
          record.scopeLibraryID,
          record.scopeKey,
        );
        if (!item) continue; // 找不到 → 不算 live
        // `deleted` 为真 = 在回收站里。用户明确要求按"不存在"处理。
        if (item.deleted) trashed.add(record.scopeKey);
        else itemKeys.add(record.scopeKey);
      } else {
        if (!record.scopeKey) continue;
        const collection = collections.getByLibraryAndKey(
          record.scopeLibraryID,
          record.scopeKey,
        );
        if (collection) collectionKeys.add(record.scopeKey);
      }
    } catch (error) {
      // 单条查询失败不能让整个清理把**其它**条目误判为"不存在" ——
      // 保守起见把它当成还活着（宁可留残骸，不可误删）。
      appendPanelLog(
        "log",
        `清理扫描：查询 ${record.scopeKey} 失败，按"仍存在"处理：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      if (record.kind === "item") itemKeys.add(record.scopeKey);
      else if (record.scopeKey) collectionKeys.add(record.scopeKey);
    }
  }

  return { live: { itemKeys, collectionKeys }, trashed };
}

/** 工作区目录名是否是我们生成的形态（只在这种名字上动手） */
export function isManagedWorkspaceDirName(name: string): boolean {
  return /^(item|collection)-[A-Za-z0-9_-]+$/.test(name);
}

/** 上一次扫描的计划。两步式交互靠它把"看过的东西"传给执行那一步。 */
let lastPlan: CleanupPlan | undefined;

const REASON_LABEL: Record<CleanupReason, string> = {
  "scope-missing": "条目/分类已不存在",
  "scope-trashed": "条目在回收站里",
  "sidebar-deleted": "侧栏里删除过",
};

/**
 * 取路径最后一段。
 *
 * 不用 `PathUtils.filename`：那会让这个**纯展示函数**依赖 Zotero 的全局对象，
 * 于是在单测里直接 `ReferenceError`。展示逻辑不该有平台依赖。
 */
export function lastPathSegment(path: string): string {
  const parts = String(path ?? "")
    .split(/[\\/]+/)
    .filter(Boolean);
  return parts[parts.length - 1] ?? String(path ?? "");
}

/** 把计划写成人能读的预览文字 */
export function describeCleanupPlan(plan: CleanupPlan): string {
  const hasWork =
    plan.doomed.length > 0 ||
    plan.workspaceDirs.length > 0 ||
    plan.pendingDropped > 0;

  if (!hasWork) {
    return `没有可清理的内容。\n保留 ${plan.keptCount} 条会话记录 —— 它们指向的条目/分类都还在。`;
  }

  const byReason = new Map<CleanupReason, number>();
  for (const item of plan.doomed) {
    byReason.set(item.reason, (byReason.get(item.reason) ?? 0) + 1);
  }
  const reasonText = [...byReason.entries()]
    .map(([reason, count]) => `${REASON_LABEL[reason]} ${count}`)
    .join("、");

  const lines = ["将删除："];
  lines.push(
    `· 会话记录 ${plan.doomed.length} 条` +
      (reasonText ? `（${reasonText}）` : "") +
      `；保留 ${plan.keptCount} 条`,
  );
  lines.push(`· 工作区目录 ${plan.workspaceDirs.length} 个`);
  if (plan.pendingDropped > 0) {
    lines.push(`· 待确认项 ${plan.pendingDropped} 条（所属会话已不存在）`);
  }

  const preview = plan.doomed
    .slice(0, 8)
    .map((item) => `    ${item.title} — ${REASON_LABEL[item.reason]}`);
  if (preview.length > 0) {
    lines.push("", "会话示例：", ...preview);
    if (plan.doomed.length > preview.length) {
      lines.push(`    …另有 ${plan.doomed.length - preview.length} 条`);
    }
  }
  const dirPreview = plan.workspaceDirs
    .slice(0, 5)
    .map((dir) => `    ${lastPathSegment(dir)}`);
  if (dirPreview.length > 0) {
    lines.push("", "工作区目录：", ...dirPreview);
    if (plan.workspaceDirs.length > dirPreview.length) {
      lines.push(
        `    …另有 ${plan.workspaceDirs.length - dirPreview.length} 个`,
      );
    }
  }
  return lines.join("\n");
}

/** 第一步：扫描（**不修改任何东西**），把计划留在内存里供执行那一步用 */
export async function scanForCleanup(): Promise<{
  summary: string;
  hasWork: boolean;
}> {
  lastPlan = await planHistoryCleanup();
  return {
    summary: describeCleanupPlan(lastPlan),
    hasWork:
      lastPlan.doomed.length > 0 ||
      lastPlan.workspaceDirs.length > 0 ||
      lastPlan.pendingDropped > 0,
  };
}

/** 第二步：执行上次扫描出的计划 */
export async function runScannedCleanup(): Promise<{
  summary: string;
  ok: boolean;
}> {
  if (!lastPlan) {
    return { ok: false, summary: "请先点「扫描可清理项」。" };
  }
  const plan = lastPlan;
  lastPlan = undefined; // 用过就作废，避免重复执行同一份计划
  const result = await executeHistoryCleanup(plan);
  const lines = [
    `已清理：会话记录 ${result.removedRecords} 条、工作区目录 ${result.removedDirs} 个` +
      (result.removedPending > 0
        ? `、待确认项 ${result.removedPending} 条`
        : "") +
      "。",
  ];
  if (result.failures.length > 0) {
    lines.push("", `有 ${result.failures.length} 项未能删除：`);
    lines.push(...result.failures.slice(0, 8).map((f) => `    ${f}`));
    if (result.failures.length > 8) {
      lines.push(`    …另有 ${result.failures.length - 8} 项`);
    }
  }
  return { ok: result.failures.length === 0, summary: lines.join("\n") };
}

export async function planHistoryCleanup(): Promise<CleanupPlan> {
  const records = await sessionStore().list();
  const hidden = await deletedSessionIds();
  const { live, trashed } = gatherLiveScopes(records);
  const { doomed, keep } = classifyRecords({ records, live, trashed, hidden });

  const root = requireRuntimeConfig().workspaceRoot;
  const workspaceDirs: string[] = [];
  const workspaceReason: string[] = [];
  const seen = new Set<string>();

  const pushDir = (dir: string, reason: string): void => {
    const normalized = dir.toLowerCase();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    workspaceDirs.push(dir);
    workspaceReason.push(reason);
  };

  // ① 被删记录自己的目录
  for (const record of records) {
    if (!doomed.some((d) => d.sessionId === record.sessionId)) continue;
    try {
      pushDir(
        workspaceFor(root, record.kind, record.scopeKey),
        `会话已清理（${record.title || record.sessionId}）`,
      );
    } catch {
      // 拼不出路径就跳过：删目录不能靠猜
    }
  }

  // ② 磁盘上存在、但**没有任何保留记录**指向它的目录
  const survivingDirs = new Set(
    keep.map((record) =>
      workspaceFor(root, record.kind, record.scopeKey).toLowerCase(),
    ),
  );
  try {
    if (await IOUtils.exists(root)) {
      for (const child of await IOUtils.getChildren(root)) {
        const name = PathUtils.filename(child);
        if (!isManagedWorkspaceDirName(name)) continue;
        let stat;
        try {
          stat = await IOUtils.stat(child);
        } catch {
          continue;
        }
        if (stat.type !== "directory") continue;
        if (survivingDirs.has(child.toLowerCase())) continue;
        pushDir(child, "已没有任何会话对应");
      }
    }
  } catch (error) {
    appendPanelLog(
      "log",
      `清理扫描：列出工作区失败：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // ③ 待确认项：会话已不存在的那部分
  const keptIds = new Set(keep.map((r) => r.sessionId));
  let pendingDropped = 0;
  try {
    const items = await pendingStore().load();
    pendingDropped = items.filter(
      (item) => !keptIds.has(item.sessionId),
    ).length;
  } catch {
    // 待确认项是可选清理，读不到就不报数
  }

  return {
    doomed,
    keptCount: keep.length,
    workspaceDirs,
    workspaceReason,
    pendingDropped,
  };
}

/** 执行清理（**破坏性**：调用方必须先让用户确认过计划） */
export async function executeHistoryCleanup(
  plan: CleanupPlan,
): Promise<CleanupResult> {
  const failures: string[] = [];
  let removedRecords = 0;
  let removedDirs = 0;
  let removedPending = 0;

  for (const item of plan.doomed) {
    try {
      await sessionStore().remove(item.sessionId);
      removedRecords += 1;
    } catch (error) {
      failures.push(
        `删除记录 ${item.sessionId} 失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const root = requireRuntimeConfig().workspaceRoot;
  for (const dir of plan.workspaceDirs) {
    // 双保险：**只删工作区根目录下、名字符合管理模式的目录**。
    // 计划是算出来的，但删除是不可逆的 —— 动手前再验一次路径。
    const name = PathUtils.filename(dir);
    const parent = PathUtils.parent(dir);
    if (
      !isManagedWorkspaceDirName(name) ||
      !parent ||
      parent.toLowerCase() !== root.toLowerCase()
    ) {
      failures.push(`跳过可疑路径（不在工作区根下）：${dir}`);
      continue;
    }
    try {
      if (await IOUtils.exists(dir)) {
        await IOUtils.remove(dir, { recursive: true });
        removedDirs += 1;
      }
    } catch (error) {
      failures.push(
        `删除目录失败 ${dir}：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  try {
    const keptIds = new Set(
      (await sessionStore().list()).map((r) => r.sessionId),
    );
    const items = await pendingStore().load();
    const kept = items.filter((item) => keptIds.has(item.sessionId));
    removedPending = items.length - kept.length;
    if (removedPending > 0) await pendingStore().save(kept);
  } catch (error) {
    failures.push(
      `清理待确认项失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  appendPanelLog(
    "log",
    `历史缓存清理：删除记录 ${removedRecords}、目录 ${removedDirs}、` +
      `待确认项 ${removedPending}${failures.length ? `；失败 ${failures.length} 项` : ""}`,
  );

  return { removedRecords, removedDirs, removedPending, failures };
}
