/**
 * **Zotero 专用的 Agent preset** —— 本插件自有的工具组合。
 *
 * ## 为什么需要它（真机缺陷：`ask_user_question` 会永久卡住）
 *
 * 用户报告："会话页面已经认为它的回答结束了（所以没有「停止生成」），
 * 于是我又往里敲了个 `1`…" 查下来是**架构性**问题：
 *
 * - `ask_user_question` 默认**阻塞等待**；
 * - 回答它的**唯一合法通道**是 dsh 的 answerer waterfall —— 也就是
 *   **原生 dsh 客户端的提问卡片**（它直接被派发到请求，`return` 的答案
 *   成为工具返回值）；
 * - 本插件的会话页**不在**那条瀑布里。它能读到问题（轮询 `session/page`），
 *   但"回答"只能通过 `session/prompt` 送进 turn 的 inbox ——
 *   而 inbox 的 `next-step` 要等**当前步结束**才被读，当前步却正卡在等这个工具。
 *
 * ```text
 *   Agent 阻塞在 ask_user_question
 *     → 要等工具 result 才走完当前步
 *     → 而回答进了"当前步完成后才读"的队列
 *     → 死锁（真机实测卡了 14 分钟，直到用户点停止）
 * ```
 *
 * ## 这个 preset 怎么解决
 *
 * 把 `tool-ask-user` 设成 **`mode: timed` + 很短的前台超时**：
 *
 * ```text
 *   没有 Client 接手 → 前台窗口到期 → 工具返回 { pending: true, callId }
 *                                  → Agent 【继续下一步】，不再卡住
 * ```
 *
 * 用户回答后，插件现有的 `steer` 路径把文本送进 inbox，
 * Agent 在下一步就能读到。
 *
 * ## ⚠️ 一个必须说清的语义限制（别误以为"回答被正确接收了"）
 *
 * 那条 steer 进来的是**普通用户消息**（`source.kind = "user"`），
 * **不是** `user-question-reply`。所以：
 *
 * - 模型能读到内容，工作能继续 —— **这是我们需要的**；
 * - 但问题在 projection 里**仍是 `continued`**，不会被标记为"已回答"。
 *
 * ## ⚠️ "让插件成为回答者"做不到（已实测，非推测）
 *
 * 直觉上最干净的修法是让插件**直接回答**那个提问，与原生 dsh 客户端一样。
 * 实测走不通，两条路都堵：
 *
 * | 路径 | 实测结果 |
 * | --- | --- |
 * | `answer` Remote 方法 | 宿主只暴露 `session/*` 与 `settings/*` 两类 RPC；`user-questions/answer`、`session/answer`、`answer` **全部 404** |
 * | 文件桥（写文件让 Agent 读） | Agent **正卡在等工具返回**，此刻它读不到任何文件；只有工具返回后才轮到它 |
 *
 * 第二条尤其值得记住：**文件桥解决不了"等人"的问题** ——
 * 因为阻塞中的 Agent 不在执行、无法轮询。
 *
 * ## 所以真正的机制是：**窗口 + 下一步送达**
 *
 * ```text
 *   Agent 提问
 *     → 前台窗口开着（ASK_USER_TIMEOUT_SECONDS），它在等
 *   ├─ 用户在窗口内回答 → steer 进 inbox → 窗口关闭、工具返回 pending
 *   │                                      → Agent 在【下一步】读到回答
 *   └─ 用户没回答       → 窗口到期 → 同样返回 pending → Agent 继续，并说明它的假设
 * ```
 *
 * ⚠️ 注意两个分支**对模型是同一个形状**（都是 `pending` 加一条用户消息）。
 * 所以"回答是否被当作回答"不取决于窗口长短，而取决于**窗口要够长，
 * 让用户来得及回答** —— 这就是 `ASK_USER_TIMEOUT_SECONDS` 取值 1 秒太短的真正原因：
 * 它把"等人"变成了"立刻放弃"，用户看到的选项卡片形同虚设。
 *
 * ## ⚠️ 代价：工具清单由我们维护
 *
 * dsh registry 文档（`agent-preset-registry/README.zh.md`）原文：
 *
 * > **用户覆盖替换完整子插件列表，不自动合并内置列表的未来更新。**
 *
 * 也就是说 dsh 以后新增/修改的工具**不会自动进入 Zotero 模式**。
 * 这份清单是 `dsh-web-app` 的 `presets/standard.patch.yml` 在某个时点的镜像，
 * 只改了 `tool-ask-user` 一行 —— **升级 dsh 时应当重新对照一次**。
 * 我们把差异压到最小（一行），就是为了让那次对照容易做。
 */

