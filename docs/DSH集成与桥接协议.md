# DSH 集成与桥接协议

> ⚠️ **文档状态：历史设计记录（截至 2026-10-02）**
>
> 本文记录的是当时的**设计与决策过程**，其中部分方案后来被修改或删除，未逐条回改
> （保留是为了留下"为什么这么定"的记录）。**当前实现以代码与
> [交接文档.md](交接文档.md) 为准。**
>
> 本文中已**不再成立**的主要点：桌面版 Harness / 共享模式（端口 19387、3080、
> `dshHome`、`launchUrl` 等设置项一律已删）、工具菜单里的自检入口（已移入设置页）、
> **批量处理**（功能整体删除，多文献分析改由用户自己的会话完成）、
> 会话挂载的四种形态（现在只有网页链接）。

> 上位文档：[设计文档-DSH-for-Zotero.md](设计文档-DSH-for-Zotero.md)
>
> **适配版本：dsh 0.2.0-rc.2**（源码 `E:\dsh\deepseek-harness`，git `639ed015`）。
> 每条结论标注来源文件与行号，并对本机运行实例做过实测。dsh 处于 developer preview 且明示会有破坏性变更，**升级 dsh 后请按 §9 的清单复核本文件**。

---

## 1. 前提：为什么必须走本地 HTTP 桥接

| 事实                          | 说明                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| dsh 是 Node 程序              | 入口 `apps/cli`，服务端 `node:http`（`packages/host/webserver/src/index.ts:9`），全仓 1400+ 处 `node:*` 引用 |
| Zotero 插件是 Firefox 特权 JS | 无 `require`、无 Node 内建模块、不能 spawn 进程、不能 import dsh 的 npm 包                                   |
| 结论                          | **不可能同进程**。桥接 = Zotero 侧用 `fetch` + `WebSocket` 访问本机 dsh 的 HTTP 服务                         |

**只有 `web` profile 提供 HTTP 接口**；`headless` / `sdk` / `sdk-minimal` / `acp` 都走 stdio，需要父进程 spawn，插件做不到（`packages/bundle/headless/README.md:12`、`sdk-app/README.md:12`、`acp-app/README.md:12`）。

---

## 2. 服务地址与进程形态

| 项                 | 值                                                                                               | 来源                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| 桌面版默认端口     | `127.0.0.1:19387`（本机实测监听中，PID 19304）                                                   | `docs/architecture.md:55` + `netstat` 实测                                      |
| `dsh web` 默认端口 | `127.0.0.1:3080`                                                                                 | `packages/bundle/web-app/cordis.patch.yml:169-177`                              |
| CLI 参数           | `--host <host>`、`--port <port>`（`0` = 系统分配）、`--no-open`、`--trusted-host <authority...>` | `packages/bundle/web-app/src/startup.ts:46-61`                                  |
| 端口优先级         | 命令行 > 配置行 > 默认值；**没有环境变量可配**                                                   | 同上 `:174`；`apps/cli/reference/README.md:28`                                  |
| 端口冲突           | **无回退**：listen 失败 → fiber 失败 → 进程 exit 1                                               | `packages/host/webserver/src/index.ts:220-221, 293-301`                         |
| `--host 0.0.0.0`   | 明确拒绝（安全考虑）                                                                             | `startup.ts:74-76`                                                              |
| `--no-open`        | 只抑制打开浏览器；HTTP 服务与 token 行照旧                                                       | `cordis.patch.yml:193-194`、`packages/bundle/web-app/src/index.ts:271, 273-279` |
| 健康检查           | **不存在**（全仓无 `/health` 路由）；`GET /health` → 404（实测）                                 | 全仓 grep + 实测                                                                |
| 免认证路由         | 仅 `/plugins/*`（客户端 bundle）与 `/oauth/callback`；SPA 静态资源页可读但无用                   | `packages/client/modules/src/index.ts:225, 649`；子代理报告 A 节                |

### 路由总表（本项目相关部分）

| 方法           | 路径                                                                            | 认证              |
| -------------- | ------------------------------------------------------------------------------- | ----------------- |
| POST           | `/api/<namespace>/<method>`（一元 RPC，前缀路由）                               | 信任闸门 + cookie |
| GET（upgrade） | `/api/remote.mux`（WebSocket 多路复用）                                         | 信任闸门 + cookie |
| GET/HEAD       | `/api/session.export`、`/api/file`、`/api/present.host`、`/api/changes.summary` | 同上（一期不用）  |
| GET            | `/plugins/*`、`/plugins/events`（SSE）                                          | 公开              |

---

## 3. 认证（本项目最关键的一段）

### 3.1 两道闸门

```ts
// packages/client/connection/src/rpc-host.ts:103-107（逐字）
requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection {
  if (!isTrustedApiRequest(request, this.trustedHosts)) return 403
  return this.browserAuth.isAuthenticated(request) ? undefined : 401
}
```

**闸门一 · 信任检查**（`src/api-request-trust.ts:99-117`）

- `Host` 必须是 loopback 或 `trustedHosts` 条目；
- `sec-fetch-site: cross-site` → 拒绝；
- **`Origin` 缺失即放行**；带 `Origin` 时必须与 `Host` 同源。

源码文件头注释（`api-request-trust.ts:10-13`）明说：_"Non-browser and remote clients pass the same fence via loopback … this fence is not an auth layer."_

**闸门二 · 浏览器会话 cookie**（`src/browser-auth.ts:287-300`）：必须有 `dsh-auth-<hash>` cookie，值与当前 authority 绑定。

**没有任何配置能关闭认证**：`ConnectionConfig` 只有 `recovery`、`trustedHosts`、`cookieMaxAgeDays`、`maxRequestBodyBytes`（`src/index.ts:110-115`）。`trustedHosts` 只放松闸门一。

### 3.2 cookie 的确切算法

