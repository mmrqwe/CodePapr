# CodePapr System Architecture

## 1. Purpose

This document describes the formal system design of CodePapr, focusing on:

- What problem the system solves
- Core design goals and non-goals
- How components are layered and how they collaborate
- Agent runtime execution paths and key invariants
- DeepSeek prefix-cache friendliness
- Architectural positioning of sub-agents, TodoList, Project Memory, and ProjectGraph

## 2. Design Goals

### 2.1 Core Goals

- Single runtime, reusable across multiple entry points
- Local-first execution — project context stays within the workspace as much as possible
- Stable context and verifiable execution chains across multi-turn tasks
- Extensible: new providers, tool hosts, and entry points without rewriting core runtime
- Maximize DeepSeek automatic prefix-cache hit rate

### 2.2 Non-Goals

- Not a multi-tenant cloud proxy platform
- Not a pure web chat product

## 3. Logical Layers

### 3.1 Package Responsibilities

| Package | Role | Primary Responsibility |
| --- | --- | --- |
| @codepapr/types | Shared Protocol | Unified message, request, response, tool, and statistics types |
| @codepapr/common | Common Infrastructure | Logging, hashing, and general utilities |
| @codepapr/core | Runtime Core | Agent, Session, ToolRegistry, cache partitions, ProjectGraph, TodoList, Built-in Agents |
| @codepapr/api | Provider Adapter | RequestBuilder, CacheValidator, provider implementations |
| @codepapr/editor | Editor Contracts | Framework-agnostic Monaco types, markers, navigation, and static analysis contracts |
| @codepapr/ui | Desktop Workbench | React, Zustand, Tauri, WorkerBackedAgent; SQLite persistence lives in `ui/src-tauri` (Rust) |

## 4. Core Components

### 4.1 Shared Agent Runtime

- **Agent**: Drives single or multi-turn tool execution cycles
- **Session**: Holds ImmutablePrefix, AppendOnlyLog, VolatileScratch, and ToolRegistry
- **ToolRegistry**: Maintains callable tool definitions and execution entry points
- **RequestBuilder**: Constructs provider requests and performs consistency validation
- **CacheValidator**: Parses responses, validates cache-related metadata, normalizes usage

### 4.2 Desktop Agent Bridge

The desktop offloads the LLM chat loop to a Web Worker via `WorkerBackedAgent`:

```
ChatPanel → agentStore.sendMessage()
  ├─ Optimistic UI: user message appears immediately (~50ms) via set(), no I/O waits
  ├─ Background: refreshProjectDiagnostics (non-blocking), load_projectgraph_cache,
  │           loadMemoryBootstrapSection (rendered from the ledger), loadMcpToolDefinitions
  ├─ WorkerBackedAgent.chat()
  │    ├─ Worker Thread: Agent.chat() → LLM
  │    └─ Main Thread: tool execution → Tauri invoke
  └─ gitCheckpointCreate (anchored to already-displayed message)
```

**Key files:**
- `packages/@codepapr/ui/src/agent/WorkerBackedAgent.ts`: Worker proxy wrapper
- `packages/@codepapr/ui/src/agent/agentRuntime.worker.ts`: Worker-side runtime
- `packages/@codepapr/ui/src/agent/agentWorkerProtocol.ts`: Message protocol definition

### 4.3 Desktop State Layer

The desktop maintains a state management layer between the UI and shared runtime:

- **agentStore** (Zustand): Master orchestrator — sendMessage (with optimistic UI), model routing, streaming messages, session recovery, TodoList management, conversation reset
- **contextCompaction**: Context checkpoint generation for long conversations
- **projectStorage**: Project-level snapshot persistence to `.CodePapr/project.sqlite`
- **workspaceTools**: Desktop tool invocations bridged to Tauri native commands
- **permissionStore**: External file access permission management; explicit dialog authorization for `read`/`list` on absolute paths outside the project
- **toastStore**: Global toast notification queue — info/success/warning/error with auto-dismiss
- **reviewStore**: Code review state management, caching diff file lists per `baseRef..headRef`, line-level comments, and approval status

### 4.4 Rust Backend Domain Modules

The Tauri Rust backend is organized into domain modules, each with a single responsibility:

| Module | File | Responsibility |
| --- | --- | --- |
| `browser` | `src-tauri/src/browser/` | Headless Chrome automation (open / navigate / click / type / screenshot / read) |
| `shell` | `src-tauri/src/shell/` | Backend for the `bash` tool: shell command execution (through a shell), background process management, command safety guards |
| `web` | `src-tauri/src/web/` | HTTP fetch, web page content extraction, multi-engine search (SearXNG first, with automatic fallback to built-in multi-source aggregation: Bing / Mojeek / Qwant / Wikipedia) |
| `workspace_fs` | `src-tauri/src/workspace_fs/` | File listing, text reading, writing, SEARCH/REPLACE diff, text/path search |
| `task_queue` | `src-tauri/src/task_queue/mod.rs` | Heavy I/O serialization queue; frontend polls `task_id` for results |
| `db` | `src-tauri/src/db/mod.rs` | Application and project-level SQLite persistence, session and cache statistics |
| `tts` | `src-tauri/src/tts/` | GPT-SoVITS TTS subsystem: server management, voice synthesis, WebSocket batch synthesis, audio playback, installer, fine-tuning |
| `lsp` | `src-tauri/src/lsp.rs` | LSP server process management, stdin/stdout JSON-RPC bridging |
| `symbol_provider` | `src-tauri/src/symbol_provider.rs` | tree-sitter fallback symbol extraction |
| `mcp_host` | `src-tauri/src/mcp_host.rs` | MCP tool server host (stdio / sse / streamable-http); dynamic tool discovery (`mcp__<serverId>__<toolName>`); 3 permission modes (read-only / read-write / dangerous); mutating-tool confirmation flow; 24h tool definition cache; MCP marketplace (official registry one-click install) |
| `shared` | `src-tauri/src/shared/` | Path normalization, workspace path resolution, runtime helpers, string/time utilities |
| `papr_runtime` | `src-tauri/src/papr_runtime/` | .papr app runtime: manifest loading, permission validation, SDK injection, storage/HTTP/FS commands, app context registry |
| `app_runtime` | `src-tauri/src/app_runtime.rs` | Custom URI scheme `codepapr-app://`, app discovery and scanning, SDK injection, workspace registration |

### 4.5 Task Queue

All heavy-I/O Tauri commands (file listing, reading, command execution, etc.) execute serially through a single-consumer channel:

- Commands return `task_id` immediately without blocking the frontend
- Frontend polls `poll_workspace_task` for results
- Avoids multi-threaded concurrent reads/writes to the same workspace

### 4.6 Tool Architecture

The LLM can invoke 30 discrete tools (including `task`/`todo` as dynamic tools), each with a single responsibility. The 7 tools with `action` parameters all use `enum` constraints. File read/write/SEARCH/REPLACE operations have a 20MB cap:

| Unified Tool | Action | Delegated Tool |
|---|---|---|
| `read` | Line range / window / context read | workspace_read_file |
| `read_image` | Image file read (PNG/JPEG/WebP/GIF) | workspace_read_image |
| `write` | Create / overwrite file | workspace_write_file |
| `edit` | SEARCH/REPLACE single-file modification | workspace_apply_patch |
| `patch` | Multi-file atomic SEARCH/REPLACE | workspace_apply_diff |
| `grep` | Regex search file contents; `semantic:true` switches to LSP workspace symbol search (degrades to regex without LSP) | workspace_search_text / workspace_workspace_symbol |
| `glob` | Filename pattern search | workspace_search_files |
| `list` | Browse directory tree, embeds lightweight per-file symbols (extractSymbols, AST); no-AST languages return path only | workspace_list_files |
| `graph` | **Hidden from LLM (UI-only)**: full / overview / lookup / implementations / dependency / entrypoints / impact / smart_context / dead_code / circular_deps / type_hierarchy / suggest_refactors / test_impact / generate_tests | graphQuery |
| `lsp` | goToDefinition / findReferences / hover / documentSymbol / workspaceSymbol / goToImplementation / prepareCallHierarchy / incomingCalls / outgoingCalls (LSP-first, AST project-graph fallback, results tagged with source/confidence) | workspace_symbol_definition / references / hover / document_symbol / workspace_symbol / implementation / prepare_call_hierarchy / incoming_calls / outgoing_calls |
| `lsp_edit` | rename / code_action / format | workspace_rename_symbol / workspace_apply_code_action / workspace_format_files |
| `diagnostics` | Single-file LSP diagnostics / project-level diagnostics | workspace_lsp_diagnostics / workspace_project_diagnostics |
| `git` | status / diff / log / branch / stage / commit / restore / reset | workspace_git_* |
| `bash` | Run shell commands in the project (through a shell); action: run/list/stop/stop_all; background:true for background | workspace_run_shell_command / workspace_start_shell_background_command / workspace_*_background_processes |
| `browser` | open / navigate / reload / close / click / type / read / screenshot / get | browser_* |
| `websearch` | Online search | websearch (registered directly) |
| `webfetch` | Read a webpage as text; with `save: true` download raw content to project and return path | web_fetch_url / web_download_file |
| `app_render` | Render .papr App | app_render |
| `app_list` | List all registered apps | app_list |
| `app_start` | Start app backend | app_start |
| `app_stop` | Stop app backend | app_stop |
| `app_delete` | Delete app | app_delete |
| `skill` | Load skill documentation | skill_load |
| `question` | Ask user a question | question |
| `task` | Delegate subtask to sub-agent | subagent |
| `todo` | tasks / updates task planning | TodoList |

