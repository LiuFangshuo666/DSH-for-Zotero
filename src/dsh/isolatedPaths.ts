/**
 * 隔离运行时的路径规划。
 *
 * 设计（用户确认的方案 A）：DSH-for-Zotero 使用**自己的 dsh 运行时与数据目录**，
 * 与本机 DeepSeek Harness 完全隔离 —— 不共享凭据、不共享会话、不共享端口。
 *
 * 目录布局（全部位于 Zotero 数据目录下，随库一起备份/迁移）：
 *
 *   <数据目录>/dsh-for-zotero/
 *     runtime/            从 Harness 的 app.asar 提取出的 dsh 运行时（约 108 MB JS
 *                         + 224 MB 原生模块），幂等可重建
 *     home/               本插件专属的 DSH_HOME（凭据、会话、storages 都在这里）
 *       profiles/plugin/  这个 dsh 实例的 profile（bundle 清单与补丁层）
 *       .credentials.yaml 本实例自己的浏览器会话密钥（与桌面版不同）
 *     state.json          宿主进程与端口的记录，用于跨重启判断"是否已在运行"
 *
 * 为什么提取而不是复用桌面版那份：桌面版只能从 Electron 的 asar 内加载（普通 Node
 * 不认 asar），且端口写死 19387。实测把运行时提取到磁盘、补上原生模块、把端口改成
 * 环境变量之后，第二份宿主的 session/list 返回 HTTP 200 且凭据与桌面版哈希不同。
 */

/** 相对数据目录的插件根 */ export const PLUGIN_DIR_NAME = "dsh-for-zotero";

/** 提取出的运行时所在子目录 */
export const RUNTIME_DIR_NAME = "runtime";

/** 本插件专属 DSH_HOME 所在子目录 */
export const HOME_DIR_NAME = "home";

/** 本实例的 profile 名（落在 <home>/profiles/<名字>） */
export const PROFILE_NAME = "plugin";

/** 宿主进程使用的端口环境变量名（补丁会把宿主里写死的 19387 改为读它） */
export const PORT_ENV_NAME = "DSH_FOR_ZOTERO_PORT";

/** 默认端口：刻意避开桌面版的 19387，让两者可以并行运行 */
export const DEFAULT_ISOLATED_PORT = 19400;

export interface RuntimePaths {
  /** <数据目录>/dsh-for-zotero */
  root: string;
  /** 提取出的 dsh 运行时 */
  runtime: string;
  /** 本插件的 DSH_HOME */
  home: string;
  /** 本实例的 profile 目录 */
  profile: string;
  /** 宿主入口脚本 */
  hostEntry: string;
  /** 状态记录文件 */
  stateFile: string;
  /** 运行时清单（记录来源与文件数，用于判断是否需要重新提取） */
  manifestFile: string;
  /**
   * 宿主启动代理脚本。
   *
   * 为什么要代理：在 Zotero 沙箱里，被 `Subprocess.sys.mjs` 拉起的子进程
   * **stdout 管道读不到数据**（实测 stdout 0 字节、stderr 1179 字节），
   * 而带 token 的启动 URL 正是打到 stdout 的。代理把 stdout 接过来并
   * 把 URL 写到 `launchUrlFile`，插件读文件即可（文件 I/O 在本机可靠）。
   */
  launcherFile: string;
  /** 代理写入的带 token 启动 URL（每行一个，运行前会清空） */
  launchUrlFile: string;
}

function join(...parts: string[]): string {
  return PathUtils.join(...parts);
}

/** 计算所有路径；数据目录拿不到时返回 undefined（调用方给可读错误） */
export function resolveRuntimePaths(): RuntimePaths | undefined {
  const dataDir = Zotero.DataDirectory?.dir;
  if (!dataDir) return undefined;
  const root = join(dataDir, PLUGIN_DIR_NAME);
  const runtime = join(root, RUNTIME_DIR_NAME);
  const home = join(root, HOME_DIR_NAME);
  return {
    root,
    runtime,
    home,
    profile: join(home, "profiles", PROFILE_NAME),
    hostEntry: join(
      runtime,
      "node_modules",
      "@deepseek-ai",
      "dsh-desktop-host",
      "lib",
      "index.js",
    ),
    stateFile: join(root, "state.json"),
    manifestFile: join(runtime, "dsh-runtime-manifest.json"),
    launcherFile: join(root, HOST_LAUNCHER_FILE_NAME),
    launchUrlFile: join(root, "launch-url.txt"),
  };
}

/** 需要从 asar 提取的路径前缀 */
export const ASAR_PREFIX = "/dsh/";

