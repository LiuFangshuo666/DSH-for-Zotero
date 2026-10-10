/**
 * dsh 侧安装的**编排**：按设置项把"伴读 skill 与常驻指令"同步到目标状态。
 *
 * 设计取舍：安装/移除是**双向同步**而不是单向追加。
 *  - 设置项打开 → 确保已安装（幂等，重复运行不会重复内容）；
 *  - 设置项关闭 → 移除我们写过的内容（skill 文件、AGENTS.md 里的标记块），
 *    但**绝不动用户自己写的其它内容**。
 * 这样用户只要改设置再跑一次 DSH 自检，就能确认 dsh 侧处于预期状态，不必手动删文件。
 */

import {
  buildAgentsBlock,
  installAgentInstructions,
  installReadingSkill,
  uninstallReadingSkill,
  AGENTS_BLOCK_END,
  AGENTS_BLOCK_START,
  type InstallResult,
} from "./skill";
import { agentsFilePath, skillFilePath } from "./paths";

export interface SyncOutcome {
  skill?: InstallResult | { action: "removed"; path: string; bytes: number };
  agents?: InstallResult | { action: "removed"; path: string; bytes: number };
  errors: string[];
}

/** 从 AGENTS.md 内容里移除我们写的标记块；返回移除后的内容（可能为空串） */
export function removeAgentsBlock(existing: string): string {
  const start = existing.indexOf(AGENTS_BLOCK_START);
  const end = existing.indexOf(AGENTS_BLOCK_END);
  if (start < 0 || end <= start) return existing;
  const before = existing.slice(0, start).replace(/\s+$/, "");
  const after = existing
    .slice(end + AGENTS_BLOCK_END.length)
    .replace(/^\s+/, "");
  if (before.length === 0) return after;
  if (after.length === 0) return `${before}\n`;
  return `${before}\n\n${after}`;
}

/**
 * 启动时的**只更新、不新建**同步。
 *
 * ## 为什么需要（真机反复踩到的漂移）
 *
 * 技能与常驻指令原先**只在自检时**同步（见 selfcheck.ts 第 8 项）。
 * 后果是：模板改了，磁盘上那份**不会跟着变**，直到用户想起来跑一次自检 ——
 * 而 Agent 读的就是磁盘上那份。真机上已经因此让 Agent 拿着**旧说明**工作：
 *
 *  - 技能里还写着"按 meta.json 作答"，而独立会话里根本没有那个文件；
 *  - 它还照样宣称 DSH 源码在 `runtime\` 下（那里只有 node_modules）。
 *
 * 会话工作区的材料走的是另一条路（`MATERIALS_VERSION` + 启动自动刷新），
 * 从来没有这个问题 —— 技能/AGENTS 缺的正是同一套机制。
 *
 * ## 为什么是"只更新、不新建"
 *
 * 这两个文件是**用户显式开启**才装的（设置里的两个开关，默认关）。
 * 启动时若无条件安装，就等于**替用户做了他没收到的决定** —— 那是越权。
 * 所以这里只对**已经存在**的文件做内容更新：
 *  - 文件不存在 → 什么都不做（用户没开启，或已被他删掉）；
 *  - 文件存在但内容不同 → 用当前模板覆盖（这正是"漂移"的定义）；
 *  - 内容相同 → 不动。
 *
 * 移除仍由自检负责（关掉开关 → 跑自检 → 移除），语义不变。
 */
export async function refreshInstalledDshSide(dshHome: string): Promise<{
  skill: InstallResult | undefined;
  agents: InstallResult | undefined;
  errors: string[];
}> {
  const errors: string[] = [];
  let skill: InstallResult | undefined;
  let agents: InstallResult | undefined;

  // 伴读 skill：仅当 SKILL.md 已存在时更新
  try {
    const path = skillFilePath(dshHome);
    if (await IOUtils.exists(path)) {
      skill = await installReadingSkill(dshHome);
    }
  } catch (error) {
    errors.push(
      `skill 更新失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // 常驻指令：仅当 AGENTS.md 里**已有我们的标记块**时更新
  // （不能只看文件在不在 —— 用户可能自己就有一份 AGENTS.md）
  try {
    const path = agentsFilePath(dshHome);
    if (await IOUtils.exists(path)) {
      const existing = await IOUtils.readUTF8(path);
      if (existing.includes(AGENTS_BLOCK_START)) {
        agents = await installAgentInstructions(dshHome);
      }
    }
  } catch (error) {
    errors.push(
      `常驻指令更新失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { skill, agents, errors };
}

/** 按设置项同步 dsh 侧内容（幂等；任何失败都记录在 errors 里，不抛） */
export async function syncDshSide(params: {
  dshHome: string;
  wantSkill: boolean;
  wantAgents: boolean;
}): Promise<SyncOutcome> {
  const outcome: SyncOutcome = { errors: [] };

  // 伴读 skill
  try {
    if (params.wantSkill) {
      outcome.skill = await installReadingSkill(params.dshHome);
    } else {
      const path = skillFilePath(params.dshHome);
      const removed = await uninstallReadingSkill(params.dshHome);
      if (removed) outcome.skill = { action: "removed", path, bytes: 0 };
    }
  } catch (error) {
    outcome.errors.push(
      `skill 同步失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // 常驻指令（AGENTS.md）
  try {
    if (params.wantAgents) {
      outcome.agents = await installAgentInstructions(params.dshHome);
    } else {
      outcome.agents = await removeAgentsFromFile(params.dshHome);
    }
  } catch (error) {
    outcome.errors.push(
      `常驻指令同步失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return outcome;
}

/** 从 AGENTS.md 移除我们的块；文件因此变空时删除文件 */
async function removeAgentsFromFile(
  dshHome: string,
): Promise<
  InstallResult | { action: "removed"; path: string; bytes: number } | undefined
> {
  const path = agentsFilePath(dshHome);
  if (!(await IOUtils.exists(path))) return undefined;
  const existing = await IOUtils.readUTF8(path).catch(() => "");
  const cleaned = removeAgentsBlock(existing);
  if (cleaned === existing) return undefined; // 没有我们的块
  if (cleaned.trim().length === 0) {
    await IOUtils.remove(path);
    return { action: "removed", path, bytes: 0 };
  }
  await IOUtils.writeUTF8(path, cleaned);
  return { action: "updated", path, bytes: cleaned.length };
}