All 30 tools are registered in ToolRegistry, frozen and hashed for cache consistency. `todo` and `task` are dynamically generated.

Ask / Plan read-only modes use `FilteringToolRegistry` (a `ToolRegistry` subclass): at registration it skips mutating tools (`MUTATING_TOOL_NAMES`: write/edit/patch/lsp_edit/bash/git/app_*) by predicate, so they appear neither in the tool set nor as registered handlers — a hard block rather than a prompt-level soft constraint. Agent / App modes use the plain `ToolRegistry`.

**External path permissions**: The desktop app shows a `PermissionDialog` for `read`/`list` operations on absolute paths outside the project. The user can choose "Deny / Allow this file / Allow this folder". Authorizations are stored in the `permissionStore` allowlist. For a file directly under the filesystem root, choosing "Allow this folder" is downgraded to granting that single file only (so one click can never grant the entire filesystem root).

### 4.7 Papr App Runtime

Papr is CodePapr's application runtime — AI-generated `.papr` apps run directly in the desktop client, using the SDK to call Agent, LLM, storage, HTTP, and filesystem capabilities.

**Directory structure:**

```
.CodePapr/apps/<appId>/
├── manifest.json     ← Metadata + permissions + agent definitions
└── index.html        ← Entry HTML (customizable via manifest.entry)
```

**manifest.json spec:**

```json
{
  "spec": "papr/0.1",
  "name": "Todo App",
  "version": "0.1.0",
  "local": "read",
  "network": true,
  "agents": [{
    "name": "assistant",
    "model": "deepseek",
    "systemPrompt": "You are a task management assistant",
    "tools": ["read", "websearch"],
    "maxToolRounds": 20
  }]
}
```

Access is two-axis: `local` (`none`/`read`/`write`) × `network` (`true`/`false`). Legacy `level` (0–3) is migration-only. `permissions[]` is not a runtime source (omitted when empty). `papr.db` / `papr.fs` are always available; `papr.http` needs `network: true`; Agent project tools follow `local`/`network`.

**Papr SDK (`window.papr`):**

JavaScript SDK injected into every app iframe, providing a unified API:

| API | Description |
|---|---|
| `papr.db.get/set/delete/keys()` | Persistent key-value storage (per-app isolation) |
| `papr.agent.run({agent, task}, onProgress?)` | Invoke manifest-defined agents (streaming events + step tracking) |
| `papr.http.request({method, url, headers?, body?})` / `get` / `post` | HTTP requests (JSON returned as-is; header allowlist) |
| `papr.fs.readFile` / `writeFile` / `exists` / `list` / `delete` | File I/O (app data dir; `encoding: 'base64'` for binary) |
| `papr.app.info()` | Get app metadata |

**IPC bridge:** The iframe SDK sends `{__papr:true, reqId, type, payload}` protocol messages via `window.parent.postMessage()`. The React main window's `usePaprBridge` hook listens → first-pass permission check → routes to `invoke()` (Rust) or Worker (Agent).

**Permission system (two-layer):**

1. **React first-pass** — `usePaprBridge` fast-rejects based on the effective access profile (manifest `local`/`network` ∩ user override)
2. **Rust authoritative** — every `papr_*` Tauri command checks the two-axis profile at the top, blocking even direct postMessage bypass

Tool permission mapping: `read/grep/list` → `local>=read`, `write/edit` → `local=write`, `bash` → `local=write`, `websearch/webfetch` → `network=true`.

**App Agent system:**

Independent from built-in sub-agents (explore/scout/mentor) and from the main chat Worker (`_appAgent`):
- manifest `agents[].tools` specifies a whitelist (15 allowed tools)
- Worker-side `handleRunAppAgent` builds a full `Session` (`ImmutablePrefix` + `AppendOnlyLog` + `ToolRegistry`)
- Runs `Agent.chat()` multi-turn tool loop (`maxToolRounds` default 20, max 50)
- Three-layer 300s **idle** timeout (iframe SDK / main-thread `WorkerBackedAgent` / Worker `withIdleTimeout`): any streaming event resets the timer, so long-running tasks that keep producing are never cut off; only 300s of total silence is treated as hung. Tool IPC proxied to main thread
- Streaming events forwarded to iframe via `app-agent-stream` messages

**Protocol-level SDK injection:** `app_runtime.rs::handle_app_protocol` injects `<script src="__papr_sdk.js">` after `<head>` when serving HTML. SDK content is embedded in the Rust binary at compile time (`include_str!`).

**Rust modules (`papr_runtime/`):**

| File | Responsibility |
|---|---|
| `manifest.rs` | Manifest loading, validation, caching |
| `permission.rs` | Permission matrix + tool permission mapping |
| `sdk_inject.rs` | SDK injection into HTML + SDK file serving |
| `app_context.rs` | app_id → workspace_path in-memory registry |
| `app_storage.rs` | `papr_storage_*` Tauri commands (permission check + SQLite CRUD) |
| `services.rs` | `papr_http_*` / `papr_fs_*` Tauri commands (permission check + fs/http operations) |
| `protocol.rs` | postMessage protocol types (reserved) |

**Storage isolation:**

```
papr.db.set('key', value) → app_storage(key, value) in .CodePapr/apps/<appId>/db.sqlite
```

Each app gets its own SQLite file (WAL + busy_timeout), isolated from project.sqlite
internal state; the app folder stays self-contained (manifest + html + db) and is removed
as a whole when the app is deleted. db.sqlite is never served over the codepapr-app://
protocol and cannot be overwritten via app_render.files.

**App Management Tools:**

LLM can manage app lifecycle via 4 tools (registered as merge tools in `workspaceTools.ts`):

| Tool | Params | Function |
|---|---|---|
| `app_list` | none | List all registered apps (appId, title, hasBackend, isRunning) |
| `app_start` | `appId` | Start backend (check port → `start_workspace_background_command` → `setAppRunning`) |
| `app_stop` | `appId` | Stop backend (`stop_background_process` → `setAppStopped`) |
| `app_delete` | `appId` | Full delete (stop + `papr_delete_app` delete files + `closeApp`) |

**AppDockPanel — Application Management Panel:**

App list + fixed bottom action bar. List items: status dot (green = backend running, red = backend stopped, gray = frontend-only ready) + emoji icon + app name. Bottom bar: ▶ Start / Open / ■ Stop / 🗑 Delete / Export zip. Open starts the backend first when needed; failure stays on the dock with process output. Stopping a backend leaves an already-open window in place and prompts to restart. Overwrites snapshot the previous tree into `.versions/` (excluding `db.sqlite*` / `node_modules`).

**Permission Model (Two Axes: local × network):**

Apps declare an access profile via manifest `local` (`none`/`read`/`write`) × `network` (`true`/`false`); legacy `level` (0-3) migrates automatically (0→{none,off}, 1→{read,off}, 2→{read,on}, 3→{write,on}):

| local | Capabilities |
|---|---|
| `none` | Pure compute; only `papr.db`/`papr.fs` (app-owned sandbox, always available) |
| `read` | + Agent read-only tools (read/grep/list/lsp/diagnostics/read_image/skill_load) |
| `write` | + Agent write/execute (write/edit/patch/bash) |
| network=true | + papr.http + Agent websearch/webfetch + MCP |

Resolution: `effective = manifest_access ∩ per-app override` (overrides can only narrow). When the manifest does not declare `local`/`network`/`level`, it falls back to the user's **default when undeclared**. That fallback is **not** a ceiling for declared apps. Settings **App Tab** (`AppPermissionsTab.tsx`): default when undeclared (local × network) + per-app two-control overrides.

**Network enforcement chain (core of the two-axis model):**

1. **Direct iframe networking**: `handle_app_protocol` injects a CSP response header (`build_app_csp`) per the manifest access profile. Network off: `connect-src 'self' [own backend port]`, `img-src 'self' data:`, `form-action 'none'`, `script-src` without `https:` — enforced by the browser engine, JS cannot bypass. Network on: `https:/http:/wss:/ws:` opened.
2. **Backend processes**: `app_start` resolves the access profile from the manifest and passes it via the `sandbox` argument to `start_workspace_background_command`; the sandbox-exec profile is built per axis (network off = `network-bind` + `network-inbound` for localhost listen, no outbound; local=read = workspace read-only).
3. **App-agent bash**: the worker carries `appAccess` in the tool-request bridge; the main-thread `run_workspace_shell_command` builds the sandbox per the access profile.
4. **Agent webfetch**: `fetch_web_url` now has SSRF protection (aligned with papr.http), blocking internal/private addresses.

**Backend URL Injection:**

`handle_app_protocol` detects the `port` field in manifest and injects `window.__PAPR_BACKEND_URL = 'http://localhost:{port}'` into HTML responses. Generated backend app HTML uses `const API = window.__PAPR_BACKEND_URL || ""` as API base URL. SDK's `papr.app.info()` returns `backendUrl`. Frontend always loads via `codepapr-app://` protocol (SDK auto-injected), backend only serves API endpoints.

**CSP Fix:** Added `codepapr-app:` to `frame-src` and `script-src` in `tauri.conf.json` CSP, fixing white screen when iframe loads custom protocol URLs that were blocked by CSP.

## 5. Character and Voice System

### 5.1 Character Roleplay

The character system allows users to create, import, and activate AI personas. When activated, the profile is injected into the Session Bootstrap, not the ImmutablePrefix, so switching characters does not break the system-prefix cache.

