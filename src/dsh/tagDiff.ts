/**
 * 标签差异计算。
 *
 * ## 只留下"算差异"，不再有"方案文件"
 *
 * 早先标签整理走的是**方案文件**（模型写 `tagplan.json`，用户在会话页点预览→应用）。
 * 现在 Agent 可以直接调 `zotero` 工具里的 `setTags` 自己写库，那套方案文件就成了
 * 并存的第二条路 —— 两条路只会让 Agent 犹豫该用哪个，所以已整体撤掉。
 *
 * 但**差异计算本身仍然需要**：`setTags` 工具与阅读器侧栏的写回都靠它。
 * 它与"方案文件"无关，是纯粹的标签运算，所以留在单独模块里并可单测。
 */

/** 以 `_` 开头的标签是 Zotero 内部用的系统标签，任何重整都必须保留 */
export function isSystemTag(tag: string): boolean {
  return tag.startsWith("_");
}

export interface TagDiff {
  /** 最终应写入的标签（含保留的系统标签） */
  next: string[];
  /** 相对现状要新增的 */
  add: string[];
  /** 相对现状要删除的 */
  remove: string[];
  /** 被保留的系统标签 */
  kept: string[];
}

/**
 * 算出一个条目的标签差异。
 *
 * 规则：`next = 现有系统标签(以 _ 开头) + 期望标签`。
 * 系统标签必须保留 —— 它们由 Zotero 内部维护，删掉可能影响功能。
 */
export function diffTags(current: string[], desired: string[]): TagDiff {
  const kept = current.filter(isSystemTag);
  const next = [...new Set([...kept, ...desired])];
  // ⚠️ `add` 要从**去过重的** next 里算，不能直接用 desired：
  // 否则期望里把同一个标签写两遍时，add 会出现重复项（单测抓到的）。
  const add = next.filter((t) => !current.includes(t));
  const remove = current.filter((t) => !next.includes(t));
  return { next, add, remove, kept };
}
