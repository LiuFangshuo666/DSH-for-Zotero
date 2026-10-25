/**
 * ## 清理历史缓存：判断逻辑
 *
 * 这是整个功能里**唯一"有判断"的部分**，而删除不可逆 —— 所以它被抽成纯函数，
 * 脱离 Zotero 与文件系统单独测。
 *
 * 四条规则（都来自用户的原话）：
 *
 *  1. 条目/分类**已不存在** → 删该会话记录；
 *  2. 条目**在回收站里** → 按"**存在**"处理（用户明确要求）：它仍可还原；
 *  3. **侧栏里删过**的会话 → 记录清掉；
 *  4. 分类会话的 `scopeKey` 为空 = "我的文库"根 → **永不删**（它不对应任何具体分类）。
 *
 * 另外单测 `isManagedWorkspaceDirName`：删目录前靠它做**最后一道白名单**，
 * 判据错了就是把用户别的东西删掉。
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = await import(
  new URL(
    `file://${join(here, ".build", "unit-entry.mjs").replace(/\\/g, "/")}`,
  ).href
);
const {
  classifyRecords,
  gatherLiveScopes,
  isManagedWorkspaceDirName,
  describeCleanupPlan,
} = bundle;

/** 造一条最小可用的会话记录 */
const record = (patch) => ({
  sessionId: "session-1",
  kind: "item",
  scopeKey: "ABCD1234",
  scopeLibraryID: 1,
  scopeTitle: "某篇论文",
  title: "关于 X 的讨论",
  createdAt: 1,
  updatedAt: 2,
  workspace: "C:/w/item-ABCD1234",
  ...patch,
});

const sets = (itemKeys = [], collectionKeys = [], hidden = []) => ({
  live: {
    itemKeys: new Set(itemKeys),
    collectionKeys: new Set(collectionKeys),
  },
  hidden: new Set(hidden),
});

describe("清理历史缓存：判断", function () {
  it("条目还在 → 保留", function () {
    const out = classifyRecords({
      records: [record({})],
      ...sets(["ABCD1234"]),
    });
    assert.equal(out.doomed.length, 0);
    assert.equal(out.keep.length, 1);
  });

  it("条目不存在 → 删除（scope-missing）", function () {
    const out = classifyRecords({ records: [record({})], ...sets() });
    assert.equal(out.doomed.length, 1);
    assert.equal(out.doomed[0].reason, "scope-missing");
  });

  it("**条目在回收站里 → 保留**（用户要求按存在算）", function () {
    // 回收站里的条目仍可还原，只是被移出了文库视图。
    // 所以它出现在 itemKeys 里时，会话必须保留。
    const out = classifyRecords({
      records: [record({})],
      ...sets(["ABCD1234"]),
    });
    assert.equal(out.doomed.length, 0, "回收站条目的会话不应被清理");
    assert.equal(out.keep.length, 1);
  });

  it("分类不存在 → 删除；分类还在 → 保留", function () {
    const gone = classifyRecords({
      records: [record({ kind: "collection", scopeKey: "COLL1" })],
      ...sets(),
    });
    assert.equal(gone.doomed[0]?.reason, "scope-missing");

    const alive = classifyRecords({
      records: [record({ kind: "collection", scopeKey: "COLL1" })],
      ...sets([], ["COLL1"]),
    });
    assert.equal(alive.doomed.length, 0);
  });

  it("**分类会话的 scopeKey 为空（我的文库根）永不删**", function () {
    const out = classifyRecords({
      records: [record({ kind: "collection", scopeKey: "" })],
      ...sets(),
    });
    assert.equal(out.doomed.length, 0);
    assert.equal(out.keep.length, 1);
  });

  it("**侧栏里删过的会话 → 删除**，哪怕指向的条目还在", function () {
    const out = classifyRecords({
      records: [record({})],
      ...sets(["ABCD1234"], [], ["session-1"]),
    });
    assert.equal(out.doomed.length, 1);
    assert.equal(out.doomed[0].reason, "sidebar-deleted");
  });

  it("doomed 里带上标题与原因，便于界面展示", function () {
    const out = classifyRecords({ records: [record({})], ...sets() });
    assert.equal(out.doomed[0].title, "关于 X 的讨论");
    assert.equal(out.doomed[0].kind, "item");
    assert.equal(out.doomed[0].sessionId, "session-1");
  });

  it("空记录列表不炸", function () {
    const out = classifyRecords({ records: [], ...sets() });
    assert.deepEqual(out.doomed, []);
    assert.deepEqual(out.keep, []);
  });
});

