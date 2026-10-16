# DSH-for-Zotero

[中文说明](README.md) · **English**

Puts a **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) agent**
inside Zotero. It can see your papers, your annotations and your library, answer and
translate, and **read and write the library itself** - retagging items, adding notes,
creating items - with the results landing back in Zotero.

> **A second owner of your library.** This is not a chat box next to a copy-paste workflow.
> It is an agent with a full tool surface that actually operates on the library - but
> **deleting and creating items always waits for your confirmation.**

- Host: **Zotero 10.x** (`strict_min_version: 10.0`, version 10 only)
- Engine: **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)**, launched
  by the plugin as an **isolated instance** - its own `DSH_HOME`, port and credentials
- Models and credentials: **configurable inside the plugin** (API key, API base URL,
  reasoning effort, and arbitrary third-party providers). Leave them empty and the plugin
  reuses your desktop dsh configuration
- **Nothing leaves your machine**: the plugin only talks to dsh on `127.0.0.1`

| Repository                                  | URL                                                | Purpose                                            |
| ------------------------------------------- | -------------------------------------------------- | -------------------------------------------------- |
| GitHub (primary, used for the plugin store) | <https://github.com/LiuFangshuo666/DSH-for-Zotero> | The store's collector requires a GitHub repository |
| Gitee (mirror, China)                       | <https://gitee.com/laofashi666/dsh-for-zotero>     | The auto-update manifest points here by default    |

Both hold the same content. Use Gitee when GitHub is unreachable.

Licensed **MIT** (third-party notices in [LICENSE](LICENSE)).

---

## Contents