/**
 * 前台等待窗口（秒）。
 *
 * ## ⚠️ 必须很**短** —— 它不是「等人」的时间，而是「多久才告诉 Agent 没人答」
 *
 * 我在这个数字上**错了两次，而且是相反的方向**，所以把机制写清楚：
 *
 * | 窗口 | 结果 |
 * | --- | --- |
 * | 阻塞（无限） | **死锁**：回答进了 inbox，而 inbox 的 `next-step` 要等当前步结束；当前步却卡在等这个工具 —— 真机卡了 14 分钟 |
 * | 很**长**（120 秒） | **无谓的长卡顿**：回答早到也要等窗口到期，因为当前步同样要等工具返回 |
 * | 很**短**（3 秒） | 工具几乎立刻返回 `pending` → 当前步结束 → **下一步立刻读到回答** |
 *
 * 关键事实在 `user-questions/src/timed-wait.ts:36`：定时器**只在没人 claim 时跑**，
 * 而 `claims` 只由 `attach` 填充 —— **本插件从不调用 `attach`**（那是客户端的事），
 * 所以它**不可能提前结束**，只能等到期。
 *
 * 而「等人」本来就不靠这个窗口：工具返回 `pending` 后，插件仍在轮询 `session/page`，
 * 你的回答一到就会在**下一个步边界**被读到 —— 不需要长窗口。
 *
 * 取 3 秒而不是 0：给「原生客户端在场」那种情形留一点余地
 * （那种情况下它会 claim，答案直接成为工具返回值）。
 *
 * ## ⚠️ 窗口短了以后，真正的问题变成：**Agent 拿到 `pending` 之后干什么**
 *
 * 它必须**停下来等**，而不是自己猜一个继续干。那是人设（`suffix`）里的规则，
 * **不是这个窗口能解决的** —— 见下面 persona 的那条。
 */
export const ASK_USER_TIMEOUT_SECONDS = 3;

/** 本 preset 的标识符（会话记录里保存的就是它） */
export const ZOTERO_PRESET_ID = "zotero";

/**
 * ## ⚠️ 为什么**不**把本 preset 设成全局 `default`（真机事故）
 *
 * 我最初的写法是让 patch 覆盖 `agent-preset-registry` 的 `default: zotero`。
 * 后果：**所有会话都建不出来** ——
 *
 * ```json
 * {"code":"agent-preset/not-found","message":"Unknown agent preset: zotero",
 *  "details":{"available":["standard","ptc","minimal","cordis"]}}
 * ```
 *
 * 原因有两层：
 *
 * 1. `agent-preset-registry` 已经由 `dsh-web-app` 的 patch 注册过了
 *    （`default: standard`）。我再写一行同名注册，是**在覆盖别人的行**，
 *    而 registry 的默认值是**全局**的 —— 一旦指向的 preset 没挂载成功，
 *    就连「用默认值建会话」这条最基础的路都断了。
 * 2. preset 的挂载只在**宿主启动**时发生。那个 `default` 立刻生效、
 *    而 `preset-zotero` 还没注册 —— **两者不同步**，必然失败。
 *
 * 正确的做法是**插件自己显式指定**：建会话时带 `agentPreset: "zotero"`，
 * 失败就回退到不指定（用全局默认）。这样：
 *
 * - preset 没挂载成功 → 会话照建，只是用不上它（**降级而非崩溃**）；
 * - 挂载成功 → 自动用上，不需要改任何全局配置。
 *
 * ## ⚠️ 它是否真的挂载成功，**只能在宿主重启后验证**
 *
 * 插件无法查询 preset 列表（`agent-preset/list` 等 RPC 都是 404），
 * 所以唯一判据就是 `session/create` 的返回码 —— 这正是兜底存在的理由。
 */
export function presetRequest(): { agentPreset: string } {
  return { agentPreset: ZOTERO_PRESET_ID };
}

