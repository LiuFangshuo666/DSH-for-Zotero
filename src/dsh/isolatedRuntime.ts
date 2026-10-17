/**
 * 隔离 dsh 运行时的生命周期管理。
 *
 * 职责：
 *  1. **准备**：从本机 Harness 的 `app.asar` 提取 dsh 运行时到插件数据目录，
 *     合并 `app.asar.unpacked` 里的原生模块，把宿主写死的端口改成读环境变量，
 *     并写好本实例专属的 profile。
 *  2. **启动**：用 Harness 自带的 Node 解释器拉起宿主，环境里带
 *     `DSH_HOME`（本插件专属）与 `DSH_FOR_ZOTERO_PORT`（避开桌面版）。
 *  3. **健康检查**：读宿主打印的 `dsh web: http://127.0.0.1:<port>/?token=…`，
 *     并用该 token 换取 cookie 后调一次 `session/list`。
 *  4. **停止**：结束宿主进程，清理状态。
 *
 * ## 为什么这些步骤缺一不可（均为实测结论）
 *
 * - **提取**：桌面版的 dsh 树在 `app.asar` 内，普通 Node 不认 asar，无法直接运行。
 * - **原生模块合并**：asar 内文件是压缩存储的，提取出的 `.node` 无法 `dlopen`
 *   （实测 `No usable native binding found for node-addon-require-builtin-win32-x64-msvc`），
 *   可加载的那份在 `app.asar.unpacked`。
 * - **端口补丁**：宿主把 19387 写在参数里，第二个实例必然 `EADDRINUSE`。
 * - **平台差异**：`node.exe` / `app.asar` 是 Windows 形态；非 Windows 上找不到就
 *   明确报错而不是静默失败。
 */

import { spawn, runToCompletion, type SpawnedProcess } from "./subprocess";
import { HOST_LAUNCHER_SOURCE } from "./hostLauncher";
import { appendPanelLog } from "./runLog";
import {
  logCredentialMerge,
  mergeProviderCredentials,
} from "./credentialMerge";
import { syncApiKeyToCredentials } from "./modelConfig";
import { applyProviders } from "./providers";
import { defaultDshHome } from "./config";
import {
  ASAR_PREFIX,
  DEFAULT_ISOLATED_PORT,
  PORT_ENV_NAME,
  PROFILE_NAME,
  findHarness,
  harnessCandidates,
  resolveRuntimePaths,
  type HarnessLocation,
  type RuntimePaths,
} from "./isolatedPaths";

export type RuntimePhase =
  | "unknown"
  | "no-harness"
  | "not-prepared"
  | "preparing"
  | "ready"
  | "starting"
  | "running"
  | "stopped"
  | "error";

export interface RuntimeStatus {
  phase: RuntimePhase;
  /** 人类可读的一句话 */
  message: string;
  /** 宿主端口（运行中才有意义） */
  port?: number;
  /** 宿主进程号 */
  pid?: number;
  /** 启动 token（换取 cookie 用） */
  token?: string;
  /**
   * 宿主自己打印的完整启动 URL（含 token）。
   * 用它而不是自己拼：dsh 的认证入口就是这个 URL，拼错一个字符就会
   * 报 "dsh web authentication required"。
   */
  launchUrl?: string;
  /** 提取进度描述 */
  progress?: string;
}

interface PersistedState {
  port?: number;
  pid?: number;
  preparedAt?: string;
  harnessDir?: string;
}

const PROFILE_FILES: Record<string, string> = {
  "package.json": `{
  "name": "dsh-profile-plugin",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app"
      ]
    }
  }
}
`,
  "cordis.yml": `# dsh profile root — 空入口列表，树由补丁层组合。由 DSH-for-Zotero 维护。
[]
`,
  "cordis.patch.yml": `# DSH-for-Zotero 的补丁层：默认模型设为 deepseek-flash。
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-official
    model: deepseek-flash
    reasoningEffort: max
`,
  "pnpm-workspace.yaml": `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`,
};

/** 需要从 unpacked 覆盖到 runtime 的路径特征（原生二进制及其包） */
const NATIVE_HINTS = [
  "@swc",
  "@img",
  "node-pty",
  "sherpa-onnx-win-x64",
  "node-addon-require-builtin-win32-x64-msvc",
];

/**
 * 取父目录。
 * `PathUtils.parent` 的返回类型是 `string | null`（根目录返回 null）。
 * 这里显式处理，避免用非空断言掩盖真实的边界情况。
 */
function parentDir(path: string): string {
  const parent = PathUtils.parent(path);
  if (!parent) throw new Error(`无法取得父目录：${path}`);
  return parent;
}

/**
 * 把 PowerShell 脚本编码成 `-EncodedCommand` 需要的 Base64（UTF-16LE）。
 *
 * 为什么需要：脚本里含内层引号（`-Filter "Name='node.exe'"`），而经 `-Command`
 * 传递时引号会被剥掉，导致 WMI 报"无效查询"、枚举永远返回 0 个（真机实测：
 * 结果是残留宿主从来清理不掉、端口一直被占、端口漂移）。
 * `-EncodedCommand` 完全绕开引号解析，是唯一稳的做法。
 *
 * 手写是因为沙箱里没有 Node 的 `Buffer`（与 base64url.ts 同一原因），
 * 且必须是 **UTF-16LE**：Windows PowerShell 5.1 只认这个字节序。
 */
function encodePowerShellCommand(script: string): string {
  const bytes = new Uint8Array(script.length * 2);
  for (let i = 0; i < script.length; i++) {
    const code = script.charCodeAt(i);
    bytes[i * 2] = code & 0xff;
    bytes[i * 2 + 1] = (code >> 8) & 0xff;
  }
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  // 标准 Base64（含 + / =），不是 base64url —— powershell 只认标准字母表
  return btoa(binary);
}

/**
 * 把宿主源码里写死的端口改成读环境变量的**纯函数**（可单测）。
 *
 * ## 为什么抽出来（真机事故：DSH 升级后插件完全跑不起来）
 *
 * 2026-10-17：用户升级桌面端 DSH，插件侧无法运行，日志只有
 *
 * ```text
 *   准备结果：error —— 准备失败：宿主里找不到预期的端口字面量
 *   （Harness 版本可能已变化）。为避免误改，已中止
 * ```
 *
 * 旧版宿主写 `"--port", "19387"`，新版改成 `"--port", "0"`（0 = 系统分配）。
 * 我原来的正则把 `"19387"` **写死**在里面，于是 DSH 一升级插件就死。
 *
 * 现在判据是「`--port` 后跟任意数字字面量」——那个**形状**比具体数字稳定得多。
 * 抽成纯函数是为了让这条判据有测试：再遇到版本变化，测试会先红，
 * 而不是等用户在真机上发现插件起不来。
 *
 * @param source 宿主入口源码
 * @param envName 端口环境变量名
 * @returns patched（含改后源码与原默认值）/ already（已打过）/ not-found（形状不符）
 */
export function patchHostPortInSource(
  source: string,
  envName: string,
):
  | { kind: "patched"; source: string; hostDefault: string }
  | { kind: "already" }
  | { kind: "not-found" } {
  // 幂等：改过之后源码里就有环境变量名了
  if (source.includes(envName)) return { kind: "already" };
  const pattern = /("--port"\s*,\s*\n?\s*)"(\d+)"/;
  const match = pattern.exec(source);
  if (!match) return { kind: "not-found" };
  const hostDefault = match[2];
  const patched = source.replace(
    pattern,
    `$1String(process.env.${envName} ?? "${hostDefault}")`,
  );
  return { kind: "patched", source: patched, hostDefault };
}

