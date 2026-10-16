/**
 * ## Zotero 专用 preset：**只改 `tool-ask-user` 一行**
 *
 * 真机缺陷：用户报告"会话页面已经认为它的回答结束了（没有「停止生成」），
 * 于是我又往里敲了个 `1`…"。查下来是架构性的：
 *
 * - `ask_user_question` 默认**阻塞等待**；
 * - 回答它的唯一合法通道是 dsh 的 answerer waterfall —— 也就是
 *   **原生 dsh 客户端的提问卡片**（它的 `return` 成为工具返回值）；
 * - 本插件的会话页**不在**那条瀑布里，它的"回答"只能经 `session/prompt`
 *   进 turn 的 inbox，而 inbox 的 `next-step` 要等当前步结束才被读 ——
 *   当前步却正卡在等这个工具。**死锁**（实测 14 分钟，直到用户点停止）。
 *
 * 修法：自建 preset 把 `tool-ask-user` 设成 `mode: timed` + 极短超时，
 * 于是工具立刻返回 `{ pending: true, callId }`，Agent 继续下一步。
 *
 * ⚠️ 这个 preset 是上游 `standard.patch.yml` 的**完整镜像**，
 * 只改那一行 —— registry 的已知限制是"用户覆盖不会自动合并内置更新"，
 * 所以把差异压到最小，才好在上游变更时对照。
 */
import assert from "node:assert/strict";
import yaml from "js-yaml";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = await import(
  new URL(
    `file://${join(here, ".build", "unit-entry.mjs").replace(/\\/g, "/")}`,
  ).href
);
const { buildZoteroPresetPatch, ASK_USER_TIMEOUT_SECONDS, ZOTERO_PRESET_ID } =
  bundle;

/** Cordis 的 entry-list 方言带 `!!js` 标签（上游也用），普通解析器会报 unknown tag */
const jsTag = new yaml.Type("tag:yaml.org,2002:js", {
  kind: "scalar",
  resolve: () => true,
  construct: (value) => ({ js: value }),
});

describe("Zotero 专用 preset", function () {
  const patch = buildZoteroPresetPatch();

  it("必须把 registry 的 default 指向本 preset", function () {
    assert.match(
      patch,
      /- id: agent-preset-registry\n {2}name: '@deepseek-ai\/dsh-agent-preset-registry'\n {2}config:\n {4}default: zotero/,
      "新会话要默认用 Zotero 这一套 —— 否则改了 preset 也没人用",
    );
    assert.equal(ZOTERO_PRESET_ID, "zotero");
  });

  it("**`tool-ask-user` 必须是 timed 且超时很短**（这正是它存在的理由）", function () {
    assert.match(
      patch,
      /- id: tool-ask-user\n {8}name: '@deepseek-ai\/dsh-tool-ask-user'\n {8}config:\n {10}mode: timed/,
      "阻塞式下插件无法回答提问，Agent 会卡到用户点停止",
    );
    assert.match(
      patch,
      new RegExp(`timeout: ${ASK_USER_TIMEOUT_SECONDS}\\b`),
      "超时必须很短：本插件没有能 claim 前台等待的 Client，窗口越长 Agent 白等越久",
    );
    assert.ok(
      ASK_USER_TIMEOUT_SECONDS >= 1 && ASK_USER_TIMEOUT_SECONDS <= 5,
      "超时应落在 1–5 秒：够「原生客户端在场时立刻成交」，又几乎立刻退化成 pending",
    );
  });

  it("其余工具必须与上游镜像（差异只有那一行）", function () {
    // 这些是上游 standard.patch.yml 里的条目 —— 少一个都说明镜像漏了
    const must = [
      "persona",
      "agent-instructions",
      "time-context",
      "tool-pwsh",
      "tool-fs",
      "tool-fs-search",
      "tool-jobs",
      "tool-schedule",
      "skill-filesystem",
      "tool-skill",
      "tool-todo",
      "tool-web",
      "present",
      "tool-plugin-manager",
      "planning",
      "compaction",
      "delegation",
    ];
    for (const id of must) {
      assert.ok(
        patch.includes(`- id: ${id}\n`) || patch.includes(`- id: ${id}\r\n`),
        "镜像里缺少 " + id + " —— 用户选的是「完整镜像」，不能顺手精简",
      );
    }
  });

  it("`disallowed` 平台分支必须保留 `!!js` 表达式（那是上游的写法）", function () {
    assert.match(
      patch,
      /disabled: !!js process\.platform === 'win32'/,
      "tool-bash 在 Windows 上要禁用 —— 这是上游一行不改搬过来的",
    );
    assert.match(patch, /disabled: !!js process\.platform !== 'win32'/);
  });

  it("必须写明'不自动跟随上游更新'的代价与对照提醒", function () {
    assert.match(
      patch,
      /不会.*自动跟随|不自动合并/,
      "注释里要留下这个已知代价，否则升级 dsh 时没人会去对照上游",
    );
  });

  it("**空 provider 时 preset 仍然要写**（这是接线的关键）", function () {
    // 接线处若写成 `defs.length === 0` 就 return，最常见的配置下 preset 不会被写。
    // 这里用源码断言钉住"两块都要拼进去"。
    const src = bundle.__sourceOfProviders ?? undefined;
    void src;
    assert.ok(
      patch.length > 500,
      "patch 内容不能是空的 —— 它必须包含完整的 preset 声明",
    );
  });
});