```
authority = Host 头的 host[:port]，本机为 "127.0.0.1:19387"
cookie 名 = "dsh-auth-" + b64url( SHA-256( authority ) )
payload   = { version: 1, authority, issuedAt: <ms>, expiresAt: <ms> }
body      = b64url( JSON.stringify(payload) )
sig       = b64url( HMAC-SHA256( secret, body ) )
cookie 值 = "v1." + body + "." + sig
属性      = Path=/; HttpOnly; SameSite=Strict   （默认 30 天，无 Secure）
```

来源：`browser-auth.ts:106-108`（名）、`:129-132`（值）、`:27-32`（payload）、`:122`（属性）、`:113`（`cookieMaxAgeDays` 默认 30）、`:69-78`（authority 规范化，**含端口**）。

→ `127.0.0.1:19387` 与 `127.0.0.1:3080` 是**两个不同的 cookie**。

### 3.3 密钥从哪来

`$DSH_HOME/.credentials.yaml` 中键 `client-connection/browser-session` 的 `grant` 记录里的 `secret`（base64url，解码 32 字节）：

```yaml
version: 1
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: <base64url, 32 bytes>
```

来源：`browser-auth.ts:12`（记录键）、`:80-98`（解码校验）、`:161-178`（不存在时自动生成）。本机文件已存在（实测 540 字节）。删除该记录会**吊销所有会话**。

### 3.4 取得认证的两条路

| 方式                      | 步骤                                                                                                                                                 | 评价                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **A. 本地自签（主实现）** | 读 `$DSH_HOME/.credentials.yaml` → 按 §3.2 用 `crypto.subtle` 签名 → 每个请求（含 WebSocket 握手）带 `Cookie:`                                       | 全自动、零用户操作、重启后仍可用（密钥持久）                |
| **B. token 换取（兜底）** | 用户从 dsh 启动输出的 `dsh web: http://127.0.0.1:<port>/?token=…` 行复制 token → 插件 `GET /?token=…`（`redirect:'manual'`）→ 收 `Set-Cookie` → 复用 | 零魔法但需用户操作；**桌面版 token 是否可得未核实**（见下） |

方式 B 的协议细节：仅接受 `GET /`（`pathname === '/'`）且**恰好一个** `?token=`，成功后 `303` + `Set-Cookie`；token 不匹配 → 401。token 是每进程 `randomBytes(32)`，且**只打印到 stdout**，无文件、无端点暴露它（`browser-auth.ts:238-264`、`:52-58`；`packages/bundle/web-app/src/index.ts:262, 271`）。

> ⚠️ **未核实**：桌面版（Electron，端口 19387）是否把带 token 的 URL 写到任何可读位置。因此一期以**方式 A 为主**，方式 B 仅作退路。

### 3.5 Zotero 侧实现要点（均已验证）

| 能力               | 结论                                                                             | 证据                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 读任意用户可读文件 | 可以                                                                             | `IOUtils.readUTF8`（`xpcom/server/server_localAPI.js:147`）、`Zotero.File.getContentsAsync`（`xpcom/itemTree.js:54`）                      |
| 写文件             | 可以                                                                             | `IOUtils.writeUTF8/writeJSON`（`server_localAPI.js:162`、`xpcom/reader.js:1069`）、`IOUtils.makeDirectory`（`xpcom/dataDirectory.js:908`） |
| HMAC-SHA256        | **可用 `crypto.subtle`**                                                         | Zotero 自身即用：`modules/backup/ArchiveEncryption.sys.mjs:300` → `await crypto.subtle.sign("HMAC", this.#authKey, metaBytes)`             |
| 随机数 / UUID      | `crypto.getRandomValues`（`ArchiveEncryption.sys.mjs:192`）；`crypto.randomUUID` | 同上                                                                                                                                       |
| HTTP               | `fetch`（可设自定义头、可流式读）                                                | `xpcom/http.js:617, 723`                                                                                                                   |
| WebSocket          | `new WebSocket(url)` 可用                                                        | `xpcom/streamer.js:240`                                                                                                                    |
| WebSocket 握手头   | **标准构造器不能设 `Cookie`** → 见 §7                                            | 待 M0 实测                                                                                                                                 |

---

## 4. 一元 RPC：报文与响应

### 4.1 请求

```
POST http://127.0.0.1:<port>/api/<namespace>/<method>
Content-Type: application/json
Cookie: dsh-auth-…=v1.…
（不要带 Origin；带了就必须与 Host 同源）
```

```jsonc
{
  "type": "client-request",
  "rpcId": "<uuid>", // 客户端生成
  "method": "session/create", // 必须与 URL 末尾严格一致
  "payload": {
    "args": {
      /* 具名参数 */
    },
  },
}
```

来源：`packages/client/connection/src/rpc.ts:79-84`；`packages/api/gateway/src/client/index.ts:445`（发送方只发 `{ args }`）；`src/rpc-host.ts:230-258`（路径必须恰好两段、媒体类型必须 `application/json`、`method` 必须与 endpoint 一致）。

### 4.2 响应

```jsonc
{ "type": "server-response", "rpcId": "<同一 uuid>",
  "result": { "ok": true, "value": { /* 业务返回值 */ } } }

{ "type": "server-response", "rpcId": "…",
  "result": { "ok": false, "error": { "code": "gateway/bad-request", "message": "…", "details": {} } } }
```

来源：`src/rpc-schema.ts:21-32, 42-47`、`src/rpc-host.ts:291-302`。

**必须记住的三条**：

1. **业务成功与业务失败都返回 HTTP 200**，判成败只看 `result.ok`（`rpc-host.ts:295-302`）。
2. 信封非法 → 400 / 媒体类型错 → 415 / 路径不匹配 → 404 / handler 抛异常 → 500（`rpc-host.ts:230-265`）。
3. 请求体上限 300 MiB → 超限 413（`src/http-bridge.ts:14, 59-77`）。

---

## 5. 会话接口（`session` 命名空间）

命名空间来自 `super(ctx, 'sessionController', { namespace: 'session' })`（`packages/api/session-controller/src/index.ts:136`）。

### 5.1 本项目要用的报文

