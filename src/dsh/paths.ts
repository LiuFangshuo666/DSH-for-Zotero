/**
 * 路径助手：统一走 Zotero 沙箱注入的 `PathUtils`。
 *
 * 为什么要抽出来：此前 skill.ts / install.ts / workspace.ts 各自拼过一次路径，
 * 其中 install.ts 用了 `join("/")`，在 Windows 上会拼出错误路径 —— 这类"看着能跑"的
 * 错误只有真机上才暴露，所以集中一处并加测试。
 */

/** 拼接路径片段（使用平台分隔符） */
export function joinPath(...parts: string[]): string {
  return PathUtils.join(...parts.map(nativeSeparators));
}

/**
 * 把路径里的分隔符统一成**当前平台的原生形态**。
 *
 * ## ⚠️ 为什么必须做（真机实测，不是推测）
 *
 * 记录里的工作区路径曾是这种**混合分隔符**形态（29 条全是）：
 *
 * ```text
 *   C:\Users\…\dsh-for-zotero\home\dsh-for-zotero/collection-VZVXRZ6D
 *                                              ↑ 只有最后一段是正斜杠
 * ```
 *
 * 后果不是"显示难看"，而是**功能直接不可用**。作者在运行中的 Gecko 里实测了三种写法：
 *
 * ```text
 *   PathUtils.join("C:\…\dsh-for-zotero/collection-VZVXRZ6D", "zotero")  → 抛 NS_ERROR_FILE_UNRECOGNIZED_PATH
 *   PathUtils.join("C:\…\collection-VZVXRZ6D",               "zotero")  → ✅ 正常
 *   PathUtils.join("C:/…/collection-VZVXRZ6D",               "zotero")  → 抛 NS_ERROR_FILE_UNRECOGNIZED_PATH
 * ```
 *
 * **Windows 上只接受全反斜杠。** 这条我以前写错过：`session.ts` 里曾注明
 * "只用 `/`；Zotero 在 Windows 上也接受" —— 那个前提是错的，
 * 而它产出的混合路径让 `startToolPoller` 抛错，进而**全库所有会话的工具桥一起失效**。
 *
 * 注意 Node 对混写路径是**宽容**的，所以单测永远发现不了这个问题；
 * 只有真机（Gecko）能暴露。这也是本函数存在的理由。
 */
export function nativeSeparators(path: string): string {
  if (!path) return path;
  // 用"是否 Windows 绝对路径"判断平台，不去碰 `Services.appinfo`：
  // 单测与 Node 环境里没有那个对象，而 `PathUtils` 是沙箱注入的、始终可用。
  const windows = /^[A-Za-z]:[\\/]/.test(path);
  return windows ? path.replace(/\//g, "\\") : path;
}

// ⚠️ 这里原有 `baseName` 与 `workspaceRoot` 两个导出，**都无人使用**：
//  - `baseName`：`papers/workspace.ts` 里另有一份同名实现（那份自带纯实现以便 Node 单测），
//    实际调用走的是那一份；
//  - `workspaceRoot`：`config.ts` 里内联了完全相同的 `PathUtils.join(dshHome, "dsh-for-zotero")`。
// 留着会让人以为"统一从这里取"，实际却有两份定义 —— 正是这个文件当初想避免的问题。

/** 伴读 skill 的 SKILL.md 路径 */
export function skillFilePath(dshHome: string): string {
  return joinPath(dshHome, "skills", "dsh-for-zotero-reading", "SKILL.md");
}

/** 常驻指令文件路径 */
export function agentsFilePath(dshHome: string): string {
  return joinPath(dshHome, "AGENTS.md");
}