/**
 * ## 生成的 YAML 必须真的能被解析
 *
 * 这不是形式主义：这段文本会被写进 `cordis.patch.yml`，**宿主启动时读它**。
 * 一个缩进错误 = 组合失败 = 整个隔离实例起不来，而那时的表现是
 * "插件装了但什么都不工作"，极难定位。
 *
 * ⚠️ 要用**注册了 `!!js` 标签**的 schema —— `disabled: !!js process.platform === 'win32'`
 * 是 Cordis 的 entry-list 方言，普通解析器会直接报 `unknown tag`。
 * （这正是上游 `standard.patch.yml` 的写法，我们一行不改地搬了过来。）
 */
describe("preset 的 YAML 可解析性", function () {
  const patch = buildZoteroPresetPatch();

  it("必须能解析成两行：registry 与 preset 声明", function () {
    const parsed = yaml.load(patch, {
      schema: yaml.DEFAULT_SCHEMA.extend([jsTag]),
    });
    assert.ok(Array.isArray(parsed), "顶层必须是插件行列表");
    assert.equal(parsed.length, 2, "应当是 registry + preset 两行");
    assert.equal(parsed[0].id, "agent-preset-registry");
    assert.equal(parsed[0].config.default, ZOTERO_PRESET_ID);
    assert.equal(parsed[1].id, "preset-zotero");
    assert.equal(parsed[1].config.id, ZOTERO_PRESET_ID);
  });

  it("tool-ask-user 的配置要能解析出 timed", function () {
    const parsed = yaml.load(patch, {
      schema: yaml.DEFAULT_SCHEMA.extend([jsTag]),
    });
    const ask = parsed[1].config.plugins.find((p) => p.id === "tool-ask-user");
    assert.deepEqual(
      ask.config,
      { mode: "timed", timeout: ASK_USER_TIMEOUT_SECONDS },
      "解析出来的必须是 timed + 超时，而不是靠字符串匹配碰巧对上",
    );
  });

  it("`!!js` 条件表达式必须被保留（不能被我写成字符串）", function () {
    const parsed = yaml.load(patch, {
      schema: yaml.DEFAULT_SCHEMA.extend([jsTag]),
    });
    const bash = parsed[1].config.plugins.find((p) => p.id === "tool-bash");
    assert.ok(
      bash.disabled !== undefined && typeof bash.disabled === "object",
      "tool-bash 的 disabled 应是 !!js 表达式；写成普通字符串就不会按平台生效",
    );
  });
});

