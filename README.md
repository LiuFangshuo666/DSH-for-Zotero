# DSH-for-Zotero

**中文** · [English](README.en.md)

把 **DeepSeek Harness（dsh）的 Agent** 放进 Zotero：它看得见你的论文全文与划注，能回答、翻译、解释、追问，也能**直接读写你的文献库**（改标签、加笔记、建条目），并把结果落回 Zotero。

> **Zotero 里的第二个主人。** 不是"聊天窗口 + 复制粘贴"，而是一个有完整工具、能真正操作文献库的 Agent —— 但**删除与新建条目始终要你点确认**。

- 目标宿主：**Zotero 10.x**（`strict_min_version: 10.0`，只支持 10）
- Agent 引擎：**[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)**（由插件自己拉起的**隔离实例**：独立 `DSH_HOME`、独立端口、独立凭据）
- 模型与凭据：**可在插件设置页里直接填**（API Key、API 地址、推理等级、以及任意第三方 provider）—— 没填则沿用你桌面版 dsh 的配置
- **数据不出本机**：插件只与本机 `127.0.0.1` 上的 dsh 通信

| 仓库                      | 地址                                               | 说明                         |
| ------------------------- | -------------------------------------------------- | ---------------------------- |
| GitHub（主仓库 / 上架用） | <https://github.com/LiuFangshuo666/DSH-for-Zotero> | 插件市场收录要求 GitHub 仓库 |
| Gitee（国内镜像）         | <https://gitee.com/laofashi666/dsh-for-zotero>     | 自动更新的清单默认指向这里   |

> 两边内容一致，任选其一。国内访问 GitHub 不稳定时用 Gitee。