/**
 * 判断失败是否属于「本 preset **不可用**」（可安全回退到默认组合）。
 *
 * ## ⚠️ 必须同时认 `not-found` 与 `invalid`（真机事故）
 *
 * 我最初只认 `not-found`，理由是"其它错误不该被回退掩盖"。
 * 那个原则对，但**范围划错了**：
 *
 * 2026-10-17 用户升级到 0.2.1-rc.1 后**完全无法新建会话**，日志：
 *
 * ```text
 *   新建会话失败：agent-preset/invalid: tool-subagent (...):
 *   toolFilter is no longer supported; ...
 * ```
 *
 * 新版移除了 `toolFilter` 配置，而我的 preset 里还带着它 → preset 非法。
 * 而 `invalid` 不在回退清单里 → 一个**插件自身配置过时**的问题，
 * 变成了**用户连会话都建不出来**。
 *
 * 教训：回退的判据应当是「**这份 preset 用不了**」，而不是某一个错误码。
 * `invalid` 与 `not-found` 在这个意义上是同一类。其它错误（磁盘、权限、
 * 模型凭据）仍然照常抛出，不被掩盖。
 */
export function isPresetUnusable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "agent-preset/not-found" || code === "agent-preset/invalid";
}

/**
 * 生成 `cordis.patch.yml` 里声明 Zotero preset 的那一段（entry-list YAML）。
 *
 * ## 结构
 *
 * ```yaml
 * - id: agent-preset-registry
 *   name: '@deepseek-ai/dsh-agent-preset-registry'
 *   config:
 *     default: zotero                 # ← 新会话默认用我们这一套
 * - id: preset-zotero
 *   name: '@deepseek-ai/dsh-agent-preset'
 *   config:
 *     id: zotero
 *     order: 1
 *     plugins: [ … ]
 * ```
 *
 * ⚠️ **这个函数名与返回内容容易被误读**：它返回的是"插件行"（plugin row），
 * 不是顶层 `--patch` 条目 —— dsh 文档特意强调过这一点
 * （`tool-ask-user/README.zh.md`："以上片段是插件条目，不是顶层 `--patch` 条目"）。
 */