**CharacterProfile data model:** name, avatar, description, personality, scenario, first message, example messages, system prompt, tags, creator, version, interaction mode (coding persona / roleplay).

**Core capabilities:**
- **Manual creation**: Fill in name, description, personality, scenario, first message, example dialog, etc.
- **Import character cards**: Supports PNG (embedded chara-card-v3 JSON) and JSON file imports; compatible with SillyTavern and other tools using the CCv3 spec
- **Export character cards**: Export characters as PNG cards with JSON embedded in tEXt/iTXt chunks
- **Activate character**: Enable applies to the **current session only** (clicking a name in the list edits, it does not enable). The profile is injected via `buildCharacterSystemPrompt()` into the Session Bootstrap, **not** the ImmutablePrefix (preserving cache). Default is **coding persona**: voice and attitude only, tools and reply format unchanged. Optional **roleplay**: stage-play format for chat and TTS.

**Roleplay format convention (roleplay mode only):** Wrap actions/narration in `*single asterisks*` (not spoken), keep spoken dialogue as plain text (read aloud), use `**double asterisks**` for emphasis, and use `(parenthetical)` tone indicators (not spoken). Coding-persona mode does not inject this format.

### 5.2 Text-to-Speech (TTS)

The voice system is powered by GPT-SoVITS, a local voice cloning engine.

**Architecture:**
```
ChatPanel → useTtsPlayer hook → Rust TTS Module → GPT-SoVITS Python Server → rodio playback
```

**Key components:**
- **Rust TTS module** (`tts/`): Manages Python server process lifecycle, HTTP/WebSocket synthesis requests, rodio audio playback, model management, fine-tuning, training data generation
- **useTtsPlayer hook** (React): Streaming text input, sentence splitting, queue management, playback mode switching
- **TtsInstaller component**: One-click GPT-SoVITS installer (clone repo, pip install, download pretrained models)
- **TtsStatusBadge component**: TTS server status indicator

**Playback mode:**
The current UI uses `ws-batch` (WebSocket batch streaming) as the default and only active mode — all sentences are sent over a persistent WebSocket connection, synthesized and streamed back one-by-one, with ~1-2s latency to first word. The codebase retains `whole`, `streamed-pipeline`, and `streamed-pcm` modes, but the settings panel does not yet expose a mode switcher.

**Voice configuration (VoiceConfig):**
- Reference audio (`referenceSamplePath`) + text (`referenceText`) for voice cloning
- Speed (`speed`, 0.5-2.0), sample steps (`sampleSteps`, 4/8/16 presets: 4=fastest, 8=balanced, 16=highest quality), sentence chunking (`sentencesPerChunk`, 1-5)
- Fine-tuning support (`fineTunedModelPath`): auto-generate training data → background fine-tuning → produce .pth model

### 5.3 Playback Interaction

During voice playback, each AI reply has a "Replay" button on hover to re-speak that message. Cancelling the current Agent message stops ongoing playback.

On Apple Silicon Macs, users can manually click "GPU Warmup" in the Voice Tab of the character editor to pre-compile Metal GPU kernels, avoiding 5-15 seconds of first-synthesis delay.

## 6. Sub-Agents

### 6.1 Built-in Sub-Agents

| Agent | Purpose | Model | Tools |
|-------|------|------|------|
| explore | Read-only code analysis | fast | read, read_image, list, graph, glob, lsp, diagnostics, grep |
| scout | Web search + download | fast | websearch, webfetch, browser, read_image |
| mentor | Architecture/algorithm guidance | Configurable independent model | None |
| compactor | Context compaction (recoverable checkpoint generation) | `compactionModel` tier (fast/primary) | None (pure reasoning) |
| verifier | Goal verification | `verifierModelTier` tier | read, grep, glob, list |

> **Main Agent tool set**: the main Agent has all read/write/execution tools (read/write/edit/patch/grep/glob/list/lsp/lsp_edit/diagnostics/git/bash/browser/webfetch/skill/question/todo/task, etc.), but `graph` is **soft-hidden** from it — project structure and symbol navigation are handled by `list` + `lsp`, while cross-module dependency/impact analysis is delegated to Explore. The `graph` definition and handler stay registered, so sub-agents (Explore) can select it via allowlist and execute it.

> The Goal autonomous loop's verifier is a built-in read-only sub-agent (read/grep/glob/list) configured in Advanced settings (`verifierModelTier`). It is an internal agent, never exposed via the `task` tool, and only invoked internally by GoalRunner.

> Context compaction (Compactor) is likewise a built-in internal sub-agent (`compactionModel` tier + `compactionTemperature`/`compactionMaxTokens`), zero-tool pure reasoning — the compaction input (transcript) already contains all facts. It is invoked directly by the runtime compaction pipeline (between-turn and mid-loop compaction), never exposed via the `task` tool. Execution reuses core's `resolveSubagentExecution` + `runSubagentSession` (`utils/compactorRunner.ts`), shared by both threads (main-thread between-turn / Worker mid-loop); mid-loop compaction wires the `sessionAbortControllers` cancel signal, and a mid-flight cancel makes the handler return null for graceful teardown. The wall-clock budget keeps the sub-agent default of 20 minutes.

The `task` tool only exposes agents whose `mode` is `subagent` / `all`; agents with `mode: primary` (only usable as an @-mentioned primary agent) or `internal: true` never appear in the delegation list.

### 6.2 Sub-Agent Independent Context

**Each sub-agent gets a fresh Session**, with no access to the main Agent's conversation history:

- Creates a new `AppendOnlyLog` — blank log
- Tool set is filtered by the allowlist in the definition (Explore has 8 tools)
- Only receives the task description from `task.prompt` as its sole context
- Nesting depth is configurable (`subagentMaxDepth`, default 2; explore/scout can override via `exploreMaxDepth` / `scoutMaxDepth`)

Design intent: sub-agents are "stateless workers focused on a single task", isolated from the main Agent's context window pollution.

**Single source of truth**: the main-thread (`uiTaskTool.ts`) and Worker (`agentRuntime.worker.ts`) sub-agent paths share `@codepapr/core`'s `subagentConfig.ts` — `resolveSubagentExecution` (resolves model route / parameters / depth / rounds / mentor config) and `runSubagentSession` (builds the Session + Agent and runs it). Each path injects only its differing parts: the ToolRegistry (direct execution vs IPC) and the Provider (including mentor construction), preventing logic drift.

### 6.3 Model Routing

Sub-agents select models via `selectSubagentExecutionRoute`:
- Sub-agent definition `model: 'fast'` → fast model (default deepseek-v4-flash)
- Task contains execution verbs (fix/implement/build) → primary model
- Mentor defaults to primary model, configurable with independent API key and model; falls back to the main API key when no dedicated key is configured
- A custom sub-agent's `temperature` declared in frontmatter takes effect (as the route temperature); explore/scout have their own defaults (0.5 / 0.3)
- Explore / Scout support tier switching between `primary` and `fast` via settings

### 6.4 Sub-Agent Timeout Protection

Sub-agents never wait indefinitely — multiple layers of timeout ensure timely failure:

- **90-second per-tool timeout**: each `toolRegistry.execute()` call in `Agent.ts` is wrapped with `withTimeout`; on timeout, returns `{ error: 'tool execution timeout' }` to the LLM for autonomous decision
- **Overall wall-clock timeout**: `runSubagentSession` in `subagentConfig.ts` has a built-in timeout (5 minutes on the Worker path); timeout calls `agent.cancel()` to terminate the loop
- **120-second Worker IPC timeout**: `requestToolExecution` promise includes a built-in timeout that cleans up the waiter, preventing permanent hangs when the main thread fails to respond
- **App Agent 300-second idle timeout**: the `papr.agent.run` path uses idle semantics at all three layers (iframe SDK, main-thread `WorkerBackedAgent`, Worker `withIdleTimeout`) — every streaming event resets the timer, so a task may run indefinitely as long as it keeps producing events; only 300s of total silence triggers the timeout

Timeouts are not silent failures — error information is returned to the LLM, which can decide to retry, switch strategies, or report to the user.

## 7. TodoList

### 7.1 Design Intent

TodoList is the main Agent's "short-term working memory", replacing the old three-tool system (todo_write/todo_update/todo_complete) and old orchestration system (agentOrchestration.ts).

### 7.2 Single Tool, Two Modes

```
todo tool
├── tasks parameter → Full replacement (initialize / re-plan)
└── updates parameter → Partial update (progress report / completion / failure report)
```

- Marking tasks `completed` automatically advances to the next `pending` task
- Failed tasks auto-retry per `maxRetries` (configurable, default 3)
- Each invocation returns the full TodoList snapshot; the LLM can see current state without relying on system prompt

### 7.3 Division of Labor with task Tool

- `todo`: Maintains the main Agent's own plan
- `task`: Delegates individual tasks to sub-agents
- The two are orthogonal and non-conflicting

### 7.4 UI Interaction

- **TaskChecklist** component displays real-time progress bars and status
- Shows only titles (not descriptions and status labels), compact layout
- **Auto-collapse**: Collapses to a one-line summary when all tasks complete + Agent stops
- **Auto-expand**: Expands when new tasks arrive or status updates occur
- Manual click to expand/collapse

### 7.5 Conversation Reset (Shadow Git Rollback)

Hover a user message → "Reset to here" button appears:

