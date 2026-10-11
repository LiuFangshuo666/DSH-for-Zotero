pref-title = DSH-for-Zotero
pref-help = { $name } version { $version } (built { $time })

# ── Isolated runtime (the only mode) ─────────────────────
pref-isolated = Isolated runtime
pref-isolated-desc = The plugin prepares its own dsh runtime with a separate DSH_HOME, port and credentials, fully independent of the local desktop Harness. The first preparation extracts about 330 MB from the local Harness and takes roughly 10-30 seconds.
pref-isolated-port = Isolated port
pref-isolated-port-hint = Deliberately avoids the desktop's 19387 so both can run at once
pref-harness-dir = Harness install directory
pref-runtime-status = Runtime status:
pref-runtime-unknown = unknown (the plugin prepares it shortly after startup)

# ── Self-check ───────────────────────────────────────────
pref-selfcheck = Self-check
pref-selfcheck-desc = Checks the runtime, authentication and model calls. The result is also written to dsh-for-zotero-selfcheck.txt in the data directory for offline inspection. The "Onboarding" button on the right reopens the first-run explanation at any time.
pref-selfcheck-idle = Self-check has not run yet

# ── Reader side panel (the session page ignores these) ───
pref-reader = Reader side panel
pref-reader-desc = These settings apply only to the side panel while reading a PDF; the session page does not read them.
pref-chunk-bytes = Full-text chunk size (bytes)
pref-chunk-bytes-hint = dsh's read tool caps out around 50 KiB per call; 40960 is a safe value
pref-confirm-first =
    .label = Confirm before the first time paper content is sent to the agent
pref-streaming =
    .label = Try token-by-token streaming (will not succeed in this environment, see below)
pref-streaming-hint = Streaming needs a WebSocket, and the handshake needs the login cookie; the sandbox cannot write the cookie jar, so the attempt fails and falls back to showing the answer once it is complete. Leaving it on is harmless, it just costs one doomed attempt per question; turning it off keeps the diagnostic log cleaner.
pref-answer-language = Answer language
pref-highlight-color = Highlight colour
pref-highlight-color-hint = A Zotero palette value; the default yellow is #ffd400
pref-custom-commands-hint = A JSON array whose entries carry label and instruction fields, e.g. "Reviewer view / list three main reviewer concerns"; empty means the five built-ins only

# ── Model (API key and reasoning effort) ─────────────────────
# This section closes a real gap: without desktop Harness credentials the plugin
# cannot answer at all, and the failure is only visible deep in a turn's reason.
pref-model = Model
pref-model-desc = On first start the isolated runtime copies model credentials from your local desktop Harness. If you have not installed it, or have not signed in or stored a key there, enter one here — a key entered here takes precedence, and leaving it empty keeps using the desktop copy.
pref-model-api-key = DeepSeek API key
pref-model-save-key = Save and write
pref-model-api-key-hint = Saving writes it into the isolated instance's .credentials.yaml as refs.DEEPSEEK_API_KEY; the host's credential service watches that file and reloads it. Stored in plain text, exactly as the desktop Harness does. Empty means keep using the desktop credentials.
pref-model-id = Model used by sessions
pref-model-refresh = Refresh list
pref-model-effort = Reasoning effort
pref-model-base-url = API base URL (optional)
pref-model-base-url-hint = Leave empty to use the official DeepSeek endpoint. Relays, self-hosted deployments and corporate gateways work, provided they speak the DeepSeek Messages protocol. Changing this only changes where the request goes, not which protocol is spoken - so an OpenAI /v1/chat/completions URL will not work.
pref-model-status = (model list not loaded yet)

# ── Advanced (includes what gets written into your dsh home) ─
pref-providers = Custom model providers (GLM, Moonshot, Qwen, self-hosted)
pref-providers-desc = The API base URL above changes the endpoint of the DeepSeek adapter, which speaks the Anthropic Messages protocol. This one mounts additional providers speaking OpenAI Completions, OpenAI Responses or Anthropic Messages. Provide a JSON array; each entry needs route (also the provider name shown in the model picker), api, baseURL, apiKey and models (id required). Example: [{"route":"glm","api":"openai-completions","baseURL":"https://open.bigmodel.cn/api/v1","apiKey":"...","models":[{"id":"glm-4.7","name":"GLM-4.7"}]}]
pref-providers-save = Save and apply
pref-providers-example = Insert example
pref-providers-status = (not saved yet)

# ── 高级 ───────────────────────────────────────
pref-advanced = Advanced
pref-request-timeout = Request timeout
pref-request-timeout-hint = Per-request timeout for dsh in milliseconds (default 15000). Raise it on slow machines or for long tasks.
pref-install-skill =
    .label = Install the reading skill into DSH_HOME/skills
pref-install-agents =
    .label = Write standing instructions into DSH_HOME/AGENTS.md
pref-install-hint = Run the self-check above after changing these: ticking installs/updates, unticking removes. Only our own content is touched; the rest of AGENTS.md is left alone.