```jsonc
// ① 连通性/登录自检
POST /api/session/list
{ "type":"client-request","rpcId":"1","method":"session/list","payload":{"args":{"_request":{}}} }
// → value: { "items": SessionSummary[] }
//   SessionSummary = { sessionId, updatedAt, running, blank, agentAvailable,
//                      parentSessionId?, origin?, cwd?, projections? }

// ② 创建会话
POST /api/session/create
{ … "method":"session/create","payload":{"args":{"request":{
    "cwd": "C:\\Users\\Administrator\\.dsh\\dsh-for-zotero\\1-ABCD1234"
    // 可选：sessionId（省略则由服务端生成 session-<uuid>）、agentPreset、workspaceId
    // 注意：workspaceId 与 cwd 互斥
} } } }
// → value: { "sessionId": "session-…", "agentPreset": "…" }

// ③ 发问
POST /api/session/prompt
{ … "method":"session/prompt","payload":{"args":{"request":{
    "requestId": "<uuid>",          // 幂等键：同 requestId 重复提交只会被接受一次
    "sessionId": "session-…",
    "mode": "queue",                // "queue" → followup；"steer" → steer
    "content": [ { "type": "text", "text": "…" } ],
    "clientTimeZone": "Asia/Shanghai"
} } } }
// → value: { "accepted": true }

// ④ 取消
POST /api/session/cancel
{ … "method":"session/cancel","payload":{"args":{"request":{"sessionId":"session-…"}}} }
// → value: { "accepted": true }；若没有活跃 agent 则抛 session/not-found（取消不会触发 resume）
```

来源：`session-controller/src/index.ts:251-254, 272-275, 425-429, 456-459, 467-470`；`src/types.ts:176-188, 263-296, 332-346, 373-380`；`src/commands.ts:105-144, 311-377, 511-525`。

**要点**

- `PromptContentPart` = `{type:'text',text}` | `{type:'image',mediaType,data,name?}` | `{type:'file',receiptId}`（`types.ts:89-97`）。**论文上下文就放在 `content[].text` 里**，无需工具。
- **冷会话可直接 prompt**：`resolveAgent` 会透明地恢复持久会话（`src/agent.ts:170-201, 407-411`），所以插件不必先"打开"会话。
- **恢复旧会话用 `create` 带显式 `sessionId`**：它要么收养活跃会话、要么恢复持久会话，并保留写锁（争用返回 `session/writer-held`）。**`cwd` 必须与该会话记录一致，否则抛 `ApiSessionCwdConflict`**（`session-controller/README.md:38`、`commands.ts:105-144`、`agent.ts:457-473`、`:463-465`）。
- `prompt` 的成功只代表**已入队**，正文要另订阅（§6）。
- **Remote 接口没有 system prompt 字段**：`SessionPromptRequest` 只有 `content`/`mode`，`SessionCreateRequest` 也没有 `instructions`（`types.ts:89-97, 285-290`）。`agent.inject()` 是 Host 侧能力、HTTP 不可达（`core/agent/src/runtime-types.ts:233-241`）。立规矩只能靠：内联在 `content[].text`、`$DSH_HOME/AGENTS.md`（`packages/context/agent-instructions/README.md:32`）、或工作区文件。

### 5.2 其他可用命名空间（同版本实测挂载清单）

`session` 之外，本版本挂载的可编程命名空间还包括：`workspace`、`workspaceFiles`、`agentPresets`、`llm`、`skills`、`subagents`、`job`、`terminal`、`userQuestions`、`settings`、`account`、`goals`、`schedule`、`pluginManager`、`pluginInventory`、`messageFeedback`、`sessionFeedback`、`fileUploads`、`sessionReferences`、`permissionPresets`、`dynamic`、`commands`、`officeToPdf`、`productAnalytics`、`pluginRegistryProbe`（`packages/api/remotes/src/client/index.ts:181-188`）。

对二期有用的两个：

- `skills/list`（`{ sessionId }` → `{ skills: SkillEntry[] }`，命名空间 `skills`）——可在插件里列出 Agent 可用的技能。
- `fileUploads`（`@Remote('upload')`）配合 `PromptContentPart` 的 `{type:'file',receiptId}`——需要把 PDF 原文件交给 Agent 时的正规通道。

### 5.2 历史读取

```jsonc
POST /api/session/page
{ … "payload":{"args":{"request":{
    "address": { "kind": "session", "sessionId": "session-…" },
    "throughSeq": 42,      // 来自 follow 开场 snapshot 的 cursor；-1 表示空
    "beforeSeq": 43,       // 可选，向后翻页游标
    "maxMessages": 50,     // 可选，默认 50
    "turnWindow": { "minMessages": 1, "minTurns": 1 }   // 可选
} } } }
// → value: { "records": SessionHistoryRecord[], "hasMore": boolean }
```

来源：`src/history.ts:38, 77-112, 305-335, 382-390`；`types.ts:408-415（SessionAddress）, 425-468（记录）, 471-484, 545-549`。

---

## 6. 流式：`session/follow`（token 级，可用）

### 6.1 载波与帧

WebSocket：`ws://127.0.0.1:<port>/api/remote.mux`（`stream-protocol.ts:7`）。**无子协议**、**仅文本帧**（二进制帧 → `close(1003,'text messages required')`；JSON 不可解析 → `close(1008, …)`）。

```jsonc
// 客户端 → 服务端
{"type":"open","streamId":"s1","endpoint":"session/follow",
 "payload":{"args":{"request":{
     "address":{"kind":"session","sessionId":"session-…"},
     "assistantStream": true,                    // 关键开关
     "maxMessages":50, "turnWindow":{"minMessages":1,"minTurns":1}   // 可选
 }}}}

// 服务端 → 客户端
{"type":"item","streamId":"s1","value": <SessionFollowFrame>}    // 多次
{"type":"error","streamId":"s1","error":{"code":"…","message":"…","details":{}}}
{"type":"end","streamId":"s1"}

// 客户端取消
{"type":"cancel","streamId":"s1"}
```

来源：`packages/api/gateway/src/stream-protocol.ts:235-257, 264-286`；`src/stream-server.ts:150-160, 174-261, 326-352`；`session-controller/src/client/transport.ts:179-183`（官方客户端就是这么发的）。

