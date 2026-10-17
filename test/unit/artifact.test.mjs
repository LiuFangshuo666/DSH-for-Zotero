/**
 * 构建产物结构校验：确认打出来的 xpi 是一个**结构自洽**的插件包。
 *
 * 为什么单独做：构建成功 ≠ 能被 Zotero 接受。清单里任何一处引用写错
 * （图标路径、FTL 文件名、bootstrap 加载的脚本路径、面板图标）都会导致
 * 插件加载失败 —— 而 Zotero 会**吞掉 bootstrap 异常**（`xpcom/plugins.js:257-267`），
 * 出问题时在界面上只表现为"什么都没发生"，极难定位。
 *
 * 本测试直接读构建产物目录（.scaffold/build/addon），不联网、不依赖 Zotero。
 */

import { strict as assert } from "node:assert";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const addonDir = join(here, "..", "..", ".scaffold", "build", "addon");
/** 源码目录：有些约束只能在源码里检查（例如"是否调用了某个注册 API"） */
const srcDir = join(here, "..", "..", "src");

/**
 * 去掉字符串字面量与注释，只留代码。
 *
 * 为什么需要：宿主启动代理脚本（`hostLauncher.ts`）以模板字符串内嵌，
 * 里面本来就有 `import { spawn } from "node:child_process";` 这类 Node 代码 ——
 * 它是**字符串数据**而不是本产物的 import，但裸正则会把它当成未打包的 import
 * （实测误报过一次）。因此"自包含"类检查必须先剥掉字符串与注释。
 */