许可证 **MIT**（第三方声明见 [LICENSE](LICENSE)）。

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [能做什么](#能做什么)
- [安装](#安装)
- [使用](#使用)
- [设置项](#设置项)
- [工作原理](#工作原理)
- [开发](#开发)
- [排障](#排障)
- [项目文档](#项目文档)

---

## 它解决什么问题

读文献时最费时间的不是"读懂一段话"，而是**围绕一篇文献的重复动作**：

- 想按主题整理标签，得逐条想、逐条打；
- 想知道"这个分类里哪几篇在解决同一个问题"，得自己翻摘要；
- 读到某段不懂，切出去问模型，再把答案粘回笔记 —— 上下文全丢了。

这些动作的共同点是：**都要读写文献库本身**。所以这个插件不是"把模型接进来聊天"，而是**给 Agent 一套操作文献库的工具**，让它在库里干活。

## 能做什么

| 能力           | 说明                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| **读**         | 搜索、读条目元数据、列分类树、读笔记、**读论文原文**（`getFullText`，按需分段，长文不必一次读完）                 |
| **找论文**     | **在外部数据库检索并取全文**（`findPaper`）—— 走**你本机的网络与机构订阅**，不是模型服务端                        |
| **写**         | 改标签、加笔记、加入分类 —— 直接执行，**进 Zotero 撤销栈**（`Ctrl+Z` 可撤）                                       |
| **结构性改动** | **新建条目**、**补全文**（`attachPdf`）与**删除** —— 不直接执行，登记为待确认，会话页顶部出现黄色角标由你逐条确认 |
| **会话**       | **独立会话**（工作区 = 一个分类）与**条目会话**（工作区 = 一篇文献）                                              |
| **挂载**       | 会话是一个**真实的 Zotero 附件**（网页链接），双击即在 Zotero 内打开可交互界面                                    |
| **回写**       | 任何一条回答都可一键**存为笔记**（条目会话落到条目下，独立会话落到分类下）                                        |

### 找论文并取全文（`findPaper`）

论文由自建的 `findPaper` 负责，**web search 仍然保留**（查会议、作者主页、项目页、
新闻这类线上资讯时它有用）。两者是**分工**：

|            | dsh 的 web_search                     | 本插件的 findPaper                                |
| ---------- | ------------------------------------- | ------------------------------------------------- |
| 适用       | 各类线上资讯                          | **论文**（元数据 + 全文）                         |
| 网络出口   | 模型服务端                            | **你本机**（`Zotero.HTTP`，带你的 cookie 与代理） |
| 机构订阅   | ❌ 看不见 —— 那基于来源 IP / 机构代理 | ✅ 用得上                                         |
| 返回内容   | 网页摘要                              | **结构化元数据**（标题/作者/年份/期刊/DOI/摘要）  |
| 能否建条目 | ❌ 够不到 `Zotero.Items`              | ✅ 直接建条目并挂全文                             |
| 能否取全文 | ❌                                    | ✅ 见下                                           |

流程（你只需说人话，Agent 会走这两步）：

```text
1. findPaper   在 Crossref / DataCite 里检索 → 拿回候选与 DOI
2. createItem  用那个 DOI 建条目（待你确认）
        ↓
   你点「确认」后，插件用你的网络去取全文 PDF 并挂成附件
```

> **为什么两个数据源**：绝大多数期刊/会议论文的 DOI 注册在 **Crossref**，
> 而 **arXiv、Zenodo、机构库**的注册在 **DataCite**。只查一个会漏掉一整类论文 ——
> 真机上查 arXiv 的 `10.48550/arXiv.1706.03762` 就查不到，而模型不会就此停下，
> 它会从近似结果里挑一条，于是把**错的 DOI 与年份**写进库里。

取全文的顺序（**按确定性从高到低**，与 `paperFetch.ts` 的实现一致）：

1. 明确给了 `pdfUrl` 时**先试直链** —— 这是调用方已经知道确切地址的情况，最确定；
2. `Zotero.Attachments.addAvailableFile()` —— **Zotero 自己的解析链**：
   跟随 DOI 到出版社、你的自定义解析器、开放获取。这是"用你的机构访问"的落点；
3. 开放获取直链（OpenAlex）—— 覆盖"没有订阅但有 OA 版"的情况。

> 📌 这三条的顺序先前在 README 里写反了（把最确定的直链排在最后）。
> 代码一直是"直链 → 解析链 → OpenAlex"，以 `src/dsh/paperFetch.ts` 的
> `attachBestPdf` 为准。

> ⚠️ **取全文可能几十秒**（跟随 DOI 跳转、机构代理认证），而且**失败不算建条目失败** ——
> 条目会正常建好，只是在确认结果里说明没拿到全文。这种情况下可在 Zotero 里
> 右键条目「查找可用 PDF」手动再试。

### 安全边界

用户可配置的边界是"**读 + 写自由，仅删除需确认**"。实现上：

- **读**：按 `key` 查找，**允许跨文库**（读不设范围限制）；
- **写**：**严格限定在会话范围内**（分类会话 = 该分类下的条目）—— 这是"第二主人"与"失控"之间的界线。
  ⚠️ **`attachPdf`（补全文）也受这条限制**：它会在库里新增附件条目，属结构性改动；
  拿别处的 key 去补会失败（`getFullText` 能跨库读，但它不能跨库写）；
- **结构性改动**（新建条目 / **补全文** / 删除）：**不立即执行**，由你在界面上逐条确认。
  ⚠️ 例外：**删除不做会话范围校验** —— 它的防线是"你逐条确认"，不是作用域。

## 安装

**前置**：本机需装有 **DeepSeek Harness 桌面端**。插件要从它那里提取一份**隔离运行时**（首次约 330 MB，10–30 秒），因此它不是可选项。

1. **装插件**：Zotero → **工具 → 插件** → 右上齿轮 → _Install Plugin From File…_ → 选 `dsh-for-zotero.xpi`。
2. **完全退出并重启 Zotero**（Zotero 不会热加载已安装的 xpi）。
3. **首次启动**：会弹一个**新手引导**说明它在准备什么；同时有进度窗口显示提取阶段。
4. **等就绪**：`设置 → DSH-for-Zotero → 隔离运行时` 里状态显示 `running` 即可用。

> ⚠️ **只有通过"插件"界面安装才会注册**。把 xpi 直接丢进 profile 的 `extensions/` 目录**不会**生效（Zotero 靠 `extensions.json` 记录，那个文件只能由安装流程写入）。

## 使用

### 建会话

两种会话的**工作区不同**，这决定了 Agent 看得到什么：

| 会话类型     | 怎么建                                     | 工作区内容                                                   |
| ------------ | ------------------------------------------ | ------------------------------------------------------------ |
| **独立会话** | 文献库界面 **右键一个分类 → 新建独立会话** | 该分类的条目清单（`collection.md`：key/标签/摘要）           |
| **条目会话** | **右键一个条目 → 新建会话**                | 该篇的元数据与全文（`meta.json` + 分块 `paper.part-NN.txt`） |

> 独立会话**也能读单篇正文** —— 让 Agent 用 `getFullText` 即可，**不需要**另建条目会话。

### 和它说话

会话里直接说人话即可（没有"必须先点某个按钮"的流程）：

```
把这个分类里的论文按主题聚类，输出一份研究地图
给「网表表示学习」那几篇加上统一的标签，先给我看方案再写
用 getFullText 读一下 RTL 那篇，和这篇的方法有什么差别
把刚才的结论存成笔记
```

### 待确认的改动

Agent 提交新建/删除后，**会话页顶部会出现黄色角标**：

```
⚠ 有 2 项改动等你确认（点这里展开/收起）
```

点开可逐条**确认**或**忽略**；确认前条目不存在（新建）/ 还在（删除）。

### 存为笔记

每条回答下方有「存为笔记」按钮 —— 条目会话落到该条目下，独立会话落到该分类下。

## 设置项

设置页**六节**（按界面里的实际顺序）：

| 节                      | 内容                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| **隔离运行时**          | 隔离端口、Harness 安装目录、运行时状态（准备 / 启动 / 停止）                                |
| **自检**                | 一键检查运行时/认证/模型调用；结果也写入 `dsh-for-zotero-selfcheck.txt`；含「新手引导」按钮 |
| **阅读器侧栏面板**      | 分块大小、首次发送确认、流式显示、回答语言、高亮颜色、自定义指令（**会话页不读取这些**）    |
| **模型**                | **API Key、API 地址、会话使用的模型、推理等级** —— 见下节                                   |
| **自定义模型 provider** | 接 GLM / Moonshot / Qwen / 自建端点等第三方模型 —— 见下节                                   |
| **高级**                | 请求超时、安装伴读 skill、写入常驻指令                                                      |

> **两个"dsh 侧"开关默认关闭**。打开后需在「自检」里跑一次自检才会写入
> `<DSH_HOME>/skills/` 与 `<DSH_HOME>/AGENTS.md`；之后每次启动会自动保持最新。

### 配置模型（「模型」一节）

隔离实例第一次启动时会从你桌面版 Harness **复制一份模型凭据**。所以：

- **装过桌面版 dsh 且配好了** → 插件开箱可用，**这一节什么都不用改**
- **没装过桌面版，或装了没登录/没配 Key** → 在这里直接填

| 项                   | 说明                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------ |
| **DeepSeek API Key** | 点「保存并写入」写入隔离实例的 `.credentials.yaml`。**填了就优先用你的**，留空则沿用桌面版 |
| **API 地址（可选）** | 换端点（中转站 / 私有部署 / 企业网关）。留空用 DeepSeek 官方                               |
| **会话使用的模型**   | 点「刷新列表」从宿主读取**当前可用的模型**，选一个即可                                     |
| **推理等级**         | 随所选模型**动态变化**（等级由模型自己声明）。「（模型默认）」表示不干预                   |

> ⚠️ **「API 地址」换的是发往哪里，不是换协议。** 它对应 DeepSeek 适配器，
> 说的是 **Anthropic Messages** 协议。要接 **OpenAI 兼容**端点（如 GLM 的
> `/api/v1`），请看下一节。

### 接第三方模型（「自定义模型 provider」一节）

这一节会额外挂载 dsh 的 **`llm-pi-ai`** 适配器，支持三种协议：

| 协议取值             | 适用                                                      |
| -------------------- | --------------------------------------------------------- |
| `openai-completions` | 绝大多数第三方与自建端点（**GLM 的 `/api/v1` 属于这种**） |
| `anthropic-messages` | Anthropic 协议端点（GLM 的 `/api/anthropic`、部分中转站） |
| `openai-responses`   | OpenAI Responses 协议                                     |

填一个 **JSON 数组**（点「填入示例」可直接得到一份再改）：

```json
[
  {
    "route": "glm",
    "api": "openai-completions",
    "baseURL": "https://open.bigmodel.cn/api/v1",
    "apiKey": "你的 key",
    "displayName": "智谱 GLM",
    "models": [{ "id": "glm-4.7", "name": "GLM-4.7" }]
  }
]
```

| 字段          | 必填 | 说明                                                                 |
| ------------- | ---- | -------------------------------------------------------------------- |
| `route`       | ✅   | 路由名，小写字母/数字/连字符。它同时是模型选择器里显示的 provider 名 |
| `api`         | ✅   | 上表三种协议之一                                                     |
| `baseURL`     | ✅   | API 根地址（http/https，不能带查询参数或 `#`）                       |
| `apiKey`      | —    | 该端点的 Key；写入 `.credentials.yaml` 的 `refs.<自动派生名>`        |
| `displayName` | —    | 界面显示名                                                           |
| `models`      | ✅   | 至少一个；`id` 必填，`name` / `contextWindow` / `maxTokens` 可选     |

保存后：provider 配置写进隔离实例的 `cordis.patch.yml`，Key 写进 `.credentials.yaml`。

> ⚠️ **改动 provider 列表需要重启隔离运行时**（profile 的组合发生在宿主启动时）。
> 设置页会对比磁盘与实际定义，直接告诉你「是否需要重启」。

## 工作原理

理解这张图就能看懂大部分代码：

```
┌─────────────────────────────┐         ┌──────────────────────────────┐
│  Zotero（插件在这里跑）      │         │  dsh 宿主（独立进程）         │
│                             │         │                              │
│  sessionPane.ts             │  HTTP   │  Agent 循环                  │
│   ├─ 右键菜单 / 挂载附件     │◀───────▶│   ├─ 模型调用                │
│   ├─ 工作区材料生成          │  RPC    │   └─ shell / 文件工具        │
│   └─ 工具轮询与执行 ─────────┼──┐      │                              │
│                             │  │      └──────────────────────────────┘
└─────────────────────────────┘  │                    ▲
                                 │  文件（请求/应答）  │
                                 └────────────────────┘
                                     <workspace>/zotero/
                                       call.json  ← Agent 写
                                       result.json ← 插件写
```

### 三个关键设计

**① 为什么是"文件"而不是真正的 RPC（给 Agent 调 Zotero）**

`Zotero.Items` 这类 API **只能在 Zotero 进程内**调用，而 Agent 跑在独立的 dsh 进程里 —— 它够不到。

于是用会话工作区里的两个文件当传输层：Agent 写 `zotero/call.json`，插件轮询到后执行、把结果写进 `zotero/result.json`。语义上是**真正的 tool 调用**（有请求 id、返回值、错误信息，Agent 可以迭代修正），只是通道换成了文件。

> 文件式是**刻意的选择**，不是沙箱所迫：调用与结果都留在工作区里，用户能直接看懂 Agent 做了什么。

**② 为什么插件自己拉一份运行时**

直接连你桌面版的 dsh 会让两边的会话、凭据、工作区互相污染。所以插件从本机 Harness 提取一份**隔离实例**（独立 `DSH_HOME` / 端口 / 凭据）—— 你桌面版的 dsh 完全不受影响。

隔离实例的**端口与 HOME 由运行时管理器给出，不由设置项决定**：否则设置与实际监听的端口不一致时，会得到难以理解的连接失败。

**③ 为什么"独立会话"的工作区是分类而不是会话**

dsh 会话的 `cwd` 在**创建那一刻固定**，之后不可更改。所以工作区必须按**范围**（分类 / 条目）确定，与会话 id 无关 —— 这也让同一分类的多个会话共享材料，不必重复提取。

## 开发

### 环境

- **Node.js 20+**（本项目在 Node 24 上开发）
- **Zotero 10**（跑集成测试与热重载需要）
- **DeepSeek Harness 桌面端**（插件要从它提取运行时）

```powershell
git clone <repo>
cd dsh-for-zotero
npm install

# 复制环境模板，按本机情况修改
copy .env.example .env
```

`.env` 至少要填 Zotero 可执行文件与一个**独立的开发 profile**
（不要用你的日常文献库 —— 插件会往里写条目）：

```dotenv
ZOTERO_PLUGIN_ZOTERO_BIN_PATH = C:\Program Files\Zotero\zotero.exe
ZOTERO_PLUGIN_PROFILE_PATH    = C:\path\to\dev-profile
```

### 常用命令

```powershell
npm run build        # 构建 xpi（含 tsc --noEmit 类型检查）
npm run test:unit    # 单元测试（纯逻辑，不需要 Zotero）
npm run lint:check   # prettier --check + eslint
npm run lint:fix     # 自动修复格式

npm run verify       # 一次跑完：构建 + 单测 + 产物核验 ← 提交前跑这个

npm start            # 开发模式：构建 + 启动 Zotero + 热重载
npm test             # 集成测试（**需要真实 Zotero + 图形环境**）
```

### 版本号规则

版本形如 **`A.B.C`**（语义化版本）：

| 位    | 含义               | 什么时候 +1                                            |
| ----- | ------------------ | ------------------------------------------------------ |
| **A** | **架构级重构**     | 架构发生不兼容的变化。**上线官方插件市场前固定为 `0`** |
| **B** | **功能增加或优化** | 新增能力、行为改进、体验优化                           |
| **C** | **问题修复**       | 修 bug —— 尤其是"本该能用却不能用"的那类               |

**判断顺序：先看有没有 A，没有 A 再看有没有 B，都没有才走 C。**
一次发布同时含功能与修复时，**按最高位计**（例如"加了功能又修了三个 bug" → B 位 +1，
C 位归零）。

发布流程：

```powershell
npm version 0.2.1 --no-git-tag-version   # 同步 package.json 与 package-lock.json
npm run verify                            # 确认构建/测试/产物都过
npm run update:json                       # ⚠️ 必跑：发布自动更新清单（见下）
git commit -am "chore: release 0.2.1"

git tag -a v0.2.1 -m "0.2.1"              # 附注标签，写清这个版本改了什么
git push gitee main
git push gitee v0.2.1                     # ⚠️ 只推**这一个**标签

# 最后一步在网页上：Gitee → 发行版 → 为 v0.2.1 建 Release，
# 上传 .scaffold/build/dsh-for-zotero.xpi
```

> ### ⚠️ 第 4 步不能省
>
> `update.json` 里的 `update_link` 指向 **Release 附件**。只推 tag、不建 Release
> 的话，用户点更新会**下载到 404** —— 而你自己那边看不出任何异常。

> ⚠️ **不要用 `git push --tags`。** 本仓库的历史是从脚手架模板重建的，**模板作者
> 的 40 个发布标签曾一并被带进来**（`v1.1.0` … `v3.1.0`），与这里的 A.B.C 规则
> 完全冲突 —— 我们才到 `0.2.1`，却会冒出 `v3.1.0`。那些标签已删除；一旦有人用
> `--tags` 推送，就会重新出现。**按标签名逐个推**。
>
> 如果确实需要批量推送，先确认待推列表：
> `git push --tags --dry-run gitee`。

> 版本号**只有一个来源**：`package.json`。`addon/manifest.json` 里的
> `"version": "__buildVersion__"` 由构建时注入；设置页显示的版本同样是构建注入的。
> 所以**不要手工去改 manifest**，改了也会被覆盖。

### 自动更新

Zotero 用的是 Firefox 的扩展更新机制，两个地址配合：

```text
  manifest.json 的 update_url   →  Zotero 定期取这个 JSON，比对版本号
  update.json 的 update_link    →  有新版时下载这个 xpi
  update.json 的 update_hash    →  下载后校验（sha512），防止下到坏文件
```

| 环节          | 地址                                             | 谁生成                    |
| ------------- | ------------------------------------------------ | ------------------------- |
| `update_url`  | `…/raw/main/update.json`                         | `zotero-plugin.config.ts` |
| `update_link` | `…/releases/download/v{版本}/dsh-for-zotero.xpi` | 同上                      |
| 清单文件本身  | 仓库根目录的 `update.json`                       | `npm run update:json`     |

**为什么清单放在仓库根目录、而不放 Release 附件里**（这是实测结论，不是偏好）：

```text
  releases/download/release/update.json   →  404
    要它可用，得有一个叫 release 的 Release 专门托管清单文件；只打版本 tag 不够
  raw/main/update.json                    →  200，匿名可读 ✅
```

`npm run update:json` 做的事是**校验 + 搬运**，而不是自己拼一份：

- 脚手架 `npm run build` 已经在 `.scaffold/build/update.json` 生成内容正确的清单
  （版本、地址、sha512、Zotero 版本范围都由它推导）；
- 脚本会核对**版本与 `package.json` 一致**、地址是 Gitee 而非脚手架的 GitHub 默认值、
  哈希形状正确，**并且真的把 xpi 读一遍验哈希**；
- 任一条不过就**报错退出**，不发布。

> 之所以"不宽容"：清单里的版本若落后于 `package.json`，后果是**用户永远收不到新版**
> 而发布者以为已经发出去了。这类静默失效在本项目里出现过太多次。

预发布版本（`0.3.0-beta.1` 这种）走 `update-beta.json`，正式用户不会被推上 beta。

### 发布渠道与双仓库同步

两个仓库内容一致，各自承担不同用途：

| 仓库       | 用途                        | 说明                                                                          |
| ---------- | --------------------------- | ----------------------------------------------------------------------------- |
| **GitHub** | 插件市场收录 + CI + Release | `zotero-chinese/zotero-plugins` 的收集器要求 `repo` 是 GitHub 的 `owner/name` |
| **Gitee**  | 国内下载 + 自动更新清单     | 国内访问稳定；`update.json` 默认指向这里                                      |

一次改动推送两边：

```bash
git remote -v
#   github  https://github.com/LiuFangshuo666/DSH-for-Zotero.git
#   gitee   https://gitee.com/laofashi666/dsh-for-zotero.git

git push gitee main && git push gitee v0.6.8     # 先推国内
git push github main && git push github v0.6.8   # 再推 GitHub
```

**GitHub Actions 会在推 tag 时自动构建并创建 Release**（见 `.github/workflows/release.yml`）。
Gitee **不跑** GitHub Actions，所以 Gitee 侧的 Release 需要手动建：

```text
Gitee → 发行版 → 新建，tag 填 v0.6.8，
上传 .scaffold/build/dsh-for-zotero.xpi（文件名必须是 dsh-for-zotero.xpi）
```

> **为什么 `update_link` 指向 Gitee 而不是 GitHub**：实测本机访问
> `raw.githubusercontent.com` 不稳定，而自动更新是**每次启动都会做**的事，
> 不能依赖一个时常连不上的源。GitHub 侧的 Release 仍然要发 —— 市场收录与
> 用户手动下载都靠它。

### ⚠️ `addonID` 一旦有用户就不能再改

> 自动更新是按 **`addonID`** 匹配的（现在是 `dsh-for-zotero@zotero.cn`）。
> 改了它，Zotero 会当成**另一个插件**：已有用户收不到更新，且必须重装一次。
>
> 这个改动**已经做过一次**（`dsh-for-zotero@local.dev` → `dsh-for-zotero@zotero.cn`），
> 目的是在正式收录之前把 ID 定下来：官方规范要求 ID 用**邮箱格式**，
> 而 `.local` 后缀明显是开发占位。**`0.3.0` 对外不兼容**，老版本用户需先卸载。
>
> ID 的**唯一来源**是 `package.json` 的 `config.addonID`（部署脚本也从那里读，
> 所以不会再分叉）。将来若真要再换，用 `tools/remove-old-addon.ps1` 清掉旧记录 ——
> 它同时移除 xpi 文件与 `extensions.json` 里的条目，两者缺一都会留下幽灵插件。

### 测试分两层

| 层           | 命令                | 依赖          | 覆盖什么                                            |
| ------------ | ------------------- | ------------- | --------------------------------------------------- |
| **单元测试** | `npm run test:unit` | 无（纯 Node） | 解析、状态机、渲染、文档一致性                      |
| **集成测试** | `npm test`          | 真实 Zotero   | 用**真实构建产物**在假沙箱里跑启动流程与 RPC 全链路 |

（测试数量不写在这里 —— 它会变，而写死的数字一定会过时。跑一次就有。）

### 提交前的验收基线是 `npm run verify`

```bash
npm run verify
#  1. npm run build              构建 + tsc --noEmit
#  2. npm run update:json        同步仓库根的 update.json
#  3. npm run test:unit          单元测试
#  4. node tools/verify-bundle.mjs   核对产物 + 核对清单哈希
```

**顺序不能换，两步都不省**：

- **第 2 步**：构建**每次都生成不同的 xpi**（内嵌构建时间戳，不可重现），
  所以清单里的 sha512 只有跟着重建才对得上；`npm version` 之后也必须重跑，
  否则清单版本落后于 `package.json`；
- **第 3 步放在第 2 步之后**：有一条测试专门校验"清单版本与 `package.json` 一致"，
  而它正是靠第 2 步把两者对齐。顺序颠倒会让那条测试**误报**；
- **第 4 步**核对产物与清单的哈希一致 —— 漏了第 2 步就在这里失败。

> 这两条检查都是踩出来的：`update.json` 的哈希一度指向上一份产物，而它**安静地**
> 让用户更新失败（上传的 xpi 与清单哈希不是同一份，Zotero 校验不通过）。
> 现在它属于 `verify`，漏了就直接红。

单元测试通过 `test/unit/entry.ts` 这个**唯一入口**把被测模块打包出来（`esbuild` + `mocha`）。
入口文件决定了哪些内部函数可以被单测 —— 新增可测的纯函数时需要在 `entry.ts` 里导出。

> `tools/verify-bundle.mjs` 是第三层：直接检查**构建产物**。它存在的理由很实际 ——
> 中文在 bundle 里是 `\uXXXX` 转义的，用 `grep` 搜中文**会静默失败**（本项目因此在
> 错误的结论上浪费过好几轮）。这个脚本先解码再匹配。

### ⚠️ 关于"源码文本守卫"的纪律（`test/unit/sourceSlices.mjs`）

有一批守卫靠**读源码做文本断言**（因为 `sessionPane.ts` 里那些类方法没法在 Node 里跑）。
这类断言**本质上是弱判据**，本项目已经因此误报过三次：

| #   | 写法                                  | 后果                                                                    |
| --- | ------------------------------------- | ----------------------------------------------------------------------- |
| 1   | `slice(start, start + 2600)` 固定窗口 | 函数变长后目标被推到 `+3765`，测试报"注册时必须用 dir 当键"，而代码正确 |
| 2   | 按**方法名**搜索                      | 命中注释里提到该名字的地方，切出 660 字符，13 个操作全报"缺失"          |
| 3   | 按关键字找"下一个方法"                | 守卫自己的注释里含 `async`，切片在函数体中间断掉                        |

所以：

- **能跑真实代码的地方优先跑真实代码**（见 `sessionRender.test.mjs` 的 `loadRenderer()`：
  把页面脚本的前半段放进 `vm` 求值，根本不需要读文本）；
- 必须读文本时，用 `sourceSlices.mjs` 的 `methodBody()`（**按签名行定位、按配平大括号取**），
  **不要用固定字符窗口**；
- 写注释时**不要在注释里写出块注释的结束标记**（那两个字符）—— 它会当场关掉注释，
  后面几行变成代码，报出的错误行看起来完全无辜。这个坑也踩过。

### 代码结构

```
src/
├─ index.ts                入口：构造插件实例
├─ hooks.ts                生命周期与事件分发（只做分发）
├─ chat/
│  ├─ transport.ts         会话创建/提问/取消/steer；从 dsh 会话日志组装回答
│  ├─ state.ts             对话状态与消息模型
│  ├─ commands.ts          一键指令（速读摘要等）
│  └─ mergeText.ts         跨段回答合并（同一轮多个 assistant/message）
├─ dsh/
│  ├─ config.ts            运行期配置（只支持隔离实例）
│  ├─ isolatedRuntime.ts   隔离运行时的准备/启动/健康检查（约 900 行，最复杂的一块）
│  ├─ isolatedPaths.ts     运行时目录布局
│  ├─ credentialMerge.ts   把模型凭据合进隔离实例（**不**复制浏览器会话密钥）
│  ├─ modelConfig.ts       设置页的模型配置：API Key、端点地址、模型与推理等级
│  ├─ providers.ts         自定义 provider：写 profile 组合层与凭据（GLM/Qwen/自建…）
│  ├─ auth.ts              cookie 自签 + 投递通道
│  ├─ rpc.ts               POST /api/<ns>/<method> 信封客户端
│  ├─ stream.ts            session/follow 流式（ChromeWorker WebSocket）
│  ├─ askUser.ts           ask_user_question 的解析与回答格式化
│  ├─ zoteroTool.ts        **给 Agent 的工具契约**（操作清单的单一来源）
│  ├─ session.ts           会话记录（sessions.json）
│  ├─ paths.ts             路径拼接与**分隔符归一化**（Gecko 只接受全反斜杠）
│  ├─ runLog.ts            诊断日志落盘（追加 + 串行队列）
│  ├─ skill.ts             伴读 skill 与 AGENTS.md 块
│  ├─ install.ts           dsh 侧内容的安装/移除/刷新
│  ├─ selfcheck.ts         逐项自检
│  └─ *Probe.ts            沙箱能力探测（cookie 罐 / 子进程 / Worker）
├─ modules/
│  ├─ sessionPane.ts       会话宿主：挂载、右键菜单、工具轮询与执行、工作区材料（约 4400 行，见下）
│  ├─ readerPanel.ts       阅读器侧栏面板
│  ├─ selectionToolbar.ts  划词工具条
│  ├─ selfCheck.ts         设置页入口
│  └─ onboarding.ts        首次启动引导
├─ notes/writeback.ts      回答/高亮写回 Zotero 笔记（Markdown → HTML）
├─ papers/workspace.ts     全文提取、按字节分块、工作区材料
└─ utils/                  偏好、本地化、ztoolkit 薄封装

#### ⚠️ `sessionPane.ts` 为什么还这么大（以及怎么拆才安全）

三份独立审计都指出它该拆。**实测过耦合度，结论是"不能靠脚本拆"**：

| 观察 | 数字 |
| --- | --- |
| 类内被 `this.` 互相引用的成员 | **65 个** |
| **类之外、完全不引用 `this` 的顶层声明** | 约 **980 行**（`buildWorkspaceReadme` 116、`collectScopeItemInfos` 104、会话挂载 57、菜单图标 5 个约 150…） |
| 类内三块职责（工具桥 / 待确认队列 / 工作区材料） | 与编排**共享那 65 个成员** |

也就是说：

- **能安全移出的是那 980 行顶层纯函数** —— 它们零行为变更，`tsc --noEmit` 就能验证；
- **三块"职责"不能直接剪出去**：它们与 `SessionPane` 的 65 个成员互相引用，
  想拆必须先做**依赖注入改造**（把 `sessionStore` / `ensureTransport` /
  `pendingDeletions` 等显式传进去），那是一次数天的改动，不是一次重构提交该干的事。

⚠️ **我试过用脚本按行号"剪"出菜单图标那组，失败了两次**，两次都被构建或测试当场抓住：

1. 每个声明的"结束行"探测不准（`MENU_ICON_CLASS` 与 `MENU_ICON_SVG` 的区间**重叠**）；
2. 删行时**从后往前**处理，导致前面的区间位置已经偏移。

两次都靠 `git checkout -- src/modules/sessionPane.ts` 干净回退。
**结论：这个文件的拆分要一次一块、每块单独验证，不要写脚本批量剪。**

addon/
├─ content/sessionPage.js      会话页逻辑（侧栏 / 标签页 / 窗口共用）
├─ content/session.xhtml       会话页结构
├─ content/onboarding.xhtml    新手引导页
├─ content/preferences.xhtml   设置页
├─ content/dshSocketWorker.js  worker 内建 WebSocket 的代理脚本
├─ prefs.js                    全部默认偏好
└─ locale/{zh-CN,en-US}/       Fluent 文案

tools/                     开发脚本（提取运行时、核验产物、部署到本机 Zotero）
test/unit/                 单元测试 + 集成测试
docs/                      设计与决策文档（**含历史记录，注意查看日期**）
```

### 几条必须知道的坑（都踩过）

这些不是风格建议，是**会让功能静默失效**的东西：

1. **设置页的 `oncommand` 只能挂在 XUL 元素上**。`<html:button oncommand="…">` **永远不会触发** —— HTML 按钮发的是 `click`，不是 `command`。不报错、不警告，只是按下去什么都不发生。所以按钮一律写成 `<button data-l10n-id="…" oncommand="…" />`（与 Zotero 自己的设置面板一致）。

2. **XUL 按钮的文案取自 Fluent 的 `.label`**。写 `pref-x = 保存` 会让按钮**显示为空**，必须写 `pref-x =\n    .label = 保存`。

3. **`preference` 属性必须是完整偏好键**（Zotero 7+）。写成短名（`preference="modelId"`）时 Zotero 只发一条警告然后**不绑定任何偏好** —— 改了存不进去、`onsyncfrompreference` 也不触发。源文件用 `__prefsPrefix__.<键>`，构建时替换为真实前缀。

4. **批量改属性要当心 `onsyncfrompreference`**。它含 `preference="` 这个子串，用 `/preference="([^"]+)"/` 批量补前缀会把 JS 代码也改坏（得到 `onsyncfrompreference="extensions.zotero.…Zotero.…"`），表现为**下拉框重进后变空**。

5. **状态行元素必须有 `id`**。只写 `<label data-l10n-id="…">` 时 `getElementById` 永远取不到，`setStatus` 静默什么都不做 —— 用户点了按钮一个字都看不到。

6. **设置页的按键反馈不要用弹窗**。`ztoolkit.ProgressWindow` 会把**主窗口抢到前台** —— 真机反馈"页面跳到设置页前面"，点一个按钮就被抢一次焦点。反馈一律写设置页内的状态行（带 `[时间]` 前缀，点一下时间变了就说明已响应）。**唯一例外**是启动时的后台准备：那要 10–30 秒，必须有进度窗口。

7. **面板重进不会再次触发 `load`**。Zotero 把面板内容缓存在 DOM 里，切走只是隐藏。要在 `onshowing` 里重新初始化，否则"退出重进后下拉框变空"。

8. **中文检索不要用 PowerShell**。bundle 里的中文是 `\uXXXX` 转义，`Select-String` 搜中文会**静默返回 0 结果** —— 据此判断"代码没进产物"会导致错误结论。用 `node` 脚本或 `tools/verify-bundle.mjs`。

9. **Gecko 路径不能用模板串拼**。`${dir}/package.json` 得到反斜杠与正斜杠混用，`IOUtils` 直接抛 `NS_ERROR_FILE_UNRECOGNIZED_PATH`。一律用 `PathUtils.join`。

10. **`tools/*.ps1` 必须是「UTF-8 带 BOM」**。Windows PowerShell 5.1 读无 BOM 的 UTF-8 会按 ANSI 解码，中文注释变乱码后**足以破坏脚本语法** —— 真机上因此把 xpi 部署成了 `.xpi` 却打印 `deployed` 并返回 0。

11. **`IOUtils.move` 在本项目环境下会失败**（真机实测 `NotFoundError`）。所以代码里凡是"写临时文件再改名"的地方都改成了**直接写**，归档也带 read-write-remove 回退。

12. **不要用正则/行号脚本改结构化代码**。本项目因此弄坏过文件（切掉整个方法体、误改 5 处调用、把 `import` 插进块注释）。要么用编辑工具，要么从 git 取原文做精确替换。

13. **改写给 Agent 的文案后，要 bump `MATERIALS_VERSION`**（`sessionPane.ts`），否则老会话的工作区说明不会自动刷新 —— 而 Agent 会拿着旧说明工作。

## 排障

**先做这两件事**，能排掉大半"没反应"：

1. **完全退出 Zotero 再启动**。插件代码与设置页界面**只在启动时加载**；部署新版本后不重启，跑的仍是旧代码与旧界面。
2. **等隔离运行时就绪**。首次启动要提取约 330 MB（10–30 秒）。设置页会显示「正在准备/启动」，就绪后模型列表会**自动加载**。

| 现象                     | 先看哪里                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| 插件像没安装             | `<数据目录>/dsh-for-zotero-panel.txt` 是否存在、修改时间是否刚更新                                                    |
| "运行时未就绪"           | 设置 → 隔离运行时 的状态；首次提取需要 10–30 秒                                                                       |
| **点按键没有反应**       | 看该节的**状态行**（在控件下方）。文字带 `[时间]` 前缀 —— 点一下时间变了就说明已响应；若显示"操作失败：…"，那就是原因 |
| 设置页某一行没有文字     | 状态行在可视区域之外，向下滚动一点即可。插件**不弹窗**提示（弹窗会抢焦点、把主窗口带到设置页前面）                    |
| 回答不出 / 一直"…"       | 设置 → 自检：它会逐项报告 配置 → 凭据 → 签名 → cookie → RPC → 流式                                                    |
| 填了 Key 仍报 no API key | 设置 → 模型：点「保存并写入」看状态行结果；再点「刷新列表」                                                           |
| 第三方端点取不到模型     | 确认协议对不对（GLM 的 `/api/v1` 要用**自定义 provider**，不是「API 地址」）；provider 改动后**需重启运行时**         |
| 右键菜单没有图标         | 复盘见 `sessionPane.ts` 的 `diagnoseMenuIcon` 注释（需要 `menuitem-iconic` 类）                                       |
| 流式不生效               | **预期行为**：WebSocket 握手要 cookie，而沙箱写不进 cookie 罐（详见设置页说明）                                       |
| 想确认"跑的是哪一版"     | 日志里的 `插件启动于 <时间>（v<版本>）` 与 xpi 的修改时间对照                                                         |

**有用的路径**（`<数据目录>` 通常是 `C:\Users\<你>\Zotero`）：

```
<数据目录>/dsh-for-zotero-panel.txt              诊断日志（追加写）
<数据目录>/dsh-for-zotero-selfcheck.txt          最近一次自检报告
<数据目录>/dsh-for-zotero/                       插件数据（运行时、隔离 DSH_HOME、sessions.json）
<数据目录>/dsh-for-zotero/home/dsh-for-zotero/   各会话的工作区
```

> ⚠️ `<数据目录>/dsh-for-zotero/home/.credentials.yaml` 里**明文存着**模型凭据
> （API Key、会话密钥）。这是 dsh 自己的设计，但**不要把这个文件发给任何人**。

## 项目文档

`docs/` 里有设计与决策记录，**用中文写**。给不读中文的开发者的入口是
[README.en.md](README.en.md) —— 项目 README 的完整英文版（安装、构建、测试、发版都在里面）。

> ⚠️ **注意文档日期**：早期几份写于架构变更之前，其中描述的部分方案（共享模式、批量处理、
> 会话挂载的多种形态）**后来被删除**。它们保留下来是为了留下"当时为什么这么定"的记录，
> **不构成现行规范** —— 现行实现以代码与 [交接文档](docs/交接文档.md) 为准。

| 文档                                             | 内容                                 |
| ------------------------------------------------ | ------------------------------------ |
| [README.en.md](README.en.md)                     | **英文版项目说明**（给不读中文的人） |
| [交接文档](docs/交接文档.md)                     | **接手这个仓库先读这份**             |
| [设计文档](docs/设计文档-DSH-for-Zotero.md)      | 架构与关键决策                       |
| [DSH 集成与桥接协议](docs/DSH集成与桥接协议.md)  | 认证、RPC、文件桥的实测细节          |
| [产品需求与功能规格](docs/产品需求与功能规格.md) | 功能清单                             |
| [实机验收清单](docs/实机验收清单.md)             | 在真实 Zotero 里逐项确认的步骤       |
| [开发路线图与里程碑](docs/开发路线图与里程碑.md) | 阶段划分                             |
| [上架材料](docs/上架材料.md)                     | 提交到 Zotero 中文社区商店所需的一切 |

## 参与

- 提交前请跑 `npm run verify`（构建 + 单测 + 产物核验）。
- 改动**写给 Agent 的文案**（`skill.ts` / `zoteroTool.ts` / 工作区材料）时，请同时更新
  `test/unit/workspaceDocs.test.mjs` 的断言 —— 那类缺陷不会让构建失败，只能靠测试守。
- 代码注释请写**为什么**，而不是复述代码在做什么。

## 许可证

[MIT](LICENSE)。发布产物内嵌的第三方代码（`zotero-plugin-toolkit`，MIT）声明见 LICENSE 末尾。
