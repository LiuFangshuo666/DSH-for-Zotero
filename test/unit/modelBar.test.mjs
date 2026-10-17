/**
 * ## 会话页的「模型 / 推理强度」条：三条纪律
 *
 * 这一节是从设置页搬过来的（用户要求"每个会话、每个轮次可以选择不同的
 * 模型和推理强度"）。搬的时候有三件事必须守住，下面各一条守卫。
 *
 * ### ① 选项只能来自宿主目录
 *
 * 写死一份模型/等级清单，会在模型或等级变化后给出宿主**根本不接受**的取值 ——
 * 而那种失败是**静默的**：`selectModel` 抛错，用户只看到"没生效"。
 * 项目里已经因为"写死候选值"踩过一模一样的坑（见 preferences.xhtml 的注释）。
 *
 * ### ② 老插件必须整条隐藏，而不是显示一个点了报错的控件
 *
 * 真机上"控件在、点了报能力不可用"比"没有这个控件"更难理解。
 *
 * ### ③ 空值必须表示"用模型默认等级"，且**不能**把空串传给宿主
 *
 * `selectModel` 收到空串会当成无效的 `ReasoningEffortId` 而抛错（真机踩过）。
 * 所以页面在空值时必须**省略** `reasoningEffort` 字段。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const page = readFileSync(
  join(root, "addon", "content", "sessionPage.js"),
  "utf8",
);
const xhtml = readFileSync(
  join(root, "addon", "content", "session.xhtml"),
  "utf8",
);

describe("会话页的模型 / 推理强度选择", function () {
  it("必须有一条模型栏，且默认隐藏（等目录到了再显示）", function () {
    assert.match(xhtml, /id="model-bar"/, "session.xhtml 必须有模型栏");
    assert.match(xhtml, /id="model-select"/, "必须有模型下拉");
    assert.match(xhtml, /id="effort-select"/, "必须有推理强度下拉");
    // 默认 display:none —— 目录取不到（或老插件）时不该露出一个空控件
    const bar = xhtml.slice(xhtml.indexOf('id="model-bar"'));
    assert.match(
      bar.slice(0, 400),
      /display:\s*none/,
      "模型栏默认必须隐藏，由目取到后再显示",
    );
  });

  it("**不得写死**模型 id 或推理等级 id", function () {
    // 只允许出现"从目录里读"的字段名，不允许出现具体取值。
    // 例如 deepseek-flash / off / low / high / max 这些具体 id。
    const forbidden = [
      "deepseek-flash",
      "deepseek-chat",
      "deepseek-reasoner",
      '"max"',
      "'max'",
      '"high"',
      "'high'",
    ];
    const hits = forbidden.filter((token) => page.includes(token));
    assert.deepEqual(
      hits,
      [],
      "会话页不得写死模型/等级取值：" +
        hits.join("、") +
        " —— 必须从 capability.getModelCatalog() 读（写死会静默失效）",
    );
  });

  it("老插件（没有 getModelCatalog）时整条隐藏，不报错", function () {
    // capabilityFromGlobal 里做了 typeof 守卫，renderModelBar 里再判一次
    assert.match(
      page,
      /typeof capability\.getModelCatalog !== "function"/,
      "renderModelBar 必须探测方法是否存在，缺失时直接返回（保持隐藏）",
    );
    assert.match(
      page,
      /typeof api\.getModelCatalog === "function"/,
      "全局入口里也要有守卫（老插件没有这个方法）",
    );
  });

  it("空推理等级必须**省略字段**，不能传空串给宿主", function () {
    assert.match(
      page,
      /reasoningEffort:\s*effort\s*\|\|\s*undefined/,
      "页面必须把空值转成 undefined —— 传空串会被宿主当成无效的 ReasoningEffortId",
    );
  });

  it("顶部要说明「改动对下一轮生效」（避免用户以为要重开会话）", function () {
    assert.match(
      page,
      /下一轮起|下一轮生效/,
      "必须告诉用户改动何时生效 —— dsh 的 selectForNextRequest 是对下一次请求生效",
    );
  });
});
