/**
 * DSH Session 模型（用户确认的设计）。
 *
 * ## 设计意图
 *
 * "DSH Session 仿照 Zotero 笔记，可新建为独立会话或条目会话；
 *   独立会话的工作区为当前文库分类，条目会话的工作区为当前条目。"
 *
 * 因此两种会话：
 *  - **独立会话（collection）**：不绑定具体条目，工作区 = 当前文库分类；
 *  - **条目会话（item）**：绑定一个 Zotero 条目，工作区 = 该条目。
 *
 * ## 存储位置的取舍
 *
 * 会话记录存在**插件数据目录**里（`sessions.json`），会话内容本身由 dsh 保存。
 * 为什么不把会话做成 Zotero 笔记条目：那会让 dsh 的会话数据与 Zotero 的笔记数据
 * 两份真相、还要处理同步与删除；而用户确认的答复是"只要交互模型像笔记，
 * 存储仍由 dsh 侧负责"。
 *
 * 但**交互层面**我们模仿笔记：可以在「我的文库」或条目下看到会话列表、
 * 可以重命名、可以删除。
 */

import { appendPanelLog } from "./runLog";
// ⚠️ Gecko 只接受全反斜杠路径（真机实测，见 paths.ts 里 nativeSeparators 的说明）——
// 混合或全正斜杠会让 PathUtils.join 抛 NS_ERROR_FILE_UNRECOGNIZED_PATH。
import { nativeSeparators } from "./paths";

export type SessionKind = "collection" | "item";

export interface SessionRecord {
  /** dsh 会话 id（session-<uuid>） */
  sessionId: string;
  kind: SessionKind;
  /**
   * 绑定范围：
   *  - kind=item  → 条目 key（如 "2DCDQS5U"）
   *  - kind=collection → 分类 key；空字符串表示"我的文库"根
   */
  scopeKey: string;
  scopeLibraryID: number;
  /** 分类名或条目标题，仅用于界面显示 */
  scopeTitle: string;
  /**
   * 独立会话所属分类的**数字 id**（条目会话为空）。
   *
   * 为什么要单独记：Zotero 里**分类不是条目**，不能当顶层附件的父级，
   * 所以独立会话的附件只能是文库根下的顶层条目。把它加进这个分类，
   * 用户在自己的分类视图里才找得到它，而不是埋在条目堆里。
   */
  scopeCollectionID?: number;
  /** 会话标题（默认取首次提问，可重命名） */
  title: string;
  createdAt: number;
  updatedAt: number;
  /**
   * 该会话的工作区目录（= dsh 会话的 cwd，创建后不可更改）。
   *
   * ## ⚠️ 这是**读取时按当前机器推导**出来的，不要直接持久化使用
   *
   * 真机反馈：会话记录在跨设备同步后，里面存的绝对路径在另一台机器上**不存在**
   * （数据目录不同），会话就找不到工作区了。
   *
   * 现在这份值由 {@link resolveWorkspace} 在**每次读取记录时**从
   * 「当前的 workspaceRoot + kind + scopeKey」算出来 ——
   * 根目录换了，路径跟着换，记录本身不含任何机器相关信息。
   *
   * 落盘时仍会写这一列，但**只为兼容旧记录与人工排查**；
   * 唯一可信来源是 `kind` + `scopeKey`（两者都跨设备稳定：
   * 条目/分类的 key 由 Zotero 同步，与操作系统无关）。
   */
  workspace: string;
  /**
   * 挂载用的入口笔记 id（见 sessionPane.attachSessionNote）。
   * 会话正文仍由 dsh 保存，笔记只是"在 Zotero 里可见可点"的入口。
   */
  noteID?: number;
}

interface SessionFile {
  schema: "dsh-for-zotero/sessions/v1";
  version: 1;
  sessions: SessionRecord[];
}

const FILE_NAME = "sessions.json";

function emptyFile(): SessionFile {
  return { schema: "dsh-for-zotero/sessions/v1", version: 1, sessions: [] };
}

/** 会话记录文件路径（拿不到数据目录时返回 undefined） */ function storePath():
  | string
  | undefined {
  const dataDir = Zotero.DataDirectory?.dir;
  if (!dataDir) return undefined;
  return PathUtils.join(dataDir, "dsh-for-zotero", FILE_NAME);
}