import { HOST_LAUNCHER_FILE_NAME } from "./hostLauncher";
/**
 * Harness 安装位置探测。
 *
 * 插件无法"询问"Harness 装在哪，只能按常见位置找。找到的证据是
 * `resources/app.asar` 与 `resources/runtime/primary-runtime/dependencies/node/bin/node.exe`
 * 同时存在 —— 这两个是提取与启动的必需品。
 */
export interface HarnessLocation {
  /** 安装根目录（含 resources） */
  installDir: string;
  /** resources 目录 */
  resourcesDir: string;
  /** app.asar 完整路径 */
  asar: string;
  /** 解包目录（原生模块来源） */
  unpackedDir: string;
  /** 自带 Node 解释器 */
  nodeExe: string;
  /** primary-runtime 目录 */
  primaryRuntime: string;
  /** pnpm 入口 */
  pnpmEntry: string;
  /** runtime/bin 目录 */
  runtimeBin: string;
}

/** 把一个候选安装目录组装成 HarnessLocation；缺件则返回 undefined */
export function describeHarness(
  installDir: string,
): HarnessLocation | undefined {
  const resourcesDir = join(installDir, "resources");
  const asar = join(resourcesDir, "app.asar");
  const primaryRuntime = join(resourcesDir, "runtime", "primary-runtime");
  const nodeExe = join(
    primaryRuntime,
    "dependencies",
    "node",
    "bin",
    "node.exe",
  );
  return {
    installDir,
    resourcesDir,
    asar,
    unpackedDir: join(resourcesDir, "app.asar.unpacked"),
    nodeExe,
    primaryRuntime,
    pnpmEntry: join(resourcesDir, "runtime", "pnpm", "bin", "pnpm.mjs"),
    runtimeBin: join(resourcesDir, "runtime", "bin"),
  };
}

/**
 * 逐个检查候选目录，返回第一个"必需文件齐全"的，**并把试过的候选一并返回**。
 *
 * 为什么要返回候选列表：真机反馈"设置里填了错误的 Harness 安装目录，但好像没有影响"。
 * 原因是这里把用户填的目录**排在候选最前面、失败就静默跳到自动探测** ——
 * 功能上很稳，但**用户永远不知道自己填错了**：他以为设置生效了。
 * 有了候选列表，调用方就能在日志里写清"你填的那个无效，用的是自动探测到的这个"。
 */
export async function findHarness(
  candidates: string[],
): Promise<{ location: HarnessLocation; checked: string[] } | undefined> {
  const checked: string[] = [];
  for (const dir of candidates) {
    if (!dir) continue;
    checked.push(dir);
    const loc = describeHarness(dir);
    if (!loc) continue;
    try {
      const [hasAsar, hasNode] = await Promise.all([
        IOUtils.exists(loc.asar),
        IOUtils.exists(loc.nodeExe),
      ]);
      if (hasAsar && hasNode) return { location: loc, checked };
    } catch {
      // 继续下一个候选
    }
  }
  return undefined;
}

/**
 * 常见安装位置候选（按可能性排序）。
 *
 * ⚠️ 这里**不包含任何开发机专属路径**。
 *
 * 早先第一项是硬编码的 `E:\deepseek harness` —— 那是开发机上实测到的位置，
 * 写进产品代码就是"版本迭代遗留"：对别的用户毫无意义，还会掩盖"自动探测失败"
 * 这个真实信号（因为开发机上它总会先命中）。现已移除，改为纯粹的常见位置枚举。
 *
 * 用户若装在别处，用设置里的「Harness 安装目录」指定 —— 那一项会排在最前面。
 */
export function harnessCandidates(): string[] {
  const list: string[] = [];
  const push = (p?: string) => {
    if (p && !list.includes(p)) list.push(p);
  };
  // 常见安装位置：大小写与空格写法都试一遍（Windows 路径大小写不敏感，
  // 但用户目录名可能真的是这个写法）
  for (const drive of ["C:", "D:", "E:", "F:"]) {
    push(`${drive}\\DeepSeek Harness`);
    push(`${drive}\\deepseek harness`);
    push(`${drive}\\Program Files\\DeepSeek Harness`);
    push(`${drive}\\Program Files (x86)\\DeepSeek Harness`);
  }
  try {
    const local = Services.env.get("LOCALAPPDATA");
    if (local) {
      push(join(local, "Programs", "DeepSeek Harness"));
      push(join(local, "DeepSeek Harness"));
    }
  } catch {
    // 忽略
  }
  try {
    const profile = Services.env.get("USERPROFILE");
    if (profile)
      push(join(profile, "AppData", "Local", "Programs", "DeepSeek Harness"));
  } catch {
    // 忽略
  }
  return list;
}