export function buildZoteroPresetPatch(): string {
  return [
    "# ── Zotero 专用 Agent preset ──────────────────────────────",
    "#",
    "# 工具清单镜像 dsh-web-app 的 presets/standard.patch.yml，**只改了一处**：",
    "# `tool-ask-user` 设为 timed + 极短超时，避免 Agent 阻塞在提问上永久卡住。",
    "# 详见 src/dsh/zoteroPreset.ts 的说明（含为什么插件无法回答阻塞式提问）。",
    "#",
    "# ⚠️ 这份清单**不会**自动跟随 dsh 的更新（registry 的已知限制），",
    "#    升级 dsh 时请对照上游 standard.patch.yml 重新核对一次。",
    "# ⚠️ **不要**写 agent-preset-registry 这一行！",
    "#",
    "# 它已经由 dsh-web-app 的 patch 注册过了（`default: standard`）。",
    "# 再写一行同名注册 = 覆盖别人的行，而那个 default 是**全局**的：",
    "# 一旦指向的 preset 没挂载成功，连「用默认值建会话」都会断掉。",
    "# （真机事故：这么写之后所有会话都建不出来，报 agent-preset/not-found）",
    "#",
    "# 本插件改为**建会话时显式指定** agentPreset，失败就回退（见 zoteroPreset.ts 的 presetRequest）。",
    "- insert:",
    "  - id: preset-zotero",
    "    name: '@deepseek-ai/dsh-agent-preset'",
    "    config:",
    `      id: ${ZOTERO_PRESET_ID}`,
    "      name: Zotero 文献助手",
    "      description: 面向 Zotero 文献库的组合：保留读写与检索工具，提问不阻塞。",
    "      order: 1",
    "      plugins:",
    "        - id: persona",
    "          name: '@deepseek-ai/dsh-persona'",
    "          config:",
    "            prefix: >-",
    "              You are the literature assistant embedded in the user's Zotero library,",
    "              powered by the {{model}} model. The user is a researcher; the library is",
    "              their working corpus, not a scratch space.",
    "            suffix: >-",
    "              Working rules for this library.",
    "  ",
    "              - When you need a decision from the user, ask with `ask_user_question` and then",
    "                STOP. Its result will say `pending`, with the built-in note that you may",
    '              "continue useful independent work". In this product that note is wrong: the',
    "                user is answering on a card right now, and the card is answered through the",
    "                conversation, so their reply arrives as your next message. Its other sentence",
    "                still holds and settles it - a pending result is not permission. So end your",
    "                turn with one line naming what you are waiting for. Do not guess the answer,",
    "                do not re-ask, and do not start other work.",
    "              - Ground every claim in what you actually read. Papers, notes, tags and",
    "                library metadata are readable; read before asserting, and say so when",
    "                you could not obtain a full text.",
    "              - You cannot call the Zotero API yourself. You act through the plugin",
    "                that hosts you; the exact tools and their arguments are in",
    "                `zotero/README.md` in the working directory. Read it before your first",
    "                library change.",
    "              - Do not route around those tools. Reading `zotero.sqlite`, unpacking the",
    "                plugin's .xpi, grepping the dsh runtime, and calling Zotero's local HTTP",
    "                API are all things a previous session actually did, and all of them are",
    "                wrong: the first three tell you nothing the tools do not, and the last",
    "                bypasses the user's confirmation and Zotero's undo stack.",
    "              - Writes are confined to the region this session was opened on, and",
    "                structural changes wait for the user's confirmation. Submit once, then",
    "                read `zotero/confirm-log.json` for the outcome instead of resubmitting.",
    "              - Prefer the plugin's own paper search over general web search when the",
    "                task is about literature: it runs on the user's network and reaches",
    "                their institutional subscriptions. General web search remains available",
    "                for everything else.",
    "        - id: agent-instructions",
    "          name: '@deepseek-ai/dsh-agent-instructions'",
    "          config:",
    "            maxBytes: 65536",
    "        - id: time-context",
    "          name: '@deepseek-ai/dsh-time-context'",
    "          config:",
    "            # ⚠️ 上游 preset **没有**配这一行，但它的 config 是存在的",
    "            # （`timeZone?` / `refreshIntervalMs?`，见 time-context/src/index.ts:56-67）。",
    "            #",
    "            # 为什么这里要钉时区：文献工作大量涉及**相对时间**",
    "            # （「最近 7 天」「本周新到的」「上个月读过的」）。不钉住的话",
    "            # 时区来自浏览器、缺失时退回**宿主进程时区**，而它可能不是用户所在时区 ——",
    "            # 对「今天」这类判断会直接算错。非法 IANA 值会在插件加载时抛错，",
    "            # 所以这个值必须是真实时区名。",
    "            timeZone: Asia/Shanghai",
    "            # 默认 600000（10 分钟）。文献会话的一轮通常比编码任务短，",
    "            # 10 分钟会让「现在几点」经常是陈旧的；1 分钟足够新，",
    "            # 又不像 0 那样每个 step 都注入（那会持续累积到压缩为止）。",
    "            refreshIntervalMs: 60000",
    "        - id: tool-bash",
    "          name: '@deepseek-ai/dsh-tool-bash'",
    "          disabled: !!js process.platform === 'win32'",
    "        - id: tool-pwsh",
    "          name: '@deepseek-ai/dsh-tool-pwsh'",
    "          disabled: !!js process.platform !== 'win32'",
    "        - id: tool-fs",
    "          name: '@deepseek-ai/dsh-tool-fs'",
    "        - id: tool-fs-search",
    "          name: '@deepseek-ai/dsh-tool-fs-search'",
    "          config:",
    "            sampleOverCapGlobResults: false",
    "        - id: tool-jobs",
    "          name: '@deepseek-ai/dsh-tool-jobs'",
    "        # ⚠️ **实际运行时里没有这个包**（已核实：@deepseek-ai 下 288 个包，",
    "        # 同作用域内 28 个只缺它一个）。引用不存在的包会让**整份 preset 声明加载失败**，",
    "        # 所以必须关掉。保留行而不是删除，是为了记录「它为何不在」以及「何时可以启回来」。",
    "        #",
    "        # 同时请注意：两条 tool-subagent 的 toolFilter.deny 里列了四个",
    "        # schedule_* 名字。本运行时（0.2.0-rc.2）既没有 dsh-tool-schedule、",
    "        # 也就没有那四个全局工具名，那份名单在本版本下是空操作；",
    "        # 但升到有该包的运行时后它会变得有意义 —— 到时请一并重新核对。",
    "        - id: tool-schedule",
    "          name: '@deepseek-ai/dsh-tool-schedule'",
    "          # 它无 config（包内没有 Config schema），唯一开关就是挂与不挂。",
    "          disabled: true",
    "        - id: skill-filesystem",
    "          name: '@deepseek-ai/dsh-skill-filesystem'",
    "        - id: tool-skill",
    "          name: '@deepseek-ai/dsh-tool-skill'",
    "          config:",
    "            # 默认 500。技能目录是**按描述做路由**的（只有 name 与截断后的",
    "            # description 会渲染进模型可见的目录，`whenToUse` 不渲染）。",
    "            # 把预算收紧会逼着描述写成「何时用」而不是「是什么」——",
    "            # 这在本插件的场景里尤其重要：技能少而场景明确，",
    "            # 描述写清触发条件比写全功能更有用。",
    "            catalogDescriptionMaxLength: 120",
    "        - id: command-goal",
    "          name: '@deepseek-ai/dsh-command-goal'",
    "        - id: tool-goal",
    "          name: '@deepseek-ai/dsh-tool-goal'",
    "        - id: planning",
    "          name: cordis:group",
    "          group: true",
    "          isolate:",
    "            planMode: true",
    "          config:",
    "            - id: plan-mode",
    "              name: '@deepseek-ai/dsh-plan-mode'",
    "              config:",
    `                section: 'You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user''s conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.
'`,
    "        - id: compaction",
    "          name: cordis:group",
    "          group: true",
    "          isolate:",
    "            compaction: true",
    "            toolResultPruner: true",
    "          config:",
    "            - id: compaction-basic",
    "              name: '@deepseek-ai/dsh-compaction-basic'",
    "            - id: command-compact",
    "              name: '@deepseek-ai/dsh-command-compact'",
    "            - id: tool-result-pruner",
    "              name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
    "              config:",
    "                thresholdChars: 8192",
    "                headChars: 4096",
    "                tailChars: 1024",
    "        - id: delegation",
    "          name: cordis:group",
    "          group: true",
    "          isolate:",
    "            workflowEngine: true",
    "          config:",
    "            - id: tool-subagent-control",
    "              name: '@deepseek-ai/dsh-tool-subagent-control'",
    "            - id: tool-subagent-list-agents",
    "              name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'",
    "            - id: tool-subagent",
    "              name: '@deepseek-ai/dsh-tool-subagent'",
    "              config:",
    "                provider: spawn",
    "                toolName: subagent",
    "                modelSelectionSettings: true",
    "            - id: tool-subagent-fork",
    "              name: '@deepseek-ai/dsh-tool-subagent'",
    "              config:",
    "                provider: fork",
    "                toolName: subagent_fork",
    "            - id: workflow-ptc",
    "              name: '@deepseek-ai/dsh-workflow-ptc'",
    "              config:",
    "                provider: spawn",
    "            - id: tool-workflow",
    "              name: '@deepseek-ai/dsh-tool-workflow'",
    "        # ⚠️ **本 preset 与上游唯一的差异就在下面这一行。**",
    "        #",
    "        # 上游是阻塞式（`- id: tool-ask-user` + name，没有 config）。",
    "        # 阻塞式下本插件无法回答（见本文件顶部说明），Agent 会卡到用户点停止。",
    "        # timed + 极短超时 → 工具立刻返回 `{ pending: true, callId }`，",
    "        # Agent 继续下一步；用户的回答由插件 steer 进 inbox，下一步就能读到。",
    "        - id: tool-ask-user",
    "          name: '@deepseek-ai/dsh-tool-ask-user'",
    "          config:",
    "            mode: timed",
    `            timeout: ${ASK_USER_TIMEOUT_SECONDS}`,
    "        - id: tool-todo",
    "          name: '@deepseek-ai/dsh-tool-todo'",
    "          config:",
    "            allowParallelInProgress: true",
    "        - id: tool-web",
    "          name: '@deepseek-ai/dsh-tool-web'",
    "          config:",
    "            fetch: true",
    "            searchTimeoutMs: 60000",
    "        - id: present",
    "          name: '@deepseek-ai/dsh-tool-present'",
    "        - id: tool-plugin-manager",
    "          name: '@deepseek-ai/dsh-plugin-manager/tools'",
    "          disabled: true",
    "        # 0.2.1-rc.1 新增的一行（0.2.0-rc.2 没有这个包 → 必须 disabled，",
    "        # 否则旧版用户会因「引用不存在的包」让整份 preset 加载失败）",
    "        - id: tool-plugin-market",
    "          name: '@deepseek-ai/dsh-plugin-market/tools'",
    "          disabled: true",
  ].join("\n");
}