/**
 * ## asar 数据区的起点：**必须按 Pickle 的 4 字节对齐**
 *
 * asar 的头部不是裸 JSON，而是 Electron `Pickle` 编码：
 *
 * ```text
 *   [0]  uint32 = 4                          （下面那个 uint32 的长度）
 *   [4]  uint32 = 头部字符串块的总长
 *   [8]  uint32 = 字符串块的 payload 长度     （= 4 + jsonLen + padding）
 *   [12] uint32 = JSON 字节数 jsonLen
 *   [16] JSON（jsonLen 字节）
 *   [16+jsonLen ... 16+align4(jsonLen))      ← **NUL 填充**
 *   [16+align4(jsonLen)) 起是文件数据
 * ```
 *
 * ## ⚠️ 真机事故：漏掉 padding 会**静默写坏每一个文件**
 *
 * 2026-10-17 用户升级桌面端 DSH 后，插件提取出的运行时里
 * **255 / 313 个 `package.json` 都不是合法 JSON**，宿主启动即退出：
 *
 * ```text
 *   Error: Invalid package config ...\@deepseek-ai\dsh-app-boot\package.json
 * ```
 *
 * 实测那一版的 `jsonLen = 4775822`（`% 4 = 2`），于是数据区实际从
 * `16 + 4775824` 开始 —— 比"`16 + jsonLen`"晚 **2 字节**。
 * 结果每个文件 = 前一个文件的最后 2 字节 + 真实内容的前 N-2 字节：
 * 开头多垃圾、结尾被截短，JSON 必然解析失败。
 *
 * **这个 bug 潜伏了很久**：旧版 DSH 的 `jsonLen` 恰好是 4 的倍数，
 * padding 为 0，于是"少算 padding"与"正确"结果相同。新版的长度不是 4 的倍数，
 * 才把它暴露出来。这类"条件成立时看起来正确"的算式最容易长期存活。
 *
 * @param headerSize 头部声明（`view.getUint32(12, true)`）的 JSON 字节数
 * @returns 文件数据区的起始字节偏移
 */
/**
 * 提取布局的版本号。**改动提取逻辑时必须 +1。**
 *
 * 为什么需要：提取是增量的（大小一致即跳过），而"写坏的文件大小也是对的" ——
 * 真机上漏算 Pickle padding 导致每个文件错位 2 字节，大小不变，于是修好源码后
 * 那些坏文件仍被跳过，宿主继续起不来。这个戳让"逻辑变了"能作废已有产物。
 *
 * 版本历史：
 *  - 1（隐式，无戳）：漏算 Pickle 4 字节对齐 → 文件整体错位
 *  - 2：补上对齐；引入戳，作废版本 1 的全部产物
 */
export const ASAR_LAYOUT_VERSION = 2;

export function asarDataStart(headerSize: number): number {
  // Pickle 把字符串 payload 补齐到 4 字节边界
  const aligned = (headerSize + 3) & ~3;
  return 16 + aligned;
}

/**
 * 解析提取戳（纯函数，可单测）。
 *
 * 格式：`<布局版本>|<asar 字节数>|<asar 完整路径>`。
 *
 * ## 为什么把**源 asar** 也记进去
 *
 * 布局版本只回答"提取**算法**变了吗"。用户**升级桌面端**时算法没变 ——
 * 于是产物被判为"已就绪"，插件继续跑**旧版本**的副本，而用户以为升级生效了
 * （真机：0.2.1-rc.1 → rc.2 就是这样）。
 *
 * 用**大小**而不是哈希：这是个 ~180 MB 的文件，`isPrepared()` 每次都要判断，
 * 读全文不现实。大小对内容变化已足够敏感。
 *
 * @returns 解析结果；旧格式（只有版本号）或畸形内容返回 `undefined`（视为不一致）
 */
export function parseExtractStamp(
  raw: string,
): { layout: number; asarSize: number; asarPath: string } | undefined {
  const parts = String(raw ?? "")
    .trim()
    .split("|");
  if (parts.length < 3) return undefined;
  // ⚠️ 必须用**严格数字**判据，不能用 Number()：`Number("")` 是 0（有限），
  // 于是空版本号会被当成"布局版本 0"而通过 —— 而版本号是从 1 开始的。
  if (!/^\d+$/.test(parts[0])) return undefined;
  if (!/^\d+$/.test(parts[1])) return undefined;
  // 路径里理论上可能含 `|`，所以从第 3 段起重新拼回
  const asarPath = parts.slice(2).join("|");
  if (!asarPath) return undefined;
  return {
    layout: Number(parts[0]),
    asarSize: Number(parts[1]),
    asarPath,
  };
}

export class RuntimeManager {
  private paths: RuntimePaths | undefined;
  private harness: HarnessLocation | undefined;
  private child: SpawnedProcess | undefined;
  private status: RuntimeStatus = { phase: "unknown", message: "尚未初始化" };
  private listeners = new Set<(status: RuntimeStatus) => void>();