`streamId` 由客户端自取任意非空字符串。**重复 `open` 同一个活跃 streamId 会抛错并关闭整个 socket**——这是唯一会杀掉物理连接的协议违规。

### 6.2 token 级增量帧

```ts
// session-controller/src/types.ts:551-563
type SessionFollowFrame =
  | {
      type: "snapshot";
      header;
      cursor;
      records;
      hasMore;
      projections;
      assistantStream?;
    }
  | SessionEventEntry
  | { type: "assistant-stream"; frame: SessionAssistantStreamFrame };

// types.ts:513-543 —— 这就是逐字流
type SessionAssistantStreamFrame =
  | { type: "start"; attemptId; revision; startedAfterSeq; turn; step }
  | { type: "chunk"; attemptId; revision; index; time; chunk: JsonValue } // 每个模型 chunk 一帧
  | {
      type: "end";
      attemptId;
      revision;
      index;
      outcome:
        | {
            kind: "committed";
            eventType: "assistant/message" | "assistant/attempt";
            seq;
          }
        | { kind: "abandoned" };
    };
```

服务端生产链：`history.ts:165-175` 订阅 `agent/assistant-stream` 并包装成 `assistant-stream` item；`core/agent-loop/src/assistant-stream.ts:60-71` 逐 chunk `emit`。

### 6.3 两条必须实现的纪律

1. **`revision` 连续性校验**：开场 `snapshot.assistantStream` 给出 `{ revision, activeAttempt?: { attemptId, startedAfterSeq, turn, step, nextIndex, stream } }`；此后每个 `assistant-stream` 帧的 `revision` 必须等于上一个 +1，否则必须判定"物理代次已失效"并重连（官方客户端即如此：`client/transport.ts:206-215`）。`nextIndex` 在线上**不做逐帧校验**，只靠 `revision`。
2. **心跳是协议层的**：Host 每 `websocketHeartbeatIntervalMs`（默认 **2000ms**）发 WebSocket `ping`，连续两次未回 pong 就断开（`stream-server.ts:40, 105-124`）。Firefox 在协议层自动回 pong，因此普通 `WebSocket` API 够用 —— **但如果换成 `nsIWebSocketChannel` 方案，必须确认它也会自动回 pong**。

### 6.4 事件订阅（辅助）

`$events` 逻辑流走同一 WebSocket，开场帧 `{ type:'ready', clientId, host:{ home } }`。可订阅的 Host 事件**只有 27 项白名单**（`packages/api/remotes/src/remote-events.ts:20-48`），本项目相关：`api-session/activity`、`api-session/status`、`api-session/added|removed|error`、`approval/request`、`user-questions/request`。另有 `session/control` 流提供 Host 级投影快照（`types.ts:565-581`）。

→ 用 `session/follow` 拿正文增量；用事件判断状态、处理工具审批。

---

## 7. Zotero 插件沙箱的三个限制与对应方案（M0 第一号技术问题）

Zotero 用系统主体沙箱加载插件，注入清单是**白名单**——这决定了桥接客户端必须怎么写。原文（`app:chrome/content/zotero/xpcom/plugins.js`）：

```js
137|     var scope = new Cu.Sandbox(
138|       Services.scriptSecurityManager.getSystemPrincipal(),
139|       { sandboxName: addon.id,
141|         wantGlobalProperties: [
142|         "atob","btoa","Blob","crypto","CSS","ChromeUtils","DOMParser",
149|         "fetch","File","FileReader","TextDecoder","TextEncoder","URL","URLSearchParams","XMLHttpRequest"]
158|       });
163|     Object.assign(scope, {
166|         Zotero, ChromeWorker, IOUtils, Localization, PathUtils, Services, Worker, XMLSerializer,
176|         setTimeout, clearTimeout, setInterval, clearInterval, requestIdleCallback, cancelIdleCallback });
205|       Services.scriptloader.loadSubScriptWithOptions(uri, { target: scope, ignoreCache: true });
```

**有**：`crypto`（含 `subtle`）、`fetch`、`XMLHttpRequest`、`ChromeUtils`、`Services`、`IOUtils`、`PathUtils`、`ChromeWorker`/`Worker`、`atob`/`btoa`、定时器。
**没有**：`WebSocket`、`AbortController`、`Headers`/`Request`/`Response`、`ReadableStream`、`Components`/`Cc`/`Ci`。

### 7.0 实机确认结果（Zotero 10.0.5，2026-10-02，自检输出）

用户在真实 Zotero 10.0.5 上跑通了"DSH 自检"，沙箱能力与链路结果如下：

| 项                           | 实测结果                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `crypto.subtle`              | **可用** ✅                                                                                 |
| `fetch` / `XMLHttpRequest`   | **可用** ✅                                                                                 |
| `ChromeWorker`               | **可用** ✅                                                                                 |
| `Services.cookies`           | **可用**（但见 §7.1 的签名问题）                                                            |
| 沙箱内 `WebSocket`           | **不可用**（符合预期，走 worker）                                                           |
| 凭据读取 + HMAC 自签 cookie  | **成功**（cookie 名 `dsh-auth-0exPercdGwj1vnIcTz9SFcRTWGd-owEQNWZc8Ax73_0`，值 173 字符）   |
| **`POST /api/session/list`** | **HTTP 200，43ms，返回 23 个会话** ✅ —— 桥接链路在真实 Zotero 里成立                       |
| cookie 罐                    | **写入失败**（`NS_ERROR_XPC_NOT_ENOUGH_ARGS`）→ 自动回退 XHR 显式 `Cookie` 头，RPC 照常可用 |
| 菜单可见性                   | **不可见** → 见 §7.5 的 l10n 根因                                                           |

**由此确定**：`fetch` 路径没有被信任检查拒绝（**未出现 403**），`Origin` 不是问题；认证走 XHR 头通道已足够跑通一元 RPC。剩下要解决的是 **cookie 罐（WebSocket 握手需要它）** 与 **菜单可见性**。

