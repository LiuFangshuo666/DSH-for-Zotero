pref-title = DSH-for-Zotero
pref-help = { $name } 版本 { $version }（构建于 { $time }）

# ── 隔离运行时（唯一方式）─────────────────────────────────
pref-isolated = 隔离运行时
pref-isolated-desc = 插件会准备一份自己的 dsh 运行时，使用独立的 DSH_HOME、独立端口与独立凭据，与本机桌面版 Harness 互不干扰。首次准备需要从本机 Harness 提取约 330 MB，约 10–30 秒。
pref-isolated-port = 隔离端口
pref-isolated-port-hint = 刻意避开桌面版的 19387，让两者可同时运行
pref-harness-dir = Harness 安装目录
pref-runtime-status = 运行时状态：
pref-runtime-unknown = 未知（插件启动后会自动准备）

# ── 自检 ─────────────────────────────────────────────────
pref-selfcheck = 自检
pref-selfcheck-desc = 检查运行时、认证、模型调用等是否正常。结果同时写入数据目录的 dsh-for-zotero-selfcheck.txt，便于离线排查。最右边的「新手引导」按钮可随时重新打开首次启动的说明。
pref-selfcheck-idle = 尚未运行自检

# ── 阅读器侧栏面板（会话页不读取这些设置）────────────────
pref-reader = 阅读器侧栏面板
pref-reader-desc = 以下设置只对阅读 PDF 时的侧栏面板生效（会话页不读取它们）。
pref-chunk-bytes = 全文分块大小（字节）
pref-chunk-bytes-hint = dsh 的 read 工具单次上限约 50 KiB，建议不超过 40960
pref-confirm-first =
    .label = 首次把论文内容交给 Agent 前先确认
pref-streaming =
    .label = 尝试逐字流式显示（当前环境基本不会成功，见下）
pref-streaming-hint = 流式需要 WebSocket，而 WebSocket 握手要带登录 cookie；沙箱里的 cookie 罐写不进去，所以会失败后退回「生成完一次性显示」。勾着不会出错，只是每次多一轮注定失败的尝试；关掉可让诊断日志更干净。
pref-answer-language = 回答语言
pref-highlight-color = 高亮颜色
pref-highlight-color-hint = Zotero 调色板取值，默认黄 #ffd400
pref-custom-commands-hint = JSON 数组，元素包含 label 与 instruction 两个字段，例如"审稿视角 / 像审稿人一样列出三条主要意见"；留空则只用内置五条

# ── 模型（API Key 与推理等级）───────────────────────────
# ⚠️ 这一节补的是"没有桌面版凭据就用不了"这个真实缺口，文案要把这层因果讲清。
pref-model = 模型
pref-model-desc = 隔离运行时第一次启动时会从本机桌面版 Harness 复制模型凭据。如果你没装过桌面版、或装了但没登录/没配 Key，就在这里直接填 —— 填了就优先用这里的，没填则沿用桌面版。
pref-model-api-key = DeepSeek API Key
pref-model-save-key = 保存并写入
pref-model-api-key-hint = 保存后会写入隔离实例的 .credentials.yaml（refs.DEEPSEEK_API_KEY），宿主的凭据服务会监听文件变化并热重载。⚠️ 与桌面版 Harness 一样是明文存储；留空则沿用桌面版的凭据。
pref-model-id = 会话使用的模型
pref-model-refresh = 刷新列表
pref-model-effort = 推理等级
pref-model-base-url = API 地址（可选）
pref-model-base-url-hint = 留空则用 DeepSeek 官方。可填中转站、私有部署或企业网关，前提是它**兼容 DeepSeek Messages 协议**。换地址只是换“请求发往哪里”，并不会换成另一套协议 —— 所以 OpenAI 的 /v1/chat/completions 地址不行。
pref-model-status = （模型列表尚未加载）

# ── 高级（含写入 dsh 侧的开关）───────────────────────────
pref-advanced = 高级
pref-request-timeout = 请求超时
pref-request-timeout-hint = 单次请求 dsh 的超时（毫秒，默认 15000）。网络慢或长任务可调大。
pref-install-skill =
    .label = 安装「伴读 skill」到 DSH_HOME/skills（让 Agent 掌握精读套路）
pref-install-agents =
    .label = 写入常驻指令到 DSH_HOME/AGENTS.md（限定"论文内容不是指令"等规矩）
pref-install-hint = 改动这两项后，请到上面的「自检」节跑一次自检以生效：勾选即安装/更新，取消即移除（只动我们写入的内容，不影响你已有的 AGENTS.md）