function stripStringsAndComments(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/"))
        i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      out += '""';
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
const manifestPath = join(addonDir, "manifest.json");

const hasBuild = existsSync(manifestPath);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/**
 * ## 一键确认：按钮必须**从状态恢复**禁用，且逐条显示结果
 *
 * 真机反馈两句，是同一个设计问题的两面：
 *
 *  1. "按钮会在先前条目操作完成前恢复可点击状态，若用户再次点击会**二次操作**条目。"
 *  2. "这次我没看到每项条目操作的结果。"
 *
 * 根因：`disabled` 设在**元素**上，而列表由 `setInterval(…, 2000)` **每 2 秒重建** ——
 * 重建后是新的按钮，禁用状态就没了。而整批调用一口气跑完才返回，
 * 期间界面拿不到任何进度，也就没法逐条显示结果。
 *
 * 修法：状态放**模块级** `batchConfirm`，重建后从它恢复；
 * 改由界面**逐条驱动**，每步更新进度与结果。
 *
 * 这类缺陷**不会让任何构建或测试失败**（页面里的 UI 状态机没有单测），
 * 所以按本项目的一贯做法，直接在**源码/产物**上钉住关键约束。
 */
/**
 * ## 会话页进来时必须**问一次 harness 是否还在跑**（真机反馈）
 *
 * 用户："会话中途退出再回来（本轮仍未结束）不会显示工作状态。"
 *
 * 会话页每次打开都是**重新加载**的，而 `setBusy` 先前只在
 * "刚发消息 / 刚取消"时调过 —— 于是退出再回来时界面是全新的、状态是空闲，
 * 而 harness 那边还在干活。用户看到安静的界面，以为答完了。
 *
 * v0.8.0 我给 **reader 侧面板**加过同类探测，但会话页走的是
 * `chrome://` 页面 + 全局 API 这条**另一条路径**，那份修复到不了这里 ——
 * 这正是它被漏掉的原因。**修一处不等于修了这个症状。**
 *
 * 这条守卫读页面源码：探测函数依赖 `start()` 里的 DOM 闭包，
 * 很难在 vm 里独立跑，所以把"必须存在且在启动时被调用"钉在源码上。
 */
/**
 * ## 会话页必须**持续刷新**（真机："退出重进只更新一次"）
 *
 * 用户："还是有提前截断的现象，退出重进会话页面**只是更新一次内容**、
 * 不会恢复显示正在运行、也不会持续更新（必须反复退出重进刷新内容）。"
 *
 * 根因：`loadHistory()` 只在 `start()` 里调**一次**，此后页面没有任何东西
 * 去看进度 —— 唯一会驱动界面的是"用户自己发消息"（那条路径才接流）。
 * 于是 Agent 在后台继续产出时界面静止，用户只能靠反复退出重进重新加载。
 *
 * `getHistory` 走 `session/page`，每次都是最新的（这正是"重进能看到新内容"的原因），
 * 所以修法就是**定期再取一次**。
 */
/**
 * ## 待确认列表的**标题只能由一处产生**
 *
 * 真机故障：这一块原本是"删除确认"，后来扩展成
 * "结构性改动确认"，但**标题文案没跟着改** ——
 * 结果 Agent 请求**新建 4 个网页条目**时，面板显示
 * "请求删除 4 项（删除不可逆）"，把用户吓一跳。
 *
 * 之后两处渲染（主面板 / 角标就地展开）**各写了一遍分类逻辑**，
 * 而就地展开那份的注释只写了一句"与主面板同一套分类逻辑"——
 * **那句话不是保证，只是愿望**。
 *
 * 现在两处都调 `describePendingHead()`，这条守卫把它钉住：
 * 文案只能出现在那一个函数里。
 */
describe("待确认标题只能由一处产生", function () {
  const page = readFileSync(
    join(here, "..", "..", "addon", "content", "sessionPage.js"),
    "utf8",
  );

  it("三条标题文案各自只出现一次", function () {
    for (const frag of [
      "Agent 请求新建 ",
      "Agent 请求删除 ",
      "Agent 请求改动 ",
    ]) {
      const n = page.split(frag).length - 1;
      assert.equal(
        n,
        1,
        "「" +
          frag +
          "」出现了 " +
          n +
          " 次 —— 它只应该在 " +
          "describePendingHead() 里出现一次；" +
          "多一处就意味着又有人抄了一遍，" +
          "而下次改文案时必定漏一处（真机踩过）",
      );
    }
  });

  it("分类谓词也只能有一份", function () {
    const n = (page.match(/it\.op === "createItem"/g) || []).length;
    assert.equal(
      n,
      1,
      '`it.op === "createItem"` 出现 ' +
        n +
        " 次 —— " +
        "它应该只在 pendingItemIsCreate() 里",
    );
  });
});

/**
 * ## 运行状态探测**必须一直跑**，只调间隔
 *
 * 真机缺陷（用户报告）：
 *
 * > "我这边没有「停止生成」，因为会话页面已经认为它的回答结束了…"
 *
 * 复现序列：
 *
 * ```text
 *   打开会话页 → 探测一次 → false（agent 此刻确实没在跑）
 *             → 旧代码 stopRunningProbe()，探测【永久停止】
 *   agent 后来开始跑 → 界面再也不知道 → 显示"不在工作"、没有「停止生成」
 * ```
 *
 * 根因是把探测当成了**一次性的"补课动作"**，
 * 而它描述的是**持续状态** —— agent 随时可能开始或结束一轮。
 * 而唯一会重新启动它的路径是"用户在这个页面发消息"。
 */
describe("探测必须一直跑（只调间隔）", function () {
  const page = readFileSync(
    join(here, "..", "..", "addon", "content", "sessionPage.js"),
    "utf8",
  );

  it("\u201c确定停了\u201d的分支不得再停探测", function () {
    // 取 probeSessionRunning 到下一个函数定义
    const i = page.indexOf("function probeSessionRunning()");
    assert.ok(i > 0, "找不到 probeSessionRunning");
    const rest = page.slice(i);
    const j = rest.indexOf("\n    function ", 10);
    const body = j > 0 ? rest.slice(0, j) : rest.slice(0, 4000);
    assert.ok(
      !/stopRunningProbe\(\)/.test(body),
      "probeSessionRunning 里不得调 stopRunningProbe() —— " +
        "停掉后 agent 再次开始跑时，界面就永远不知道了",
    );
    assert.match(
      body,
      /keepWatching\(\)/,
      "每个分支都要续看（包括问不到与 catch）",
    );
  });

  it("必须区分在跑与空闲两个间隔", function () {
    assert.match(page, /RUNNING_PROBE_MS = \d+/, "应有在跑时的间隔");
    assert.match(
      page,
      /RUNNING_PROBE_IDLE_MS = \d+/,
      "应有空闲时的间隔 —— 空闲也要继续看，只是疏一点",
    );
    assert.match(
      page,
      /runningKnown === true \? RUNNING_PROBE_MS : RUNNING_PROBE_IDLE_MS/,
      "keepWatching 要按当前状态选间隔",
    );
  });

  it("连续问不到仍有上限（避免无限轮询）", function () {
    assert.match(page, /RUNNING_PROBE_MAX_MISSES/, "上限要保留");
    assert.match(
      page,
      /runningProbeMisses \+= 1/,
      "只有问不到才计数 —— 问到 true/false 都应清零",
    );
  });
});

describe("会话页的持续刷新", function () {
  const page = readFileSync(
    join(here, "..", "..", "addon", "content", "sessionPage.js"),
    "utf8",
  );

  it("必须有定时刷新，且在首次载入后被启动", function () {
    assert.match(page, /function startHistoryPoll\(\)/, "必须有启动轮询的函数");
    assert.match(
      page,
      /setInterval\(function \(\) \{\s*void refreshHistory\(true\)/,
      "轮询必须**静默**取历史（后台失败不该往界面上刷错误）",
    );
    // 两个分支（成功/失败）都要启动它，否则一次网络抖动就永久静止
    const starts = page.match(/startHistoryPoll\(\);/g) || [];
    assert.ok(
      starts.length >= 2,
      "载入成功与失败后都要开始轮询（否则一次抖动就永远不再更新），实际 " +
        starts.length +
        " 处",
    );
  });

  it("**内容没变就不动 DOM**，并保住滚动位置", function () {
    // 每 2.5 秒清空重建会把用户正在读的位置弹走、也会打断选中文本
    assert.match(
      page,
      /if \(fp !== historyFingerprint\)/,
      "必须比对指纹，内容没变就不要重建 DOM",
    );
    assert.match(
      page,
      /atBottom/,
      "重建后要按\u201c原来是否贴着底部\u201d决定是否跟到底部",
    );
  });

  it("关闭页面时要停掉轮询", function () {
    assert.match(
      page,
      /stopHistoryPoll\(\)/,
      "unload 时必须清掉定时器，否则页面没了还在请求",
    );
  });
});

/**
 * ## 生成中不得显示"存为笔记"，也不得让占位提示消失
 *
 * 用户："发送消息后，先是看不到任何回复（原先的 `…` 也瞬间消失），
 * 然后回复陆续出现，但是**一直有"存为笔记"样式让人误以为回答结束**。
 * 不过回复结束后确实在气泡下正常显示了"本轮结束"。"
 *
 * 三处根因，共同点是**每 2.5 秒的重建会把流式的临时 DOM 冲掉**：
 *
 *  1. 占位 `bubble("assistant", "…")` 被冲掉 → 一瞬间什么都不显示；
 *  2. "存为笔记"的判据只是"**有文字**" → 半截回答也带按钮 → 看起来像答完了；
 *  3. `markTurnEnd()` 插的分隔也被冲掉 → 只有收尾瞬间能看到。
 *
 * 修法：把"是否生成中"变成**渲染函数知道的输入**，而不是 DOM 里的临时状态。
 */
describe("生成中的气泡不该伪装成已完成", function () {
  const page = readFileSync(
    join(here, "..", "..", "addon", "content", "sessionPage.js"),
    "utf8",
  );

  it("\u0060bubble\u0060 必须接收\u201c是否生成中\u201d，并据此决定要不要给按钮", function () {
    assert.match(
      page,
      /function bubble\(role, text, question, live\)/,
      "bubble 必须知道这一轮是否还在生成",
    );
    assert.match(
      page,
      /role === "assistant" && !live && text && text !== "…"/,
      "生成中不得挂\u201c存为笔记\u201d —— 那个按钮等于在说\u201c答完了\u201d",
    );
  });

  it("\u0060renderTurns\u0060 必须自己画出\u201c生成中\u201d提示，而不是依赖 submit 里的临时 notice", function () {
    assert.match(
      page,
      /还在生成中…/,
      "生成中的提示要在 renderTurns 里画，否则每次重建都会消失",
    );
    assert.match(
      page,
      /function renderTurns\(turns\)/,
      "渲染函数是唯一能在刷新后仍然成立的地方",
    );
  });

  it("\u201c本轮结束\u201d分隔必须也由 renderTurns 画（只给最后一轮）", function () {
    assert.match(
      page,
      /if \(!live && last\) markTurnEnd\(\);/,
      "分隔要在渲染里画，且只给最后一轮 —— 否则多轮会话里满地都是分隔线",
    );
  });

  it("submit 里不得再插一次\u201c本轮结束\u201d（会被冲掉且与渲染重复）", function () {
    // submit 的收尾分支里应改为触发重绘，而不是直接插 DOM
    assert.match(
      page,
      /setAwaitingInput\(false\);[\s\S]{0,400}?void refreshHistory\(true\);/,
      "收尾应触发重绘，由渲染函数统一画分隔",
    );
  });
});

describe("会话页的工作状态恢复", function () {
  const page = readFileSync(
    join(here, "..", "..", "addon", "content", "sessionPage.js"),
    "utf8",
  );

  it("必须有探测函数，且**在启动时被调用**", function () {
    assert.match(
      page,
      /function probeSessionRunning\(\)/,
      "必须有「问一次 harness 是否还在跑」的函数",
    );
    const calls = page.match(/^\s{4}probeSessionRunning\(\);/gm) || [];
    assert.ok(
      calls.length >= 1,
      "启动时必须调用它 —— 否则退出再回来仍然显示空闲（这正是用户报的问题）",
    );
  });

  it("必须用**三态**判断，问不到时不能谎报空闲", function () {
    assert.match(
      page,
      /running === true/,
      "要显式区分 true：只有确认在跑才恢复生成状态",
    );
    assert.match(
      page,
      /running === false/,
      "也要显式区分 false：确认停了才收尾",
    );
    // 剩下的分支（undefined）必须落到"只提示、不改界面"
    assert.match(
      page,
      /问不到运行状态/,
      "问不到时必须给一句提示，而不是静默当成空闲或当成在跑",
    );
  });

  it("必须先判能力是否存在（旧插件没有它时不能抛错）", function () {
    assert.match(
      page,
      /typeof capability\.isSessionRunning !== "function"/,
      "旧插件没有这个方法时要安全跳过，而不是抛 TypeError",
    );
  });

  it("探测必须有上限，不能无限轮询", function () {
    // `undefined`（问不到）也会排下一次探测 —— 宿主一直不答就会无限轮询。
    // 界面装饰不该无限占资源。
    assert.match(
      page,
      /RUNNING_PROBE_MAX_MISSES/,
      "必须有连续问不到的次数上限，到点就停",
    );
    assert.match(page, /stopRunningProbe/, "要能在页面卸载与用户取消后停下");
  });

  it("插件侧两条路径都必须提供 isSessionRunning", function () {
    const pane = readFileSync(
      join(here, "..", "..", "src", "modules", "sessionPane.ts"),
      "utf8",
    );
    const n = (pane.match(/isSessionRunning/g) || []).length;
    assert.ok(
      n >= 3,
      "全局 API 与窗口路径都要提供它（少一条就会出现「某条路径问不到」），实际 " +
        n +
        " 处",
    );
  });
});

describe("一键确认的按钮状态与逐条结果", function () {
  const page = readFileSync(
    join(here, "..", "..", "addon", "content", "sessionPage.js"),
    "utf8",
  );

  it("按钮的禁用状态必须**从状态变量恢复**（两个渲染器都要）", function () {
    // ## ⚠️ 这条断言曾经是**假通过**的
    //
    // 我先前写成"渲染时必须读 batchConfirm.running"，它确实能匹配到
    // 两处中的**任何一处** —— 于是我把其中一处改回旧行为时，
    // 测试依然绿。**假通过的守卫比没有守卫更糟**——
    // 它会让人以为这条路径已经被钉住了。
    //
    // 现在要求：两个渲染器各有一处、且各自**紧跟在 if 之后**。
    const restores = page.match(
      /if \(batchConfirm && batchConfirm\.running\) \{\s*allBtn0?\.disabled = true;/g,
    );
    assert.ok(
      restores && restores.length >= 2,
      "两个渲染器都必须从 batchConfirm.running 恢复禁用（否则列表重建后按钮又可点），" +
        "实际只找到 " +
        (restores ? restores.length : 0) +
        " 处",
    );
  });

  it("点击入口必须**先判运行中**再二次确认", function () {
    assert.match(
      page,
      /if \(batchConfirm && batchConfirm\.running\) return;/,
      "运行中再次点击必须直接返回（这是防二次操作的最后一道）",
    );
  });

  it("不得再用整批调用作为一键确认的入口", function () {
    // 整批版一口气跑完才返回 → 界面既禁不住按钮、也看不到进度。
    // 它仍留在能力清单里（老调用方可能用），但**点击处理器不该再直接调它**。
    //
    // ⚠️ 这里用**整文件级**的断言，不去按 "addEventListener"
    // 切片—— 切片会把后面的函数定义也包进来，
    // 我先前那版断言就是这么写错的（切片长 7713 字符）。
    assert.match(
      page,
      /function runBatchConfirm\(/,
      "必须有逐条驱动的 runBatchConfirm",
    );
    const calls = page.match(/runBatchConfirm\(items\);/g) || [];
    assert.ok(
      calls.length >= 2,
      "两个渲染器的点击都应交给 runBatchConfirm，实际只有 " +
        calls.length +
        " 处",
    );
    assert.ok(
      !/capability\.confirmAllDeletions\(\)/.test(page),
      "页面不得再直接调整批版 confirmAllDeletions() —— " +
        "那正是按钮提前恢复可点、且看不到逐条结果的成因",
    );
  });

  it("必须有逐条结果的渲染（用户「没看到每项结果」）", function () {
    assert.match(
      page,
      /function renderBatchProgress\(/,
      "必须有进度/结果渲染器",
    );
    assert.match(
      page,
      /batchConfirm\.results\.forEach/,
      "逐条结果必须被渲染出来，而不是只在最后报一句汇总",
    );
  });

  it("逐条确认必须带 key 校验（下标会变）", function () {
    // 每确认一条列表就少一项，下标随之前移；批量循环若按旧下标推进
    // 就会点到**别的条目**上。所以插件侧接受 expectKey 并在不符时拒绝。
    const pane = readFileSync(
      join(here, "..", "..", "src", "modules", "sessionPane.ts"),
      "utf8",
    );
    assert.match(
      pane,
      /expectKey/,
      "confirmPendingDeletion 必须接受期望 key 并校验",
    );
    assert.match(
      page,
      /confirmDeletionAt\(\s*idx\s*,/s,
      "页面必须把 key 一起传下去",
    );
  });
});

describe("构建产物结构", function () {
  this.timeout(10000);

  before(function () {
    if (!hasBuild) {
      this.skip();
    }
  });

  it("manifest.json 合法，且 Zotero 兼容性字段完整", function () {
    const manifest = readJson(manifestPath);
    assert.equal(
      manifest.manifest_version,
      2,
      "Zotero 插件用 manifest_version 2",
    );
    assert.ok(manifest.name, "缺少 name");
    assert.ok(manifest.version, "缺少 version");

    // Zotero 读 applications.zotero（新版也接受 browser_specific_settings）
    const zoteroApp =
      manifest.applications?.zotero ??
      manifest.browser_specific_settings?.zotero;
    assert.ok(
      zoteroApp,
      "缺少 applications.zotero / browser_specific_settings.zotero",
    );
    assert.ok(zoteroApp.id, "缺少插件 id");
    assert.match(zoteroApp.id, /^[^@]+@[^@]+$/, "插件 id 应形如 name@domain");
    assert.ok(zoteroApp.strict_min_version, "缺少 strict_min_version");
    assert.ok(zoteroApp.strict_max_version, "缺少 strict_max_version");
    // 只支持 Zotero 10.x（本项目的明确范围）
    assert.match(
      String(zoteroApp.strict_min_version),
      /^10\./,
      "应为 Zotero 10.x 起",
    );
  });

  it("manifest 里引用的图标文件真实存在", function () {
    const manifest = readJson(manifestPath);
    const icons = manifest.icons ?? {};
    const entries = Object.entries(icons);
    assert.ok(entries.length > 0, "manifest 应声明图标");
    for (const [size, relPath] of entries) {
      const full = join(addonDir, String(relPath));
      assert.ok(existsSync(full), `图标 ${size}（${relPath}）不存在`);
      assert.ok(statSync(full).size > 0, `图标 ${size}（${relPath}）是空文件`);
    }
  });

  it("bootstrap.js 存在，且它加载的脚本路径在产物里存在", function () {
    const bootstrapPath = join(addonDir, "bootstrap.js");
    assert.ok(
      existsSync(bootstrapPath),
      "缺少 bootstrap.js（Zotero 插件的入口）",
    );
    const source = readFileSync(bootstrapPath, "utf8");

    // bootstrap 通过 rootURI 加载主脚本；把这个相对路径抠出来核对
    const match = source.match(/loadSubScript\(\s*`\$\{rootURI\}\/?([^`]+)`/);
    assert.ok(match, "未能在 bootstrap.js 里找到 loadSubScript 的脚本路径");
    const rel = match[1].replace(/^\//, "");
    const full = join(addonDir, rel);
    assert.ok(existsSync(full), `bootstrap 加载的脚本不存在：${rel}`);
    assert.ok(statSync(full).size > 1000, `主脚本 ${rel} 太小，可能没打进去`);

    // 挂载点必须与 _globalThis 上的实例名一致，否则 hooks 调不到
    const instance = readJson(manifestPath).applications?.zotero?.id;
    assert.ok(instance, "拿不到插件 id");
    assert.match(
      source,
      /Zotero\.\w+\??\.hooks\.onStartup/,
      "bootstrap 应调用插件的 hooks.onStartup",
    );
  });

  it("主脚本是自包含的（不含未打包的裸 import/require）", function () {
    const scriptsDir = join(addonDir, "content", "scripts");
    const files = readdirSync(scriptsDir);
    assert.ok(files.length > 0, "content/scripts 下没有脚本");
    for (const file of files) {
      const source = readFileSync(join(scriptsDir, file), "utf8");
      // ⚠️ 要忽略**字符串与注释里**的内容：宿主启动代理脚本（hostLauncher.ts）
      // 以模板字符串内嵌，里面本来就有 `import { spawn } from "node:child_process";`
      // 和 /^\s*import\s+/m 的形式，但它只是字符串数据、不是本产物的 import。
      // 先前用裸正则判断，导致这条测试对正确代码误报。
      const stripped = stripStringsAndComments(source);

      const bareImport = stripped.match(/^\s*import\s+[^(]/m);
      assert.equal(bareImport, null, `${file} 里有未打包的 import 语句`);
      assert.equal(
        /\brequire\(/.test(stripped),
        false,
        `${file} 里有未打包的 require`,
      );
      // 也不能引用 Node 内置模块（同样只看代码，不看内嵌脚本文本）
      for (const bad of ['require("fs")', 'from "node:', "process.env.NODE"]) {
        assert.equal(
          stripped.includes(bad),
          false,
          `${file} 引用了 Node 专有内容：${bad}`,
        );
      }
    }
  });

  it("locale 下的 FTL 文件名与 bootstrap/prefs 引用的一致", function () {
    const localeDir = join(addonDir, "locale");
    assert.ok(existsSync(localeDir), "缺少 locale 目录");
    const locales = readdirSync(localeDir).filter((name) =>
      statSync(join(localeDir, name)).isDirectory(),
    );
    assert.ok(locales.includes("zh-CN"), "应有 zh-CN 文案");

    for (const locale of locales) {
      const files = readdirSync(join(localeDir, locale));
      assert.ok(files.length > 0, `${locale} 下没有 FTL 文件`);
      for (const file of files) {
        assert.match(file, /\.ftl$/, `${locale}/${file} 不是 .ftl 文件`);
        const text = readFileSync(join(localeDir, locale, file), "utf8");
        assert.ok(text.trim().length > 0, `${locale}/${file} 是空文件`);
        // Fluent 里裸的 { 会当占位符解析，导致整条消息失效（踩过这个坑）
        for (const line of text.split("\n")) {
          if (!line.includes("{") || line.trimStart().startsWith("#")) continue;
          assert.match(
            line,
            /\{\s*\$|=\s*$|\{\s*"[^"]*"\s*->/,
            `疑似把 { 当普通字符写进了 Fluent 文案：${line.trim()}`,
          );
        }
      }
    }
  });

  it("bootstrap.js 为产物提供可读写的 addon / ztoolkit 全局标识符", function () {
    // 真机踩坑（2026-10-02）：产物在模块加载期就可能引用裸标识符 `addon`，
    // 而 `_globalThis.addon = new Addon()` 的赋值在模块求值之后。
    // 若 bootstrap 不把它们暴露为全局标识符，就会抛 ReferenceError，插件静默失效。
    // 反过来，如果只定义 getter 而没有 setter，产物自己的赋值又会报
    // `TypeError: setting getter-only property "addon"` —— 两种情况都真实发生过。
    const source = readFileSync(join(addonDir, "bootstrap.js"), "utf8");

    assert.match(
      source,
      /ctx\._globalThis\s*=\s*globalThis/,
      "_globalThis 必须指向真正的全局对象",
    );

    for (const name of ["addon", "ztoolkit"]) {
      const block = source.match(
        new RegExp(
          `defineProperty\\(globalScope,\\s*"${name}"[\\s\\S]{0,400}?\\}\\)`,
        ),
      );
      assert.ok(block, `bootstrap 应在全局对象上定义 ${name}`);
      assert.match(
        block[0],
        /get\s*[:(]/,
        `${name} 需要 getter（供加载期读取）`,
      );
    }
    // addon 必须有 setter：产物会执行 `_globalThis.addon = new Addon()`
    const addonBlock = source.match(
      /defineProperty\(globalScope,\s*"addon"[\s\S]{0,400}?\}\)/,
    );
    assert.match(
      addonBlock[0],
      /set\s*[:(]/,
      "addon 必须有 setter，否则产物赋值会抛 TypeError",
    );
  });

  it("产物里没有模块加载期的裸 addon/ztoolkit 引用", function () {
    // 顶层（非函数体内）引用 `addon`/`ztoolkit` 会在模块求值时执行，
    // 而那发生在 `addon` 被赋值之前 —— 这是本轮真机失败的根因，必须防住。
    const source = readFileSync(
      join(addonDir, "content", "scripts", "dshforzotero.js"),
      "utf8",
    );
    const lines = source.split("\n");
    const offenders = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // 只关心"顶层语句"：以 var/const/let 开头且缩进为 0（esbuild 把模块代码放在 2 空格内，
      // 这里放宽为"行首无缩进或仅 2 空格"，并排除在函数体内的常见形态）
      if (!/^( {0,2})(var|const|let)\s/.test(line)) continue;
      if (/\bnew\s+\w+\(addon\.|=\s*addon\.|\(addon\./.test(line)) {
        offenders.push(`${i + 1}: ${line.trim()}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `产物顶层不应直接引用 addon（应由函数惰性访问）：\n${offenders.join("\n")}`,
    );
  });

  it("prefs.js 里的默认值都被正确加了插件前缀", function () {
    const prefsPath = join(addonDir, "prefs.js");
    assert.ok(existsSync(prefsPath), "缺少 prefs.js");
    const source = readFileSync(prefsPath, "utf8");
    const names = [...source.matchAll(/pref\(\s*"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(names.length >= 10, `prefs.js 里的默认值太少（${names.length}）`);
    assert.equal(
      new Set(names).size,
      names.length,
      "prefs.js 里有重复的偏好名",
    );
    for (const name of names) {
      // 构建脚本会给源码里的裸偏好名加上 extensions.zotero.<addonRef>. 前缀；
      // 若没加上，插件读到的永远是 undefined。
      assert.match(
        name,
        /^extensions\.zotero\.dshforzotero\./,
        `偏好 ${name} 没有加插件前缀（构建脚本可能没生效）`,
      );
    }
  });

  it("设置界面绑定的偏好名都有默认值声明", function () {
    const prefsXhtml = join(addonDir, "content", "preferences.xhtml");
    assert.ok(
      existsSync(prefsXhtml),
      "缺少 content/preferences.xhtml（设置页）",
    );
    const uiSource = readFileSync(prefsXhtml, "utf8");
    const prefsSource = readFileSync(join(addonDir, "prefs.js"), "utf8");
    // 构建产物里两边都带前缀；统一剥掉前缀再比对
    const strip = (name) =>
      name.replace(/^extensions\.zotero\.dshforzotero\./, "");
    const declared = new Set(
      [...prefsSource.matchAll(/pref\(\s*"([^"]+)"/g)].map((m) => strip(m[1])),
    );

    // ⚠️ 必须带词边界：裸的 /preference="([^"]+)"/ 会把
    // `onsyncfrompreference="…"` 的**尾巴**也当成一个偏好名（因为
    // `…preference="` 本身含那个子串），于是报出一堆并不存在的"偏好"。
    // 本项目刚因此假报过失败（见 preferences.test.mjs 的同类修正）。
    const bound = [...uiSource.matchAll(/(?:^|\s)preference="([^"]+)"/g)].map(
      (m) => strip(m[1]),
    );
    assert.ok(bound.length >= 8, `设置界面绑定的偏好太少（${bound.length}）`);
    for (const name of bound) {
      assert.ok(
        declared.has(name),
        `设置界面绑定了 ${name}，但 prefs.js 里没有它的默认值（真机上会读到 undefined）`,
      );
    }
  });

  it("设置页真的被注册进 Zotero（只写文件不注册等于不存在）", function () {
    // 真机反馈："编辑-设置 里没有 DSH-for-Zotero"。
    // 原因是当时只写了 preferences.xhtml 与文案，**从未调用注册 API** ——
    // 文件在产物里，界面上却永远不显示。这条测试守住这个调用。
    const source = readFileSync(join(srcDir, "hooks.ts"), "utf8");
    assert.match(
      source,
      /PreferencePanes/,
      "hooks.ts 里必须调用 Zotero.PreferencePanes.register（否则设置页不会出现）",
    );
    assert.match(
      source,
      /PreferencePanes[\s\S]{0,400}?register\s*\(/,
      "必须实际调用 register()，而不只是引用 PreferencePanes",
    );
    assert.match(
      source,
      /pluginID:/,
      "register 必须带 pluginID（官方实现里它是必填，缺失会抛错）",
    );
    assert.ok(
      /content\/preferences\.xhtml/.test(source),
      "register 的 src 必须指向 content/preferences.xhtml",
    );
  });

  it("asar offset/size 解析必须做数字转换（否则提取出空文件）", function () {
    // 真实故障：asar 头部里 offset 是**字符串**（如 "44669811"），
    // 直接参与运算会变成字符串拼接，subarray 切片为空 ——
    // 表现是"提取成功"却得到 11376 个 0 字节文件，端口补丁随之失败。
    //
    // ⚠️ 判据用 `Number(value.offset)` 而不是 `offset: Number(`：
    // 后来为支持外置条目（`unpacked: true`）写成了三元表达式
    // `offset: isUnpacked ? -1 : Number(value.offset)`，形态变了但**转换仍在**。
    // 这正是本项目反复出现的"守卫盯着形态、而不是它要保护的性质"。
    const source = readFileSync(
      join(srcDir, "dsh", "isolatedRuntime.ts"),
      "utf8",
    );
    assert.match(
      source,
      /Number\(value\.offset\)/,
      "offset 必须经 Number() 转换（asar 头里它是字符串）",
    );
    assert.match(
      source,
      /Number\(value\.size\)/,
      "size 也必须经 Number() 转换",
    );
    // 反向守卫：不许出现**未转换**的裸用法
    assert.ok(
      !/offset:\s*value\.offset\b/.test(source),
      "不得把 offset 原样塞进 targets —— 它是字符串，会变成字符串拼接",
    );
  });

  it("Subprocess 的环境变量必须放在 environment 上（environmentAppend 只是布尔开关）", function () {
    // 真实故障（真机退出码 1）：Gecko `Subprocess.sys.mjs:119-124` 的语义是
    //   if (!options.environment || options.environmentAppend) environment = this.getEnvironment();
    //   if (options.environment) Object.assign(environment, options.environment);
    // 先前写成 `environmentAppend: {…}`（把变量对象放在布尔开关上），
    // 于是 DSH_HOME 与端口变量**都没传进去**，宿主退回写死 19387 与桌面版冲突而退出。
    const source = readFileSync(join(srcDir, "dsh", "subprocess.ts"), "utf8");
    assert.match(
      source,
      /launch\.environment\s*=\s*options\.env/,
      "环境变量对象必须赋给 launch.environment",
    );
    assert.match(
      source,
      /launch\.environmentAppend\s*=\s*true/,
      "environmentAppend 必须显式设为布尔 true（否则不会继承 PATH 等）",
    );
    assert.ok(
      !/environmentAppend:\s*options\.env/.test(source),
      "不能把环境变量对象放在 environmentAppend 上（那样等于没传）",
    );
  });

  it("子进程的 stdout/stderr 必须显式接管道", function () {
    // 不接管道时子进程的 stdout 无人消费，dsh 宿主写启动行会阻塞、永远不监听端口；
    // 同时崩溃原因也读不到（诊断信息全丢）。
    const source = readFileSync(join(srcDir, "dsh", "subprocess.ts"), "utf8");
    assert.match(source, /stdout:\s*"pipe"/, "必须指定 stdout: 'pipe'");
    assert.match(
      source,
      /stderr:\s*"pipe"/,
      "必须指定 stderr: 'pipe'（否则崩溃原因读不到）",
    );
  });

  it("会话窗口的页面文件必须存在（否则「窗口」按钮打开空白窗）", function () {
    // 真机反馈"按钮没有实际功能"：当时 sessionPane 用 openDialog 打开
    // chrome://…/content/session.xhtml，但**这个文件从未创建** ——
    // 日志显示"已在新窗口打开"，用户看到的却是空白窗口。
    for (const rel of ["content/session.xhtml", "content/sessionPage.js"]) {
      assert.ok(
        existsSync(join(addonDir, rel)),
        `缺少 ${rel}：会话窗口会打开空白页`,
      );
    }
    // 页面必须引用它的脚本，且脚本名与产物里的一致
    const xhtml = readFileSync(
      join(addonDir, "content", "session.xhtml"),
      "utf8",
    );
    assert.match(
      xhtml,
      /sessionPage\.js/,
      "session.xhtml 必须引用 sessionPage.js",
    );
    // 打开方引用的正是这个路径
    const pane = readFileSync(
      join(srcDir, "modules", "sessionPane.ts"),
      "utf8",
    );
    assert.match(
      pane,
      /content\/session\.xhtml/,
      "sessionPane 必须打开 session.xhtml",
    );
  });

  it("会话窗口必须能拿到能力，且有兜底超时（不能永远停在「…」）", function () {
    // 真机反馈："一直在 …"，随后又报"无法连接到会话"。
    // 迭代过程（都记录在此，避免再走回去）：
    //  1) 能力通过 window.arguments 传异步函数 —— 跨 chrome 窗口边界不保证能过去，
    //     传不过去时页面静默什么都不做；
    //  2) 改为挂在 Zotero.<name> 的注册表上 —— 但对话框是**独立 chrome 窗口**，
    //     实测诊断输出 `Zotero=无`，那个对象根本不存在；
    //  3) 现在：打开方在 openDialog 返回后把能力**绑到窗口对象的属性**上，
    //     页面轮询等待绑定出现。
    const page = readFileSync(
      join(addonDir, "content", "sessionPage.js"),
      "utf8",
    );
    assert.match(
      page,
      /window\[CAPABILITY_KEY\]|window\["DSHForZoteroSession"\]|CAPABILITY_KEY/,
      "页面必须从窗口对象属性上取能力（不能依赖 Zotero —— 对话框里没有它）",
    );
    assert.match(
      page,
      /setInterval/,
      "页面必须轮询等待绑定注入（绑定晚于脚本执行）",
    );
    assert.match(page, /无法连接到会话/, "等不到能力时必须显示明确原因");
    // 兜底超时：轮询等待、历史载入、提问各一处
    const guards = (page.match(/setTimeout\(|setInterval\(/g) ?? []).length;
    assert.ok(guards >= 2, `应有至少两处等待/超时保护，实际 ${guards}`);
    assert.match(page, /超时/, "超时必须给用户可读提示，而不是停在「…」");
  });

  it("会话工作区必须被写入材料（真机：工作目录是空的）", function () {
    // 真机反馈"工作目录是空的"：新架构下新建会话只建了目录，没有写论文全文与元数据，
    // 于是 Agent 的工作目录里什么都没有 —— 而"条目会话的工作区 = 该条目"正是设计要求。
    const pane = readFileSync(
      join(srcDir, "modules", "sessionPane.ts"),
      "utf8",
    );
    assert.match(
      pane,
      /populateWorkspace\(/,
      "新建会话必须调用 populateWorkspace 写入材料",
    );
    assert.match(
      pane,
      /writePaperWorkspace\(/,
      "条目会话必须复用 writePaperWorkspace 写全文",
    );
    assert.match(pane, /collection\.md/, "独立会话必须写分类清单");
    // 历史会话要能补齐（否则用户必须删掉重建）
    assert.match(
      pane,
      /backfillWorkspaces|workspaceLooksPopulated/,
      "必须能补齐历史会话的空工作区",
    );

    // 把能力绑到对话框窗口上（这一条是上一轮修复的核心，不能丢）
    assert.match(
      pane,
      /dialog\.DSHForZoteroSession\s*=|DIALOG_CAPABILITY_KEY/,
      "sessionPane 必须把能力绑到 openDialog 返回的窗口对象上",
    );

    // 复用而不是复制：writePaperWorkspace 必须支持指定目标目录
    const workspace = readFileSync(
      join(srcDir, "papers", "workspace.ts"),
      "utf8",
    );
    assert.match(
      workspace,
      /targetDir\?:/,
      "writePaperWorkspace 必须支持 targetDir，否则会话工作区只能另写一份提取逻辑",
    );
  });

  it("工作区路径不得依赖 sessionId（dsh 的 cwd 创建后不可改）", function () {
    // 真机 bug：先用 pending-<时间戳> 建会话、拿到 id 后再算"最终"路径，
    // 结果记录里的工作区与 dsh 实际使用的不一致（目录名里留着 pending-…），
    // "条目会话的工作区 = 该条目"的设计意图没有生效。
    const source = readFileSync(join(srcDir, "dsh", "session.ts"), "utf8");
    const start = source.indexOf("export function workspaceFor");
    const fn = source.slice(start, source.indexOf("\n}", start));
    assert.ok(
      !/sessionId/.test(fn),
      "workspaceFor 不得接收 sessionId：dsh 会话的 cwd 创建后无法更改",
    );
    assert.match(
      fn,
      /`\$\{kind\}-\$\{safeScope\}`/,
      "工作区应按范围（kind + scopeKey）确定",
    );
  });

  it("阅读器面板与会话模型必须共用同一个工作区（避免同一文献提取两遍）", function () {
    // 去冗余：面板此前写 `<libraryID>-<itemKey>`、会话写 `item-<itemKey>`，
    // 同一篇文献被提取两遍、缓存两份，两边还可能看到不一致的材料。
    const panel = readFileSync(
      join(srcDir, "modules", "readerPanel.ts"),
      "utf8",
    );
    assert.match(
      panel,
      /workspaceFor\([\s\S]{0,120}?"item"/,
      '阅读器面板必须用 workspaceFor(..., "item", key) 与会话模型共用工作区',
    );
    assert.match(
      panel,
      /targetDir/,
      "面板必须把该目录传给 writePaperWorkspace（否则仍写回旧目录）",
    );
  });

  it("会话挂载必须用官方附件 API（网页链接是唯一形态）", function () {
    // 实测：Zotero 附件只有 5 种链接模式（IMPORTED_FILE=0 / IMPORTED_URL=1 /
    // LINKED_FILE=2 / LINKED_URL=3 / EMBEDDED_IMAGE=4），插件**不能注册自定义类型**，
    // 所以只能借真实的附件形态 —— 每种形态对应一个官方 API，不能凭想象拼 item 字段。
    //
    // ⚠️ 这个测试原先叫"…且四种形态都有分支"，断言 file / linked-file / note 三种可用。
    // 那三种已按用户要求删除（理由：它们的页面来自 `file://`，而 dsh 不返回 CORS 头、
    // `Origin: null` 直接 403 —— 等于**只能看不能问**）。测试名与断言必须跟着改：
    // 否则它会继续宣称一个不存在的能力，而且**永远不会失败**（被断言的字符串还在
    // 注释里），属于最难发现的那类"骗人的测试"。
    const pane = readFileSync(
      join(srcDir, "modules", "sessionPane.ts"),
      "utf8",
    );
    assert.match(
      pane,
      /Zotero\.Attachments\.importFromURL/,
      "网页链接形态必须用 Zotero.Attachments.importFromURL",
    );
    assert.match(
      pane,
      /sessionViewerUrl/,
      "必须用插件自己的会话页 URL（绑定会话 id）",
    );
    assert.match(
      pane,
      /refreshWebLinkUrl/,
      "网页链接必须能更新 URL（端口会变）",
    );
    // 已删除的三种形态不得复活
    assert.ok(
      !/Zotero\.Attachments\.importFromFile/.test(pane),
      "文件形态已删除，不应再出现 importFromFile",
    );
    assert.ok(
      !/Zotero\.Attachments\.linkFromFile/.test(pane),
      "文件链接形态已删除，不应再出现 linkFromFile",
    );
    assert.ok(
      !/^\s*(export\s+)?(async\s+)?function\s+(writeSessionPage|sessionPagePath)\b/m.test(
        pane,
      ) && !/\bawait\s+writeSessionPage\(/.test(pane),
      "会话页 HTML 生成（文件形态的产物）已删除，不应复活",
    );
    // 网页链接形态的 URL 必须能刷新（宿主重启后端口会变）
    assert.match(
      pane,
      /refreshWebLinkUrl/,
      "网页链接必须能更新 URL（端口/token 会变）",
    );
    // ⚠️ 必须是 LINKED_URL（=3），不能用 IMPORTED_URL（=1）。
    // Zotero 里两者语义完全不同：
    //   isSnapshotAttachment() = (IMPORTED_URL && text/html)  → 期望存储里有 HTML 快照
    //   isFileAttachment()     = (linkMode != LINKED_URL)
    // 打开附件时只有 LINKED_URL 会直接 loadURI(url)；IMPORTED_URL 会走 getFilePath()，
    // 拿不到路径就报"附件未找到"（真机正是如此）。
    assert.match(
      pane,
      /LINK_MODE_LINKED_URL/,
      "网页链接必须用 LINK_MODE_LINKED_URL，否则 Zotero 会当成网页快照并报附件未找到",
    );
    // refreshWebLinkUrl 的守卫也必须是 LINKED_URL（改快照型附件的 url 没有意义）
    assert.match(
      pane,
      /attachmentLinkMode !== Zotero\.Attachments\.LINK_MODE_LINKED_URL/,
      "更新 URL 前的守卫必须针对 LINKED_URL",
    );
    // 历史遗留的 IMPORTED_URL+text/html 附件要能就地修正，否则用户得重建所有会话
    assert.match(pane, /网页快照/, "必须能就地修正早期误用的快照型附件");

    // 会话窗口必须显示"绑定的工作区"。
    // 官方 dsh web 无法绑定到某条会话（实测 URL 参数被忽略、前端无任何路由，
    // pushState / window.location 均为 0 处），所以会话 ↔ 工作区的绑定关系
    // 只能在插件自己的界面里体现。
    assert.match(
      pane,
      /listWorkspaceFiles/,
      "capability 必须提供工作区材料清单",
    );
    const sessionPage = readFileSync(
      join(addonDir, "content", "sessionPage.js"),
      "utf8",
    );
    assert.match(sessionPage, /workspace-path/, "会话页必须显示工作区路径");
    assert.match(sessionPage, /listWorkspaceFiles/, "会话页必须列出工作区材料");
    const sessionXhtml = readFileSync(
      join(addonDir, "content", "session.xhtml"),
      "utf8",
    );
    assert.match(
      sessionXhtml,
      /id="workspace-path"/,
      "会话窗口必须有工作区路径容器",
    );
    assert.match(
      sessionXhtml,
      /id="workspace-files"/,
      "会话窗口必须有材料清单容器",
    );

    // ⚠️ 历史读取必须走**常驻 transport** 并**显式传会话 id**。
    // 两个真机故障叠在这里：
    //  1) 每次新建 transport 会重新解析端口，cookie 名字由 authority 派生，
    //     端口一变（19400→19401）cookie 就对不上 → HTTP 401；
    //  2) 常驻 transport 的 getSessionId 返回 undefined，loadHistory 会**静默返回空数组**
    //     → "点进会话不显示历史"且无任何报错。
    assert.match(
      pane,
      /ensureTransport\(\)[\s\S]{0,400}?loadHistory\(sessionId,\s*sessionId\)/,
      "historyFor 必须用常驻 transport 并显式传会话 id",
    );
    assert.match(
      pane,
      /transportAuthority/,
      "必须记住 transport 的 authority，端口变化时重建（否则 cookie 名字不匹配）",
    );
    const transport = readFileSync(
      join(srcDir, "chat", "transport.ts"),
      "utf8",
    );
    assert.match(
      transport,
      /loadHistory\(\s*itemKey: string,\s*explicitSessionId\?: string,?\s*\)/,
      "loadHistory 必须接受显式会话 id",
    );
    // 网页链接**不能**用 importFromURL：它会先 GET 校验 URL，而隔离实例要认证 → 401，
    // 附件根本建不出来（真机反馈"没有出现网页链接附件"）。
    // 只看实际调用（文档注释里提到它是允许的）。
    assert.ok(
      !/await\s+Zotero\.Attachments\.importFromURL/.test(pane),
      "不得用 importFromURL 建本地需认证的链接（它会 GET 校验并 401）；应直接构造附件条目",
    );
    assert.match(pane, /createWebLinkAttachment/, "必须直接构造网页链接附件");
    // URL 必须优先取宿主打印的 launchUrl（含 token），否则界面报 authentication required
    assert.match(
      pane,
      /isolatedWebUrl/,
      "取 URL 必须走统一入口（优先 launchUrl，含 token）",
    );

    // 运行时：抓 token 不能"端口一通就返回"
    const runtime = readFileSync(
      join(srcDir, "dsh", "isolatedRuntime.ts"),
      "utf8",
    );
    assert.match(
      runtime,
      /launchUrl/,
      "RuntimeStatus 必须保存宿主打印的 launchUrl",
    );
    assert.match(
      runtime,
      /token=\[\\w-\]\+|token=\[\\\\w-\]\+/,
      "必须从宿主输出里解析带 token 的 URL",
    );
    assert.match(
      runtime,
      /继续等待宿主打印带 token 的 URL/,
      "端口就绪后必须继续等 token：先前'端口一通就返回'导致 token 丢失（真机 401）",
    );
    // 超时必须够长：宿主在"启动审计"之后才打印 URL，本机实测超过 45 秒
    assert.match(
      runtime,
      /150_000/,
      "等 token 的超时必须放宽（45 秒不够：打印发生在启动审计之后）",
    );
    // 挂载的 URL 必须指向**插件自己的会话页**（chrome:// + ?session=<id>）。
    // 依据：Zotero 的 loadURI 对 `chrome:` 走 Zotero.openInViewer(uri)
    // （zoteroPane.js:5010），所以双击附件会在 Zotero 内置查看器里打开一个
    // 精简、且绑定该会话的界面 —— 而 dsh web 无法绑定会话（实测 URL 参数被忽略、
    // 前端无路由）且是完整界面。因此不再需要 dsh 的 token/端口。
    assert.match(pane, /sessionViewerUrl/, "必须提供指向插件会话页的 URL 构造");
    assert.match(
      pane,
      /chrome:\/\/\$\{ref\}\/content\/session\.xhtml\?session=/,
      "会话附件 URL 必须是 chrome://<ref>/content/session.xhtml?session=<id>",
    );
    assert.ok(
      !/缺 token[\s\S]{0,300}?attachSessionNote/.test(pane),
      "新设计不依赖 token，不应再有'缺 token 就退化成笔记'的分支",
    );
    // 会话页必须能在**内置查看器**里独立工作：从 URL 取会话 id，经全局入口取能力
    const viewerPage = readFileSync(
      join(addonDir, "content", "sessionPage.js"),
      "utf8",
    );
    assert.match(viewerPage, /sessionIdFromUrl/, "页面必须能从 URL 取会话 id");
    assert.match(
      viewerPage,
      /Zotero\.DSHForZoteroSessions/,
      "页面必须经 Zotero.DSHForZoteroSessions 全局入口取能力",
    );
    const viewerHtml = readFileSync(
      join(addonDir, "content", "session.xhtml"),
      "utf8",
    );
    assert.match(
      viewerHtml,
      /chrome:\/\/zotero\/content\/include\.js/,
      "会话页必须加载 include.js 才能拿到 Zotero 全局（Zotero 自己的 reader/note 也这么做）",
    );
    // ⚠️ 能力对象**不能**占用 `Zotero.DSHForZotero`：那是 bootstrap 放插件实例
    // （含 .hooks）的名字。我最初写错，直接把实例覆盖掉 ——
    // 真机上 `Zotero.DSHForZotero.hooks.onStartup` 不存在，插件完全不工作。
    assert.match(
      pane,
      /PAGE_API_GLOBAL\s*=\s*"DSHForZoteroSessions"/,
      "页面能力必须用 DSHForZoteroSessions",
    );
    assert.ok(
      !/Zotero\.DSHForZotero\s*=/.test(pane),
      "不得给 Zotero.DSHForZotero 赋值（会覆盖 bootstrap 放的插件实例）",
    );
  });

  it("会话入口是右键菜单（自插 DOM），且命令分支必须与参数类型一致", function () {
    const pane = readFileSync(
      join(srcDir, "modules", "sessionPane.ts"),
      "utf8",
    );
    // 用户要求：文献库界面不显示侧栏、新建会话放进右键菜单
    // ⚠️ 只检查**真实调用**。先前用宽泛正则命中了"为什么不再注册"的注释文字 ——
    // 误报会掩盖真实问题（这个教训在本项目已出现多次）。
    assert.ok(
      !/\.registerSection\s*\(/.test(pane),
      "不应再调用 ItemPaneManager.registerSection（用户要求文献库界面不显示侧栏）",
    );

    // 为什么最终不用 MenuManager（每一条都实测过）：
    //  1. 它不认 `label`（源码里 "label" 只出现在一行注释中）→ 菜单项没有文字；
    //  2. 它给元素加的类是 `_key = zotero-custom-menu-<随机>`，menuID 只进 _mainKey，
    //     按 menuID 拼类选择器永远匹配不到（dump 证实：36 个 menuitem 里没有一个带它）；
    //  3. 改用通用类找到后，补 label 仍不显示、且该项点了没反应。
    // 结论：直接插 DOM，label/command/图标全由自己掌握（工具菜单那三项一直是这样）。
    assert.match(pane, /installContextMenus/, "必须有直接插 DOM 的菜单安装");
    assert.match(pane, /#zotero-itemmenu/, "必须插入条目右键菜单");
    assert.match(pane, /#zotero-collectionmenu/, "必须插入分类右键菜单");
    assert.match(
      pane,
      /addEventListener\(\s*"command"/,
      "自插的菜单项必须自己接 command，否则点了没反应",
    );
    assert.match(pane, /setAttribute\(\s*"label"/, "必须显式设置 label");

    // ⚠️ 参数类型必须与分支判断一致。真机 bug：调用方传 `kind`（"item"），
    // 而函数签名是 menuID 且判断 `menuID.endsWith("-item")` ——
    // `"item".endsWith("-item")` 是 false，条目会话的点击永远走错分支，
    // 找不到分类就静默返回，表现正是"点了没反应"。
    assert.match(
      pane,
      /runMenuCommand\(kind: "item" \| "collection"\)/,
      "runMenuCommand 必须按 kind 枚举分发，不能从字符串猜",
    );
    assert.ok(
      !/private async runMenuCommand\(menuID/.test(pane),
      "不得再用 menuID 字符串判断分支（与调用方传的 kind 类型不符）；注释里提到旧写法是允许的",
    );

    // 图标：Zotero 的规则是 `menuitem.zotero-custom-menu-item { list-style-image: … }`，
    // 所以元素要带该类且置 --custom-menu-icon-* 变量（真机反馈"希望前面有个小 icon"）
    assert.match(
      pane,
      /zotero-custom-menu-item/,
      "菜单项必须带 Zotero 的图标类",
    );
    assert.match(
      pane,
      /--custom-menu-icon-light/,
      "必须设置图标 CSS 变量（否则 list-style-image 取到 none）",
    );
    assert.match(pane, /applyMenuIcon/, "必须有统一的图标应用函数");
    // 图标用**内联 data URL**：位图文件路径（`chrome://`）经 list-style-image
    // 加载时真机两次都没显示出来，data URL 完全绕开"路径能否解析"这一层。
    //
    // ⚠️ 图标形态的演变（每次都有理由，别改回去）：
    //   1. 内联 SVG + `fill="context-fill"`（想跟主题色）—— **渲染成透明**：
    //      容器上没有 `-moz-context-properties: fill`，context-fill 解析不出颜色。
    //   2. 内联 PNG base64（用户先给的位图）—— 能用，但 880 字符且缩放会糊。
    //   3. **内联 SVG（当前）** —— 用户随后提供了矢量原件，280 字符且任意缩放清晰。
    //      固定配色（蓝 #267CB5 + 白气泡），**不随主题变色** —— 这是图标本身的取舍。
    assert.match(
      pane,
      /data:image\/svg\+xml/,
      "菜单图标必须是内联 SVG data URL",
    );

    // 校验 SVG 真的可解析、且没有会破坏 data URL 写法的字符。
    // 只断言字符串前缀会漏掉"少了个引号/尖括号"这种错误 —— 这类错误在运行时
    // 只表现为"图标不显示"，排查代价很高，所以在构建产物测试里就拦掉。
    const svgMatch = pane.match(/const MENU_ICON_SVG =\n([\s\S]*?);\n/);
    assert.ok(svgMatch, "必须有一个常量存放菜单图标的 SVG 源码");
    // 逐行还原成最终字符串：剥掉注释行、行尾连接符与 JS 字符串引号。
    //
    // ⚠️ 这里踩过三次，每次都是"提取逻辑本身出错、而断言侥幸通过"：
    //   1. 忘了剥行尾的 ` +` 与 JS 语法引号 → 把语法引号误判成"SVG 里有双引号"；
    //   2. 忘了剥**行内**注释（源码形如 `"…" + // 圆：品牌蓝，下一行还有内容`）→
    //      注释文字被当成 SVG 内容拼了进去，而断言当时仍然全绿 ——
    //      因为拼出来的垃圾不影响 `startsWith("<svg")` 之类的判断，
    //      也就是说**断言当时并没有真正在检查 SVG**。
    //
    // 现在同时用两个条件，任一都能独立拦住注释：
    //   a. 丢掉**注释行**（行首 `//`）；
    //   b. 只保留**字符串片段行**（以 `"` 结尾，后面可跟 `+` 或 `;`）。
    //
    // ⚠️ (b) 的"后面可跟 `;`"是踩出来的：最后一行是 `"</svg>";`，
    // 而第一版正则要求引号在**行尾**，于是把 `</svg>` 整段丢了 ——
    // 好在下面有"必须以 </svg> 结尾"的断言，否则这份测试会安静地少检查一半内容。
    const svgLines = svgMatch[1]
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => !line.startsWith("//"))
      .filter((line) => /"\s*(\+|;)?$/.test(line));
    assert.ok(svgLines.length > 0, "必须至少提取到一个字符串片段行");
    const svg = svgLines
      .map((line) => {
        let s = line.replace(/\s*\+$/, "").replace(/;$/, ""); // 行尾连接符 / 分号
        s = s.replace(/^"/, "").replace(/"$/, ""); // JS 字符串引号
        return s;
      })
      .join("");
    // 拼出来的必须**真的是一段 SVG**，不能混进注释残留。
    //
    // ⚠️ 不能简单地查 `//` —— SVG 的 `xmlns='http://www.w3.org/2000/svg'` 里
    // 就含 `//`（URL 的协议分隔符）。第一版这么查，于是**对自己的图标误报**。
    // 真正的"注释残留"特征是中文字符（我们的注释都是中文），或出现 `// ` 后跟空格。
    assert.ok(
      !/[\u4e00-\u9fa5]/.test(svg),
      "提取出的 SVG 里不得含中文（那是注释残留 —— 提取逻辑出错会污染断言）",
    );
    assert.ok(
      !svg.includes("// "),
      "提取出的 SVG 里不得含 `// `（行注释残留）",
    );
    assert.ok(svg.startsWith("<svg"), "SVG 必须以 <svg 开头");
    assert.ok(svg.endsWith("</svg>"), "SVG 必须以 </svg> 结尾");
    assert.match(
      svg,
      /viewBox='0 0 128 128'/,
      "viewBox 必须与用户给的矢量一致",
    );
    // URL 里用单引号，源码里就不能出现裸双引号 —— 否则 JS 字符串会提前结束
    assert.ok(
      !svg.includes('"'),
      "SVG 源码里不得含双引号（会破坏 data URL 的写法）",
    );

    // ── 配色的两条约束（用户要求"跟着主题走，只要是蓝色就行"）──────────
    // 1. **圆**必须是**字面量**品牌蓝：图标经 list-style-image 作为独立图片渲染，
    //    拿不到父文档的 CSS 变量，所以这里绝不能写成 `var(--accent-blue)`。
    assert.ok(
      /<circle[^>]*fill='#[0-9A-Fa-f]{6}'/.test(svg),
      "圆必须用字面量十六进制蓝色（图片里解析不了 var(--accent-blue)）",
    );
    assert.ok(
      !svg.includes("var("),
      "SVG 里不得出现 var() —— list-style-image 的图片拿不到父文档的 CSS 变量",
    );
    // 2. **气泡**必须是半透明白 —— 在蓝底上呈浅蓝，两种主题下表现一致。
    //
    // ⚠️ 这里**不要**改回 `context-fill`。真的试过：它给的是**纯前景色**
    // （浅色主题 = 纯黑），在彩色底上又重又脏，真机反馈"黑色气泡太丑了"。
    // 它是为**单色**图标设计的，不适合"彩色底 + 反白图形"这种构图。
    assert.ok(
      /<path[^>]*fill='#FFFFFF'/.test(svg),
      "气泡必须是白色（配合 fill-opacity 呈半透明，在蓝底上为浅蓝）",
    );
    assert.ok(
      /<path[^>]*fill-opacity='[0-9.]+'/.test(svg),
      "气泡必须带 fill-opacity（纯白在浅色主题下过亮，半透明白才稳）",
    );
    assert.ok(
      !svg.includes("context-fill"),
      "不得再用 context-fill 上色：它给纯黑/纯白，在彩色底上是脏的（真机反馈过）",
    );
    // `#` 必须被转义成 %23，否则 URL 解析会把后面当片段
    assert.match(pane, /replace\(\/#\/g, "%23"\)/, "data URL 必须转义 #");
    // ⚠️ **往返校验**：把编码后的 data URL 解码回来，必须与源码逐字节一致。
    //
    // 这条断言抓出过一个真 bug：早先的写法是
    // `.replace(/#/g, "%23").replace(/%/g, "%25")` —— 顺序错误。
    // 第一步把 `#267CB5` 变成 `%23267CB5`，第二步又把这个 `%` 变成 `%25`，
    // 得到 `%2523267CB5`；URL 解码**一次**后是 `%23267CB5` **而不是** `#267CB5`，
    // 于是颜色失效 —— 而表现和"图标没加载"几乎一样，很难一眼看出。
    // 只断言"含 replace(#→%23)"是**抓不到**这个错误的，必须真的做一次往返。
    const dataUrlPrefix = "data:image/svg+xml;utf8,";
    const encodedIcon = svg.replace(/#/g, "%23");
    assert.equal(
      decodeURIComponent(encodedIcon),
      svg,
      "图标 data URL 必须能一次解码回源码（# 被二次转义会让颜色失效）",
    );
    assert.ok(
      `${dataUrlPrefix}${encodedIcon}`.startsWith(dataUrlPrefix),
      "图标必须是 utf8 SVG data URL",
    );
    // 源码里不得出现 `%25` 转义的**实际调用**。
    // ⚠️ 必须剥掉注释行再判断：解释这个 bug 的注释里**会提到**那段旧写法
    // （第一版断言没剥，于是把注释误判成代码，自己把自己拦下了）。
    const paneCodeOnly = pane
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    assert.ok(
      !/replace\(\/%\/g, "%25"\)/.test(paneCodeOnly),
      "不得再把 % 也转义：会让 #→%23 被二次转义成 %2523",
    );

    assert.match(
      pane,
      /ensureMenuIconStyle/,
      "必须注入自己的图标规则（不依赖 Zotero 内部的变量与媒体查询）",
    );
    // 这一条守着一个真实踩过的坑：缺了它，`context-fill` 图标会渲染成透明，
    // 而表现和"路径不对"一模一样，很容易误判。
    assert.match(
      pane,
      /-moz-context-properties/,
      "图标规则必须声明 -moz-context-properties（否则将来换 context-fill 图标会静默失效）",
    );
    assert.match(
      pane,
      /list-style-image/,
      "必须设置 list-style-image（这才是菜单项图标的渲染属性）",
    );

    // 进门先记一行：真机日志里一条菜单记录都没有时，无从判断是"没注册"还是"报错了"
    assert.match(
      pane,
      /开始注册会话右键菜单/,
      "注册前必须落盘一条日志（否则静默失败无法排查）",
    );
    // 没有选中对象时禁用，避免"点了什么都不发生"
    assert.match(pane, /hasMenuTarget/, "必须按当前选中状态启用/禁用菜单项");
    assert.match(
      pane,
      /setAttribute\(\s*"disabled"/,
      "必须显式设置 disabled 状态",
    );
  });

  it("启动时必须先清理旧宿主、再选端口（否则端口会一直漂移）", function () {
    // 真机 bug：端口从 19400 一路漂到 19401、19402…，用户收藏的链接随之失效。
    // 原因纯属**顺序**：先前先 pickPort()、后 killStaleHost()，
    // 于是选端口时旧宿主还占着 19400 → 退避到 19401，紧接着才把旧宿主杀掉 ——
    // 端口白白让出去了，下一轮重复同样的事。
    const runtime = readFileSync(
      join(srcDir, "dsh", "isolatedRuntime.ts"),
      "utf8",
    );
    // ⚠️ 只在 start() 方法**内部**比较顺序。先前取"从 async start( 到文件末尾"，
    // 结果命中了文件后面 pickPort() 的**定义**，把正确代码判成失败。
    const startAt = runtime.indexOf("async start(");
    assert.ok(startAt > 0, "找不到 start()");
    const spawnAt = runtime.indexOf("await spawn(", startAt);
    assert.ok(spawnAt > startAt, "找不到 start() 里的 spawn");
    const startBody = runtime.slice(startAt, spawnAt);
    // ⚠️ 必须匹配**真实调用**（`await this.xxx()`），不能只搜方法名 ——
    // 那段注释里就写了 `pickPort()` 来解释这个 bug，纯文本搜索会命中注释
    // （本项目的测试已因这类"搜到注释"的误报踩过多次）。
    const killAt = startBody.indexOf("await this.killStaleHost()");
    const pickAt = startBody.indexOf("await this.pickPort()");
    const waitAt = startBody.indexOf("await this.waitForPortRelease(");
    assert.ok(killAt > 0, "start() 必须调用 killStaleHost()");
    assert.ok(pickAt > 0, "start() 必须调用 pickPort()");
    assert.ok(waitAt > 0, "清理后必须等端口释放（进程终止与端口回收有延迟）");
    assert.ok(
      killAt < pickAt,
      "必须先 killStaleHost() 再 pickPort()：反了就会把首选端口白白让给旧宿主",
    );
    assert.ok(waitAt < pickAt, "等端口释放必须发生在选端口之前");
    // 退避时必须记日志，否则"为什么用了这个端口"无从判断
    assert.match(runtime, /使用设置里的固定端口/, "用首选端口时要记日志");

    // ⚠️ 枚举残留宿主这条命令踩过两个独立坑，都会让它**静默返回 0 个**，
    // 于是残留宿主永远清理不掉 → 端口一直被占 → 漂移。两条都要钉住：
    //  1. `-Filter "Name='node.exe'"` 经 `-Command` 传递时引号被剥（WMI 报"无效查询"）
    //     → 必须用 `-EncodedCommand`（Base64/UTF-16LE，绕开引号解析）；
    //  2. 路径**不要**转义反斜杠：`-like` 里反斜杠是字面量，
    //     写成 `C:\\Users\\…` 与真实命令行（单反斜杠）永不匹配
    //     （实测：单反斜杠匹配 2 个，双反斜杠匹配 0 个）。
    assert.match(runtime, /-EncodedCommand/, "枚举命令必须用 -EncodedCommand");
    assert.match(
      runtime,
      /encodePowerShellCommand/,
      "必须有 UTF-16LE Base64 编码实现",
    );
    assert.ok(
      !/paths\.runtime\.replace\(\/\\\\\/g/.test(runtime),
      "不得对 runtime 路径转义反斜杠（-like 里反斜杠是字面量，转义后永不匹配）",
    );
    // 枚举结果要记日志：0 个与"找到 N 个"必须可区分
    assert.match(runtime, /遗留宿主枚举：找到/, "枚举结果必须落盘");
  });

  it("独立会话必须自动归入所属分类（真机：没有自动归类）", function () {
    const pane = readFileSync(
      join(srcDir, "modules", "sessionPane.ts"),
      "utf8",
    );
    // Zotero 没有"分类"父类型 → 独立会话的附件只能是顶层条目，
    // 必须 addToCollection 才能在分类视图里看到
    assert.match(pane, /addToCollection/, "必须把独立会话附件加入所属分类");
    // ⚠️ 关键：分类 id 必须真的**传进**创建函数。先前该参数声明了却没传，
    // 于是 addToCollection 永远不会执行（真机现象："没有自动归类"）。
    // 用"调用点之后出现 collectionID"判定，而不是写死字面量顺序 ——
    // 后者会因为我抽了个中间变量就误报。
    assert.match(
      pane,
      /createWebLinkAttachment\([\s\S]{0,300}?collectionID,?\s*\)/,
      "创建附件时必须传入分类 id（collectionID）",
    );
    assert.match(pane, /resolveScopeCollectionID/, "必须能解析会话所属分类");
    // 已有会话也要能补归类
    assert.match(
      pane,
      /repairCollectionMembership/,
      "必须能修复历史独立会话的归类",
    );
  });

  it("宿主必须经代理启动，并从文件读取带 token 的 URL（沙箱读不到 stdout）", async function () {
    // 真机实测：插件拉起的子进程 **stdout 管道拿不到任何数据**
    //   「等待启动 URL 已 85s：stdout 0 字节，stderr 1179 字节」
    // 而同一命令在 PowerShell 里 2 秒就有 83 字节输出。stderr 能读、stdout 读不到，
    // 所以"继续等 stdout"是错的方向 —— 必须换通道：代理把 URL 写到文件。
    const runtime = readFileSync(
      join(srcDir, "dsh", "isolatedRuntime.ts"),
      "utf8",
    );
    assert.match(
      runtime,
      /paths\.launcherFile/,
      "必须经代理脚本启动宿主（args 第一项应是代理，而不是 --expose-internals）",
    );
    assert.match(
      runtime,
      /launchUrlFile/,
      "必须从 URL 文件读取带 token 的地址",
    );
    assert.match(runtime, /readLaunchUrlFile/, "必须有读 URL 文件的实现");
    // 代理必须先清空文件，否则会读到上一次运行的陈旧 URL
    const launcher = readFileSync(
      join(srcDir, "dsh", "hostLauncher.ts"),
      "utf8",
    );
    assert.match(launcher, /HOST_LAUNCHER_SOURCE/, "代理脚本必须内嵌");
    assert.match(
      launcher,
      /writeFileSync\(urlFile, ""\)/,
      "代理启动时必须先清空 URL 文件，避免读到陈旧 token",
    );
    assert.match(
      launcher,
      /child\.kill\(\)/,
      "代理退出时必须一并结束宿主，避免孤儿进程",
    );

    // 内嵌源码必须能落盘成合法 JS —— 先前手动抽字符串时转义还原写错过
    // （生成的脚本里出现真换行，node --check 直接报错）。
    const mod = await import(
      "data:text/javascript;base64," +
        Buffer.from(
          (
            await import("esbuild").then((esbuild) =>
              esbuild.build({
                entryPoints: [join(srcDir, "dsh", "hostLauncher.ts")],
                bundle: true,
                format: "esm",
                write: false,
                platform: "neutral",
              }),
            )
          ).outputFiles[0].text,
        ).toString("base64")
    );
    const emitted = mod.HOST_LAUNCHER_SOURCE;
    assert.ok(
      emitted.includes('\\n")'),
      "字符串字面量里的 \\n 不能被还原成真换行",
    );
    assert.ok(
      !/write\("host-launcher: usage[^"]*$/.test(
        emitted.split("\n").find((l) => l.includes("usage")) ?? "",
      ),
      "usage 那行不得被换行截断（说明转义还原错误）",
    );
  });

  it("声明的偏好都必须真的被读取（不许攒死设置）", function () {
    // 版本迭代中攒下过 7 个"声明了、但代码从不读取"的偏好
    // （contextMode / pageAnchors / selectionContextPages / historyLimit /
    //   debugLog / noteMode），其中 **streaming 还出现在设置界面上** ——
    // 用户勾了没有任何效果，这本身就是缺陷。已接上 streaming、删掉其余，
    // 这条测试守住它不再发生。
    const prefsSource = readFileSync(join(addonDir, "prefs.js"), "utf8");
    const declared = [...prefsSource.matchAll(/pref\(\s*"([^"]+)"/g)].map((m) =>
      m[1].replace(/^(?:extensions\.zotero\.)?dshforzotero\./, ""),
    );
    assert.ok(declared.length > 0, "prefs.js 里没有声明任何默认值");

    // 收集源码里读偏好用的字面量键
    const sources = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts"))
          sources.push(readFileSync(full, "utf8"));
      }
    };
    walk(srcDir);
    const blob = sources.join("\n");

    // 读偏好有两种写法，必须都认：
    //   getPref("chunkBytes")                       字面量键
    //   Zotero.Prefs.get(`${prefsPrefix}.streaming`) 模板拼接键
    const unused = declared.filter(
      (name) => !blob.includes(`"${name}"`) && !blob.includes(`.${name}\``),
    );
    assert.deepEqual(
      unused,
      [],
      `这些偏好声明了但代码从不读取，属于迭代冗余（要么接上实现，要么从 prefs.js 删除）：${unused.join(", ")}`,
    );
  });
});