### 7.1 限制一：`Cookie` 是 fetch 的禁止头

规范禁止脚本设置 `Cookie`，而 Zotero 自己走的是 XHR 通道（`xpcom/http.js:330-331` 强制允许第三方 cookie）。三个候选：

| 方案                         | 做法                                                                                                                                                        | 评价                                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **H1. 写 cookie 罐（首选）** | 用 `Services.cookies.add(...)`（`Services` 已在沙箱内）把 §3.2 的自签 cookie 写到 `127.0.0.1:<port>` 上；之后普通 `fetch` **与 WebSocket 握手**都会自动携带 | 一次写入同时解决 HTTP 与 WS 两个通道；代价是往用户 cookie 罐写一条本机记录（需在文档告知，并提供"清除"按钮） |
| H2. 走 XHR 通道              | 用 `Zotero.HTTP.request`（可 `setRequestHeader('Cookie', …)`，且强制携带 cookie）                                                                           | 可靠，但 `Zotero.HTTP.request` 是 XHR、**会缓冲响应**——一元 RPC 可以，流式不行                               |
| H3. worker 内 fetch          | 让 `ChromeWorker` 内的 fetch 承担请求                                                                                                                       | 与 W1 合并实现，减少一处特例                                                                                 |

### 7.2 限制二：沙箱里没有 `WebSocket`

沙箱白名单无 `WebSocket`；Zotero 自己的 XPCOM 代码能用（`xpcom/streamer.js:240`），且翻译沙箱是**显式申请**了 WebSocket 的（`TranslationChild.mjs:211`）——说明插件沙箱里直接 `new WebSocket()` 很可能是 `ReferenceError`。三个候选：

| 方案                           | 做法                                                                                                                                             | 评价                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| **W1. `ChromeWorker`（首选）** | `plugins.js:167` 注入了 `ChromeWorker`；worker 全局有完整 Web API（含 `WebSocket`）。在 worker 里建连、收帧，用 `postMessage` 把帧回传主线程渲染 | 官方提供的路径，风险最低；代价是多一层 worker 代理（约 100 行） |
| W2. 主窗口                     | `Zotero.getMainWindow()` 的 chrome 窗口内 `new WebSocket(url)`（`streamer.js` 就是这么用的），再把帧转发回来                                     | 少一层 worker，但依赖窗口生命周期，关窗口即断                   |
| W3. 退回轮询                   | 放弃 WS，用 `session/page` + `api-session/status` 每 300–500ms 轮询                                                                              | 零风险，但退化为"分段实时"，放弃逐字                            |

### 7.3 限制三：没有 `AbortController`

取消不能靠 abort signal：一元请求用 `XMLHttpRequest.abort()`（走 H2 时天然具备）；流式取消用协议自带的 `{"type":"cancel","streamId":"…"}` 帧。

### 7.4 其他的 Zotero 侧事实（已核实，实现时直接用）

| 能力               | 结论                                                                                                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 读任意用户可读文件 | 可以（系统主体，无路径白名单）：`IOUtils.readUTF8`、`Zotero.File.getContentsAsync`                                                                                                                                    |
| 写文件             | `IOUtils.writeUTF8` / `writeJSON` / `IOUtils.write({mode:'append'})` / `IOUtils.makeDirectory`；**原子写**用 `Zotero.File.putContentsAsync`（内部 `tmpPath` + rename）                                                |
| 插件数据目录       | **没有** per-plugin helper；惯用法 `PathUtils.join(Zotero.DataDirectory.dir, '<id>')` + `IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true })`                                                 |
| HMAC-SHA256        | `crypto.subtle.importKey('raw', …, {name:'HMAC', hash:'SHA-256'}, false, ['sign'])` + `sign`。Zotero 自身有先例（`ArchiveEncryption.sys.mjs:300`、`WorldCat Discovery Service.js:161-168`）。**没有** `nsICryptoHMAC` |
| base64url          | 无内置；`btoa` 产物做 `.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')`。注意 `Zotero.Utilities.Internal.Base64` 是标准字母表且会做 UTF-8 编码，**不能**直接用于签名                                         |
| 文件监视           | **没有**通用 watcher（`xul.dll` 无 `nsINativeFileWatcher`）；Zotero 自带一个仅用于 storage 目录的（`fileChangeWatcher.js`，不可复用）。→ 只能 `setInterval` + `IOUtils.stat(...).lastModified` 轮询                   |

### 7.5 菜单项与 FTL：l10n 解析失败会导致"菜单项根本不显示"

**实机教训**（Zotero 10.0.5，2026-10-02）：插件注册了工具菜单项，但用户**完全看不到**"DSH 自检"。

根因在 `xpcom/pluginAPI/menuManager.js:453`：

```js
if (menuData.l10nID) {
  menuElem.dataset.l10nId = menuData.l10nID; // 只是设 data-l10n-id
}
```

MenuManager **只设 `data-l10n-id`，不写 `label`**。若该消息 ID 在已注册的 FTL 里解析不到，Gecko 的 Fluent 就不会给元素文字——元素存在但**没有标签**，用户看起来就是"没有这一项"。

两条必须同时做：

1. **用带插件前缀的完整消息 ID**：`l10nID: "<addonRef>-menuitem-selfcheck"`（不是 `"menuitem-selfcheck"`）。
2. **把插件的 FTL 注册进去**：
   - 启动时 `Zotero.ftl.addResourceIds(["<addonRef>-addon.ftl"])`（`xpcom/intl.js:83-93` 的注释明确写了插件用这个入口；`Zotero.ftl` 是运行时挂上去的属性，不在 `zotero-types` 里，需要断言类型）；
   - 每个主窗口 `win.MozXULElement.insertFTLIfNeeded("<addonRef>-addon.ftl")`。

**并且要留兜底**：本插件在 `onShowing` 里检查对应元素是否已有 `label`，为空就用插件自己的 `Localization` 实例取文案补上。这样即使 FTL 注册方式在后续 Zotero 版本再变，菜单也不会"消失"，只会退化成硬编码文案。