/**
 * 会话记录的持久化（`<数据目录>/dsh-for-zotero/sessions.json`）。
 *
 * ## 为什么要内存缓存
 *
 * 这个 store 在会话页渲染、右键菜单、工具轮询里会被**高频读取**，
 * 每次都读盘既慢、又可能读到写了一半的内容。所以首次载入后驻留
 * `this.cache`，改动统一走 `persist()` 落盘。
 *
 * ## 两道防御（都是被真实故障逼出来的）
 *
 * - `load()` 对形状做检查：**文件被手工改坏时宁可空手开始**，也不要让整个功能崩掉；
 * - 读取失败一律回退到空集合，而不是抛异常 —— 会话列表读不出来时，
 *   插件其余部分仍应可用。
 *
 * ## ⚠️ 一条必须记住的约束：`workspace` 一旦写入就不再变
 *
 * dsh 会话的 `cwd` 在**创建那一刻固定**，之后改不了。所以记录里的 `workspace`
 * 是**不可变**的 —— 任何"把会话搬到另一个目录"的想法都不会成功，别在这上面
 * 花时间。这也是工作区按**范围**（分类 / 条目）而非按会话 id 命名的根本原因：
 * 同一分类下的多个会话共享一份材料，不必重复提取全文。
 */
/**
 * 把一条记录的 `workspace` 换成"当前机器上的"路径。
 *
 * **不改磁盘上的值**：修复只在读取时发生，落盘仍写创建时的路径。
 * 这样即使推导逻辑将来出问题，也不会把记录写坏 —— 读时修正是可逆的，
 * 写时改写是不可逆的，两者代价差很多。
 */
function withResolvedWorkspace(record: SessionRecord): SessionRecord {
  const resolved = resolveWorkspace(record);
  return resolved === record.workspace
    ? record
    : { ...record, workspace: resolved };
}

export class SessionStore {
  private cache: SessionFile | undefined;

  /** 读取全部记录（同步缓存，首次从磁盘载入） */
  private async load(): Promise<SessionFile> {
    if (this.cache) return this.cache;
    try {
      const path = storePath();
      if (!path || !(await IOUtils.exists(path))) {
        this.cache = emptyFile();
        return this.cache;
      }
      const parsed = JSON.parse(await IOUtils.readUTF8(path)) as SessionFile;
      // 形状防御：文件可能被手工改坏，宁可从空开始也不要让整个功能崩掉
      if (!parsed || !Array.isArray(parsed.sessions)) {
        this.cache = emptyFile();
        return this.cache;
      }
      this.cache = { ...emptyFile(), ...parsed };
      return this.cache;
    } catch {
      this.cache = emptyFile();
      return this.cache;
    }
  }

