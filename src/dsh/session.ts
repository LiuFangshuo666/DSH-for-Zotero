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
  /** 该会话的工作区目录（= dsh 会话的 cwd，创建后不可更改） */
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

/** 会话记录文件路径（拿不到数据目录时返回 undefined） */
function storePath(): string | undefined {
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

  /** 全部会话，按最近使用排序 */
  async list(): Promise<SessionRecord[]> {
    const file = await this.load();
    return [...file.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
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
    return file.sessions.find((s) => s.sessionId === sessionId);
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
  return PathUtils.join(workspaceRoot, `${kind}-${safeScope}`);
}

/** 从首次提问生成一个可读标题 */
export function titleFromQuestion(question: string, maxLength = 40): string {
  const oneLine = question.replace(/\s+/g, " ").trim();
  if (!oneLine) return "未命名会话";
  return oneLine.length > maxLength
    ? `${oneLine.slice(0, maxLength)}…`
    : oneLine;
}