> 小结：**"菜单没出现"不等于注册失败，先怀疑 l10n。** 同一条也适用于面板头 `header.l10nID`。

> **M0 判定顺序**：cookie 通道 H1 → H2；WS 通道 W1 → W2 → W3。结论回写本节。
>
> **M0 实现进展（代码已完成，待在真实 Zotero 里跑自检定案）**：
>
> - H1 已按"参数从多到少"实现（`nsICookieManager.add` 的实现在 C++ 层，源码不在 `omni.ja`，无法静态核对签名；10/9/8/7 参逐个尝试），全失败自动回退 H2。
> - W1 已实现（`addon/content/dshSocketWorker.js` + `src/dsh/stream.ts`），并内置 W2（主窗口）与 W3（不可用上报）回退。
> - 自检里新增**cookie 罐只读探测**，会直接报告"cookie 到底写进去了没有"，避免靠推测。
> - 另有一个**新发现的沙箱限制**：`plugins.js` 注入清单里没有 `AbortController`，故取消一律走 XHR `abort()` 或协议层的 `{"type":"cancel"}` 帧。

---

## 8. 端到端最小序列（一期实现目标）

```
1. 读 $DSH_HOME/.credentials.yaml → 取 secret
2. 自签 cookie（§3.2）
3. POST /api/session/list            → 验证认证通过（失败则提示走方式 B）
4. POST /api/session/create {cwd}    → 得到 sessionId（首次）
5. WS 打开 /api/remote.mux（带 cookie）
   → 发 open{session/follow, assistantStream:true}
6. POST /api/session/prompt {requestId, sessionId, content:[{type:'text',text}]}
7. 从 item 帧渲染 assistant-stream/chunk（逐字）；用 event/snapshot 帧补历史
8. 用户点停止 → WS 发 cancel{s1}，或 POST /api/session/cancel
```

### 8.1 本机实测记录（已跑通，2026-10-02）

用 `tools/dsh-auth-poc.mjs` 与 `tools/dsh-stream-poc.mjs` 对**正在运行的桌面版实例（127.0.0.1:19387）**做了真机验证：

| 步骤                                            | 结果                                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 无 cookie 调 `POST /api/session/list`           | `HTTP 401 unauthorized`                                                                                                        |
| 读凭据密钥 + 自签 cookie 后同样调用             | **`HTTP 200`，`result.ok=true`，返回 21 个会话**（含 `cwd` 字段）                                                              |
| `POST /api/session/create {cwd}`                | 成功，返回 `session-<uuid>`                                                                                                    |
| `ws://…/api/remote.mux` **带 cookie 握手**      | **成功**（Node 侧用 `new WebSocket(url, { headers: { cookie } })`）                                                            |
| `open` → `session/follow{assistantStream:true}` | 收到 `snapshot` 帧                                                                                                             |
| `POST /api/session/prompt`                      | `{accepted:true}`                                                                                                              |
| **逐字输出**                                    | **确认可用**。帧序列：`snapshot` → `event`×15 → `assistant-stream/start` → `assistant-stream/chunk`×9 → `assistant-stream/end` |

实测到的 chunk 形状（模型输出"桥接成功"时的真实帧，注意是**块级增量**而非裸字符串）：

```jsonc
{"type":"block-start","index":0,"blockType":"reasoning"}
{"type":"block-end","index":0,"block":{"type":"reasoning","text":""}}
{"type":"block-start","index":1,"blockType":"text"}
{"type":"text-delta","index":1,"text":"桥"}
{"type":"text-delta","index":1,"text":"接"}
{"type":"text-delta","index":1,"text":"成功"}
{"type":"block-end","index":1,"block":{"type":"text","text":"桥接成功"}}
{"type":"usage","usage":{"inputTokens":6587,"outputTokens":4,"cacheReadTokens":1024,"cacheWriteTokens":0,"totalTokens":…}}
{"type":"finish","reason":{"kind":"stop"},"replayState":{…}}
```

**由此得到两条实现要点**：

1. **渲染要处理 `block-start`/`block-end`/`text-delta`/`usage`/`finish` 五类 chunk**，不能只认裸文本。`reasoning` 块可以做成灰色小字或折叠。
2. **`session/follow` 是"常驻跟随流"，生成结束不会 `end`**（实测：finish 之后流仍打开，直到客户端 `cancel`）。也就是说它同时承担"历史快照 + 实时增量"，插件应在**面板关闭或切换文献时**发 `cancel`，而不是等 `end`。

### 8.2 仍未在真机验证的两点

| 项                                | 说明                                                                                                                                                                                                           |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zotero 侧 `fetch` 是否带 `Origin` | Node 侧不带 Origin 即通过（已实测）。Zotero 是 Firefox 特权环境，预期同样不带；**但必须用真实插件实测**（若带 `Origin: null` 会被 403，届时改用 `Origin: http://127.0.0.1:<port>` 或走 `Zotero.HTTP.request`） |
| Zotero 侧 WebSocket 如何带 cookie | Node 的 `WebSocket` 支持 `headers` 选项，**Firefox 的标准 `WebSocket` 不支持** → 仍需 §7 的 W1/W2 方案之一                                                                                                     |

> 结论：桥接链路的**服务端侧已完全证实可用**；剩余风险集中在 Zotero 客户端的两个平台细节上，且都有明确备选方案。

---

## 9. 升级 dsh 后的复核清单

| #   | 复核点                                                        | 本文件对应节 |
| --- | ------------------------------------------------------------- | ------------ | ------ | ---- | -------------- | --- |
| 1   | cookie 名/载荷/签名算法、信任规则                             | §3.1–3.2     |
| 2   | 凭据记录键是否仍为 `client-connection/browser-session`        | §3.3         |
| 3   | RPC 信封与"业务结果恒为 HTTP 200"                             | §4           |
| 4   | `session/create                                               | prompt       | cancel | list | page` 的字段名 | §5  |
| 5   | `session/follow` + `assistantStream` 帧形状与 `revision` 规则 | §6           |
| 6   | 事件白名单                                                    | §6.4         |
| 7   | 默认端口与 CLI 参数                                           | §2           |