  private async persist(): Promise<void> {
    const path = storePath();
    if (!path || !this.cache) return;
    try {
      await IOUtils.makeDirectory(PathUtils.parent(path) ?? path, {
        ignoreExisting: true,
      });
      await IOUtils.writeUTF8(path, JSON.stringify(this.cache, null, 2));
    } catch (error) {
      appendPanelLog(
        "session",
        `会话记录写入失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 全部会话，按最近使用排序（`workspace` 已按当前机器解析） */
  async list(): Promise<SessionRecord[]> {
    const file = await this.load();
    return [...file.sessions]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(withResolvedWorkspace);
  }

  /** 某个范围下的会话（条目会话按条目 key；独立会话按分类 key + libraryID） */
  async listInScope(
    kind: SessionKind,
    scopeKey: string,
    libraryID: number,
  ): Promise<SessionRecord[]> {
    const all = await this.list();
    return all.filter(
      (s) =>
        s.kind === kind &&
        s.scopeKey === scopeKey &&
        s.scopeLibraryID === libraryID,
    );
  }

  async get(sessionId: string): Promise<SessionRecord | undefined> {
    const file = await this.load();
    const found = file.sessions.find((s) => s.sessionId === sessionId);
    return found ? withResolvedWorkspace(found) : undefined;
  }

  /** 新建或更新一条记录 */
  async upsert(record: SessionRecord): Promise<void> {
    const file = await this.load();
    const index = file.sessions.findIndex(
      (s) => s.sessionId === record.sessionId,
    );
    if (index >= 0)
      file.sessions[index] = {
        ...file.sessions[index],
        ...record,
        updatedAt: Date.now(),
      };
    else file.sessions.push(record);
    await this.persist();
  }

  /** 更新标题（重命名） */
  async rename(sessionId: string, title: string): Promise<void> {
    const file = await this.load();
    const record = file.sessions.find((s) => s.sessionId === sessionId);
    if (!record) return;
    record.title = title;
    record.updatedAt = Date.now();
    await this.persist();
  }

  /** 删除记录（不删除 dsh 侧会话数据，避免误删不可恢复） */
  async remove(sessionId: string): Promise<void> {
    const file = await this.load();
    file.sessions = file.sessions.filter((s) => s.sessionId !== sessionId);
    await this.persist();
  }

  /** 触达更新（提问/回答后调用，用于排序） */
  async touch(sessionId: string): Promise<void> {
    const file = await this.load();
    const record = file.sessions.find((s) => s.sessionId === sessionId);
    if (!record) return;
    record.updatedAt = Date.now();
    await this.persist();
  }
}

/** 进程内单例：多处（面板、菜单、标签页）都要读同一份记录 */
let storeInstance: SessionStore | undefined;
export function sessionStore(): SessionStore {
  storeInstance ??= new SessionStore();
  return storeInstance;
}

/**
 * 当前机器的工作区根目录提供者。
 *
 * ## 为什么要一个"提供者"而不是直接 import
 *
 * 根目录来自运行期配置（`<数据目录>/dsh-for-zotero/home/dsh-for-zotero`），
 * 而它**只在隔离宿主就绪后才存在**（未就绪时 `resolveRuntimeConfig()` 返回
 * undefined —— 不再回退到桌面版，见 config.ts 的说明）。
 *
 * 若在 `session.ts` 里直接 import 配置模块，就会形成
 * `session.ts → config.ts → session.ts` 的循环依赖；而且启动早期拿不到根目录时
 * **不能**因此报错（那时用户还没建会话，修复可以晚一点做）。
 *
 * 所以由 `sessionPane` 在启动维护时注入一个取值函数：拿不到就返回 undefined，
 * 此时 `resolveWorkspace` 退回记录里存的值（等于保持旧行为，不会更差）。
 */
let workspaceRootProvider: (() => string | undefined) | undefined;

/** 装配工作区根目录提供者（由 sessionPane 在启动时调用一次即可） */
export function setWorkspaceRootProvider(
  provider: () => string | undefined,
): void {
  workspaceRootProvider = provider;
}

/** 当前根目录；未装配或运行时未就绪时为 undefined */
function currentWorkspaceRoot(): string | undefined {
  try {
    return workspaceRootProvider?.();
  } catch {
    // 提供者内部任何异常都只意味着"现在拿不到"，不该影响读取会话
    return undefined;
  }
}

/**
 * 计算某条记录**在当前机器上**的工作区目录。
 *
 * ## 为什么必须"算"而不是"读"（跨设备同步，真机反馈）
 *
 * 原先 `record.workspace` 是**创建时算好的绝对路径**，直接持久化。
 * 这样一份 `sessions.json` 只在**那一台机器**上有效：换台机器（数据目录不同）
 * 之后，记录里的路径不存在，会话就失去工作区 —— 而 Zotero 的条目/分类本身
 * 是同步过来的，用户完全预期"会话也应该跟着走"。
 *
 * 关键事实是：**路径本来就可以推导**。
 *  - `workspaceFor(root, kind, scopeKey)` —— 目录名只由 kind 与 scopeKey 决定，
 *    而 scopeKey（Zotero 条目/分类 key）跨设备稳定；
 *  - 唯一与机器绑定的是**根目录**（`<数据目录>/dsh-for-zotero/...`）。
 *
 * 所以这里用当前的根目录重算。记录里那一列保留，仅用于两个目的：
 *  1. 迁移旧记录（从旧路径里取出目录名，见 `workspaceNameOf`）；
 *  2. 日志/界面显示时给出人来读的路径。
 *
 * @param record - 会话记录（至少要有 kind 与 scopeKey）
 */
export function resolveWorkspace(
  record: Pick<SessionRecord, "kind" | "scopeKey" | "workspace">,
): string {
  const root = currentWorkspaceRoot();
  if (!root) return record.workspace;
  return workspaceFor(root, record.kind, record.scopeKey);
}

/**
 * 从一条旧记录里取出它的**工作区目录名**（如 `item-2DCDQS5U`）。
 *
 * 迁移用：旧记录只有绝对路径，而目录名本身是稳定的（不含机器相关信息），
 * 所以可以用它拼到新的根目录上而不丢材料。
 *
 * 取不到时返回 undefined —— 调用方应回退到"按 kind/scopeKey 重新推一个"。
 */
export function workspaceNameOf(workspace: string): string | undefined {
  if (!workspace) return undefined;
  const parts = workspace.replace(/\\/g, "/").split("/");
  const name = parts[parts.length - 1];
  // 只接受我们自己生成的两种形态，避免把随便一个目录名当成工作区
  return /^(item|collection)-/.test(name) ? name : undefined;
}

/** 已尝试迁移过的工作区目录名（避免每次启动都重试重命名） */
const migratedNames = new Set<string>();

/**
 * 路径拼接（Windows 上产出**全反斜杠**）。
 *
 * ⚠️ 这里曾写着"只用 `/`；Zotero 在 Windows 上也接受" —— **那个前提是错的**。
 * 作者在运行中的 Gecko 上实测：`PathUtils.join` 对**混合分隔符**与**全正斜杠**
 * 都抛 `NS_ERROR_FILE_UNRECOGNIZED_PATH`，只有全反斜杠可用。
 *
 * 而这行正是混合路径的**源头**：它把 `C:\…\dsh-for-zotero`（反斜杠结尾）
 * 与目录名用 `/` 拼起来，产出的路径让 `startToolPoller` 抛错，
 * 于是**全库所有会话的工具桥一起失效**。
 *
 * 详见 `paths.ts` 里 `nativeSeparators` 的说明（含实测输出）。
 */
function joinPath(root: string, name: string): string {
  const trimmed = root.replace(/[/\\]+$/, "");
  const base = /^[A-Za-z]:[\\/]/.test(trimmed)
    ? trimmed.replace(/\//g, "\\")
    : trimmed;
  return `${base}/${name}`;
}

async function ioExists(path: string): Promise<boolean> {
  try {
    return await IOUtils.exists(path);
  } catch {
    return false;
  }
}

/** 把旧目录里的**子项**搬进新目录（旧目录本身留着，空着也无妨） */
async function ioMoveChildren(from: string, to: string): Promise<void> {
  const children = await IOUtils.getChildren(from);
  for (const child of children) {
    const name = PathUtils.filename(child);
    const dest = joinPath(to, name);
    if (await ioExists(dest)) continue; // 已有的不动（新机器上可能已生成）
    try {
      await IOUtils.move(child, dest);
    } catch {
      // 单个文件失败不影响其余（比如它正被别的进程占用）
    }
  }
}

/**
 * 解析工作区，并在需要时把**另一台机器上的同名目录搬过来**。
 *
 * ## 处理的是哪种情况（跨设备同步，用户反馈）
 *
 * 会话记录里存的是**创建那台机器**上的绝对路径。同步到另一台机器后根目录不同
 * （数据目录不同），但**最后一个目录名是稳定的**（`item-<条目key>` /
 * `collection-<分类key>`，见 `workspaceFor`）。
 *
 * 所以取旧路径的最后一段拼到当前根目录上，就得到"同一篇文献的工作区"：
 *  - 当前根目录下已有该目录 → 直接用（不覆盖）；
 *  - 还没有、而旧目录确实存在 → 把里面的材料搬过来。
 *
 * 搬而不是复制：旧目录的父路径属于另一台机器，这台机器不会再用它；
 * 而且论文全文、元数据、工具说明都在里面，重提取要再读一遍 PDF，代价不小。
 *
 * ## 顺带补建目录
 *
 * dsh 会话的 cwd 创建后固定；目录不存在时宿主的 shell 工具直接失败，
 * 那看起来像"Agent 坏了"。所以这里保证目录**一定存在**。
 */
export async function ensureWorkspaceDir(
  record: Pick<SessionRecord, "kind" | "scopeKey" | "workspace">,
): Promise<string> {
  const root = currentWorkspaceRoot();
  // ⚠️ 归一化分隔符：这个值会被传给 PathUtils.join（轮询器、传输层），
  // 而 Gecko 对混合/正斜杠路径一律抛 NS_ERROR_FILE_UNRECOGNIZED_PATH（真机实测）。
  const resolved = nativeSeparators(resolveWorkspace(record));
  if (!root) return resolved;

  const name = workspaceNameOf(resolved);
  const target = nativeSeparators(name ? joinPath(root, name) : resolved);

  try {
    if (await ioExists(target)) return target;
    await IOUtils.makeDirectory(target, {
      ignoreExisting: true,
      createAncestors: true,
    });

    const legacy = record.workspace;
    // `name` 为 undefined 时说明记录里的路径不是我们生成的形态（例如被人工改过），
    // 那就只能按 scopeKey 推出的路径用，不做迁移。
    if (
      name !== undefined &&
      legacy &&
      workspaceNameOf(legacy) === name &&
      legacy !== target &&
      !migratedNames.has(name) &&
      (await ioExists(legacy))
    ) {
      migratedNames.add(name);
      await ioMoveChildren(legacy, target);
      appendPanelLog(
        "session",
        `检测到工作区来自另一台机器，已迁移材料：${legacy} → ${target}`,
      );
    }
  } catch (error) {
    // 迁移失败不该阻断对话：目录已建出来，最坏是材料要重新生成
    appendPanelLog(
      "session",
      `工作区迁移失败（继续使用 ${target}）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return target;
}

/**
 * 会话的工作区目录。
 *
 * ## 为什么路径里**不含 sessionId**（真机 bug 修正）
 *
 * dsh 会话的 `cwd` 在 `session/create` 那一刻就固定了，**事后无法更改**。
 * 最初实现先造一个 `pending-<时间戳>` 路径去建会话、拿到 sessionId 后再算出
 * "最终"路径写进记录 —— 结果是**记录里的路径与 dsh 实际使用的工作区不一致**
 * （实测工作区目录名里赫然留着 `pending-1790962129769`），
 * 于是"条目会话的工作区 = 该条目"这个设计意图根本没生效。
 *
 * 现在改为**按范围确定路径**，与 sessionId 无关：
 *  - 条目会话 → `<root>/item-<条目key>`，即该文献的工作区；
 *  - 独立会话 → `<root>/collection-<分类key 或 root>`，即该分类的工作区。
 *
 * 同一文献的多个会话共享同一个工作区是**符合设计意图**的：论文全文、元数据这类
 * 材料本就属于该文献，重复缓存没有意义；而会话之间本来就通过 dsh 的 sessionId 隔离。
 */
export function workspaceFor(
  workspaceRoot: string,
  kind: SessionKind,
  scopeKey: string,
): string {
  const safeScope = scopeKey.replace(/[^A-Za-z0-9_-]/g, "_") || "root";
  // ⚠️ 先把 root 的分隔符归一：它来自 `dshHome`（带正斜杠），
  // 直接交给 PathUtils.join 会报 NS_ERROR_FILE_UNRECOGNIZED_PATH（真机实测）。
  const root = /^[A-Za-z]:[\\/]/.test(workspaceRoot)
    ? workspaceRoot.replace(/\//g, "\\")
    : workspaceRoot;
  return PathUtils.join(root, `${kind}-${safeScope}`);
}

/** 从首次提问生成一个可读标题 */
export function titleFromQuestion(question: string, maxLength = 40): string {
  const oneLine = question.replace(/\s+/g, " ").trim();
  if (!oneLine) return "未命名会话";
  return oneLine.length > maxLength
    ? `${oneLine.slice(0, maxLength)}…`
    : oneLine;
}
