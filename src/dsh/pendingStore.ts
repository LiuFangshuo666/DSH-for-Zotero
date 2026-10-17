/**
 * 待确认项的**持久化**。
 *
 * ## 为什么必须有（真机事故：重启丢掉 22 条待确认）
 *
 * 2026-10-17：批量确认 28 条新条目，卡在第 7 条的 PDF 下载（约 8 分钟没返回），
 * 用户重启 Zotero 解卡 —— 然后发现**剩下 22 条待确认全部消失**。
 *
 * 根因：`SessionPane.pendingDeletions` 只是**进程内数组**，没有任何落盘。
 * 于是插件重启、Zotero 崩溃、用户关掉窗口，都会让用户**已经批准的意图**蒸发。
 *
 * 而这不是"少了个便利功能"：那 22 条是 Agent 已经查好 DOI、字段、作者、
 * 分类的结果，重建它们的成本是**一次完整的检索**（真机上花了 10 分钟）。
 *
 * ## 语义边界（重要的两条）
 *
 * 1. **只有"待确认"被持久化** —— 已执行的结果不在这里（那是 `confirm-log.json`）。
 *    所以恢复后用户看到的是"当时还没确认的"，不会重复执行已完成的。
 * 2. **恢复时不校验会话是否还在** —— 会话可能被用户删了，但待确认项仍是
 *    用户真实表达过的意图。让它在列表里出现（并允许确认或忽略）比静默丢弃好；
 *    执行时找不到会话会给出明确原因。
 *
 * ## 与 `sessions.json` 同构
 *
 * 同一个目录（`<数据目录>/dsh-for-zotero/`）、同一套防御式读写：
 * 文件损坏时**宁可空手开始**，也不要让整个插件崩掉；
 * 读取失败一律回退空集合（待确认列表读不出来时，其余功能仍应可用）。
 */
import { appendPanelLog } from "./runLog";

/** 一条待确认项（形状必须与 `SessionPane.pendingDeletions` 完全一致） */
export interface PendingItem {
  /** 永不变的身份（界面与插件都用它定位，而不是用会变的下标） */
  uid: string;
  sessionId: string;
  op: string;
  keys: string[];
  requestedAt: string;
  /** 新建条目 / 结构性改动的参数 */
  payload?: Record<string, unknown>;
  /** 给用户看的一句话描述 */
  summary?: string;
}

interface PendingFile {
  schema: "dsh-for-zotero/pending/v1";
  version: 1;
  items: PendingItem[];
}

const FILE_NAME = "pending-confirmations.json";

function emptyFile(): PendingFile {
  return { schema: "dsh-for-zotero/pending/v1", version: 1, items: [] };
}

/** 文件路径（拿不到数据目录时返回 undefined —— 此时持久化被静默跳过） */
function storePath(): string | undefined {
  const dataDir = Zotero.DataDirectory?.dir;
  if (!dataDir) return undefined;
  return PathUtils.join(dataDir, "dsh-for-zotero", FILE_NAME);
}

/**
 * 校验一条从磁盘读回来的记录。
 *
 * 为什么要逐字段校验而不是 `as PendingItem`：这份文件是**用户可编辑**的
 * （就在数据目录里，谁都能打开改）。一条畸形的项混进来会让确认流程
 * 在半个小时后崩在某个意料之外的地方 —— 那时已经很难联想到这里。
 */
function validItem(value: unknown): value is PendingItem {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.uid === "string" &&
    v.uid.length > 0 &&
    typeof v.sessionId === "string" &&
    v.sessionId.length > 0 &&
    typeof v.op === "string" &&
    v.op.length > 0 &&
    Array.isArray(v.keys) &&
    v.keys.every((k) => typeof k === "string") &&
    typeof v.requestedAt === "string"
  );
}

export class PendingStore {
  /** 内存缓存：首次载入后驻留，改动统一走 `persist()` 落盘 */
  private cache?: PendingItem[];

  /** 读出全部待确认项（读不到返回空数组，**不抛**） */
  async load(): Promise<PendingItem[]> {
    if (this.cache) return this.cache;
    const path = storePath();
    if (!path) {
      this.cache = [];
      return this.cache;
    }
    try {
      if (!(await IOUtils.exists(path))) {
        this.cache = [];
        return this.cache;
      }
      const text = await IOUtils.readUTF8(path);
      const parsed = JSON.parse(text) as Partial<PendingFile>;
      if (
        parsed.schema !== "dsh-for-zotero/pending/v1" ||
        !Array.isArray(parsed.items)
      ) {
        appendPanelLog(
          "session",
          "待确认项文件形状不对（schema 或 items 不匹配），已忽略并从空开始",
        );
        this.cache = [];
        return this.cache;
      }
      const items = parsed.items.filter(validItem);
      if (items.length !== parsed.items.length) {
        appendPanelLog(
          "session",
          `待确认项文件里有 ${parsed.items.length - items.length} 条形状不合法，已跳过`,
        );
      }
      this.cache = items;
      return items;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendPanelLog("session", `读取待确认项失败（从空开始）：${message}`);
      this.cache = [];
      return this.cache;
    }
  }

  /** 覆盖写入（调用方保证 `items` 就是当前真实列表） */
  async save(items: PendingItem[]): Promise<void> {
    this.cache = items;
    const path = storePath();
    if (!path) return;
    try {
      const parent = PathUtils.parent(path);
      if (parent) {
        await IOUtils.makeDirectory(parent, {
          ignoreExisting: true,
          createAncestors: true,
        });
      }
      const file: PendingFile = {
        schema: "dsh-for-zotero/pending/v1",
        version: 1,
        items,
      };
      await IOUtils.writeUTF8(path, `${JSON.stringify(file, null, 2)}\n`);
    } catch (error) {
      /**
       * ⚠️ **写失败必须记日志，但不能让调用方失败。**
       *
       * 待确认项落不了盘是可惜（重启会丢），但"确认按钮点了没反应"更糟 ——
       * 那会让人以为功能坏了。所以这里吞掉错误，只留痕迹。
       * 恢复能力属于"更好"，可用性属于"必须有"。
       */
      const message = error instanceof Error ? error.message : String(error);
      appendPanelLog(
        "session",
        `写入待确认项失败（本次改动未持久化）：${message}`,
      );
    }
  }

  /**
   * 清空（`clear()` 只清缓存；要连磁盘一起清用 `clearAll()`）。
   *
   * 拆成两个是为了让"测试里重置"不必碰用户的真实文件。
   */
  clearCache(): void {
    this.cache = undefined;
  }
}

let storeInstance: PendingStore | undefined;

export function pendingStore(): PendingStore {
  storeInstance ??= new PendingStore();
  return storeInstance;
}