> 建议 M0 顺手做一个**协议自检命令**（插件工具菜单），一键跑完 §8 的第 1–4 步并打印结果；升级 dsh 后用它快速定位破坏点。

---

## 10. cookie 罐写入：实测结论与影响面（2026-10-02 更新）

### 10.1 实测结果

在真实 Zotero 10.0.5 里，`Services.cookies.add(...)` 的全部 6 种参数签名尝试**均失败**，
统一报：

```
NS_ERROR_XPC_NOT_ENOUGH_ARGS (0x80570001)
"Not enough arguments [nsICookieManager.add]"
```

尝试过的签名（见 `src/dsh/auth.ts` 的 `putCookieInJar`）：

| #   | 形态                                              | 结果                                           |
| --- | ------------------------------------------------- | ---------------------------------------------- |
| 1   | 11 参（新版顺序 + `partitionKey`）                | **`NS_ERROR_ILLEGAL_VALUE`（个数对，值非法）** |
| 2   | 10 参（新版顺序）                                 | `NS_ERROR_XPC_NOT_ENOUGH_ARGS`（参数不足）     |
| 3   | 12 参（新版顺序 + 两个尾部参数）                  | **`NS_ERROR_ILLEGAL_VALUE`**                   |
| 4   | 10 参（旧顺序 + `originAttributes` + `sameSite`） | 参数不足                                       |
| 5   | 9 参（旧顺序 + `originAttributes`）               | 参数不足                                       |
| 6   | 8 参（旧顺序）                                    | 参数不足                                       |

**两类错误码给出了关键信息**：
`NOT_ENOUGH_ARGS` 出现在 8/9/10 参 → 个数确实不够；
`ILLEGAL_VALUE` 出现在 11/12 参 → **个数已经够了，问题在第 11 个参数（`partitionKey`）的取值上**。
此前一律传 `{}`，对 `partitionKey` 而言不是合法值。

据此外扩为**参数形态矩阵**（每种只花一次调用，代价极低）：

- `originAttributes` × `{ {} , null }`
- `partitionKey` × `{ null, undefined, "" , {} }`

共 8 种 11 参组合，另保留 1 种已知"个数不足"的形态用于诊断对比。

**矩阵结果（由插件内置的离线探针自动跑出，无需人工操作）**：

```
cookie 罐探针：全部失败（9 种）：NS_ERROR_ILLEGAL_VALUE×8, NS_ERROR_XPC_NOT_ENOUGH_ARGS×1
cookie 相关接口清单：
  Components=object   Cc=object   Ci=object   Cu=object
  ChromeUtils.interfaces=无   OriginAttributes=undefined
```

**两点重要更正与结论**：

1. **早先"沙箱里没有 `Ci`"的判断是错的。** 运行时枚举（上面的接口清单）显示
   `Components`/`Cc`/`Ci`/`Cu` **都存在**。因此把 `NS_ERROR_ILLEGAL_VALUE`
   归因于"缺接口常量"是**不可靠的推断**；真正原因尚未确定。
2. 不论原因如何，**结果稳定**：8 种 11 参组合一律 `ILLEGAL_VALUE`，
   少参一律 `NOT_ENOUGH_ARGS`，且**无一成功**。

> **本项目的结论：cookie 罐路线不再继续尝试。** 它只影响 WebSocket 握手的逐字流式，
> 而不影响任何功能（一元 RPC 走 XHR 显式 Cookie 头，已实测 HTTP 200 / 21 ms）。

### 10.5 WebSocket 流式：唯一阻塞点已定位为 cookie 罐

内置的 ChromeWorker 探针（`src/dsh/workerProbe.ts`，脚本 `content/dshWorkerProbe.js`）
在启动时自动执行，结果写进诊断文件。实测：

```
ChromeWorker 探针：构造器=有；构造=成功；脚本执行=成功；11ms
```

即 **`chrome://` 资源注册、worker 构造、脚本加载与执行全部正常**。
`worker 错误：unknown` 并非 worker 加载失败，而是 **WebSocket 握手被拒**。

而 Firefox 的 `WebSocket` 构造器**不支持自定义请求头**，握手时只能携带 cookie 罐里的
cookie。于是链路唯一缺失的一环就是 cookie 罐：

| 环节                               | 状态                                     |
| ---------------------------------- | ---------------------------------------- |
| `chrome://<ref>/content/` 资源注册 | ✅ 正常                                  |
| ChromeWorker 构造与脚本执行        | ✅ 正常（11 ms）                         |
| WebSocket 握手携带凭据             | ❌ **只能靠 cookie 罐，而它不可行**      |
| 一元 RPC（XHR 显式 Cookie 头）     | ✅ 正常（HTTP 200，21–43 ms，23 个会话） |
| `session/page` 轮询作为替代        | ✅ 已实现并验证                          |

**最终结论：逐字流式在本环境下不可得；面板按"轮询 + 分块显示"工作。
这是环境限制，不是实现缺陷。** 若将来必须逐字流式，只剩两条路，
都需要改动 dsh 或放弃"不改 dsh"的自我约束：

1. 让 dsh 接受 `Sec-WebSocket-Protocol` 或查询参数形式的凭据；
2. 由用户环境放宽 cookie 策略。

### 10.6 陈旧 cookie 与 401：成因与自愈（2026-10-02 实测）

现象：插件自检一度报 `gateway/non-json ... (HTTP 401)`。

排查过程（全部以真机为准）：

1. 用凭据文件里的 secret 现签 cookie 直连 `/api/session/list` → **HTTP 200**，
   说明**服务端与签名算法都没问题**；
