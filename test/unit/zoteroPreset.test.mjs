/**
 * ## Zotero 专用 preset
 *
 * ## 真机事故：**不能**把本 preset 设成全局 `default`
 *
 * 我最初的写法是让 patch 覆盖 `agent-preset-registry` 的 `default: zotero`。
 * 后果：**所有会话都建不出来** ——
 *
 * ```json
 * {"code":"agent-preset/not-found","message":"Unknown agent preset: zotero",
 *  "details":{"available":["standard","ptc","minimal","cordis"]}}
 * ```
 *
 * 两层原因：
 *
 * 1. `agent-preset-registry` 已经由 `dsh-web-app` 的 patch 注册过（`default: standard`）。
 *    再写一行同名注册是**覆盖别人的行**，而那个 default 是**全局**的；
 * 2. preset 的挂载**只在宿主启动时**发生，而 default 立刻生效 ——
 *    必然出现「默认指向一个还没注册的 preset」的窗口。
 *
 * 现在：patch 里**只有** preset 声明一行；插件建会话时**显式请求**它，
 * 拿不到就回退（见 `createSessionPreferringPreset`）。
 *
 * ## 配置事实（每个都核实过源码）
 *
 * - `plan-mode` 的 `section` 是**必填、无默认** —— 我漏过一次，加载即失败。
 * - `@deepseek-ai/dsh-tool-schedule` 在**实际运行时里不存在**。
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = await import(
  new URL(
    `file://${join(here, ".build", "unit-entry.mjs").replace(/\\/g, "/")}`,
  ).href
);
const {
  buildZoteroPresetPatch,
  ASK_USER_TIMEOUT_SECONDS,
  ZOTERO_PRESET_ID,
  presetRequest,
  isPresetNotFound,
} = bundle;

/** Cordis 的 entry-list 方言带 `!!js` 标签（上游也用），普通解析器会报 unknown tag */
const jsTag = new yaml.Type("tag:yaml.org,2002:js", {
  kind: "scalar",
  resolve: () => true,
  construct: (value) => ({ js: value }),
});
const parsePatch = () =>
  yaml.load(buildZoteroPresetPatch(), {
    schema: yaml.DEFAULT_SCHEMA.extend([jsTag]),
  });
/** patch 里唯一那一行 preset 声明 */
const presetRow = () => parsePatch().find((r) => r.id === "preset-zotero");
/** 展开组内的子插件（cordis:group 的 config 是数组） */
const pluginsOf = (row) =>
  row.config.plugins.flatMap((p) =>
    Array.isArray(p.config) ? [p, ...p.config] : [p],
  );

describe("Zotero 专用 preset", function () {
  it("**不得**再写 agent-preset-registry 行（那会让所有会话建不出来）", function () {
    const parsed = parsePatch();
    assert.ok(
      !parsed.some((r) => r.id === "agent-preset-registry"),
      "patch 里不能出现 agent-preset-registry：它已由 dsh-web-app 注册，" +
        "覆盖它的 default 会导致 preset 尚未挂载时**所有会话都建不出来**（真机事故）",
    );
    assert.equal(parsed.length, 1, "patch 里应当只有 preset 声明这一行");
    assert.equal(parsed[0].id, "preset-zotero");
  });

  it("应当是**显式请求 + 可回退**，而不是改全局默认", function () {
    assert.deepEqual(
      presetRequest(),
      { agentPreset: ZOTERO_PRESET_ID },
      "建会话时要显式带上 agentPreset",
    );
    assert.equal(ZOTERO_PRESET_ID, "zotero");
  });

  it("回退判据只认 not-found，其它错误不得被掩盖", function () {
    assert.equal(
      isPresetNotFound({ code: "agent-preset/not-found" }),
      true,
      "preset 未挂载应当回退",
    );
    assert.equal(isPresetNotFound({ code: "gateway/internal" }), false);
    assert.equal(isPresetNotFound(new Error("disk full")), false);
    assert.equal(isPresetNotFound(undefined), false);
    assert.equal(isPresetNotFound(null), false);
    assert.equal(isPresetNotFound("agent-preset/not-found"), false);
  });

  it("**`tool-ask-user` 必须是 timed，且窗口很短**", function () {
    const ask = pluginsOf(presetRow()).find((p) => p.id === "tool-ask-user");
    assert.ok(ask, "应当挂载 tool-ask-user");
    assert.equal(ask.config?.mode, "timed");
    /**
     * ⚠️ 上界守卫。我在这个数字上错了两次，方向相反：
     * 阻塞 → 死锁（真机 14 分钟）；改 120 秒 → 无谓长卡顿。
     *
     * 关键在 `timed-wait.ts:36`：定时器**只在没人 claim 时跑**，
     * 而 `claims` 只由 `attach` 填充 —— 本插件从不调用它，
     * 所以窗口**不可能提前结束**，只能等到期。而「等人」不靠窗口
     * （`pending` 之后插件仍在轮询 `session/page`）。
     */
    assert.equal(
      ask.config.timeout,
      ASK_USER_TIMEOUT_SECONDS,
      "超时值必须真的写进 patch",
    );
    assert.ok(
      ASK_USER_TIMEOUT_SECONDS <= 10,
      "窗口必须很短（≤10 秒）：它只是「多久才告诉 Agent 没人答」",
    );
    assert.ok(
      ASK_USER_TIMEOUT_SECONDS >= 1,
      "也不该是 0：留余地给「原生客户端在场」那种情形（它会 claim）",
    );
  });

  it("其余工具必须与上游镜像（差异只有那几处有意的）", function () {
    const ids = new Set(pluginsOf(presetRow()).map((p) => p.id));
    for (const id of [
      "persona",
      "agent-instructions",
      "time-context",
      "tool-pwsh",
      "tool-fs",
      "tool-fs-search",
      "tool-jobs",
      "skill-filesystem",
      "tool-skill",
      "tool-todo",
      "tool-web",
      "present",
      "tool-plugin-manager",
      "planning",
      "compaction",
      "delegation",
      "compaction-basic",
      "tool-subagent",
      "tool-workflow",
    ]) {
      assert.ok(ids.has(id), `镜像里缺少 ${id} —— 用户选的是「完整镜像」`);
    }
  });

  it("`!!js` 平台条件必须被保留（不能被我写成字符串）", function () {
    const bash = pluginsOf(presetRow()).find((p) => p.id === "tool-bash");
    assert.ok(
      bash && typeof bash.disabled === "object",
      "tool-bash 的 disabled 应是 !!js 表达式；写成普通字符串就不会按平台生效",
    );
  });
});