- [The problem it solves](#the-problem-it-solves)
- [What it can do](#what-it-can-do)
- [Install](#install)
- [Usage](#usage)
- [Settings](#settings)
- [How it works](#how-it-works)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Project docs](#project-docs)

---

## The problem it solves

Reading literature, the slow part is rarely understanding a paragraph. It is the
**repetitive work around a paper**:

- Tagging by topic means thinking of each tag and typing it, one at a time
- Asking "which of these papers attack the same problem" means reading abstracts yourself
- Hitting a passage you do not follow means leaving Zotero, asking a model, pasting the
  answer back into a note - and losing all the context on the way

What these have in common is that they **read and write the library**. So this plugin is
not "a model wired up to chat". It is **a tool surface over the library**, so the agent can
work where the library is.

## What it can do

| Capability             | Detail                                                                                                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Read**               | Search, read item metadata, list the collection tree, read notes, **read full text** (`getFullText`, chunked on demand - long papers need not be read in one go)                                                            |
| **Write**              | Retag, add notes, add to collections - executed directly and **pushed onto Zotero's undo stack** (`Ctrl+Z` reverts)                                                                                                         |
| **Structural changes** | **Creating items**, **fetching full text** (`attachPdf`) and **deleting** are not executed directly. They are registered as pending and a yellow badge appears at the top of the session page for you to confirm one by one |
| **Sessions**           | **Standalone sessions** (workspace = one collection) and **item sessions** (workspace = one paper)                                                                                                                          |
| **Mounting**           | A session is a **real Zotero attachment** (a web link); double-clicking opens the interactive page inside Zotero                                                                                                            |
| **Write-back**         | Any answer can be **saved as a note** - item sessions file it under the item, standalone sessions under the collection                                                                                                      |

### Safety boundary

The configurable boundary is "**read and write freely, only deletion needs confirmation**".
In implementation:

- **Reads**: looked up by `key`, **allowed across libraries** - reads are not scoped
- **Writes**: **strictly confined to the session scope** (a collection session may only
  touch items in that collection). This is the line between "second owner" and "out of control"
- **Structural changes** (create / delete): **not executed immediately**; you confirm them
  in the interface

### Finding papers and fetching their full text (`findPaper`)

Papers are handled by `findPaper`. **`web_search` is still available** and still useful for
other online material - conference pages, author homepages, project pages, news. The two are
a division of labour:

|                            | dsh's web_search                                 | this plugin's findPaper                                              |
| -------------------------- | ------------------------------------------------ | -------------------------------------------------------------------- |
| For                        | general online material                          | **papers** (metadata and full text)                                  |
| Network                    | the model provider's side                        | **your machine** (`Zotero.HTTP`, with your cookies and proxy)        |
| Institutional subscription | not visible - it depends on source IP or a proxy | used                                                                 |
| Returns                    | prose summaries                                  | **structured metadata** (title, authors, year, venue, DOI, abstract) |
| Can create items           | no, it cannot reach `Zotero.Items`               | yes, and it attaches the full text                                   |
| Can fetch full text        | no                                               | yes, see below                                                       |

The flow (you just describe what you want; the agent takes these two steps):

```text
1. findPaper   searches Crossref / DataCite -> candidates with DOIs
2. createItem  creates the item from that DOI (waits for your confirmation)
        |
   on confirmation the plugin fetches the PDF through your network and attaches it
```

> **Why two data sources**: most journal and conference DOIs are registered with
> **Crossref**, while **arXiv, Zenodo and institutional repositories** register with
> **DataCite**. Querying only one misses an entire class of papers - on a real machine
> arXiv's `10.48550/arXiv.1706.03762` could not be found, and an agent does not stop there:
> it picks the nearest hit, which writes a **wrong DOI and wrong year** into the library.

Order of attempts for the full text, **by certainty, highest first** (matches `paperFetch.ts`):

1. an explicit `pdfUrl`, tried **first** - the caller already knows the exact address, so it is
   the most certain path;
2. `Zotero.Attachments.addAvailableFile()` - **Zotero's own resolver chain**: follows the
   DOI to the publisher, your custom resolvers, open access. This is where your
   institutional access gets used;
3. an open-access direct link (OpenAlex) - covers "no subscription, but an OA version exists".

> 📌 This order used to be written backwards here, with the most certain path last. The code has
> always been pdfUrl -> resolver chain -> OpenAlex; `attachBestPdf` is the reference.

> ⚠️ **Fetching can take tens of seconds** (following the DOI, institutional proxy
> authentication), and **failing to fetch does not fail the item** - the item is created and
> the confirmation result explains that no full text was obtained. You can retry manually
> with right-click -> "Find Available PDF" in Zotero.

## Install

**Prerequisite**: **DeepSeek Harness desktop** must be installed locally. The plugin
extracts an **isolated runtime** from it (about 330 MB on first run, 10-30 seconds), so it
is not optional.

1. **Install the plugin**: Zotero -> **Tools -> Plugins** -> gear icon (top right) ->
   _Install Plugin From File…_ -> pick `dsh-for-zotero.xpi`.
2. **Quit Zotero completely and start it again.** Zotero does not hot-load an installed xpi.
3. **First start**: an onboarding window explains what is being prepared, and a progress
   window shows the extraction.
4. **Wait for ready**: `Settings -> DSH-for-Zotero -> Isolated runtime` shows `running`.

> ⚠️ **Only installing through the Plugins interface registers it.** Dropping the xpi into
> the profile's `extensions/` directory does **not** work - Zotero tracks add-ons in
> `extensions.json`, and only the install flow writes to it.

## Usage

### Creating a session

The two kinds of session have **different workspaces**, which is what decides what the
agent can see:

| Session kind   | How to create                                                               | Workspace contents                                                                 |
| -------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Standalone** | In the library pane, **right-click a collection -> New standalone session** | That collection's items (`collection.md`: key, tags, abstract)                     |
| **Item**       | **Right-click an item -> New session**                                      | That paper's metadata and full text (`meta.json` plus chunked `paper.part-NN.txt`) |

> A standalone session **can also read a single paper's full text** - ask the agent to use
> `getFullText`. You do **not** need a separate item session for that.

### Talking to it

Just write normally. There is no required button sequence:

```
Cluster the papers in this collection by topic and produce a research map
Give the "graph representation learning" papers a consistent set of tags - show me the plan first
Use getFullText on the RTL paper, and compare its method with this one
Save that conclusion as a note
```

### Pending changes

After the agent submits a create or a delete, **a yellow badge appears at the top of the
session page**:

```
⚠ 2 changes await your confirmation (click to expand/collapse)
```

Expanding it lets you **confirm** or **ignore** each one. Until then the item does not exist
(for a create) or is still there (for a delete).

### Saving as a note

Every answer has a "Save as note" button. Item sessions file it under that item, standalone
sessions under that collection.

## Settings

The settings pane has **six sections**, in the order they appear:

| Section                    | Contents                                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Isolated runtime**       | Isolated port, Harness install directory, runtime state (prepare / start / stop)                                                          |
| **Self-check**             | One-click check of runtime, auth and model calls. Also written to `dsh-for-zotero-selfcheck.txt`. Contains the onboarding button          |
| **Reader side panel**      | Chunk size, confirm-first-send, streaming, answer language, highlight colour, custom commands (**the session page ignores all of these**) |
| **Model**                  | **API key, API base URL, model used by sessions, reasoning effort** - see below                                                           |
| **Custom model providers** | Third-party models such as GLM, Moonshot, Qwen or your own endpoint - see below                                                           |
| **Advanced**               | Request timeout, install the reading skill, write standing instructions                                                                   |

> **The two "dsh-side" switches default to off.** Turning one on and then running the
> self-check writes `<DSH_HOME>/skills/` and `<DSH_HOME>/AGENTS.md`; after that every start
> keeps them current.

### Configuring the model

On first start the isolated instance **copies model credentials from your desktop Harness**.
So:

- **You have desktop dsh installed and configured** -> the plugin works out of the box and
  **nothing in this section needs changing**
- **You have never installed it, or installed it without signing in or storing a key** ->
  enter one here

| Field                       | Detail                                                                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DeepSeek API key**        | "Save and write" writes it into the isolated instance's `.credentials.yaml`. **A key entered here wins**; leaving it empty falls back to the desktop copy |
| **API base URL** (optional) | Point at another endpoint (a relay, a private deployment, a corporate gateway). Empty means the official DeepSeek endpoint                                |
| **Model used by sessions**  | "Refresh list" reads the **currently available models** from the host; pick one                                                                           |
| **Reasoning effort**        | Changes with the selected model, because the levels are **declared by the model itself**. "(model default)" means do not override                         |

> ⚠️ **The API base URL changes where the request goes, not which protocol is spoken.**
> It configures the DeepSeek adapter, which speaks **Anthropic Messages**. To reach an
> **OpenAI-compatible** endpoint such as GLM's `/api/v1`, use the next section.

### Third-party models (the "Custom model providers" section)

This section additionally mounts dsh's **`llm-pi-ai`** adapter, which supports three
protocols:

| `api` value          | Use for                                                                      |
| -------------------- | ---------------------------------------------------------------------------- |
| `openai-completions` | Most third-party and self-hosted endpoints (**GLM's `/api/v1` is this one**) |
| `anthropic-messages` | Anthropic-protocol endpoints (GLM's `/api/anthropic`, some relays)           |
| `openai-responses`   | The OpenAI Responses protocol                                                |

Provide a **JSON array** ("Insert example" gives you one to edit):

```json
[
  {
    "route": "glm",
    "api": "openai-completions",
    "baseURL": "https://open.bigmodel.cn/api/v1",
    "apiKey": "your key",
    "displayName": "Zhipu GLM",
    "models": [{ "id": "glm-4.7", "name": "GLM-4.7" }]
  }
]
```

| Field         | Required | Detail                                                                                           |
| ------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `route`       | yes      | Route name: lowercase letters, digits, hyphens. Also the provider name shown in the model picker |
| `api`         | yes      | One of the three protocols above                                                                 |
| `baseURL`     | yes      | API root (http/https, no query string, no `#`)                                                   |
| `apiKey`      | no       | Key for that endpoint; written to `refs.<derived name>` in `.credentials.yaml`                   |
| `displayName` | no       | Label shown in the interface                                                                     |
| `models`      | yes      | At least one. `id` is required; `name` / `contextWindow` / `maxTokens` optional                  |

On save, the provider configuration goes into the isolated instance's `cordis.patch.yml`
and the key into `.credentials.yaml`.

> ⚠️ **Changing the provider list requires restarting the isolated runtime**, because the
> profile is composed when the host starts. The settings pane compares what is on disk
> against what is defined and tells you whether a restart is needed.

## How it works

This diagram explains most of the code:

```
┌─────────────────────────────┐         ┌──────────────────────────────┐
│  Zotero (plugin runs here)  │         │  dsh host (separate process) │
│                             │         │                              │
│  sessionPane.ts             │  HTTP   │  Agent loop                  │
│   ├─ context menus / mounts │◀───────▶│   ├─ model calls             │
│   ├─ workspace materials    │  RPC    │   └─ shell / file tools      │
│   └─ tool polling + exec ───┼──┐      │                              │
│                             │  │      └──────────────────────────────┘
└─────────────────────────────┘  │                    ▲
                                 │  files (req/reply) │
                                 └────────────────────┘
                                     <workspace>/zotero/
                                       call.json   ← agent writes
                                       result.json ← plugin writes
```

### Three key decisions

**1. Why files rather than real RPC (for the agent calling into Zotero)**

APIs such as `Zotero.Items` **only work inside the Zotero process**, and the agent runs in a
separate dsh process - it cannot reach them.

So two files in the session workspace act as the transport: the agent writes
`zotero/call.json`, the plugin polls for it, executes, and writes `zotero/result.json`.
Semantically these are **real tool calls** - request id, return value, error message, so the
agent can iterate and correct itself. Only the channel is a file.

> The file channel is a **deliberate choice**, not something the sandbox forced: calls and
> results stay in the workspace, so you can read exactly what the agent did.

**2. Why the plugin extracts its own runtime**

Connecting directly to your desktop dsh would let sessions, credentials and workspaces leak
into each other. So the plugin extracts an **isolated instance** from the local Harness -
its own `DSH_HOME`, port and credentials - and your desktop dsh is untouched.

The isolated instance's **port and home come from the runtime manager, not from a
setting**: were they configurable, a mismatch between the setting and the port actually
listened on would produce a connection failure nobody can interpret.

**3. Why a standalone session's workspace is a collection, not a session**

A dsh session's `cwd` is **fixed the moment it is created** and cannot change afterwards. So
the workspace has to be keyed by **scope** (collection or item) rather than by session id.
That also lets several sessions over one collection share the same materials instead of
extracting them repeatedly.

## Development

### Requirements

- **Node.js 20+** (developed on Node 24)
- **Zotero 10** (needed for integration tests and hot reload)
- **DeepSeek Harness desktop** (the plugin extracts its runtime)

```powershell
git clone <repo>
cd dsh-for-zotero
npm install

# copy the environment template and edit it for your machine
copy .env.example .env
```

`.env` needs at least the Zotero executable and a **separate development profile**. Do not
point it at your real library - the plugin writes items into it:

```dotenv
ZOTERO_PLUGIN_ZOTERO_BIN_PATH = C:\Program Files\Zotero\zotero.exe
ZOTERO_PLUGIN_PROFILE_PATH    = C:\path\to\dev-profile
```

### Common commands

```powershell
npm run build        # build the xpi (includes tsc --noEmit)
npm run test:unit    # unit tests (pure logic, no Zotero needed)
npm run lint:check   # prettier --check + eslint
npm run lint:fix     # fix formatting

npm run verify       # build + unit tests + artifact check  <- run this before committing

npm start            # dev mode: build, launch Zotero, hot reload
npm test             # integration tests (REQUIRES a real Zotero with a display)
```

### Before committing

```bash
npm run verify
#  1. npm run build                  build + tsc --noEmit
#  2. npm run update:json            sync the root update.json
#  3. npm run test:unit              unit tests
#  4. node tools/verify-bundle.mjs   check the artifact and the manifest hash
```

**The order matters and no step can be skipped:**

- **Step 2**: every build produces a different xpi - the build time is embedded, so the
  bytes change - which means the `sha512` in the manifest only matches if it is
  regenerated. It must also be re-run after `npm version`, or the manifest version lags
  behind `package.json`.
- **Step 3 comes after step 2** because one test asserts that the manifest version matches
  `package.json`, and step 2 is what aligns them. Swapping the two makes that test report a
  false failure.
- **Step 4** verifies that the artifact and the manifest hash agree, so a skipped step 2
  fails here.

> Both checks exist because of a real incident: the manifest hash once pointed at the
> previous artifact and **silently** broke updates - Zotero refuses a download whose hash
> does not match, so users saw an update that never installed while both files looked fine
> on their own. It is part of `verify` now, so forgetting it goes red.

### Versioning

Versions are **`A.B.C`**:

| Digit | Meaning                    | When to bump                                                                               |
| ----- | -------------------------- | ------------------------------------------------------------------------------------------ |
| **A** | **Architectural change**   | Incompatible architectural change. **Stays `0` until the plugin is in the official store** |
| **B** | **Feature or improvement** | New capability, better behaviour, polish                                                   |
| **C** | **Fix**                    | Bug fixes - especially "it was supposed to work and did not"                               |

**Check A first, then B, then C.** When a release contains both features and fixes, the
highest digit wins (a feature plus three fixes bumps B and resets C).

Release flow:

```powershell
npm version 0.6.11 --no-git-tag-version  # syncs package.json and package-lock.json
npm run verify                           # confirm build, tests and artifact
npm run update:json                      # MANDATORY: publishes the auto-update manifest
git commit -am "chore: release 0.6.11"

git tag -a v0.6.11 -m "0.6.11"           # annotated tag, describing what changed
git push gitee main
git push gitee v0.6.11                   # push ONLY this tag

# Last step is on the web: Gitee -> Releases -> create a release for v0.6.11
# and attach .scaffold/build/dsh-for-zotero.xpi
```

> ### ⚠️ The last step cannot be skipped
>
> `update_link` in `update.json` points at the **release asset**. Tagging without creating
> the release makes the update **download a 404**, and nothing on your side looks wrong.

> ⚠️ **Never use `git push --tags`.** This repository's history was rebuilt from a scaffold
> template, and **the template author's 40 release tags came along with it** (`v1.1.0` …
> `v3.1.0`), which flatly contradicts the A.B.C rule here - we would jump from `0.6.11` to
> a spurious `v3.1.0`. Those tags have been deleted; one `--tags` push brings them back.
> Push tags by name.
>
> If you do need a bulk push, check the list first:
> `git push --tags --dry-run gitee`.

> The version has **exactly one source**: `package.json`. `addon/manifest.json` carries
> `"version": "__buildVersion__"`, injected at build time, and the version shown in the
> settings pane is injected the same way. **Do not edit the manifest by hand** - it will be
> overwritten.

### Auto-update

Zotero uses Firefox's extension update mechanism, which needs two URLs:

```text
  manifest.json update_url   →  Zotero fetches this JSON periodically and compares versions
  update.json update_link    →  downloads this xpi when there is a newer version
  update.json update_hash    →  verified after download (sha512), so a bad file is rejected
```

| Piece               | URL                                                 | Generated by              |
| ------------------- | --------------------------------------------------- | ------------------------- |
| `update_url`        | `…/raw/main/update.json`                            | `zotero-plugin.config.ts` |
| `update_link`       | `…/releases/download/v{version}/dsh-for-zotero.xpi` | same                      |
| the manifest itself | `update.json` in the repository root                | `npm run update:json`     |

**Why the manifest lives in the repository root rather than as a release asset** (measured,
not a preference):

```text
  releases/download/release/update.json   →  404
    would need a release literally tagged "release" to host the manifest;
    a version tag is not enough
  raw/main/update.json                    →  200, readable anonymously ✅
```

`npm run update:json` **validates and moves** the file rather than composing one:

- the scaffold's `npm run build` already writes a correct manifest to
  `.scaffold/build/update.json` (version, URLs, sha512, Zotero version range are all derived)
- the script checks that the **version matches `package.json`**, that the URLs point at
  Gitee rather than the scaffold's GitHub defaults, that the hash has the right shape, and
  that the **xpi actually hashes to that value**
- any failure **exits with an error** instead of publishing

> It is deliberately unforgiving: a manifest older than `package.json` means **users never
> receive the update** while the maintainer believes it was shipped. That class of silent
> failure has happened too many times in this project.

Pre-releases (`0.6.0-beta.1`) go to `update-beta.json`, so regular users are never pushed a
beta.

### Publishing channels and the two remotes

Both repositories hold the same content and serve different purposes:

| Repository | Purpose                                  | Note                                                                        |
| ---------- | ---------------------------------------- | --------------------------------------------------------------------------- |
| **GitHub** | Plugin store listing, CI, releases       | `zotero-chinese/zotero-plugins` requires `repo` to be a GitHub `owner/name` |
| **Gitee**  | Downloads in China, auto-update manifest | Stable from China; `update.json` points here                                |

Push a change to both:

```bash
git remote -v
#   github  https://github.com/LiuFangshuo666/DSH-for-Zotero.git
#   gitee   https://gitee.com/laofashi666/dsh-for-zotero.git

git push gitee main && git push gitee v0.6.11     # domestic first
git push github main && git push github v0.6.11   # then GitHub
```

**GitHub Actions builds and creates the release when a tag is pushed**
(`.github/workflows/release.yml`). Gitee **does not run** GitHub Actions, so the Gitee
release is manual:

```text
Gitee -> Releases -> New, tag v0.6.11,
attach .scaffold/build/dsh-for-zotero.xpi (the file must be named dsh-for-zotero.xpi)
```

> **Why `update_link` points at Gitee and not GitHub**: `raw.githubusercontent.com` proved
> unreliable from the development machine, and auto-update runs **on every start**, so it
> cannot depend on a source that is often unreachable. The GitHub release still matters -
> the store listing and manual downloads use it.

### ⚠️ `addonID` cannot change once you have users

> Auto-update matches on **`addonID`** (currently `dsh-for-zotero@zotero.cn`). Change it and
> Zotero treats the plugin as a **different add-on**: existing users stop receiving updates
> and must reinstall.
>
> This has **already been done once** (`dsh-for-zotero@local.dev` ->
> `dsh-for-zotero@zotero.cn`) to settle the ID before listing: the convention requires an
> email-shaped ID and `.local` is obviously a placeholder. **`0.3.0` is not compatible**;
> users on older versions must uninstall first.
>
> The **single source** for the ID is `config.addonID` in `package.json` (the deploy scripts
> read it from there, so it cannot diverge). Should it ever change again, use
> `tools/remove-old-addon.ps1` - it removes both the xpi and the `extensions.json` entry,
> and leaving either behind produces a ghost plugin.

### Tests

| Layer           | Command             | Needs                | Covers                                                                                           |
| --------------- | ------------------- | -------------------- | ------------------------------------------------------------------------------------------------ |
| **Unit**        | `npm run test:unit` | nothing (plain Node) | parsing, state machines, rendering, docs consistency                                             |
| **Integration** | `npm test`          | a real Zotero        | the startup flow and the whole RPC path inside a fake sandbox, using the **real build artifact** |

Unit tests bundle the modules under test through the single entry `test/unit/entry.ts`
(`esbuild` + `mocha`). That entry decides which internals are reachable from tests, so new
testable pure functions must be exported there.

> `tools/verify-bundle.mjs` is a third layer: it inspects the **build artifact** directly.
> Its reason for existing is concrete - Chinese text is `\uXXXX`-escaped inside the bundle,
> so grepping for it **silently fails**, and this project wasted several rounds drawing
> conclusions from that. The script decodes before matching.

### Layout

```
src/
├─ index.ts                entry: constructs the plugin instance
├─ hooks.ts                lifecycle and event dispatch (dispatch only)
├─ chat/
│  ├─ transport.ts         session create/prompt/cancel/steer; assembles answers from the dsh session log
│  ├─ state.ts             conversation state and message model
│  ├─ commands.ts          one-click commands (quick summary, etc.)
│  └─ mergeText.ts         merging answers split across several assistant messages
├─ dsh/
│  ├─ config.ts            runtime configuration (isolated instance only)
│  ├─ isolatedRuntime.ts   prepare/start/health-check the isolated runtime (the most intricate file)
│  ├─ isolatedPaths.ts     runtime directory layout
│  ├─ credentialMerge.ts   merges model credentials into the isolated instance (never the browser session key)
│  ├─ modelConfig.ts       model settings: API key, base URL, model, reasoning effort
│  ├─ providers.ts         custom providers: writes the profile composition and credentials
│  ├─ auth.ts              cookie self-signing and delivery channels
│  ├─ rpc.ts               POST /api/<ns>/<method> envelope client
│  ├─ stream.ts            session/follow streaming (ChromeWorker WebSocket)
│  ├─ askUser.ts           parsing and formatting ask_user_question
│  ├─ zoteroTool.ts        the tool contract given to the agent (single source of truth)
│  ├─ session.ts           session records (sessions.json)
│  └─ runLog.ts            diagnostic log persistence (append + serial queue)
├─ modules/
│  ├─ sessionPane.ts       sessions: menus, mounting, workspace materials, tool bridge
│  ├─ modelPanel.ts        the model and provider sections of the settings pane
│  ├─ readerPanel.ts       reader side panel
│  ├─ selfCheck.ts         self-check entry point and reporting
│  ├─ selectionToolbar.ts  text-selection popup
│  └─ onboarding.ts        first-run onboarding
├─ notes/writeback.ts      answers written back as Zotero notes
└─ papers/workspace.ts     paper extraction and chunking

addon/
├─ manifest.json           generated version field; do not edit by hand
├─ bootstrap.js            Zotero entry point
├─ content/sessionPage.js  the interactive session page (runs in the reader)
├─ content/preferences.xhtml  the settings pane
├─ prefs.js                all default preferences
└─ locale/{zh-CN,en-US}/   Fluent strings

tools/                     dev scripts (extract runtime, verify artifact, deploy locally)
test/unit/                 unit tests plus integration tests
docs/                      design and decision records (mostly Chinese; check the dates)
```

### Pitfalls you need to know (all of them were hit)

These are not style advice. Every one of them makes a feature **fail silently**:

1. **`oncommand` in the settings pane only works on XUL elements.** `<html:button oncommand="…">` **never fires** - an HTML button emits `click`, not `command`. No error, no warning, it just does nothing when pressed. Write buttons as `<button data-l10n-id="…" oncommand="…" />`, matching Zotero's own panes.

2. **A XUL button takes its label from Fluent's `.label`.** Writing `pref-x = Save` leaves the button **blank**; it must be `pref-x =\n    .label = Save`.

3. **The `preference` attribute must be a full preference key** (Zotero 7+). Given a bare name (`preference="modelId"`) Zotero emits one warning and then **binds nothing** - edits are not saved and `onsyncfrompreference` never fires. Source files use `__prefsPrefix__.<key>`, substituted at build time.

4. **Beware `onsyncfrompreference` when bulk-editing attributes.** It contains the substring `preference="`, so a `/preference="([^"]+)"/` pass that adds prefixes also rewrites the JavaScript into `onsyncfrompreference="extensions.zotero.…Zotero.…"`, and the dropdown comes back empty after reopening the pane.

5. **Status-line elements must have an `id`.** With only `<label data-l10n-id="…">`, `getElementById` never finds them and `setStatus` silently does nothing - the user presses a button and sees no text at all.

6. **Do not use a popup for per-click feedback in the settings pane.** `ztoolkit.ProgressWindow` **raises the main window**, so every button press yanks the page in front of whatever you were looking at. Feedback goes to status lines inside the pane, which carry a `[time]` prefix so a changed timestamp proves it responded. The single exception is the startup background preparation: that takes 10-30 seconds and genuinely needs a progress window.

7. **Reopening the pane does not fire `load` again.** Zotero caches the pane's content in the DOM; switching away only hides it. Reinitialise on `onshowing`, or the dropdown is empty after leaving and returning.

8. **Do not search for Chinese with PowerShell.** Inside the bundle Chinese is `\uXXXX`-escaped, so `Select-String` **silently returns zero matches** - and concluding "the code is not in the artifact" from that leads you the wrong way. Use a Node script or `tools/verify-bundle.mjs`.

9. **Do not build Gecko paths with template strings.** `${dir}/package.json` produces a backslash-and-forward-slash mix, and `IOUtils` throws `NS_ERROR_FILE_UNRECOGNIZED_PATH`. Always use `PathUtils.join`.

10. **`tools/*.ps1` must be UTF-8 with a BOM.** Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI, and the resulting mojibake in Chinese comments is **enough to break the script's syntax** - on a real machine that deployed the xpi as `.xpi` while printing `deployed` and returning 0.

11. **`IOUtils.move` fails in this environment** (measured: `NotFoundError`). Every "write a temp file then rename" step became a **direct write**, and archiving falls back to read-write-remove.

12. **Do not edit structured code with regex or line-number scripts.** This project has damaged files that way - cutting out a whole method body, rewriting five call sites by accident, inserting an `import` inside a block comment, and turning `onsyncfrompreference` JavaScript into a preference key. Use an editing tool, or take the original from git and replace precisely.

13. **After changing text written for the agent, bump `MATERIALS_VERSION`** (`sessionPane.ts`), or existing sessions keep the old workspace documentation - and the agent works from the stale description.

## Troubleshooting

**Do these two things first**; they resolve most "nothing happens" reports:

1. **Quit Zotero completely and start it again.** Plugin code and the settings markup are
   loaded **only at startup**; without a restart you are running the old code and the old UI.
2. **Wait for the isolated runtime to be ready.** The first start extracts about 330 MB
   (10-30 seconds). The settings pane shows "preparing/starting", and the model list loads
   **automatically** once it is ready.

| Symptom                                  | Where to look                                                                                                                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The plugin looks uninstalled             | Does `<data dir>/dsh-for-zotero-panel.txt` exist, and was it just modified?                                                                                                        |
| "Runtime not ready"                      | Settings -> Isolated runtime. First extraction takes 10-30 seconds                                                                                                                 |
| **A button does nothing**                | The **status line** of that section (below the controls). Text carries a `[time]` prefix - if the time changes, it responded. If it says "operation failed: …", that is the reason |
| A status line shows no text              | It is outside the visible area; scroll down a little. The plugin **does not** raise a popup, because that would steal focus and pull the main window in front of the pane          |
| No answer, or it stays on "…"            | Settings -> Self-check. It reports configuration -> credentials -> signing -> cookie -> RPC -> streaming, item by item                                                             |
| Key entered, still "no API key"          | Settings -> Model: press "Save and write" and read the status line, then "Refresh list"                                                                                            |
| A third-party endpoint returns no models | Check the protocol. GLM's `/api/v1` needs a **custom provider**, not the "API base URL" field. Provider changes **need a runtime restart**                                         |
| Context-menu icons missing               | See the `diagnoseMenuIcon` comment in `sessionPane.ts` (the `menuitem-iconic` class is required)                                                                                   |
| Streaming does not work                  | **Expected.** The WebSocket handshake needs a cookie and the sandbox cannot write to the cookie jar (see the settings pane)                                                        |
| Which version is running?                | Compare `插件启动于 <time>（v<version>）` in the log against the xpi's modification time                                                                                           |

**Useful paths** (`<data dir>` is usually `C:\Users\<you>\Zotero`):

```
<data dir>/dsh-for-zotero-panel.txt              diagnostic log (appended)
<data dir>/dsh-for-zotero-selfcheck.txt          most recent self-check report
<data dir>/dsh-for-zotero/                       plugin data (runtime, isolated DSH_HOME, sessions.json)
<data dir>/dsh-for-zotero/home/dsh-for-zotero/   per-session workspaces
```

> ⚠️ `<data dir>/dsh-for-zotero/home/.credentials.yaml` stores model credentials **in plain
> text** (API keys, session secrets). That is dsh's own design, but **never send this file to
> anyone**.

## Project docs

`docs/` holds design and decision records. **They are written in Chinese** - the intent is
that a contributor who wants to work on a specific area translates the part they need.

> ⚠️ **Check the dates.** The earliest documents predate architectural changes; some schemes
> they describe (shared mode, batch processing, several session mounting modes) were
> **removed afterwards**. They are kept as a record of why those decisions were made at the
> time and are **not current specification**. The implementation and the handover document
> are authoritative.

| Document                                                               | Contents                                                       |
| ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| [交接文档](docs/交接文档.md) (handover)                                | **Read this first if you are taking over**                     |
| [设计文档](docs/设计文档-DSH-for-Zotero.md) (design)                   | Architecture and key decisions                                 |
| [DSH 集成与桥接协议](docs/DSH集成与桥接协议.md) (integration protocol) | Measured details of auth, RPC and the file bridge              |
| [产品需求与功能规格](docs/产品需求与功能规格.md) (spec)                | Feature list                                                   |
| [实机验收清单](docs/实机验收清单.md) (acceptance checklist)            | Steps to verify on a real Zotero                               |
| [开发路线图与里程碑](docs/开发路线图与里程碑.md) (roadmap)             | Milestones                                                     |
| [上架材料](docs/上架材料.md) (store submission)                        | Everything needed to submit to the Zotero Chinese plugin store |

## Contributing

- Run `npm run verify` before committing (build, unit tests, artifact check).
- When changing **text written for the agent** (`skill.ts`, `zoteroTool.ts`, workspace
  materials), update the assertions in `test/unit/workspaceDocs.test.mjs` as well. That class
  of defect never breaks the build; only a test can catch it.
- Comments should explain **why**, not restate what the code does.

## License

[MIT](LICENSE). Third-party code embedded in the release artifact
(`zotero-plugin-toolkit`, MIT) is acknowledged at the end of LICENSE.