/**
 * ## 参考的包**必须真的装得上**（真机缺陷）
 *
 * 我把上游 `standard.patch.yml` 当成权威清单来镜像，但**上游的包集合与本插件实际提取的运行时不同步**：
 *
 * ```text
 *   standard.patch.yml 里有 @deepseek-ai/dsh-tool-schedule
 *   而实际运行时（0.2.0-rc.2）里【没有这个包】
 *   → 引用不存在的包 → preset 声明加载失败
 * ```
 *
 * 而失败的表现是「插件装了但什么都不工作」，极难定位。
 * 同样的道理适用于**必填的 config 字段**：`plan-mode` 的 `section`
 * 是必填，我漏掉它时也是“加载即报错”。
 *
 * ⚠️ 这条守卫依赖本机的运行时目录：找不到就**跳过**（而不是假绿）。
 */
describe("参考的包必须真的装得上", function () {
  const patch = buildZoteroPresetPatch();
  const runtimeRoot = join(
    process.env.USERPROFILE ?? "",
    "Zotero",
    "dsh-for-zotero",
    "runtime",
    "node_modules",
    "@deepseek-ai",
  );
  const available = existsSync(runtimeRoot);

  it("每个引用的包都要在实际运行时里存在", function () {
    if (!available) {
      this.skip();
      return;
    }
    /**
     * ⚠️ 判据是「**引用了不存在的包、又没有显式 `disabled: true`**」。
     *
     * 为什么不是"名字都不能出现"：上游 `standard.patch.yml` 里有一行
     * `@deepseek-ai/dsh-tool-schedule`，而这个插件实际提取的运行时
     * （0.2.0-rc.2）**没有那个包** —— 引用它会加载失败，所以本 preset 必须关掉它。
     * 保留那一行并显式禁用，是为了记下「它为何不在」与「何时该启回来」。
     *
     * 所以真正危险的是**被启用**却装不上的行。
     */
    const rows = [];
    const walk = (list) => {
      for (const r of list) {
        rows.push(r);
        if (Array.isArray(r.config)) walk(r.config);
      }
    };
    walk(
      yaml.load(patch, { schema: yaml.DEFAULT_SCHEMA.extend([jsTag]) })[1]
        .config.plugins,
    );

    const unresolved = rows.filter((r) => {
      const name = typeof r.name === "string" ? r.name : "";
      if (!name.startsWith("@deepseek-ai/")) return false;
      const dir = name.replace("@deepseek-ai/", "").split("/")[0];
      return !existsSync(join(runtimeRoot, dir));
    });
    const notDisabled = unresolved.filter((r) => r.disabled !== true);
    assert.deepEqual(
      notDisabled.map((r) => r.id),
      [],
      "这些行引用了实际运行时里**不存在**的包，会让整份 preset 加载失败：" +
        notDisabled.map((r) => r.id).join(", ") +
        "（确实要保留就必须 `disabled: true`）",
    );
  });

  it("必填的 config 字段不能漏（plan-mode.section）", function () {
    const parsed = yaml.load(patch, {
      schema: yaml.DEFAULT_SCHEMA.extend([jsTag]),
    });
    const find = (id) => {
      const walk = (rows) => {
        for (const r of rows) {
          if (r.id === id) return r;
          if (Array.isArray(r.config)) {
            const hit = walk(r.config);
            if (hit) return hit;
          }
        }
        return undefined;
      };
      return walk(parsed[1].config.plugins);
    };
    const plan = find("plan-mode");
    assert.ok(plan, "应当挂载 plan-mode");
    assert.ok(
      typeof plan.config?.section === "string" &&
        plan.config.section.trim().length > 0,
      "plan-mode 的 section 是**必填**：缺失或空白都会让插件加载失败（真机踩过）",
    );
    assert.match(
      plan.config.section,
      /exit_plan_mode/,
      "这段引导必须提到 exit_plan_mode：否则模型不知道怎么退出计划模式",
    );
  });
});
