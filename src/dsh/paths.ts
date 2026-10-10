/**
 * 路径助手：统一走 Zotero 沙箱注入的 `PathUtils`。
 *
 * 为什么要抽出来：此前 skill.ts / install.ts / workspace.ts 各自拼过一次路径，
 * 其中 install.ts 用了 `join("/")`，在 Windows 上会拼出错误路径 —— 这类"看着能跑"的
 * 错误只有真机上才暴露，所以集中一处并加测试。
 */

/** 拼接路径片段（使用平台分隔符） */
export function joinPath(...parts: string[]): string {
  return PathUtils.join(...parts);
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
