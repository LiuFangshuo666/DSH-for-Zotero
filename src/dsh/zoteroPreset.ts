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
 * 要真正"结清"问题，得用 `answer` Remote 方法（带 `callId` 与结构化答案）。
 * 那是后续工作，**不是这个 preset 能解决的**。
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
 * 设得很短是**有意**的：本插件没有能 claim 那条等待的 Client，
 * 所以窗口越长，Agent 就越是"白等"。1 秒足够让"有原生客户端在场"的
 * 情形仍然立刻成交（那种情况下答案会立刻返回），同时在插件场景下
 * **几乎立刻**退化成 `pending`，Agent 继续干活。
 */
export const ASK_USER_TIMEOUT_SECONDS = 1;

/** 本 preset 的标识符（会话记录里保存的就是它） */
export const ZOTERO_PRESET_ID = "zotero";

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
    "- id: agent-preset-registry",
    "  name: '@deepseek-ai/dsh-agent-preset-registry'",
    "  config:",
    `    default: ${ZOTERO_PRESET_ID}`,
    "- id: preset-zotero",
    "  name: '@deepseek-ai/dsh-agent-preset'",
    "  config:",
    `    id: ${ZOTERO_PRESET_ID}`,
    "    name: Zotero 文献助手",
    "    description: 面向 Zotero 文献库的组合：保留读写与检索工具，提问不阻塞。",
    "    order: 1",
    "    plugins:",
    "      - id: persona",
    "        name: '@deepseek-ai/dsh-persona'",
    "        config:",
    "          prefix: >-",
    "            You are the literature assistant embedded in the user's Zotero library,",
    "            powered by the {{model}} model. The user is a researcher; the library is",
    "            their working corpus, not a scratch space.",
    "          suffix: >-",
    "            Working rules for this library.",
    "",
    "            - Ground every claim in what you actually read. Papers, notes, tags and",
    "              library metadata are readable; read before asserting, and say so when",
    "              you could not obtain a full text.",
    "            - You cannot call the Zotero API yourself. You act through the plugin",
    "              that hosts you; the exact tools and their arguments are in",
    "              `zotero/README.md` in the working directory. Read it before your first",
    "              library change.",
    "            - Writes are confined to the region this session was opened on, and",
    "              structural changes wait for the user's confirmation. Submit once, then",
    "              read `zotero/confirm-log.json` for the outcome instead of resubmitting.",
    "            - Prefer the plugin's own paper search over general web search when the",
    "              task is about literature: it runs on the user's network and reaches",
    "              their institutional subscriptions. General web search remains available",
    "              for everything else.",
    "      - id: agent-instructions",
    "        name: '@deepseek-ai/dsh-agent-instructions'",
    "        config:",
    "          maxBytes: 65536",
    "      - id: time-context",
    "        name: '@deepseek-ai/dsh-time-context'",
    "        config:",
    "          # ⚠️ 上游 preset **没有**配这一行，但它的 config 是存在的",
    "          # （`timeZone?` / `refreshIntervalMs?`，见 time-context/src/index.ts:56-67）。",
    "          #",
    "          # 为什么这里要钉时区：文献工作大量涉及**相对时间**",
    "          # （「最近 7 天」「本周新到的」「上个月读过的」）。不钉住的话",
    "          # 时区来自浏览器、缺失时退回**宿主进程时区**，而它可能不是用户所在时区 ——",
    "          # 对「今天」这类判断会直接算错。非法 IANA 值会在插件加载时抛错，",
    "          # 所以这个值必须是真实时区名。",
    "          timeZone: Asia/Shanghai",
    "          # 默认 600000（10 分钟）。文献会话的一轮通常比编码任务短，",
    "          # 10 分钟会让「现在几点」经常是陈旧的；1 分钟足够新，",
    "          # 又不像 0 那样每个 step 都注入（那会持续累积到压缩为止）。",
    "          refreshIntervalMs: 60000",
    "      - id: tool-bash",
    "        name: '@deepseek-ai/dsh-tool-bash'",
    "        disabled: !!js process.platform === 'win32'",
    "      - id: tool-pwsh",
    "        name: '@deepseek-ai/dsh-tool-pwsh'",
    "        disabled: !!js process.platform !== 'win32'",
    "      - id: tool-fs",
    "        name: '@deepseek-ai/dsh-tool-fs'",
    "      - id: tool-fs-search",
    "        name: '@deepseek-ai/dsh-tool-fs-search'",
    "        config:",
    "          sampleOverCapGlobResults: false",
    "      - id: tool-jobs",
    "        name: '@deepseek-ai/dsh-tool-jobs'",
    "      - id: tool-schedule",
    "        name: '@deepseek-ai/dsh-tool-schedule'",
    "      - id: skill-filesystem",
    "        name: '@deepseek-ai/dsh-skill-filesystem'",
    "      - id: tool-skill",
    "        name: '@deepseek-ai/dsh-tool-skill'",
    "        config:",
    "          # 默认 500。技能目录是**按描述做路由**的（只有 name 与截断后的",
    "          # description 会渲染进模型可见的目录，`whenToUse` 不渲染）。",
    "          # 把预算收紧会逼着描述写成「何时用」而不是「是什么」——",
    "          # 这在本插件的场景里尤其重要：技能少而场景明确，",
    "          # 描述写清触发条件比写全功能更有用。",
    "          catalogDescriptionMaxLength: 120",
    "      - id: command-goal",
    "        name: '@deepseek-ai/dsh-command-goal'",
    "      - id: tool-goal",
    "        name: '@deepseek-ai/dsh-tool-goal'",
    "      - id: planning",
    "        name: cordis:group",
    "        group: true",
    "        isolate:",
    "          planMode: true",
    "        config:",
    "          - id: plan-mode",
    "            name: '@deepseek-ai/dsh-plan-mode'",
    "      - id: compaction",
    "        name: cordis:group",
    "        group: true",
    "        isolate:",
    "          compaction: true",
    "          toolResultPruner: true",
    "        config:",
    "          - id: compaction-basic",
    "            name: '@deepseek-ai/dsh-compaction-basic'",
    "          - id: command-compact",
    "            name: '@deepseek-ai/dsh-command-compact'",
    "          - id: tool-result-pruner",
    "            name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
    "            config:",
    "              thresholdChars: 8192",
    "              headChars: 4096",
    "              tailChars: 1024",
    "      - id: delegation",
    "        name: cordis:group",
    "        group: true",
    "        isolate:",
    "          workflowEngine: true",
    "        config:",
    "          - id: tool-subagent-control",
    "            name: '@deepseek-ai/dsh-tool-subagent-control'",
    "          - id: tool-subagent-list-agents",
    "            name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'",
    "          - id: tool-subagent",
    "            name: '@deepseek-ai/dsh-tool-subagent'",
    "            config:",
    "              provider: spawn",
    "              toolName: subagent",
    "              modelSelectionSettings: true",
    "              toolFilter:",
    "                deny:",
    "                  - schedule_create",
    "                  - schedule_delete",
    "                  - schedule_list",
    "                  - schedule_update",
    "          - id: tool-subagent-fork",
    "            name: '@deepseek-ai/dsh-tool-subagent'",
    "            config:",
    "              provider: fork",
    "              toolName: subagent_fork",
    "              toolFilter:",
    "                deny:",
    "                  - schedule_create",
    "                  - schedule_delete",
    "                  - schedule_list",
    "                  - schedule_update",
    "          - id: workflow-ptc",
    "            name: '@deepseek-ai/dsh-workflow-ptc'",
    "            config:",
    "              provider: spawn",
    "          - id: tool-workflow",
    "            name: '@deepseek-ai/dsh-tool-workflow'",
    "      # ⚠️ **本 preset 与上游唯一的差异就在下面这一行。**",
    "      #",
    "      # 上游是阻塞式（`- id: tool-ask-user` + name，没有 config）。",
    "      # 阻塞式下本插件无法回答（见本文件顶部说明），Agent 会卡到用户点停止。",
    "      # timed + 极短超时 → 工具立刻返回 `{ pending: true, callId }`，",
    "      # Agent 继续下一步；用户的回答由插件 steer 进 inbox，下一步就能读到。",
    "      - id: tool-ask-user",
    "        name: '@deepseek-ai/dsh-tool-ask-user'",
    "        config:",
    "          mode: timed",
    `          timeout: ${ASK_USER_TIMEOUT_SECONDS}`,
    "      - id: tool-todo",
    "        name: '@deepseek-ai/dsh-tool-todo'",
    "        config:",
    "          allowParallelInProgress: true",
    "      - id: tool-web",
    "        name: '@deepseek-ai/dsh-tool-web'",
    "        config:",
    "          fetch: true",
    "          searchTimeoutMs: 60000",
    "      - id: present",
    "        name: '@deepseek-ai/dsh-tool-present'",
    "      - id: tool-plugin-manager",
    "        name: '@deepseek-ai/dsh-plugin-manager/tools'",
    "        disabled: true",
    "",
  ].join("\n");
}