  onStatus(listener: (status: RuntimeStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  getStatus(): RuntimeStatus {
    return this.status;
  }

  private setStatus(status: RuntimeStatus): void {
    this.status = status;
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch {
        // 监听者异常不影响运行时
      }
    }
  }

  /**
   * 写一条诊断日志。
   * 同时进 Zotero 调试输出与插件数据目录 —— 前者需要开 -ZoteroDebugText 才能看，
   * 而运行时故障恰恰是最需要"事后能读"的一类。
   */
  private log(message: string): void {
    try {
      Zotero.debug(`[DSH runtime] ${message}`);
    } catch {
      // 忽略
    }
    appendPanelLog("runtime", message);
  }

  private requirePaths(): RuntimePaths {
    this.paths ??= resolveRuntimePaths();
    if (!this.paths)
      throw new Error("拿不到 Zotero 数据目录，无法放置隔离运行时");
    return this.paths;
  }

  // ── 准备（提取 + 原生模块 + 端口补丁 + profile） ────────────────

  /**
   * 运行时是否已经准备好了（宿主入口有内容、清单与 profile 都在、**且端口补丁仍在**）。
   *
   * 两个必须检查的点，都来自真实故障：
   *
   * 1. **宿主入口非空**。曾经因为 asar 的 offset 是字符串、未做 Number() 转换，
   *    `subarray` 切片全为空 —— "提取成功"却得到 11376 个 0 字节文件。
   *    只看"文件存在"会把这个坏状态当成就绪，而且**永远不会自我修复**。
   * 2. **端口补丁仍在**。重新提取会覆盖被打过补丁的宿主入口（13977 → 13998 字节），
   *    若不检查就会退回写死 19387，启动时表现为端口占用。
   */
  async isPrepared(): Promise<boolean> {
    const paths = resolveRuntimePaths();
    if (!paths) return false;
    try {
      const [host, manifest, profilePkg] = await Promise.all([
        IOUtils.exists(paths.hostEntry),
        IOUtils.exists(paths.manifestFile),
        IOUtils.exists(PathUtils.join(paths.profile, "package.json")),
      ]);
      if (!host || !manifest || !profilePkg) return false;

      // ① 宿主入口必须真的有内容
      const hostStat = await IOUtils.stat(paths.hostEntry);
      if ((hostStat.size ?? 0) <= 0) return false;

      // ② 端口补丁必须在
      if (!(await this.isPortPatchApplied(paths))) return false;

      /**
       * ③ **提取布局版本必须匹配**（真机事故：修好算式却等于没修）
       *
       * 提取是增量的（大小一致即跳过）。而"漏算 Pickle padding"写坏的文件
       * **大小完全正确** —— 于是修好算式后，`extractFromAsar` 会把它们
       * 全判为"已完成"而跳过，宿主继续报 `Invalid package config`。
       *
       * 所以布局版本也是"已准备好"的一部分：戳不对就必须重跑提取。
       * ⚠️ 这里**不能**用"宿主入口存在"代替 —— 它就是存在且非空（只是内容错位）。
       */
      return await this.isLayoutStampCurrent(paths);
    } catch {
      return false;
    }
  }

  /**
   * 提取产物是否与**当前**的 `app.asar` 一致（布局版本 + 源文件指纹）。
   *
   * ## 为什么除了布局版本还要看源文件（真机场景：用户连着升级两次）
   *
   * 布局版本只回答"提取**算法**变了吗"。而用户**升级桌面端**时算法没变，
   * 于是提取产物被判为"已就绪"→ 插件继续跑**旧版本**的副本，
   * 而用户以为自己升级了（2026-10-17 用户从 0.2.1-rc.1 升到 rc.2 就是这样）。
   *
   * 所以把**源 asar 的大小与路径**也记进戳里：
   *
   * - 桌面端更新 → asar 大小变 → 重新提取（约 10–15 秒，一次性）；
   * - 桌面端被卸载/搬走 → 路径不存在 → 也重新提取（会重新定位）。
   *
   * ⚠️ 用**大小**而不是逐字节哈希：这是一个 180 MB 的文件，每次 `isPrepared()`
   * 都去读一遍是不现实的。大小对"内容变化"已经足够敏感（一个包变了大小就变）。
   *
   * 戳的格式：`<布局版本>|<asar 字节数>|<asar 完整路径>`。
   * 旧版戳（只有 `2`）解析失败 → 视为不一致 → 重新提取一次，安全。
   */
  private async isLayoutStampCurrent(paths: RuntimePaths): Promise<boolean> {
    try {
      const stamp = PathUtils.join(paths.runtime, ".extract-layout");
      if (!(await IOUtils.exists(stamp))) return false;
      const raw = (await IOUtils.readUTF8(stamp)).trim();
      const parsed = parseExtractStamp(raw);
      if (!parsed) return false; // 旧格式（无指纹）/ 畸形 → 重新提取
      if (parsed.layout !== ASAR_LAYOUT_VERSION) return false;
      const stat = await IOUtils.stat(parsed.asarPath);
      if (stat.type !== "regular") return false;
      return Number(stat.size) === parsed.asarSize;
    } catch {
      return false;
    }
  }

  /**
   * 运行时目录是否处于"提取出空文件"的污染状态。
   *
   * 判据：宿主入口**存在但为 0 字节**。这是 asar offset 未做 Number() 转换时的典型症状
   * （切片全空），且增量提取无法自愈 → 必须整体重建。
   */
  private async isRuntimePolluted(paths: RuntimePaths): Promise<boolean> {
    try {
      if (!(await IOUtils.exists(paths.hostEntry))) return false;
      const stat = await IOUtils.stat(paths.hostEntry);
      return (stat.size ?? 0) === 0;
    } catch {
      return false;
    }
  }

  /**
   * 清空已被污染或过期的运行时目录。
   *
   * 为什么需要：`extractFromAsar` 是增量的（大小一致即跳过），这在正常重跑时是优点；
   * 但若上一次提取产出的全是 0 字节文件，增量逻辑会把它们当成"已有一致"而永远跳过，
   * 坏状态便无法自愈。检测到宿主入口为空时，直接整体重建（约 6–10 秒，可接受）。
   */
  private async resetRuntimeDir(paths: RuntimePaths): Promise<void> {
    try {
      if (await IOUtils.exists(paths.runtime)) {
        await IOUtils.remove(paths.runtime, { recursive: true });
      }
    } catch (error) {
      throw new Error(
        `无法清理损坏的运行时目录（${paths.runtime}）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    await IOUtils.makeDirectory(paths.runtime, { ignoreExisting: true });
  }

  /** 宿主入口里是否还有我们的端口补丁 */
  private async isPortPatchApplied(paths: RuntimePaths): Promise<boolean> {
    try {
      const source = await IOUtils.readUTF8(paths.hostEntry);
      return source.includes(PORT_ENV_NAME);
    } catch {
      return false;
    }
  }

  /**
   * 准备隔离运行时。幂等：已就绪时直接返回。
   * `onProgress` 用于把耗时步骤显示到界面。
   */
  async prepare(onProgress?: (text: string) => void): Promise<RuntimeStatus> {
    const paths = this.requirePaths();
    const report = (text: string) => {
      this.setStatus({ phase: "preparing", message: text, progress: text });
      onProgress?.(text);
    };

    try {
      if (await this.isPrepared()) {
        this.setStatus({ phase: "ready", message: "隔离运行时已就绪" });
        return this.status;
      }

      report("正在定位本机 DeepSeek Harness…");
      const configured = this.readConfiguredHarnessDir();
      const candidates = configured
        ? [configured, ...harnessCandidates()]
        : harnessCandidates();
      const found = await findHarness(candidates);
      if (!found) {
        // 找不到时把**试过哪些目录**写进诊断：否则用户只看到"找不到"，
        // 不知道自己填的那个是不是被忽略了（真机反馈过这个困惑）。
        const message =
          "找不到 DeepSeek Harness 安装（需要 resources/app.asar 与自带的 node.exe）。" +
          (configured
            ? `已优先尝试你指定的「${configured}」，但它缺少必需文件；`
            : "") +
          "请在设置里指定正确的安装目录。";
        this.log(`定位 Harness 失败，试过：${candidates.join(" | ")}`);
        this.setStatus({ phase: "no-harness", message });
        return this.status;
      }
      // ⚠️ 用户填了目录但它不是最终选中的那个 → **明确告知**。
      //
      // 真机反馈："设置里输入了错误的 Harness 安装目录，但好像没有影响功能"。
      // 行为上确实没影响（用户填的排在候选最前、失败就自动探测），
      // 但**用户以为自己填对了** —— 这属于设置界面在"骗人"，必须说出来。
      if (configured && found.location.installDir !== configured) {
        this.log(
          `⚠️ 设置里的 Harness 安装目录「${configured}」无效（缺少 resources/app.asar 或 node.exe），` +
            `已改用自动探测到的「${found.location.installDir}」。` +
            "若这就是你想要的，可以把设置留空。",
        );
        report(`你指定的目录无效，已改用「${found.location.installDir}」`);
      }
      this.harness = found.location;
      // 把"实际用了哪个目录"记下来：设置里填错时上面会有一条 ⚠️，
      // 两行放在一起就能一眼看出"我填的没用上、实际用的是这个"。
      this.log(
        `Harness 安装目录：${found.location.installDir}` +
          (configured ? `（设置里填的是「${configured}」）` : "（自动探测）"),
      );

      // 检测"上次提取产出的全是空文件"的污染状态：此时增量提取会把空文件当成
      // "已有一致"而永远跳过，必须整体重建才能自愈（见 resetRuntimeDir 注释）。
      const polluted = await this.isRuntimePolluted(paths);
      /**
       * ## 提取布局版本变了 → **整目录重建**（不只覆盖）
       *
       * 真机事故（2026-10-17）暴露了两件事：
       *
       * 1. 漏算 Pickle padding 让每个文件错位 2 字节，而**大小完全正确** ——
       *    增量提取会把它们判为"已完成"永久跳过，修了算式等于没修；
       * 2. 用户**升级 DSH** 时，运行时会变成**两个版本的混合体**：
       *    新 asar 里有的文件被覆盖（`写入 6946`），
       *    而尺寸恰好相同的旧文件被跳过（`跳过 8718`）——
       *    于是 `dsh-desktop-host/package.json` 还报着**旧版本号**。
       *
       * 只"强制覆盖"解决不了第 2 点：**旧版本独有的文件不会被删**。
       * 所以版本不匹配时**整个 runtime 目录清掉重来** —— 这是唯一能保证
       * "目录内容与当前 asar 严格一致"的做法。
       *
       * 代价：一次约 10–15 秒的全量提取。只在首次安装与布局/版本变化时发生。
       */
      const layoutStale = !(await this.isLayoutStampCurrent(paths));
      if (polluted || layoutStale) {
        report(
          polluted
            ? "检测到上次提取的文件为空，正在重建运行时…"
            : "提取布局版本已更新，正在重建运行时（清除旧版本残留，约 10–15 秒）…",
        );
        await this.resetRuntimeDir(paths);
      }

      await IOUtils.makeDirectory(paths.runtime, { ignoreExisting: true });
      await IOUtils.makeDirectory(paths.profile, { ignoreExisting: true });
      await this.writeProfileFiles(paths, report);

      // ⚠️ 组合层里与应用户相关的那部分：自定义 provider。
      //
      // 必须在**拉起宿主之前**写完 —— `package.json` 的 `bundles` 决定宿主
      // 启动时组合哪些包，启动之后再改是无效的（要重启）。
      // 放在 `writeProfileFiles` 之后：那个方法只在文件不存在时写入基础内容，
      // 而这里做的是"在既有内容上并入托管区块"。
      report("正在写入模型 provider 配置…");
      const applied = await applyProviders({
        profileDir: paths.profile,
        credentialsFile: PathUtils.join(paths.home, ".credentials.yaml"),
      });
      if (applied.needsRestart) {
        this.log(`自定义 provider 配置已更新：${applied.detail}`);
      }

      report("正在提取 dsh 运行时（约 110 MB，首次约 10 秒）…");
      await this.extractFromAsar(found.location, paths, report);

      report("正在补上原生模块（约 224 MB）…");
      await this.mergeNativeModules(found.location, paths, report);

      report("正在让宿主端口可配置…");
      await this.patchHostPort(paths);

      // 写启动代理：沙箱里读不到宿主的 stdout 管道，代理会把带 token 的
      // 启动 URL 写到文件（见 hostLauncher.ts 的说明）。
      await IOUtils.writeUTF8(paths.launcherFile, HOST_LAUNCHER_SOURCE);

      // 复制模型侧凭据：隔离实例是全新 DSH_HOME，没有模型 API key 会导致
      // 问答立刻失败（错误藏在 turn/end 的 reason 里，界面表现为一直"…"）。
      // 只复制模型账号相关记录；宿主的浏览器会话密钥保持独立（见 credentialMerge.ts）。
      report("正在准备模型凭据…");
      await this.copyProviderCredentials(paths);
      // 设置页里填过 API Key 的话，它**优先于**刚从桌面版复制来的值
      // （见 modelConfig.ts 的规则表）。放在复制之后，顺序不能反。
      const keyResult = await syncApiKeyToCredentials(
        PathUtils.join(paths.home, ".credentials.yaml"),
      );
      this.log(`模型 API Key：${keyResult.detail}`);

      await this.saveState({
        preparedAt: new Date().toISOString(),
        harnessDir: found.location.installDir,
      });
      this.setStatus({ phase: "ready", message: "隔离运行时已就绪" });
      return this.status;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus({ phase: "error", message: `准备失败：${message}` });
      return this.status;
    }
  }

  /** profile 四个小文件：缺哪个写哪个（不覆盖用户可能改过的内容） */
  private async writeProfileFiles(
    paths: RuntimePaths,
    report: (t: string) => void,
  ): Promise<void> {
    report("正在写入 profile…");
    for (const [name, content] of Object.entries(PROFILE_FILES)) {
      const target = PathUtils.join(paths.profile, name);
      if (await IOUtils.exists(target)) continue;
      await IOUtils.writeUTF8(target, content);
    }
  }

  /** 读取设置里指定的 Harness 目录（留空则自动探测） */
  private readConfiguredHarnessDir(): string | undefined {
    try {
      const value = String(
        (Zotero.Prefs.get(
          `${addon.data.config.prefsPrefix}.harnessDir`,
          true,
        ) as string | undefined) ?? "",
      ).trim();
      return value || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 从 asar 提取 `/dsh/` 树。
   *
   * 实现说明：asar 头部（pickle）在**文件起始处**，不是 ZIP 的尾部中央目录 ——
   * 这一点本项目在写工具脚本时踩过坑。头部布局：
   *   偏移 12 = uint32 头长度；偏移 16 = JSON；数据从 16 + 头长度 起算。
   *
   * 用 Uint8Array 直接切片写盘，避免把 116 MB 转成字符串。
   */
  private async extractFromAsar(
    harness: HarnessLocation,
    paths: RuntimePaths,
    report: (t: string) => void,
  ): Promise<void> {
    const bytes = await IOUtils.read(harness.asar);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerSize = view.getUint32(12, true);
    const headerText = new TextDecoder().decode(
      bytes.subarray(16, 16 + headerSize),
    );
    const tree = JSON.parse(
      headerText.slice(0, headerText.lastIndexOf("}") + 1),
    ) as {
      files?: Record<string, AsarNode>;
    };
    const dataStart = asarDataStart(headerSize);

    const targets: Array<{ path: string; offset: number; size: number }> = [];
    const walk = (node: AsarNode, prefix: string) => {
      for (const [name, value] of Object.entries(node.files ?? {})) {
        const p = `${prefix}/${name}`;
        if (value.files) walk(value, p);
        else if (value.offset !== undefined && value.size !== undefined) {
          if (p.startsWith(ASAR_PREFIX)) {
            // ⚠️ 必须 Number()：asar 头部里 **offset 是字符串**（大偏移量如此存储），
            // 实测 `{"size":13773,"offset":"44669811"}`。若直接参与运算，
            // `dataStart + offset` 会做**字符串拼接**（"3392064" + "44669811"），
            // 传给 subarray 被强转成巨大索引 → **切片为空**，
            // 于是"提取成功"却得到 11376 个 0 字节文件，端口补丁随之找不到字面量。
            // 这个坑真实发生过一次，改这里时请勿删掉 Number()。
            targets.push({
              path: p,
              offset: Number(value.offset),
              size: Number(value.size),
            });
          }
        }
      }
    };
    walk({ files: tree.files }, "");

    /**
     * ## 布局版本戳：让"提取逻辑变了"能**作废**已有文件
     *
     * "大小一致就跳过"是续跑的关键，但它有个致命副作用：
     * **写坏的文件大小也是对的**，于是会被永久跳过。
     *
     * 真机事故（2026-10-17）：因为漏算 Pickle padding，每个文件都错位 2 字节 ——
     * 大小完全不变。修好 `dataStart` 后，那 255 个坏 `package.json` 仍会被
     * 判为"已完成"而留着，宿主继续起不来。**修了等于没修。**
     *
     * 所以把布局版本写进一个戳文件：戳不匹配就**强制全量重写**。
     * 以后只要改动提取逻辑（对齐、prefix、offset 语义），就把版本 +1。
     */
    const stampPath = PathUtils.join(paths.runtime, ".extract-layout");
    let force = false;
    try {
      if (await IOUtils.exists(stampPath)) {
        // 戳格式：`<布局版本>|<asar 字节数>|<asar 路径>`（见 isLayoutStampCurrent）
        const seenLayout = (await IOUtils.readUTF8(stampPath))
          .trim()
          .split("|")[0];
        force = seenLayout !== String(ASAR_LAYOUT_VERSION);
        if (force) {
          report(
            `提取布局版本从 ${seenLayout || "（空）"} 变为 ${ASAR_LAYOUT_VERSION}，将全量重写（旧文件可能已损坏）`,
          );
        }
      } else {
        // 没有戳：可能是从没提过，也可能是旧版本提的（那时还没有戳）
        force = true;
      }
    } catch {
      force = true;
    }

    let written = 0;
    let skipped = 0;
    for (const file of targets) {
      const rel = file.path.slice(ASAR_PREFIX.length);
      const dest = PathUtils.join(paths.runtime, ...rel.split("/"));
      // 幂等：大小一致就跳过，支持中断后续跑（**除非**布局版本变了）
      if (!force) {
        try {
          if (await IOUtils.exists(dest)) {
            const stat = await IOUtils.stat(dest);
            if (stat.size === file.size) {
              skipped++;
              continue;
            }
          }
        } catch {
          // 取不到大小就覆盖写
        }
      }
      await IOUtils.makeDirectory(parentDir(dest), { ignoreExisting: true });
      await IOUtils.write(
        dest,
        bytes.subarray(
          dataStart + file.offset,
          dataStart + file.offset + file.size,
        ),
      );
      written++;
      if (written % 2000 === 0)
        report(`已提取 ${written} / ${targets.length} 个文件…`);
    }
    report(
      `提取完成：写入 ${written} 个，跳过 ${skipped} 个（共 ${targets.length}）`,
    );
    // 全量重写成功后才写戳 —— 中途失败时戳不更新，下次仍会全量重试。
    //
    // 戳里记 **源 asar 的大小与路径**（不只是布局版本）：用户升级桌面端时
    // 提取算法没变，但源文件变了 —— 只看版本号会继续复用旧副本，
    // 让用户以为"已经用上新版"（真机：rc.1 → rc.2 就是这样）。
    try {
      const asarStat = await IOUtils.stat(harness.asar);
      await IOUtils.writeUTF8(
        stampPath,
        `${ASAR_LAYOUT_VERSION}|${Number(asarStat.size)}|${harness.asar}`,
      );
    } catch {
      // 戳写不进去只影响下次是否重新提取，不影响本次结果
    }

    /**
     * ## 提取后自检：抽几个 `package.json` 验证 JSON 合法
     *
     * 为什么值得这一步（真机事故的教训）：漏算 Pickle padding 时，
     * 每个文件都错位 2 字节 —— **大小完全正确、提取"成功"、日志全绿**，
     * 直到宿主启动才报 `Invalid package config`，而那时离根因已经很远。
     *
     * 这一小段把"半小时排查"变成**一行日志**。
     * 不 fail-fast：自检失败也继续（可能只是抽样文件恰好缺失），
     * 但日志里会有明确线索。
     */
    const probes = [
      "@deepseek-ai/dsh-app-boot",
      "@deepseek-ai/dsh-desktop-host",
      "@deepseek-ai/dsh-agent",
    ];
    let probeOk = 0;
    const probeFail: string[] = [];
    for (const pkg of probes) {
      const p = PathUtils.join(
        paths.runtime,
        "node_modules",
        ...pkg.split("/"),
        "package.json",
      );
      try {
        if (!(await IOUtils.exists(p))) continue;
        JSON.parse(await IOUtils.readUTF8(p));
        probeOk += 1;
      } catch {
        probeFail.push(pkg);
      }
    }
    report(
      `提取自检：${probeOk} 个关键 package.json 合法` +
        (probeFail.length
          ? `；**${probeFail.join("、")} 不是合法 JSON** —— 提取可能错位（对齐/偏移问题）`
          : ""),
    );
  }

  /**
   * 把 `app.asar.unpacked` 里的原生二进制覆盖到提取目录。
   * 只复制原生相关路径，避免白拷 1500 个文件里无关的部分。
   */
  private async mergeNativeModules(
    harness: HarnessLocation,
    paths: RuntimePaths,
    report: (t: string) => void,
  ): Promise<void> {
    const sourceRoot = PathUtils.join(harness.unpackedDir, "dsh");
    if (!(await IOUtils.exists(sourceRoot))) {
      report("警告：没有 app.asar.unpacked，原生模块可能缺失");
      return;
    }

    let copied = 0;
    const walk = async (dir: string): Promise<void> => {
      let children: string[];
      try {
        children = await IOUtils.getChildren(dir);
      } catch {
        return;
      }
      for (const child of children) {
        let stat;
        try {
          stat = await IOUtils.stat(child);
        } catch {
          continue;
        }
        if (stat.type === "directory") {
          await walk(child);
          continue;
        }
        const isNative =
          /\.(node|dll|exe|so|dylib)$/i.test(child) ||
          NATIVE_HINTS.some((h) => child.includes(h));
        if (!isNative) continue;
        const rel = child.slice(sourceRoot.length).replace(/^[\\/]+/, "");
        const dest = PathUtils.join(paths.runtime, ...rel.split(/[\\/]/));
        try {
          if (await IOUtils.exists(dest)) {
            const destStat = await IOUtils.stat(dest);
            if (destStat.size === stat.size) continue;
          }
        } catch {
          // 覆盖写
        }
        await IOUtils.makeDirectory(parentDir(dest), { ignoreExisting: true });
        await IOUtils.copy(child, dest);
        copied++;
        if (copied % 100 === 0) report(`已合并原生文件 ${copied} 个…`);
      }
    };
    await walk(sourceRoot);
    report(`原生模块合并完成：${copied} 个文件`);
  }

  /**
   * 把宿主里写死的端口改为读环境变量（只改我们的副本，且幂等）。
   *
   * ## ⚠️ 必须容忍**任意数字字面量**（真机事故：DSH 升级后插件跑不起来）
   *
   * 2026-10-17：用户升级桌面端 DSH 后，插件侧完全无法运行，日志只有
   *
   * ```text
   *   准备结果：error —— 准备失败：宿主里找不到预期的端口字面量
   *   （Harness 版本可能已变化）。为避免误改，已中止
   * ```
   *
   * 根因：旧版宿主写的是 `"--port", "19387"`，新版改成了 `"--port", "0"`
   * （0 = 让系统分配）。我原来的正则把 `"19387"` 写死在里面 ——
   * 于是 DSH 一升级，插件就**完全起不来**。
   *
   * ## 现在的做法：捕获原值，并把它作为**兜底**
   *
   * ```ts
   *   "--port", "0"   →   "--port", String(process.env.DSH_FOR_ZOTERO_PORT ?? "0")
   * ```
   *
   * 兜底用**宿主原来的值**而不是我们写死的 19387：这样即使插件的环境变量
   * 没传进来，宿主的行为也与它自己的默认一致（新版的"自动分配"不会被我们
   * 悄悄改成固定端口）。
   *
   * ## 为什么仍然"找不到就中止"
   *
   * 不改比改错好。上一版中止得对 —— 只是**判据太窄**，把"版本演进了"
   * 误判成"文件不认识"。现在判据是"`--port` 后面跟一个数字字面量"，
   * 这个形状比具体的数字稳定得多。
   */
  private async patchHostPort(paths: RuntimePaths): Promise<void> {
    if (!(await IOUtils.exists(paths.hostEntry))) {
      throw new Error("提取后仍找不到宿主入口，运行时可能不完整");
    }
    const source = await IOUtils.readUTF8(paths.hostEntry);
    // 判据与替换都在纯函数里（有单测）—— 这里只负责读写与报错
    const outcome = patchHostPortInSource(source, PORT_ENV_NAME);
    if (outcome.kind === "already") return;
    if (outcome.kind === "not-found") {
      throw new Error(
        "宿主里找不到 `--port` 后的端口字面量（Harness 版本可能已变化）。" +
          "为避免误改，已中止。" +
          `\n排查：检查 ${paths.hostEntry} 里是否还有 "--port" 参数；` +
          `若 Harness 改成用别的方式指定端口，请更新插件（这是插件与宿主的契约点）。`,
      );
    }
    await IOUtils.writeUTF8(paths.hostEntry, outcome.source);
    appendPanelLog(
      "runtime",
      `已把宿主端口改为读 ${PORT_ENV_NAME}（宿主原默认 ${outcome.hostDefault}）`,
    );
  }

  // ── 启动 / 停止 / 健康检查 ──────────────────────────────────

  /** 启动宿主。已就绪但未运行时调用；重复调用直接返回当前状态。 */
  async start(): Promise<RuntimeStatus> {
    if (this.status.phase === "running") return this.status;
    const paths = this.requirePaths();

    if (!(await this.isPrepared())) {
      const prepared = await this.prepare();
      if (prepared.phase !== "ready") return prepared;
    }
    // `findHarness` 现在返回 `{ location, checked }`（checked 供日志说明"试过哪些目录"）
    if (!this.harness) {
      const found = await findHarness(
        [this.readConfiguredHarnessDir(), ...harnessCandidates()].filter(
          (x): x is string => typeof x === "string",
        ),
      );
      this.harness = found?.location;
    }
    if (!this.harness) {
      const message = "找不到 DeepSeek Harness 安装，无法启动隔离运行时";
      this.setStatus({ phase: "no-harness", message });
      return this.status;
    }

    // ⚠️ 必须**先清理旧宿主，再选端口**（真机 bug：端口不断漂移 19400→19401→…）。
    //
    // 先前顺序相反，于是 `pickPort()` 看到旧宿主还占着 19400 → 退避到 19401，
    // 紧接着才 `killStaleHost()` 把旧宿主杀掉 —— 端口白白让出去了。
    // 下一轮又是同样的事，端口就一路往上爬，用户收藏/复制的链接随之失效。
    //
    // 为什么必须清理：`stop()` 在 Zotero 关闭时是"发出即忘"，不足以保证进程结束。
    await this.killStaleHost();
    // 清理后再等一小会儿：进程终止与端口释放有延迟，
    // 否则刚杀掉的端口仍显示"占用"，等于没修。
    await this.waitForPortRelease(
      Number(
        (Zotero.Prefs.get(
          `${addon.data.config.prefsPrefix}.isolatedPort`,
          true,
        ) as number | undefined) ?? DEFAULT_ISOLATED_PORT,
      ),
    );

    const port = await this.pickPort();
    this.setStatus({
      phase: "starting",
      message: `正在启动隔离 dsh（端口 ${port}）…`,
      port,
    });

    try {
      const child = await spawn({
        // 经代理启动：代理把宿主的 stdout 接过去，并把带 token 的 URL 写进
        // `launchUrlFile` —— 沙箱里直接读宿主 stdout 拿不到数据（实测 0 字节）。
        command: this.harness.nodeExe,
        args: [
          paths.launcherFile,
          paths.launchUrlFile,
          paths.hostEntry,
          paths.runtime,
          paths.profile,
          this.harness.primaryRuntime,
          this.harness.pnpmEntry,
          this.harness.runtimeBin,
        ],
        env: {
          DSH_HOME: paths.home,
          [PORT_ENV_NAME]: String(port),
        },
      });
      this.child = child;
      // 把实际使用的端口记进日志：先前因为环境变量没传进去，宿主退回写死端口，
      // 而日志里看不出这一点（只显示我们"以为"用的端口）。
      this.log(
        `已拉起宿主：node=${this.harness.nodeExe}；DSH_HOME=${paths.home}；${PORT_ENV_NAME}=${port}；PID=${child.pid ?? "?"}`,
      );

      // 宿主会把 `dsh web: http://127.0.0.1:<port>/?token=…` 打到 stdout。
      // 用带超时的轮询读取，避免一直阻塞。
      const launched = await this.waitForLaunch(child, port);
      if (!launched.ok) {
        child.kill();
        this.child = undefined;
        this.setStatus({ phase: "error", message: launched.error });
        return this.status;
      }

      await this.saveState({
        port,
        pid: child.pid,
        harnessDir: this.harness.installDir,
      });
      const healthy = await this.verifyHealth(port);
      if (!healthy) {
        child.kill();
        this.child = undefined;
        const message = `宿主已在端口 ${port} 就绪，但健康检查（session/list）失败；已结束该进程。`;
        this.setStatus({ phase: "error", message });
        this.log(message);
        return this.status;
      }
      this.setStatus({
        phase: "running",
        message: launched.tokenMissing
          ? `隔离 dsh 正在运行（端口 ${port}，PID ${child.pid ?? "?"}）；` +
            `但尚未拿到浏览器登录 token —— 会话功能正常，网页链接将在下次刷新时补齐`
          : `隔离 dsh 正在运行（端口 ${port}，PID ${child.pid ?? "?"}）`,
        port,
        pid: child.pid,
        token: launched.token,
        launchUrl: launched.url,
      });
      if (launched.tokenMissing) {
        this.log(
          "⚠️ 150 秒内没抓到带 token 的启动 URL：宿主打印它要等启动审计完成。" +
            "会话与问答不受影响；网页链接附件会在拿到 token 后自动更新。",
        );
      }
      return this.status;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus({ phase: "error", message: `启动失败：${message}` });
      return this.status;
    }
  }

  /**
   * 结束所有遗留的隔离宿主进程。
   *
   * ## 为什么不能只杀 state.json 里那一个（真机故障）
   *
   * 最初只清理记录中的单个 PID，而 `stop()` 在 Zotero 退出时是"发出即忘"、
   * 并不保证进程结束。结果**每次启动都泄漏一个宿主**：实测同时存在
   * 19400 / 19401 / 19402 / 19403 / 19405 五个孤儿进程，端口一路向上漂移。
   * 更糟的是插件状态仍记着旧端口，于是会话窗口连过去得到 ECONNREFUSED，
   * 而 XHR 无超时 → Promise 永不落地 → 界面永远停在"正在载入…"。
   *
   * 因此改为**按端口范围 + 进程命令行匹配**整体清理：
   * 只要命令行里出现我们的 runtime 路径，就是我们的宿主，一律结束。
   */
  private async killStaleHost(): Promise<void> {
    const state = await this.loadState();
    const recorded =
      typeof state.pid === "number" && state.pid > 0 ? state.pid : undefined;
    const targets = new Set<number>();
    if (recorded && this.child?.pid !== recorded) targets.add(recorded);

    const systemRoot = Services.env.get("SystemRoot") ?? "C:\\Windows";
    const taskkill = PathUtils.join(systemRoot, "System32", "taskkill.exe");
    const powershell = PathUtils.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );

    // 用 PowerShell 找出所有命令行含我们 runtime 路径的 node 进程。
    // 为什么用命令行匹配而不是"端口范围内的所有 node"：用户可能自己跑着 node，
    // 误杀代价太大；而 runtime 路径是我们独有的特征。
    try {
      const paths = this.requirePaths();
      // ⚠️ 用 `-EncodedCommand`（Base64）而不是 `-Command`（真机实测踩坑）。
      //
      // 为什么：脚本里需要 `-Filter "Name='node.exe'"` 这种**内层引号**，
      // 而把带引号的命令经 `-Command` 传给 `powershell.exe` 时，引号会在参数传递中
      // 被剥掉，命令退化成 `Get-CimInstance Win32_Process -Filter Name='node.exe'`
      // → WMI 报 `无效查询` → 枚举结果永远 0 个
      // → **残留宿主从来清理不掉** → 端口一直被占 → 端口漂移（真机同时存在 3 个残留宿主）。
      //
      // 试过把整条命令用单引号包裹，仍被剥（PowerShell 的参数绑定会先解析一层引号）。
      // `-EncodedCommand` 接收 Base64(UTF-16LE)，**完全绕开引号解析**，是最稳的做法。
      // ⚠️ 路径**不要**转义反斜杠（真机实测）。
      //
      // 这里踩过两个独立的坑，都会让枚举返回 0 个、残留宿主永远清理不掉：
      //  1. `-Filter "Name='node.exe'"` 经 `-Command` 传递时引号被剥 → WMI 报"无效查询"；
      //     改用 `-EncodedCommand` 解决。
      //  2. 曾把路径写成 `replace(/\\/g, "\\\\")` —— 那是**正则**的转义习惯，
      //     而 PowerShell 的 `-like` 里反斜杠是**字面量**：模式成了 `C:\\Users\\…`，
      //     与真实命令行（单反斜杠）永不匹配。实测：单反斜杠匹配 2 个，双反斜杠匹配 0 个。
      const script =
        `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ` +
        `Where-Object { $_.CommandLine -like '*${paths.runtime}*' } | ` +
        `ForEach-Object { $_.ProcessId }`;
      const found = await runToCompletion(
        {
          command: powershell,
          args: [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            encodePowerShellCommand(script),
          ],
        },
        15_000,
      );
      for (const line of found.stdout.split("\n")) {
        const pid = Number(line.trim());
        if (Number.isInteger(pid) && pid > 0 && pid !== this.child?.pid)
          targets.add(pid);
      }
      this.log(
        `遗留宿主枚举：找到 ${targets.size} 个候选 PID` +
          (found.stderr.trim()
            ? `（stderr：${found.stderr.trim().slice(0, 200)}）`
            : ""),
      );
    } catch (error) {
      this.log(
        `枚举遗留宿主失败（继续按记录的 PID 清理）：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (targets.size === 0) return;
    for (const pid of targets) {
      try {
        const result = await runToCompletion(
          {
            // ⚠️ 必须绝对路径：Gecko 的 Subprocess.call 不搜索 PATH
            command: taskkill,
            args: ["/PID", String(pid), "/T", "/F"],
          },
          10_000,
        );
        if (result.exitCode === 0) {
          this.log(`已结束遗留宿主进程 PID ${pid}`);
        } else {
          // 进程不存在是正常情况（上一次已清理），不当作错误刷屏
          const output = `${result.stdout}${result.stderr}`.trim();
          if (!/not found|没有找到|û���ҵ�/i.test(output)) {
            this.log(
              `清理遗留宿主 PID ${pid} 未成功（退出码 ${result.exitCode}）：${output.slice(0, 160)}`,
            );
          }
        }
      } catch (error) {
        this.log(
          `清理遗留宿主 PID ${pid} 异常：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    // 等端口真正释放，避免紧接着启动时撞上尚未退出的进程
    await new Promise((r) => setTimeout(r, 1200));
  }

  /**
   * 把模型侧凭据从桌面版 Harness 的 DSH_HOME（`~/.dsh`）复制进隔离实例。
   *
   * ## ⚠️ 这里原有一个 `dshHome` 偏好读取（已删）
   *
   * 原先写的是：
   *
   * ```js
   * const configured = Zotero.Prefs.get(`${prefsPrefix}.dshHome`, true);
   * const sourceHome = configured || defaultDshHome();
   * ```
   *
   * 但 `dshHome` 偏好**已随共享模式一起从 `prefs.js` 删除** ——
   * 于是 `configured` 恒为空串、`||` 右边恒生效，等于**每次都在读一个不存在的偏好**。
   * 这是最坏的一类残留：它不出错、不影响行为，只让后来者以为"这里还能配"。
   * 现在直接取平台默认（桌面版 Harness 的 DSH_HOME 就是 `~/.dsh`）。
   *
   * ## 凭据只在**宿主已生成自己的凭据**之后才合并
   *
   * 若宿主还没写 `.credentials.yaml` 就跳过（见下面的存在性检查）——
   * 这是**故意**的：合并的目标是宿主那份文件，早于它创建就没有合并对象。
   * 跳过时会记一条日志，否则表现为"问答失败但看不出原因"。
   */
  private async copyProviderCredentials(paths: RuntimePaths): Promise<void> {
    try {
      const sourceHome = defaultDshHome();
      const sourcePath = PathUtils.join(sourceHome, ".credentials.yaml");
      const targetPath = PathUtils.join(paths.home, ".credentials.yaml");
      if (!(await IOUtils.exists(targetPath))) {
        // 宿主尚未生成自己的凭据。原先是**静默** return —— 表现为"凭据没合进来、
        // 问答失败但日志里什么都看不到"，所以这里明确记一条。
        this.log(
          `宿主尚未生成凭据（${targetPath} 不存在），本次跳过凭据合并；` +
            "若问答失败请检查该文件是否出现。",
        );
        return;
      }

      const result = await mergeProviderCredentials(sourcePath, targetPath);
      logCredentialMerge(result, targetPath);
    } catch (error) {
      this.log(
        `模型凭据复制异常：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 健康检查：端口上是否**真的是我们的 dsh 宿主**在服务。
   *
   * ## 判据（真机故障修正）
   *
   * 最初用裸 XHR 调 `session/list` 并要求 HTTP 200 —— 但 dsh 要求认证，
   * 未带 cookie 的请求会返回 **401**。于是检查把**自己刚拉起来的好宿主判为失败并杀掉**
   * （日志实测：`启动结果：error —— 健康检查失败；已结束该进程`），
   * 连锁后果是工作区回退到共享 DSH_HOME、会话创建失败。
   *
   * 正确的判据是**"服务在响应"**而不是"认证通过"：
   *  - 200：认证也通过了，最好；
   *  - 401：宿主活着且是 dsh（这正是它的未认证响应），**算健康**；
   *  - 连不上 / 超时 / 其它状态：不健康。
   */
  private async verifyHealth(port: number): Promise<boolean> {
    try {
      const request = new XMLHttpRequest();
      request.open("POST", `http://127.0.0.1:${port}/api/session/list`, true);
      request.setRequestHeader("content-type", "application/json");
      request.timeout = 6_000;
      const body = JSON.stringify({
        type: "client-request",
        rpcId: `health-${Date.now()}`,
        method: "session/list",
        payload: { args: { _request: {} } },
      });
      return await new Promise<boolean>((resolve) => {
        let settled = false;
        const done = (ok: boolean) => {
          if (settled) return;
          settled = true;
          resolve(ok);
        };
        // 401 视为健康：服务在跑，只是这次请求没带凭据（本检查故意不带）
        request.onload = () =>
          done(request.status === 200 || request.status === 401);
        request.onerror = () => done(false);
        request.ontimeout = () => done(false);
        try {
          request.send(body);
        } catch {
          done(false);
        }
      });
    } catch {
      return false;
    }
  }

  /**
   * 等某个端口真正释放（进程被杀后端口不会立刻可用，最多等约 3 秒）。
   *
   * 为什么需要：`killStaleHost()` 用 `taskkill /F` 结束进程，而操作系统回收
   * 监听端口有短暂延迟。若紧接着就 `pickPort()`，会看到端口"仍被占用"而退避 ——
   * 那这次顺序修复就白做了。
   */
  private async waitForPortRelease(
    port: number,
    timeoutMs = 3000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.isPortInUse(port))) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    // 超时也继续：pickPort 会退避到下一个端口，不会因此失败
  }

  /**
   * 选监听端口：**优先用设置里的端口**，被别的程序占用才向上退避。
   *
   * 端口固定对用户有实际价值：会话附件里的链接、用户自己收藏的网页界面地址
   * 都指向 `127.0.0.1:<port>`，端口漂移会让它们失效。
   *
   * 注意：正常路径下到不了"退避"—— `start()` 已先清理旧宿主并等端口释放
   * （见那段注释，先前顺序相反导致端口一路往上爬）。
   */
  private async pickPort(): Promise<number> {
    const preferred = Number(
      (Zotero.Prefs.get(
        `${addon.data.config.prefsPrefix}.isolatedPort`,
        true,
      ) as number | undefined) ?? DEFAULT_ISOLATED_PORT,
    );
    const start =
      Number.isInteger(preferred) && preferred > 0
        ? preferred
        : DEFAULT_ISOLATED_PORT;
    for (let port = start; port < start + 20; port++) {
      if (!(await this.isPortInUse(port))) {
        this.log(
          port === start
            ? `使用设置里的固定端口 ${port}`
            : `端口 ${start} 被其它程序占用，退避到 ${port}（设置里可改「隔离端口」）`,
        );
        return port;
      }
    }
    this.log(`端口 ${start}–${start + 19} 全部被占用，仍尝试 ${start}`);
    return start;
  }

  /** 端口占用探测：能连上就认为被占用 */
  private isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value: boolean) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        const transport = new XMLHttpRequest();
        transport.open("GET", `http://127.0.0.1:${port}/`, true);
        transport.timeout = 800;
        transport.onload = () => done(true);
        transport.onerror = () => done(false);
        transport.ontimeout = () => done(false);
        transport.send();
        setTimeout(() => {
          try {
            transport.abort();
          } catch {
            // 忽略
          }
          done(false);
        }, 900);
      } catch {
        done(false);
      }
    });
  }

  /**
   * 等宿主打印启动行并取到 token。
   *
   * 这里**同时**做三件事，缺一不可（都来自真机故障）：
   *  1. 持续抓 stdout：宿主会把 `dsh web: http://127.0.0.1:<port>/?token=…` 打出来；
   *  2. 持续抓 stderr：子进程崩溃的原因只在这里，先前没开 pipe 导致完全看不到；
   *  3. 检测子进程是否**提前退出**：此时继续等端口是白等，要立刻报出退出码与输出。
   */
  /** 读代理写入的启动 URL（文件不存在或为空时返回 undefined） */
  private async readLaunchUrlFile(): Promise<
    { url: string; token: string } | undefined
  > {
    try {
      const paths = this.requirePaths();
      if (!(await IOUtils.exists(paths.launchUrlFile))) return undefined;
      const text = (await IOUtils.readUTF8(paths.launchUrlFile)).trim();
      if (!text) return undefined;
      const match = /https?:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/.exec(text);
      if (!match) return undefined;
      return { url: match[0], token: match[0].split("token=")[1] };
    } catch {
      return undefined;
    }
  }

  /**
   * 等宿主启动并抓取它打印的带 token URL。
   *
   * ## 为什么超时必须放宽到 150 秒（真机实测）
   *
   * `dsh web` 打印 URL 的条件不只是"端口就绪"：
   *
   * ```js
   * const settled = connectionCtx.get("loader")?.await();
   * else settled.then(async () => {
   *   await auditStartupEntries(connectionCtx.root, "dsh web", () => {});  // ← 先跑启动审计
   *   if (webServer && connection) announceReady();                        // ← 再打印
   * });
   * ```
   *
   * 本机有 4 个条目加载失败（含缺失的 `@deepseek-ai/libreoffice-kit`），
   * 审计要逐个处理，实测**超过 45 秒**才打印 —— 而旧超时正是 45 秒，
   * 于是"端口已就绪"却"没有 token"，网页链接附件被建成无 token 的
   * `http://127.0.0.1:<port>/`，用户双击看到认证失败（真机反馈）。
   *
   * ## 超时也不再算"启动失败"
   *
   * 端口已就绪即代表宿主可用（能建会话、能问答）；缺的只是浏览器登录用的 token。
   * 因此按 `ok: true` 返回并标注 `tokenMissing`，由调用方决定是否提示，
   * 而不是把整个运行时判为 error —— 那会连带影响会话功能。
   */
  private async waitForLaunch(
    child: SpawnedProcess,
    port: number,
  ): Promise<
    | { ok: true; token?: string; url?: string; tokenMissing?: boolean }
    | { ok: false; error: string }
  > {
    let output = "";
    let errors = "";
    let exited: number | undefined;
    let portSeen = false;
    let lastReport = 0;
    void child.wait().then((code) => {
      exited = code;
    });

    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      // 非阻塞抓取（readString 在管道关闭前会挂起，必须带超时）
      output += await child.drainStdout();
      errors += await child.drainStderr();

      // ⚠️ 真机结论：在 Zotero 沙箱里 **stdout 管道拿不到任何数据**
      // （实测 stdout 0 字节、stderr 1179 字节，而同一命令在 PowerShell 里 2 秒即有输出）。
      // 因此首选通道是**代理写的 URL 文件**，stdout 只作为兜底。
      const fromFile = await this.readLaunchUrlFile();
      if (fromFile)
        return { ok: true, token: fromFile.token, url: fromFile.url };

      const match = /https?:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/.exec(output);
      if (match)
        return { ok: true, token: match[0].split("token=")[1], url: match[0] };
      if (await this.isPortInUse(port)) {
        if (!portSeen) {
          portSeen = true;
          this.log(
            `端口 ${port} 已就绪，继续等待宿主打印带 token 的 URL（该打印发生在启动审计之后，可能较慢）…`,
          );
        }
      }
      // 每 10 秒记一次进度：这条日志能区分"慢但最终会打印"与"永远不打印"，
      // 否则只能看到 150 秒后的一句超时，无从判断。
      const waited = Date.now() - (deadline - 150_000);
      if (waited - lastReport >= 10_000) {
        lastReport = waited;
        this.log(
          `等待启动 URL 已 ${Math.round(waited / 1000)}s：stdout ${output.length} 字节，` +
            `stderr ${errors.length} 字节${output.trim() ? `，stdout 片段=${JSON.stringify(output.trim().slice(-160))}` : "（stdout 仍为空）"}`,
        );
      }
      if (exited !== undefined) {
        return {
          ok: false,
          error:
            `宿主启动后很快退出（退出码 ${exited}）。` +
            (errors.trim()
              ? `错误输出：${errors.trim().slice(0, 600)}`
              : "（没有错误输出）") +
            (output.trim() ? ` 标准输出：${output.trim().slice(0, 300)}` : ""),
        };
      }
      await new Promise((r) => setTimeout(r, 400));
    }

    // 超时：端口活着就算可用，只是没有 token
    if (portSeen) {
      return { ok: true, tokenMissing: true };
    }
    return {
      ok: false,
      error:
        `宿主在 150 秒内既没有就绪也没有打印带 token 的 URL（端口 ${port}未就绪）。` +
        (errors.trim() ? ` stderr：${errors.trim().slice(0, 600)}` : "") +
        (output.trim()
          ? ` stdout：${output.trim().slice(0, 300)}`
          : "（没有任何输出）"),
    };
  }

  /**
   * 停止宿主。
   *
   * 先 `kill()` 持有的句柄，再走一次 `killStaleHost()` —— 只 kill 句柄**不足以保证
   * 进程结束**（真机实测每次重启都留下孤儿，五个端口同时被占）。这里补一次按
   * 命令行匹配的兜底清理，并清空状态文件里的端口与 PID，避免下次误判"已在运行"。
   */
  async stop(): Promise<RuntimeStatus> {
    const child = this.child;
    this.child = undefined;
    if (child) {
      try {
        child.kill();
      } catch {
        // 已退出
      }
    }
    // 清状态**先于**兜底清理：否则 killStaleHost 会把刚杀的 PID 又"发现"一遍
    await this.saveState({ port: undefined, pid: undefined });
    try {
      await this.killStaleHost();
    } catch {
      // 兜底清理失败不应影响停止语义
    }
    this.setStatus({ phase: "stopped", message: "隔离 dsh 已停止" });
    return this.status;
  }

  /** 运行时是否由本插件持有（用于判断"是否需要启动"） */
  isRunning(): boolean {
    return this.status.phase === "running" && !!this.child;
  }

  /**
   * 当前记录的端口是否真的在服务。
   *
   * 供调用方在"状态显示 running 但进程其实已死"时探活 —— 真机出现过这种不一致
   * （宿主被结束而状态仍在内存里），下游表现为 `session not found` 或请求挂起。
   */
  async isRuntimeReachable(): Promise<boolean> {
    const port = this.status.port;
    if (!port) return false;
    return this.verifyHealth(port);
  }

  /** 连接信息：供桥接层使用（隔离实例的 baseUrl 与 authority） */
  getEndpoint(): { baseUrl: string; authority: string } | undefined {
    const port = this.status.port;
    if (!port) return undefined;
    return {
      baseUrl: `http://127.0.0.1:${port}`,
      authority: `127.0.0.1:${port}`,
    };
  }

  // ── 状态持久化 ──────────────────────────────────────────────

  private async saveState(state: PersistedState): Promise<void> {
    try {
      const paths = this.requirePaths();
      const previous = await this.loadState();
      await IOUtils.writeUTF8(
        paths.stateFile,
        JSON.stringify({ ...previous, ...state }, null, 2),
      );
    } catch {
      // 状态写入失败不影响运行
    }
  }

  async loadState(): Promise<PersistedState> {
    try {
      const paths = this.requirePaths();
      if (!(await IOUtils.exists(paths.stateFile))) return {};
      return JSON.parse(
        await IOUtils.readUTF8(paths.stateFile),
      ) as PersistedState;
    } catch {
      return {};
    }
  }
}

interface AsarNode {
  files?: Record<string, AsarNode>;
  /**
   * ⚠️ 类型故意标成宽松的 `number | string`：asar 头部里 offset 实际是**字符串**
   * （见 extractFromAsar 里的说明）。标成 number 会让 TS 认为无需转换，
   * 从而掩盖这个真实存在的坑。
   */
  offset?: number | string;
  size?: number | string;
}

/** 供自检/设置页显示的一句话摘要 */
export function describeRuntime(status: RuntimeStatus): string {
  const parts = [status.message];
  if (status.port) parts.push(`端口 ${status.port}`);
  if (status.pid) parts.push(`PID ${status.pid}`);
  return parts.join("；");
}

export { PROFILE_NAME, runToCompletion };