/**
 * ## 生成的 YAML 必须真的能被解析
 *
 * 它会写进 `cordis.patch.yml` 并被宿主读取。一个缩进错误 = 组合失败，
 * 而那时的表现是「插件装了但什么都不工作」，极难定位。
 */
describe("preset 的 YAML 可解析性", function () {
  it("必须是单行声明，且 id 正确", function () {
    const parsed = parsePatch();
    assert.ok(Array.isArray(parsed), "顶层必须是插件行列表");
    assert.equal(parsed[0].id, "preset-zotero");
    assert.equal(parsed[0].config.id, ZOTERO_PRESET_ID);
  });

  it("tool-ask-user 的配置要能解析出 timed", function () {
    const ask = pluginsOf(presetRow()).find((p) => p.id === "tool-ask-user");
    assert.deepEqual(ask.config, {
      mode: "timed",
      timeout: ASK_USER_TIMEOUT_SECONDS,
    });
  });

  it("必填的 config 字段不能漏（plan-mode.section）", function () {
    const plan = pluginsOf(presetRow()).find((p) => p.id === "plan-mode");
    assert.ok(plan, "应当挂载 plan-mode");
    assert.ok(
      typeof plan.config?.section === "string" &&
        plan.config.section.trim().length > 0,
      "plan-mode 的 section 是**必填**：缺失或空白都会让插件加载失败（真机踩过）",
    );
    assert.match(
      plan.config.section,
      /exit_plan_mode/,
      "这段引导必须提到 exit_plan_mode",
    );
  });
});

/**
 * ## 引用的包必须真的装得上
 *
 * 我把上游 `standard.patch.yml` 当成权威清单来镜像，但上游的包集合与本插件
 * 实际提取的运行时**不同步**：上游有 `@deepseek-ai/dsh-tool-schedule`，
 * 而运行时里没有。引用不存在的包 → preset 声明加载失败。
 *
 * 判据是「**启用了**却不存在的行」；确实要保留的必须显式 `disabled: true`。
 *
 * ⚠️ 这条守卫依赖本机的运行时目录：找不到就**跳过**（而不是假绿）。
 */
describe("参考的包必须真的装得上", function () {
  const runtimeRoot = join(
    process.env.USERPROFILE ?? "",
    "Zotero",
    "dsh-for-zotero",
    "runtime",
    "node_modules",
    "@deepseek-ai",
  );

  it("启用中的行，其包必须在运行时里存在", function () {
    if (!existsSync(runtimeRoot)) {
      this.skip();
      return;
    }
    const unresolved = pluginsOf(presetRow()).filter((r) => {
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
        `${notDisabled.map((r) => r.id).join(", ")}（要保留就必须 disabled: true）`,
    );
  });

  it("tool-schedule 必须被显式禁用（该包在本运行时不存在）", function () {
    const row = pluginsOf(presetRow()).find((r) => r.id === "tool-schedule");
    assert.ok(row, "这一行应保留（记下它为何不在）");
    assert.equal(
      row.disabled,
      true,
      "@deepseek-ai/dsh-tool-schedule 在实际运行时里不存在，" +
        "启用它会让整份 preset 加载失败",
    );
  });
});