2. 于是做 Host 头对照实验，定位 401 的**确切条件**：

   | 场景                                                | 结果   |
   | --------------------------------------------------- | ------ |
   | Host 与签名 authority 都是 `127.0.0.1:19387`        | ✅ 200 |
   | 签名用 `localhost:19387`、Host 用 `127.0.0.1:19387` | ❌ 401 |
   | Host 用 `127.0.0.1`（无端口）                       | ❌ 401 |
   | Host 用 `[::1]:19387`                               | ❌ 401 |

   **cookie 名就是 `sha256(authority)`**，所以"签名用的 authority ≠ 请求的 Host 头"
   ⇒ 名字对不上 ⇒ 等同于没有 cookie ⇒ 401。

3. 时间线对照：插件在 13:51 拿到 401，桌面版宿主进程于 **13:53:40 重启**；
   宿主就绪后再跑自检即恢复 200。**结论是"宿主重启期间的陈旧状态"，不是插件缺陷。**

**已实现的韧性**：`DshClient` 支持 `refreshCookie` 回调 —— 收到 401 时
**重读凭据、重签 cookie、重试一次**（只重试一次，避免死循环）。这样 dsh 换宿主或轮换
密钥后，插件能自愈，不必等用户重启 Zotero。

> **附带教训**：`issuedAt`/`expiresAt` 的单位是**毫秒**（插件与 dsh 实现一致）。
> 我第一版独立的 Node 探针误用秒，导致 cookie 长度 165 而非 173，被服务端判为
> "寿命超过 cookieMaxAgeDays" 而 401 —— **长度差异是最快的自检信号**。

### 10.7 离线探针：这次的取证手段（推荐沿用）

cookie 罐问题卡了三轮人工验证，最后靠**三个自动探针**一次性回答完毕：
`probeChromeWorker`（worker 能否加载执行）、`probeCookieJar`（哪种签名能写罐）、
`listCookieCapabilities`（运行时到底有哪些接口）。
三者都在 `onMainWindowLoad` 时自动运行，结果落在
`<数据目录>/dsh-for-zotero-menu.txt`，**不需要任何人工点击**；
同一文件里还有一次**完整的自动自检**，因此"桥接是否真的通"可以完全离线读取。

**这是本项目最有效的一条经验**：能离线判定的问题，就不要占用实机验证轮次。

### 10.8 划词弹窗：形状已由官方文档确认（不再是猜测）

先前在代码注释里把 `params` 的字段标为"待实机确认"。实际上 Zotero 10 的
`xpcom/reader.js` 里**就有官方用法示例**（`registerEventListener` 的 `@example`，2743-2749 行）：

```javascript
Zotero.Reader.registerEventListener(
  "renderTextSelectionPopup",
  (event) => {
    let { reader, doc, params, append } = event;
    let container = doc.createElement("div");
    container.append("Loading…");
    append(container);
    setTimeout(
      () =>
        container.replaceChildren("Translated text: " + params.annotation.text),
      1000,
    );
  },
  "my-plugin@my-namespace.com",
);
```

要点（全部与实现一致）：

- 事件对象是 `{ reader, doc, params, append }`（`ReaderEvent` typedef，2715-2721 行）；
- **选中文本在 `params.annotation.text`** —— 这是官方示例里直接使用的字段；
- `append(...Element)` 把节点插进弹窗；`doc` 是阅读器 iframe 内的 document。

另外，`append` 的实现会把参数 `cloneInto` 到 iframe 窗口
（`reader.js:200-203`），所以传进去的必须是 **iframe document 创建的元素**
（插件用 `event.doc.createElement` 正是如此），不能用主窗口的元素。

> 已补一条回归测试：用真实产物触发真实 handler，断言弹窗里被追加了四个按钮、
> 文案正确、且**在没有打开面板时按钮禁用并给出原因**（而不是静默无效）。

### 10.2 影响面（重要）

**cookie 罐失败不影响任何已实现功能**：

| 能力                                       | 依赖 cookie 罐？        | 实际状态                                                                         |
| ------------------------------------------ | ----------------------- | -------------------------------------------------------------------------------- | ------ | ------- | --- | ---------------------------------------------- |
| 一元 RPC（`session/list                    | create                  | prompt                                                                           | cancel | page`） | 否  | ✅ **实测 HTTP 200，通道 `xhr-header`，43 ms** |
| 全文问答 / 划词伴读 / 结果回写 / 批量处理  | 否                      | ✅ 全部走 RPC，可用                                                              |
| **逐字流式**（WebSocket `session/follow`） | **是**（握手需 cookie） | ⚠️ 需要 cookie 罐；不可用时**自动回退轮询**（已验证，约 1.2 秒出结果、按段显示） |

也就是说：**cookie 罐只影响"逐字流式的观感"，不影响功能**。
若后续确定要逐字流式，可选路线（按代价排序）：

1. 继续扩签名探测（低代价，但已试 6 种，收益递减）；
2. 从 Gecko 的 `nsICookieManager` IDL 拿到确切签名后一次性写对（需要 Gecko 源码，本机 `omni.ja` 里没有 IDL）；
3. 用 `ChromeWorker` + `Services` 在 worker 侧写 cookie（同一接口，预计同样失败）；
4. 换认证载体：让 dsh 侧接受 `Sec-WebSocket-Protocol` 或查询参数形式的凭据（**需要改 dsh，本项目的自我约束是不改 dsh**）。

**当前决策：保持"尽力写罐 + 失败即回退轮询"**，并在自检里如实报告，不阻塞任何功能。

### 10.3 一条方法论教训

本项目曾多次出现"按文档/推理认为某 API 可用，真机却失败"的情况（`Ci.nsIFile`、
`enumerator.hasMoreElements`、菜单文案、`addon` 裸引用、`setter-only property`）。
统一结论：**凡是与 Zotero/Gecko 运行时语义相关的判断，必须以真机日志为准**。
插件为此把两条判据固化成了产物：

- 工具菜单 → DSH 自检（含流式实测）：把结论直接打印给人看；
- `<数据目录>/dsh-for-zotero-menu.txt`：启动是否成功、菜单注册是否成功、菜单项数。

配套的取证工具（仓库内）：`tools/capture-zotero-log.mjs`（抓完整调试输出，
**不要用 `Select-String` 过滤——它会漏掉异常类型那行**，而破案靠的正是那行）。