- **Shadow Git Architecture**: CodePapr maintains an independent internal Git repo at `.CodePapr/git/` (no conflict with the user's `.git`). All git operations use libgit2 — **no system Git CLI required**
- **Snapshot Engine**: On each user message, `IgnoreResolver` (via `ignore` crate) traverses workspace files (auto-excludes `node_modules/`, `dist/`, large files, etc.), creates snapshot commits file-by-file via `index.add_path`, validates file count > 0
- **Restore Engine** (three-phase): `restore_plan` computes file changes → preview (files to restore/delete/unchanged) → user confirms → `restore_execute` performs reset (creates backup ref `refs/codepapr-backup-before-reset` + refuses empty tree)
- **Undo**: `restore_undo` restores to pre-reset state via backup ref
- **Message truncation**: Removes all messages after the target; restores truncated message input and images
- **Checkpoint Timeline**: `checkpoint_timeline` table in `project.sqlite` records each snapshot's message_id, sha, file count, and timestamp
- **Confirmation dialog** prevents accidental operations

## 8. Project Memory System

The SQLite `memory_entries` ledger is the sole store; the memory panel is the only human surface; the session-bootstrap memory slice is rendered from the ledger; procedures are recalled per turn. Human-readable layering: [`docs/web/context-architecture.en.html`](../web/context-architecture.en.html). Implementation: §16.

### 8.1 How memory sits in the context window

Remembered facts do not all live in one layer, and they do not all change at the same time:

| Kind | Stored in | Request layer | When it changes |
| --- | --- | --- | --- |
| Hand-written notes (`user-note`) | SQLite `memory_entries`; panel “every session” | Session Bootstrap (stable prefix) | After a panel edit: **next session** or **compaction epoch** |
| Preferences / constraints / project facts | Same ledger | Same, Bootstrap | Written to the ledger immediately; **current-session prefix stays frozen** until next session or compaction |
| Procedures (`procedure`) | Ledger; panel “on-demand” | Turn-scoped Recall / `memory_search` | Recallable from the next user turn; never in the prefix |
| Web / MCP citations (`citation`) | Ledger; panel “search only” | `memory_search` only (auto-Recall **skips** them) | Searchable once saved; never treated as instructions |
| Current-task goal / todos | Session Checkpoint | Session State (rewritten on compaction) | Evolves with the epoch; **not** project memory |
| Large tool output | `.CodePapr/tool-output/` | Not auto-injected; `read_artifact` on demand | Frozen at write time |

Bootstrap memory is “short instructions + facts every session carries”. Recall is “old experience that might help this turn”. Checkpoint is “where this task is”. Do not copy one into another.

### 8.2 Ledger + panel (the only memory surface)

The ledger in SQLite `memory_entries` is authoritative. The panel groups by request layer:

- **Every session**: user-note / preference / constraint / fact / convention / verification / decision / api / general. Rendered into Bootstrap, capped at 24 entries / 1500 tokens.
- **On-demand recall**: `procedure`.
- **Search only**: `citation`.

Hand-written notes are added/edited only in the panel. The Agent cannot label an entry `user-note`, and cannot `memory_forget` a handwritten note. If a leftover `.CodePapr/memory.md` is still on disk, opening the project files it into the ledger once, then deletes the file.

### 8.3 Write path (zero review)

The gate is `planMemoryWrite` (`ContentEnvelope`): persist or drop. **No user
admit queue.**

- **Save immediately**: user said remember / must / don't; workspace-grounded
  facts; successful test commands; cold-start summary; Agent `memory_write`
  that is not web content; panel handwritten notes.
- **Store as citation, never Bootstrap**: web / MCP / `https` evidence /
  `category: citation`.
- **Drop**: injection, secrets, disable-sandbox, dangerous commands, raw
  assistant reasoning, oversize / undersize.
- **Direct write/patch of `.CodePapr/memory.md`**: intercepted onto the same policy, never written to disk.

The panel is a catalog of every memory, grouped and forgettable. No admit /
reject.

### 8.4 Load mechanism (cache behavior)

- At session start, render the Bootstrap section from the ledger into `log[0]`, frozen per
  (session × stable signature) — **not reloaded on ordinary turns**;
- The rendered ledger section is excluded from `bootstrapSignature`: newly saved memories **do
  not bust the current prefix cache**;
- Refreshed with `refreshBootstrap` when a compaction epoch is rewritten
  (zero extra cache cost);
- Always re-read from the ledger on a new session;
- Each user turn also runs Recall (§8.6 / §16.6); citations are excluded from
  automatic Recall.
- Agent-initiated reads: `memory_search` (keyword search, including citations;
  available in Ask); `memory_review_candidates` (catalog preview, at most 40
  rows, unavailable in Ask). Search is not run on every message, and the ledger
  is never dumped into a request.

### 8.5 Dedup

Same-hash active rows are superseded. There is no LLM pass over a standalone memory file.

### 8.6 Memory Recall (on-demand retrieval)

See §16.6. Auto-Recall corpus = active `memory_entries` (skipping
`citation` and untrusted) + historical checkpoints. `memory_search` can still
retrieve citations. The Recall Block never enters log / surface / archive
messages; audited in `memory_recalls`.

### 8.7 Key Source Locations

- `packages/@codepapr/core/src/context/ContentEnvelope.ts`: envelope / redaction / `planMemoryWrite`
- `packages/@codepapr/ui/src/utils/memoryLedger.ts`: extraction / Bootstrap rendering
- `packages/@codepapr/ui/src/utils/memoryPersist.ts`: auto persist (no user queue)
- `packages/@codepapr/ui/src/store/internals/memoryLedgerStore.ts`: session-start render + end-of-turn orchestration
- `packages/@codepapr/ui/src/components/MemoryLedgerPanel.tsx`: memory panel
- `packages/@codepapr/ui/src-tauri/src/db/mod.rs`: memory_entries / memory_candidates /
  memory_recalls tables; `ingest_legacy_memory_md`

## 9. ProjectGraph Semantic Analysis

### 9.1 Tool Definition

`graph` is a unified project semantic graph tool accessed via the `action` parameter. **Soft-hidden from the main Agent's LLM**: main-Agent-facing code intelligence is provided by the `lsp` tool (9 navigation actions, LSP-first with AST project-graph fallback) and `list` (directory tree + per-file lightweight symbols), while cross-module dependency/impact analysis is delegated to the Explore sub-agent. The `graph` definition and handlers stay registered — the Explore sub-agent selects it via allowlist for impact/dependency analysis, and it also serves UI panels and acts as the AST fallback backend for `lsp` point queries.

**Graph build cache**: on the UI side, `buildIntelligenceProjectGraph` (workspaceTools.ts) caches the full build result—keyed by "build args + workspace", 60s TTL, cleared on any workspace write via `notifyWorkspaceMutation`, with in-flight builds for the same key deduped and capped at 3 entries (FIFO eviction). A `lookup→dependency→impact` sequence builds the graph only once.

**Basic navigation (7 actions):**
| Action | Function |
|---|---|
| `full` / `overview` | Generate full ProjectGraph (directory tree + code structure skeleton + dependency graph) |
| `lookup` | Find symbols by name/path |
| `dependency` | Extract dependency subgraph |
| `entrypoints` | Find entry files |
| `impact` | Reverse impact analysis |
| `implementations` | Find interface/base class implementations |
| `smart_context` | Task-aware intelligent context |

**Advanced analysis (6 actions):**
| Action | Function |
|---|---|
| `dead_code` | Detect unused symbols |
| `circular_deps` | Detect circular import dependencies |
| `type_hierarchy` | Build type inheritance hierarchy |
| `suggest_refactors` | Refactoring suggestions (extract method + separate file) |
| `test_impact` | Change-impact test selection |
| `generate_tests` | Test skeleton generation |

### 9.2 Implementation Location

- Public entry point is `core/src/tool/workspace/graphQuery.ts` (a barrel); implementations are split by query domain under `core/src/tool/workspace/graph/` (19 modules: symbolLookup / dependency / overview / rename / circularDeps / deadCode / typeHierarchy / testDiscovery / refactorSuggestions / testImpact / architecture / semanticDiff / testGeneration / refactorPlans / incrementalUpdate, etc.)
- The UI registers the tool handlers via `workspaceGraphLspTools.ts`
- The Explore sub-agent selects this tool via allowlist (`graph: true`); its system prompt lists the commonly-used actions

## 10. Prompt Assembly and DeepSeek Cache Optimization

### 10.1 Three-Layer Structure

**Layer 1: System Prompt (ImmutablePrefix)**
Fully fixed, cross-session reusable prefix:
1. Base Identity
2. Mode Intro (Agent/Plan/Ask constraints)
3. Workspace Path
4. Core Constraints
5. Tool Constraints (dynamically generated per available tools)

**Layer 2: Session Bootstrap (AppendOnlyLog first assistant message)**
Stable across turns:
1. Skills Section
2. Custom Guidance (user long-term preference prompt)
3. Character profile (**this session's** CharacterProfile; new sessions start with none)

**Layer 3: Runtime User Prompt (current turn user message)**
Built on each user input:
1. Mode Header
2. User Input
3. Runtime Context (date/timezone)
4. TodoList Digest (background progress, marked "the current turn follows the user's latest message")

The project structure overview and project diagnostics are **no longer injected into the per-turn user prompt**: user messages sit at the request tail and never hit the prefix cache, and on large projects the overview can reach tens of thousands of tokens per turn. Instead the agent fetches them on demand via the `graph` ("get the map before acting") / `diagnostics` (final check after edits) tools, per the system-prompt constraints; write/edit/patch still auto-return per-file diagnostics after each modification.

### 10.2 Key Invariants

- User custom prompts go into session bootstrap, not per-turn user prompt
- Skills go into bootstrap, not system prefix
- Character profile goes into bootstrap, not system prefix (switching characters does not break cache)
- ProjectGraph Summary does NOT go into the main agent's per-turn user prompt (token waste); the agent fetches it on demand via the `graph` tool. Only sub-agent bootstraps and ledger cold-start generation still use it
- Workspace path appears only once in system prompt
- Custom guidance appears only once in bootstrap
- `topP`, `temperature`, `maxTokens`, `thinkingEnabled` are frozen together in ImmutablePrefix; any change breaks the cache hash
- Session bootstrap is cached per "session × stable signature"; new ledger writes do not trigger rebuilds (see §13.6); memory is refreshed together with bootstrap at mid-loop compaction (free because the epoch is rewritten anyway)
- Per-turn dynamic content (date / TodoList digest) is placed at the tail, not in the existing prefix

## 11. Model Routing

Currently active routing functions (old planner/summary routes removed):

| Scenario | Function | Model | Temperature |
|---|---|---|---|
| Main Agent conversation | `selectTaskModelRoute` | Primary model | User-configured |
| Slash commands (declaring `model: 'fast'`) | `selectTaskModelRoute(..., 'fast')` | Fast model (falls back to primary if disabled) | User-configured |
| Context compaction (compactor sub-agent) | `selectSubagentExecutionRoute` (via `resolveSubagentExecution`) | `compactionModel` tier (fast/primary; LLM skipped when fast is disabled — rule-based fallback) | User-configured `compactionTemperature` |
| Memory consolidation | `selectContextCompactionModelRoute` | Fast/Primary model | User-configured `compactionTemperature` |
| Sub-agent execution | `selectSubagentExecutionRoute` | Determined by task weight | User-configured `subagentTemperature` |
| Primary model fallback | `buildPrimaryModelRoute` | Primary model | User-configured |

Slash command `model` field (declared in `BUILTIN_PROMPT_COMMANDS` or `.CodePapr/commands/<name>.md` frontmatter) is passed as `preferredTier` to routing: `'fast'` routes to the fast model (`selectTaskModelRoute(..., 'fast')`); otherwise the primary model is used.

## 12. Execution Model

### 12.1 Request Chain

```
User → Surface → Agent.chat() → RequestBuilder → Provider → CacheValidator → Tool Execution → State Persist → Response
```

### 12.2 Multi-Turn Tool Loop

- Continue as long as tool calls are detected
- Limited by `maxToolRounds` (configurable, default 500)
- Tool results are written to AppendOnlyLog; subsequent requests are based on the full execution history
- **Context overflow is checked before building each round's request**: if the effective threshold is exceeded, compaction runs (resetting the log into a new epoch) before continuing, so no request ever uses an over-limit context (see §13.3)

## 13. Cache-First Architecture

CodePapr's central architectural decision is **prompt partitioning and context management built around DeepSeek's implicit prefix caching**. DeepSeek caches automatically by byte-exact prefix match (no explicit breakpoints): as long as the request's `tools → system → messages` prefix is byte-identical to a recent request, the matched portion is billed at the cache rate (~¥0.025/M) and only the new tail is billed as input. Hence the first principle:

> **Keep the prefix byte-stable (append-only) within an epoch; reset it deliberately only across epochs via compaction.**

### 13.1 Three-Partition Structure

| Partition | Content | Design Purpose |
| --- | --- | --- |
| ImmutablePrefix | System prompt, tool definitions, model parameters (incl. topP/temperature/maxTokens/thinkingEnabled) | Lock the prefix byte sequence; immutable for the agent's lifetime |
| AppendOnlyLog | User messages, assistant messages, tool results | Append only, no rewrite |
| VolatileScratch | Temporary reasoning, intermediate plans, per-turn drafts | Isolate unstable content; never sent |

### 13.2 Context Epoch Model

An **epoch** = a span within one agent lifetime during which the prefix stays byte-stable. Within an epoch:

- ImmutablePrefix is unchanged (the system prompt has no dynamic content, enforced by `RequestBuilder.validateStaticSystemPrompt`, which forbids template interpolation / timestamp placeholders, etc.).
- Tool definitions are frozen and sorted (`canonicalToolDefinition` + `localeCompare`); `validateToolsImmutable` verifies byte-for-byte stability.
- AppendOnlyLog only grows: each tool-loop round appends the assistant message and tool results to the tail; the prefix (all prior messages) is reused byte-for-byte → the multiple calls within a tool loop naturally hit the cache.

**The epoch boundary = context compaction.** Compaction is the **only** sanctioned prefix reset: when the context threshold is reached, history is summarized into a checkpoint + retained tail, starting a new epoch (a one-time miss, then stable hit accumulation resumes). This mirrors OpenCode's Context Epoch and Claude Code's auto-compact.

The compacted effective context = `[checkpoint summary, ...retained tail]`. The checkpoint is **inserted at the retention boundary** (`planContextCompaction.insertIndex`, placed on a UI-message boundary via `insertCheckpointAtRetainedBoundary`), not appended at the end of the list — `buildEffectiveContextMessages` treats the messages **after** the checkpoint as the retained tail, so the most recent rounds (including tool-call↔result pairs) stay verbatim after the checkpoint and only earlier messages are summarized. The boundary is chosen at **UI-message granularity** (each assistant+tools group is atomic), so no tool message is ever orphaned. In the effective context the checkpoint is emitted as a **user turn** (not assistant), avoiding a leading/consecutive assistant message after compaction for better cross-provider (OpenAI / Claude) correctness; checkpoint detection is payload-based (`contextCheckpoint`), independent of role.

Checkpoints are **structured state** (13 sections + ContextFact provenance, see §16.4); every compaction carries full provenance (compactionId / generation / trigger / source range / tokenStats, §16.2); soft/hard budget layering and prune-first are in §16.5. The compaction transaction is committed atomically by the main-thread Store; a failed compaction keeps the previous completed surface.

### 13.3 Mid-Loop Overflow → Compaction

Context grows with tool results during the tool loop. `Agent.chat` performs an overflow check **before building each round's request** (`estimateContextTokens`: a rough estimate of prefix bytes + log bytes / 4):

1. When the effective threshold (`contextCompaction.maxContextTokens`) is exceeded, the injected compaction handler runs:
   - Convert the current log (core `IMessage`) into ui `ContextMessageLike` (`coreMessagesToContextMessages`, re-attaching tool results to the assistant's `toolInvocations`, round-trip faithful);
   - Run the same pipeline as between-turn compaction (`maybeGenerateContextCheckpoint` produces the checkpoint summary and freezes the current TodoList digest);
   - `buildEffectiveContextMessages` inserts the checkpoint at the retention boundary (the recent tail, tool calls included, stays verbatim after it) + prunes old tool results in the tail;
   - `Session.replaceLog` resets the log (`AppendOnlyLog.reset` + reload) and `RequestBuilder.resetLogTracking` resets append-only tracking to avoid false violations;
   - Merge the compaction's cacheStats, emit a `context-compacted` stream event, and continue the loop.
2. **Check timing: round-start only.** Tool results are appended at the end of a round; the overflow they cause is caught at the **next round's start** — no LLM request is ever sent with an over-limit context; the tool-calling task continues after compaction from "summary + recent tail".
3. **No mid-tool-execution compaction:** a round's multiple tool calls are executed atomically before compacting at the round boundary, preserving tool-call↔result pairing.
4. **Anti-loop:** `lastCompactionRound` guarantees at least 2 rounds between compactions; a null handler result does not reset it.
5. **Defense in depth:** `toolOutputTruncation` bounds each tool result to ~100KB (or spills to disk with a preview), so per-round growth is bounded and cannot blow the provider's hard limit in a single round. Middle-truncation keep size defaults to 20k chars and is configurable via `toolOutputMiddleKeepChars`. Tool context mode (full/summary/auto, default full) does NOT affect the current round — a tool result is always sent to the LLM in full (bounded by this truncation pipeline); it only controls whether the result is replaced by a frozen summary once it becomes history (see §13.10).

### 13.4 Pruning Is a Compaction Sub-Step (Not a Separate Mechanism)

`pruneOldToolResults` replaces large old tool results (beyond the protection window `pruneProtectRounds`, default 6 rounds, and ≥ `pruneMinChars`, default 20KB) with a placeholder. It has **no independent trigger**; it runs only inside `buildEffectiveContextMessages` (at compaction/rebuild) as an internal slimming sub-step of compaction (mirroring OpenCode's `SessionCompaction.prune`). The only trigger is the context threshold:

```
context reaches threshold → compaction (shouldCompact) → rebuild agent → prune at the end of buildEffectiveContextMessages
```

Compaction summarizes away the head (incl. old tool results); pruning slims the retained tail. The pruning settings (`pruneOldToolResults` / `pruneProtectRounds` / `pruneMinChars`) are internal tuning knobs, not exposed in the UI. Note this differs from `compactionMaxTokens` (the compaction summary's output limit): the latter is how long the summary LLM call may write, not a trigger threshold.

### 13.5 Effective Context Threshold (user-configured)

`maxContextTokens` (default **500K**) is the compaction trigger threshold. It applies **uniformly** to DeepSeek / OpenAI-compatible / Claude providers — no per-provider clamping (`effectiveMaxContextTokens`):

```
effectiveMaxContextTokens = maxContextTokens
```

OpenAI/Claude-compatible endpoints are often forwarding gateways (e.g. an OpenAI gateway serving a large-context DeepSeek model); clamping to the nominal provider limit would trigger excessive compaction on long tasks. The user owns the configured value (Settings → Advanced → Max Context Tokens).

Higher threshold → fewer compactions → fewer epoch resets → higher hit rate (cache reads are cheap). This effective value is used for both between-turn compaction (`planContextCompaction`) and the mid-loop overflow check.

### 13.6 Prefix-Stability Guarantees (avoiding per-round prefix breaks)

These measures keep the prefix byte-stable within an epoch (any break invalidates everything from that point on):

| Guarantee | Implementation |
| --- | --- |
| No per-request prefix mutation | Pruning runs only at compaction/rebuild, not as a sliding window on every request build |
| Byte-identical rebuild serialization | `toCoreTailMessages` uses `sortedStringify` for object tool results (matching the live path `Message.tool`); empty assistant content is `''` (not `' '`) |
| Fewer rebuilds | Session bootstrap is cached per "session × stable signature" (`resolveSessionBootstrap`); new ledger writes do not trigger rebuilds; memory is refreshed together with bootstrap at mid-loop compaction (free since the epoch is rewritten anyway) |
| Stable reasoning round-trip | `reasoning_content` is round-tripped based on "presence + model capability (`supportsThinkingPayload`)", decoupled from the per-request thinking toggle, so rebuilds don't add/remove reasoning on history |
| Frozen TodoList digest | The current digest is frozen into the checkpoint payload at generation and reused on rebuild instead of re-rendered live |
| Frozen parameters | topP / temperature / maxTokens / thinkingEnabled are frozen in ImmutablePrefix; any change flips the hash |
| Dynamic content placed at the tail | Per-turn dynamic content (date / TodoList digest) goes into the new user message (tail), not the existing prefix |
| Heavy context fetched on demand | Project structure overview and diagnostics are NOT injected into the per-turn user prompt (tail content never hits the prefix cache; tens of thousands of tokens per turn on large projects); the agent fetches them via `graph` / `diagnostics` tools on demand |

### 13.7 Hashing and Validation

- ImmutablePrefix's SHA256 hash includes the entire `parameters` object — `temperature`, `topP`, `maxTokens`, `thinkingEnabled` all participate. Any parameter change → hash change → cache miss.
- `RequestBuilder` 8-point validation: static system prompt, immutable tools, runtime tools match the frozen prefix, append-only log (`validateAppendOnly`, unchanged prefix, etc.).
- `resetLogTracking`: after compaction resets the log, append-only tracking (`lastLogMessagesHash` / `lastLogMessageCount`) is reset so the next build treats the new log as the baseline (no false "history modified" error); prefix/tool tracking is preserved (prefix unchanged).
- `CacheValidator` parses the response's `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` and normalizes hit-rate statistics.

### 13.8 Known Limitations

- **Server-side cache TTL:** DeepSeek's prefix cache has a lifetime; after a long idle period the first call re-misses the whole prefix (unavoidable, independent of the client). The higher the threshold, the larger the re-miss cost after TTL expiry.
- **Compaction is lossy:** the checkpoint summary loses some detail; the higher `maxContextTokens`, the more history a single compaction covers and the greater the summarization pressure.

### 13.9 Comparison with Industry Approaches

| Approach | Caching mechanism | Context convergence |
| --- | --- | --- |
| OpenCode | Context Epoch + Anthropic cache breakpoints (last tool / system / user message) | `isOverflow` check before each turn → compaction (incl. `SessionCompaction.prune`) |
| Claude Code | Anthropic prompt caching (prefix stability + breakpoints) | auto-compact summary at ~95% context |
| CodePapr | DeepSeek implicit prefix caching (three partitions + byte-stable within epoch) | Between-turn compaction + mid-loop round-start overflow check → compaction (incl. pruning sub-step) |

Shared principle: **bound context with overflow-triggered compaction, keep the prefix byte-stable between compactions, and never mutate the already-sent prefix per round.**

### 13.10 Tool Context Mode (current round full / history summarized)

Tool context mode (`toolContextDefaultMode` / `toolContextOverrides`, default `full`) controls how tool output appears **once it becomes history context**, decoupled from what is sent to the LLM:

- **Current round is always full:** a fresh tool result always enters the log and the current request in full (size bounded by the truncation pipeline: 60k middle-truncation / 100k offload / 150k ceiling), so the LLM sees every result completely and reasons over it.
- **Summary frozen at write time:** when the mode calls for summarization (`summary`; or `auto` with original chars > `toolContextAutoThresholdChars`, default 5k), a summary is computed once at write time and frozen into `message.metadata.toolSummary`. Interactive tools (question / todo / skill / task) are never summarized. The summary is not a content slice but a structured card: `[tool] ✓/✗ | key args` → `size stats (of the original output)` → `head+tail preview (first 3 + last 3 lines, ≤150 chars each; a single block when ≤6 lines)` → `Full output: {spill path} (read it back with read)` (only when the truncation pipeline already spilled, reusing its path), clamped to `toolContextSummaryMaxChars` (default 500). Per-tool card fields: read carries the path and line-range/symbol suffix, bash the command, edit/patch the `-removed/+added` char counts, grep/glob the query and match counts.
- **Flip at request-build time:** when assembling messages, `RequestBuilder` calls the pure function `applyHistoryToolSummaries`: among tool messages carrying a frozen summary, all EXCEPT the latest batch (the tool results of the last assistant round with toolCalls) are replaced by their frozen summary; the latest batch stays full. Only the request copy is rewritten, never the AppendOnlyLog.
- **Cache behavior:** the flip point always sits adjacent to the tail, so each round's missed suffix is a small bounded constant (one flipped message + one new round), while the "stable summary zone" before it grows with the conversation and keeps hitting. Each message flips exactly once — a one-time prefix-cache invalidation — unlike the removed legacy sliding-window pruning (its window moved every round, re-caching the whole protected window each time).
- **Live/rebuild byte parity:** the frozen summary flows into `UIToolInvocation` via the stream event's `contextSummary` and is persisted; at rebuild time (`buildEffectiveContextMessages`) it is re-attached to metadata and the same pure rule is applied. Layering with pruning: placeholder (oldest; pruning also drops the summary so it cannot resurrect) < summary (middle-aged) < full (latest batch).
- **Opt-in spectrum:** `full` produces no frozen summary — pure append-only with perfect caching (the default; out-of-box behavior is identical to the legacy version); `summary` / `auto` enable rolling summaries, opted into per tool via overrides (the built-in per-tool default table was removed; everything follows defaultMode).

## 14. Settings Structure

The settings panel has six tabs. Full parameter reference: `packages/@codepapr/core/docs/CONFIGURATION.md`.

| Tab | Content |
|---|---|
| General | Language selection, debug toggle, license |
| LLM | API type, model name, fast model, temperature, topP, maxTokens, thinking mode, maxToolRounds |
| Search | Self-hosted SearXNG first, with automatic fallback to built-in multi-source aggregation when unavailable; engine selector removed from UI; category/time/language/safe search parameters moved to collapsible Advanced Options section |
| Mentor | Mentor sub-agent independent API key, Base URL, model selection |
| Advanced | Context compaction (model/temperature/summary output tokens/context limit/conversation rounds), TodoList max retries, ProjectGraph depth/file limits, streaming & tool output (stream idle timeout, middle-truncation keep chars), tool context mode (full/summary/auto, default full; the current round always gets full output, only history is summarized per mode, see §13.10). The context limit `maxContextTokens` defaults to 500K; its effective value is clamped to the selected provider's context limit (see §13.5) |
| App | .papr app permissions — default when undeclared (local × network) and per-app two-axis overrides |

Voice configuration is not in the main settings panel — it is configured per character in the CharacterModal Voice Tab.

## 15. Project Statistics

The project statistics modal (`ProjectStatsModal`) provides two views: **codebase statistics** and **Agent contribution statistics**.

### 15.1 Native Rust Statistics Engine

Codebase statistics are computed in one pass by the Rust command `compute_project_stats` (`workspace_fs/stats.rs`), replacing the earlier slow "frontend reads every file over IPC" approach:

- **Gitignore-aware parallel walk**: reuses the search module's `ignore::WalkBuilder` (`.git_ignore(true).git_exclude(true).ignore(true)` + `should_ignore_dir` filter) with `build_parallel()` multi-threaded traversal, honoring the project's actual `.gitignore` (not a hardcoded ignore list).
- **Language detection**: `language_from_path` (ported from `editorLanguage.ts`) maps filename special cases (dockerfile/makefile/.env, etc.) and extensions to language ids.
- **code/blank/comment classification**: per-language comment-syntax table (`//`, `#`, `--`, `;`, `/* */`, `<!-- -->`, `""" """`, etc.) + a cross-line block-comment state machine; lines mixing code with a trailing comment count as code (cloc convention).
- **Binary exclusion**: `decode_text_bytes` rejects binary files (counted as skipped).
- **Aggregation**: aggregates by language / top-level directory / file-size bucket, computing largest file, average/median/max lines per file, and the code/config/doc ratio.
- **Result shape**: `#[serde(rename_all="camelCase")]` mirrors the frontend interface, including `blankLines`/`commentLines` and per-language code/blank/comment.

The frontend `loadProjectStats` makes a single `invoke('compute_project_stats')` and only adds display labels (`formatLanguageLabel`) on the frontend.

### 15.2 Frontend Visualization & Interaction

- **Directory treemap**: a self-contained balanced-split algorithm `computeTreemap` (weighted by line count, recursively splitting along the longer axis; no third-party dependency). Cells are sized by area proportion, with hover highlight/dim + tooltip.
- **Sortable/filterable language table**: `LanguageTable` with clickable sortable headers (language/files/lines/code/blank/comment, asc/desc), a language filter input, and row hover; the stacked ratio bar is kept on top.
- **Result caching + timestamp**: a module-level `statsCache` shows cached data immediately and refreshes in the background (falling back to cache on error); the header shows an "As of HH:MM:SS" timestamp.
- **Motion**: staggered section reveal (`statsReveal`), treemap cell pop-in (`treemapPop`), bar growth (`barStretch`) — see `index.css`.

### 15.3 Agent Contribution Statistics

The `AgentContribution` component reuses **existing backend commands** (no new Rust code) to compute the agent's changes:

- **Data source**: checkpoints in the shadow Git repo (`.CodePapr/git`). Each user message triggers `snapshotCreate` and writes to the `checkpoint_timeline` table.
- **Cumulative contribution**: `loadCheckpointRecords` fetches all checkpoints; `diffSnapshots(first checkpoint → HEAD)` yields changed files and added/deleted lines (`FileDiff.additions/deletions`).
- **Display**: cumulative cards (files changed / additions / deletions / net), top 8 changed files (sorted by churn, green/red bars), and session activity (checkpoint count + time range per session).
- **Note**: cumulative changes based on Git checkpoints, including both agent and manual edits; degrades gracefully when there are no checkpoints.

### 15.4 Tool Usage Statistics

The `ToolUsageStats` component aggregates tool call records (`toolInvocations`) from all sessions in `agentStore.sessionMessages`, supporting tool-design decisions:

- **Aggregation**: `aggregateToolUsage` counts calls and success/failure per tool name, sorted by call count descending.
- **Display**: horizontal bars (bar length scaled relative to the max count) + call count + success rate (≥90% green / ≥60% yellow / else red); a header summarizes total calls and distinct tool count.
- **Purpose**: makes it obvious which tools are heavily used vs. rarely or never called (never-called tools are not listed), helping evaluate tool-design soundness.

The modal is enlarged to `w-[min(96vw,1280px)] h-[90vh]` (slightly smaller than the main interface) and uses a multi-column grid layout (languages + tool usage in two columns, three metric cards, file size in two columns) to take advantage of the width.

## 16. Context architecture (request layers · Surface · ledger · Recall)

> Human-readable layering and flow: [`docs/web/context-architecture.en.html`](../web/context-architecture.en.html).
> Implementation below: SQLite messages remain the raw archive; the history the model sees is a Surface projection and never duplicates message text.

### 16.1 How a request is stacked (01–05)

```text
01 System core      system prompt / tools / params / AGENTS.md     frozen for the session
02 Session bootstrap Skills catalog / memory slice / guidance       memory: compact or new session
03 Session state    checkpoint + retained recent turns              rewritten on compaction
04 Turn recall      retrieved old experience (skip citations)       new every user turn
05 This turn        current user message + tool results             append-only
```

Storage maps to: Archive (messages) → Surface (authority for the current model history) → Checkpoint → Memory Ledger → turn-scoped Recall. Project memory: §8.

Final request shape:

```text
[Immutable Prefix]        system prompt / tools / params / AGENTS.md
[Session Bootstrap]       skills catalog / memory slice / long-term guidance (always outside Surface)
[Surface Materialization] checkpoint + retained model-visible history
[Turn-scoped Recall]      anchored before the current user message (this request only)
[Current User Message]    current user message
[Current Turn History]    this turn’s assistant / tool results
```

### 16.2 Context Surface & compaction transaction

- **No foreign keys**: `context_surfaces` / `context_surface_nodes` /
  `context_compactions` store message-ID strings only — `save_message_batch` is
  full-replace (DELETE+INSERT), so FK cascades would wipe surfaces on every save.
  Referential integrity is application-level (missing on hydrate → degraded →
  fall back to parent generation → re-bootstrap generation 0).
- **Surface is the selection authority**: with a persisted surface, scanning for
  the "latest checkpoint" is forbidden; sessions without a surface use generation-0
  bootstrap. Rebuild = Surface hydrate → deterministic compiler replay
  (`buildEffectiveContextMessages`), byte-identical to the live epoch.
- **Single-transaction compaction commit** (`commit_context_compaction`, Rust):
  checkpoint message enters the archive with the message batch → within one
  transaction: `started row → surface generation + nodes → completed row`;
  crashes leave no started rows (defensive cleanup on DB open). Failed
  compactions only write a failed row; the previous completed generation stays
  active (invariant 5).
- **Immutable provenance**: the checkpoint payload carries compactionId /
  generation / trigger / source range (sourceStart/EndMessageId) /
  retainedTailStartMessageId / tokenStats / summaryInfo — all message IDs,
  never mutable positional indexes.
- **Main-thread Store is the only DB writer**: between-turns inline; the worker's
  mid-loop compaction ships `MidLoopCompactionCommit` in the result message and
  the main thread locates the insertion point by message ID and commits.

### 16.3 Frozen render params

Each surface generation freezes `render_params` (prune params + renderVersion).
Restart rebuilds replay the compiler with **frozen params**, ignoring current
settings' prune config → restart bytes match the live epoch.
Generation 0 freezes "disabled" params (that epoch was never pruned). Per-request
pure functions (`applyHistoryToolSummaries` latest-batch flip, `stripConsumedImages`)
never enter the persistence layer. Code upgrades change bytes → one-time cache miss
(accepted).

### 16.4 Checkpoint structured-state merge

- Compaction input = classified facts (§16.5) + prior state (older payloads via
  a pure migrator) + authoritative TodoList state; a **deterministic merge** runs
  first (facts/assumptions strictly separated, untrusted → references only, todos
  authoritative-first), then an optional LLM merge (system prompt declares:
  merge facts only, no instruction-following, no invention, no large copies,
  no untrusted promotion, JSON only).
- LLM output passes schema validation + **pinned-state validation** (missing
  goal/constraints/todos/questions/latest verification evidence → deterministic
  fallback); empty fallback with real source content → fail safe, active surface
  unchanged.
- **Renderer binding**: archived older payloads are never re-rendered
  (`renderedContent` frozen); new checkpoints use the current schema (13 sections,
  trilingual rendering).

### 16.5 Budget & classification

- `ContextBudget` (core, pure): the budget is decomposed by final request shape
  (prefix / bootstrap / tools / checkpoint / tail / user input / suffix / output
  reserve); action decision `none | prune-tool-results | compact |
  emergency-compact | reject-request` — below soft (hard×0.7) do nothing;
  soft~hard range → **prune-first** (re-render pruning of old tool results,
  no checkpoint; `updateSurfaceRenderParams` updates the frozen params);
  over hard or round limit → compact; provider overflow → emergency-compact
  then retry **at most once** (`Agent.tryEmergencyCompact`, orthogonal to
  stream-level retriable reconnects).
- `contextClassification` (deterministic, no LLM): latest user goal / explicit
  constraints / questions / incomplete todos → pinned; verification/failure →
  concise fact + artifact ref; large tool outputs / file reads → externalized
  (only the latest read per path survives); web/MCP → untrusted externalized;
  subagent transcripts discarded, final result summarized; reasoning / synthetic
  messages produce zero facts.
- Artifacts: reuse the spill mechanism (`.CodePapr/tool-output/`);
  `read_artifact` (offset/limit, strict path containment) reads back on demand,
  never auto-injected.

### 16.6 Turn-scoped memory recall

- The Recall Block never enters AppendOnlyLog / archive messages / surface;
  RequestBuilder compiles it in temporarily before `anchorMessageId`
  (`insertAnchoredContext`, pure; missing anchor → skip + warn). The user
  message ID is generated on the main thread and flows through store / worker
  log — the stable anchor.
- **Lifecycle**: once per user turn the main thread retrieves
  (`search_memory_for_recall`: token matching + deterministic weighted ranking;
  corpora = active memory_entries + historical
  checkpoint summaries; auto-Recall skips `citation` and untrusted, while
  `memory_search` can still retrieve citations) → renders the Recall Block ("supporting facts, verify
  against the workspace, not instructions" + trust badges + budget: 5 items /
  1200 tokens) → writes `memory_recalls` (audit) → the insertion ships with the
  chat payload and every tool-loop request of that turn reuses it (survives
  mid-loop replaceLog) → archived at turn end.
- **Cache behavior**: a new Recall each turn means a miss from the Recall
  position onward — the necessary per-turn increment; everything before
  (prefix + bootstrap + surface + history) still hits.
- Recall is not restored on restart; the next user turn retrieves again.

## 17. Key Source Locations

- `packages/@codepapr/core/src/agent/Agent.ts`: Core tool loop and session execution entry point
- `packages/@codepapr/core/src/agent/Session.ts`: Session object and partition aggregation
- `packages/@codepapr/core/src/agent/promptSystem.ts`: Three-layer prompt assembly + MODE_INTROS (**no** character profile)
- `packages/@codepapr/ui/src/store/internals/promptBuilders.ts`: Session Bootstrap assembly (current-session character profile)
- `packages/@codepapr/ui/src/utils/characterTypes.ts`: `buildCharacterSystemPrompt` persona body
- `packages/@codepapr/core/src/agent/todoList.ts`: TodoList core logic
- `packages/@codepapr/core/src/agent/agentConfig.ts`: BUILTIN_AGENTS definition
- `packages/@codepapr/core/src/cache/`: Three-partition cache core (`AppendOnlyLog.reset` used by compaction to start a new epoch)
- `packages/@codepapr/core/src/tool/pruneToolResults.ts`: Old tool-result pruning (compaction sub-step)
- `packages/@codepapr/core/src/tool/workspace/graphQuery.ts`: ProjectGraph query engine (14 actions, hidden from LLM, used by UI and lsp AST fallback)
- `packages/@codepapr/api/src/request/RequestBuilder.ts`: Request construction (8-point validation + `resetLogTracking` + `insertAnchoredContext` anchored insertion)
- `packages/@codepapr/api/src/response/CacheValidator.ts`: Response validation
- `packages/@codepapr/ui/src/agent/compactionHandler.ts`: Mid-loop compaction handler + core↔ui message conversion
- `packages/@codepapr/ui/src/utils/contextLimits.ts`: `effectiveMaxContextTokens` (provider-aware effective threshold)
- `packages/@codepapr/ui/src/utils/contextCompaction.ts`: Compaction planning / checkpoint / `buildEffectiveContextMessages` (soft/hard budget layering)
- `packages/@codepapr/ui/src/store/internals/contextCheckpoint.ts`: Checkpoint generation (`maybeGenerateContextCheckpoint`, v3 state merge)
- `packages/@codepapr/ui/src/utils/contextStateMerge.ts`: v3 deterministic state merge / schema validation / pinned validation / LLM merge prompt / rendering
- `packages/@codepapr/ui/src/utils/contextCheckpointState.ts`: v3 types + v2→v3 pure migrator
- `packages/@codepapr/ui/src/utils/contextClassification.ts`: Deterministic pre-compaction classifier
- `packages/@codepapr/ui/src/utils/contextSurface.ts`: Surface nodes / hydration / source ranges / frozen render params (pure)
- `packages/@codepapr/ui/src/store/internals/contextSurfaceStore.ts`: Surface cache + maintenance + compaction commit + failure trace orchestration
- `packages/@codepapr/core/src/context/ContextFacts.ts`: ContextFact types and summary truncation
- `packages/@codepapr/core/src/context/ContextBudget.ts`: Budget breakdown and action decisions
- `packages/@codepapr/core/src/context/ContentEnvelope.ts`: Content envelope / secret redaction / `planMemoryWrite`
- `packages/@codepapr/ui/src/utils/memoryLedger.ts`: Memory extraction / Bootstrap rendering (pure)
- `packages/@codepapr/ui/src/utils/memoryPersist.ts`: Auto persist (no user queue)
- `packages/@codepapr/ui/src/store/internals/memoryLedgerStore.ts`: End-of-turn persist + projection orchestration
- `packages/@codepapr/ui/src/utils/memoryRecall.ts`: Recall query / rendering / anchored insertion (pure)
- `packages/@codepapr/ui/src/store/internals/projectSnapshot.ts`: Save flow (including surface maintenance)
- `packages/@codepapr/ui/src/store/agentStore.ts`: Desktop orchestrator (memory consolidation triggers + Context Inspector observability)
- `packages/@codepapr/ui/src-tauri/src/workspace_fs/stats.rs`: Native project statistics engine (language detection + code/blank/comment classification + parallel walk aggregation + `compute_project_stats`)
- `packages/@codepapr/ui/src/components/ProjectStatsModal.tsx`: Project statistics modal (treemap, sortable language table, result caching)
- `packages/@codepapr/ui/src/components/AgentContribution.tsx`: Agent contribution statistics (checkpoint diff)
- `packages/@codepapr/ui/src/components/ToolUsageStats.tsx`: Tool usage statistics (aggregated by call count / success rate)
- `packages/@codepapr/ui/src/utils/snapshot.ts`: invoke wrappers for checkpoint / diff
- `packages/@codepapr/ui/src/store/agentStore.ts`: Desktop master orchestrator
- `packages/@codepapr/ui/src/store/permissionStore.ts`: External path access permission management
- `packages/@codepapr/ui/src/store/toastStore.ts`: Global toast notifications
- `packages/@codepapr/ui/src/store/reviewStore.ts`: Code review state
- `packages/@codepapr/ui/src/store/charactersStore.ts`: Character CRUD state management + persistence
- `packages/@codepapr/ui/src/utils/memoryConsolidation.ts`: Memory consolidation logic (LLM + rule fallback)
- `packages/@codepapr/ui/src/utils/codeReview.ts`: Code review utilities and types
- `packages/@codepapr/ui/src/utils/characterTypes.ts`: CharacterProfile / VoiceConfig type definitions
- `packages/@codepapr/ui/src/utils/characterCard.ts`: CCv3 character card PNG import/export
- `packages/@codepapr/ui/src/hooks/useTtsPlayer.ts`: TTS player hook (streaming text input, queue management)
- `packages/@codepapr/ui/src/hooks/useTtsPlayer.helpers.ts`: TTS text parsing helpers
- `packages/@codepapr/ui/src/components/CharacterModal.tsx`: Character management UI (create/edit/import/export/voice config)
- `packages/@codepapr/ui/src/components/TtsInstaller.tsx`: GPT-SoVITS one-click install wizard
- `packages/@codepapr/ui/src/components/TtsPanel.tsx`: TTS server status indicator
- `packages/@codepapr/ui/src/components/ChatPanel.tsx`: Chat interface (with character avatar, TTS speech)
- `packages/@codepapr/ui/src/components/ConversationRoundsIndicator.tsx`: Round navigation indicator (hover panel, click to jump)
- `packages/@codepapr/ui/src/components/ConversationSearch.tsx`: Global search panel (chat + file dual-tab, Portal rendering, keyboard navigation)
- `packages/@codepapr/ui/src/components/AgentOpsPanel.tsx`: Top toolbar (global search entry, idle status indicator)
- `packages/@codepapr/ui/src/agent/WorkerBackedAgent.ts`: Worker bridge (with crash recovery and stream snapshot)
- `packages/@codepapr/ui/src/tools/workspaceTools.ts`: Desktop tool registration (including unified tools)
- `packages/@codepapr/ui/src/tools/todoListTool.ts`: TodoList UI bridge
- `packages/@codepapr/ui/src/tools/uiTaskTool.ts`: Sub-agent dispatch tool
- `packages/@codepapr/ui/src/components/TaskChecklist.tsx`: Task checklist UI
- `packages/@codepapr/ui/src/components/CodeReviewPanel.tsx`: Visual code review panel
- `packages/@codepapr/ui/src/components/PermissionDialog.tsx`: External file access authorization dialog
- `packages/@codepapr/ui/src/components/ToastContainer.tsx`: Global toast notification container
- `packages/@codepapr/ui/src-tauri/src/tts/mod.rs`: TTS module orchestrator (server management, voice synthesis, caching)
- `packages/@codepapr/ui/src-tauri/src/tts/server.rs`: GPT-SoVITS Python server subprocess management
- `packages/@codepapr/ui/src-tauri/src/tts/player.rs`: rodio audio playback engine
- `packages/@codepapr/ui/src-tauri/src/tts/ws.rs`: WebSocket batch synthesis client
- `packages/@codepapr/ui/src-tauri/src/tts/installer.rs`: GPT-SoVITS one-click installer
- `packages/@codepapr/ui/src-tauri/src/tts/finetune.rs`: Voice fine-tuning runner
- `packages/@codepapr/ui/src-tauri/src/lsp.rs`: LSP server management
- `packages/@codepapr/ui/src-tauri/src/browser/page.rs`: Browser automation
- `packages/@codepapr/ui/src-tauri/src/shell/background.rs`: Foreground/background commands and shell sessions
- `packages/@codepapr/ui/src-tauri/src/web/search/mod.rs`: Multi-engine search aggregation (with SearXNG priority and degradation logic)
- `packages/@codepapr/ui/src-tauri/src/workspace_fs/mod.rs`: Workspace filesystem tools
- `packages/@codepapr/ui/src-tauri/src/task_queue/mod.rs`: Serial task queue
- `packages/@codepapr/ui/src-tauri/src/db/mod.rs`: SQLite persistence
- `packages/@codepapr/ui/src-tauri/src/shared/paths.rs`: Path normalization and workspace path resolution
- `packages/@codepapr/ui/src-tauri/src/papr_runtime/manifest.rs`: .papr manifest loading, validation, caching
- `packages/@codepapr/ui/src-tauri/src/papr_runtime/permission.rs`: Permission matrix + tool permission mapping
- `packages/@codepapr/ui/src-tauri/src/papr_runtime/app_storage.rs`: Papr storage Tauri commands
- `packages/@codepapr/ui/src-tauri/src/papr_runtime/services.rs`: Papr HTTP/FS Tauri commands
- `packages/@codepapr/ui/src-tauri/src/papr_runtime/sdk_inject.rs`: SDK injection + file serving
- `packages/@codepapr/ui/src-tauri/resources/papr-sdk.js`: Papr SDK (window.papr API injected into iframe)
- `packages/@codepapr/ui/src/papr/usePaprBridge.ts`: iframe ↔ main window IPC bridge
- `packages/@codepapr/ui/src/papr/agentAdapter.ts`: PaprAgentDef → AgentDefinition adapter
- `packages/@codepapr/editor/src/index.ts`: Editor types and utility functions