describe("收集「还活着」的范围（回收站语义）", function () {
  const byKey = (map) => (libraryID, key) => map[key];

  it("**回收站里的条目也算存在**（用户明确要求）", function () {
    // 这条规则来自用户的一次改动：原来按"不存在"算，现在按"存在"算。
    // 它决定了"删还是不删"，所以必须有测试。
    const { live } = gatherLiveScopes([record({})], {
      getItem: byKey({ ABCD1234: { deleted: true } }),
      getCollection: byKey({}),
    });
    assert.equal(
      live.itemKeys.has("ABCD1234"),
      true,
      "deleted=true 的条目也必须进 itemKeys —— 它只是被移进了回收站，仍可还原",
    );
  });

  it("真的查不到才算不存在", function () {
    const { live } = gatherLiveScopes([record({})], {
      getItem: byKey({}),
      getCollection: byKey({}),
    });
    assert.equal(live.itemKeys.has("ABCD1234"), false);
  });

  it("查询抛错时按**存在**处理（宁可留残骸，不可误删）", function () {
    const { live } = gatherLiveScopes([record({})], {
      getItem: () => {
        throw new Error("boom");
      },
      getCollection: byKey({}),
    });
    assert.equal(
      live.itemKeys.has("ABCD1234"),
      true,
      "单条查询失败不能把这条会话判成可删",
    );
  });

  it("分类同理：存在才算，scopeKey 为空直接跳过", function () {
    const { live } = gatherLiveScopes(
      [
        record({ kind: "collection", scopeKey: "COLL1" }),
        record({ kind: "collection", scopeKey: "" }),
      ],
      { getItem: byKey({}), getCollection: byKey({ COLL1: {} }) },
    );
    assert.equal(live.collectionKeys.has("COLL1"), true);
    assert.equal(live.collectionKeys.has(""), false, "文库根不应进集合");
  });
});

describe("工作区目录名白名单", function () {
  it("只认插件自己生成的形态", function () {
    assert.equal(isManagedWorkspaceDirName("item-ABCD1234"), true);
    assert.equal(isManagedWorkspaceDirName("collection-LVQYAJKD"), true);
    assert.equal(isManagedWorkspaceDirName("item-a_b-c"), true);
  });

  it("**拒绝任何可能越界的名字**（删目录前的最后一道闸）", function () {
    for (const bad of [
      "..",
      ".",
      "item-../etc",
      "item-..",
      "item-",
      "item",
      "foo",
      "item-ABCD/../x",
      "item-AB CD", // 空格
      "/item-ABCD",
      "C:\\item-ABCD",
      "item-ABCD1234/sub",
    ]) {
      assert.equal(
        isManagedWorkspaceDirName(bad),
        false,
        `必须拒绝这个名字：${JSON.stringify(bad)}`,
      );
    }
  });
});

describe("清理计划的可读描述", function () {
  it("没有可清理项时明确说「没有」，并报出保留数", function () {
    const text = describeCleanupPlan({
      doomed: [],
      keptCount: 7,
      workspaceDirs: [],
      workspaceReason: [],
      pendingDropped: 0,
    });
    assert.match(text, /没有可清理的内容/);
    assert.match(text, /7/);
  });

  it("有内容时列出数量与示例", function () {
    const text = describeCleanupPlan({
      doomed: [
        {
          sessionId: "session-1",
          title: "关于 X 的讨论",
          kind: "item",
          reason: "scope-missing",
        },
      ],
      keptCount: 3,
      workspaceDirs: ["C:\\w\\item-ABCD1234"],
      workspaceReason: ["会话已清理"],
      pendingDropped: 2,
    });
    assert.match(text, /会话记录 1 条/);
    assert.match(text, /条目\/分类已不存在 1/);
    assert.match(text, /工作区目录 1 个/);
    assert.match(text, /待确认项 2 条/);
    assert.match(text, /关于 X 的讨论/);
    assert.match(text, /item-ABCD1234/);
  });
});
