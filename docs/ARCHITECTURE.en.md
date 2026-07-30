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
- Not two separate implementations for CLI and desktop

## 3. Logical Layers

### 3.1 Package Responsibilities

| Package | Role | Primary Responsibility |
| --- | --- | --- |
| @codepapr/types | Shared Protocol | Unified message, request, response, tool, and statistics types |
| @codepapr/common | Common Infrastructure | Logging, hashing, and general utilities |
| @codepapr/core | Runtime Core | Agent, Session, ToolRegistry, cache partitions, ProjectGraph, TodoList, Built-in Agents |
| @codepapr/api | Provider Adapter | RequestBuilder, CacheValidator, provider implementations |
| @codepapr/db | Persistence Layer | SQLite wrapper and repositories |
| @codepapr/editor | Editor Contracts | Framework-agnostic Monaco types, markers, navigation, and static analysis contracts |
| @codepapr/ui | Desktop Workbench | React, Zustand, Tauri, WorkerBackedAgent |

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
  │           read_text_file(.CodePapr/memory.md), loadMcpToolDefinitions
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

**External path permissions**: The desktop app shows a `PermissionDialog` for `read`/`list` operations on absolute paths outside the project. The user can choose "Deny / Allow this file / Allow this folder". Authorizations are stored in the `permissionStore` allowlist. CLI read boundaries are more permissive; writes remain workspace-scoped.

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
  "permissions": ["storage:read", "storage:write", "agent:run:assistant"],
  "agents": [{
    "name": "assistant",
    "model": "deepseek",
    "systemPrompt": "You are a task management assistant",
    "tools": ["read", "websearch"],
    "maxToolRounds": 20
  }]
}
```

10 permission types: `storage:read/write`, `http:get/post`, `fs:read/write`, `llm:chat`, `workspace:read/write/exec`, `agent:run:<name>`.

**Papr SDK (`window.papr`):**

JavaScript SDK injected into every app iframe, providing a unified API:

| API | Description |
|---|---|
| `papr.db.get/set/delete/keys()` | Persistent key-value storage (per-app isolation) |
| `papr.agent.run({agent, task}, onProgress?)` | Invoke manifest-defined agents (streaming events + step tracking) |
| `papr.http.get/post(url, body)` | HTTP requests |
| `papr.fs.readFile/writeFile/list/delete(path)` | File I/O (restricted to .CodePapr/apps/<appId>/data/) |
| `papr.app.info()` | Get app metadata |

**IPC bridge:** The iframe SDK sends `{__papr:true, reqId, type, payload}` protocol messages via `window.parent.postMessage()`. The React main window's `usePaprBridge` hook listens → first-pass permission check → routes to `invoke()` (Rust) or Worker (Agent).

**Permission system (two-layer):**

1. **React first-pass** — `usePaprBridge` fast-rejects based on manifest.permissions
2. **Rust authoritative** — every `papr_*` Tauri command calls `check_permission(manifest, capability)` at the top, blocking even direct postMessage bypass

Tool permission mapping (`check_tool_permission`): `read/grep/list` → `workspace:read`, `write/edit` → `workspace:write`, `bash` → `workspace:exec`, `websearch/webfetch` → `http:get`.

**App Agent system:**

Independent from built-in sub-agents (explore/scout/mentor). Uses a dedicated Agent loop:
- manifest `agents[].tools` specifies a whitelist (15 allowed tools)
- Worker-side `handleRunAppAgent` builds a full `Session` (`ImmutablePrefix` + `AppendOnlyLog` + `ToolRegistry`)
- Runs `Agent.chat()` multi-turn tool loop (`maxToolRounds` default 20, max 50)
- 300s wall-clock timeout + tool IPC proxy to main thread
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
papr.db.set('key', value) → project.sqlite.app_storage(app_id, key, value)
```

Same key in different apps is fully isolated via `app_id` primary key prefix.

**App Management Tools:**

LLM can manage app lifecycle via 4 tools (registered as merge tools in `workspaceTools.ts`):

| Tool | Params | Function |
|---|---|---|
| `app_list` | none | List all registered apps (appId, title, hasBackend, isRunning) |
| `app_start` | `appId` | Start backend (check port → `start_workspace_background_command` → `setAppRunning`) |
| `app_stop` | `appId` | Stop backend (`stop_background_process` → `setAppStopped`) |
| `app_delete` | `appId` | Full delete (stop + `papr_delete_app` delete files + `closeApp`) |

**AppDockPanel — Application Management Panel:**

App list + fixed bottom action bar. List items: green/red status dot + emoji icon + app name. Bottom bar: ▶ Start / Open / ■ Stop / 🗑 Delete. Buttons auto-enable/disable based on selected app state. "Open" for pure frontend apps is always enabled; for backend apps, only when running.

**Permission Level System (4 Tiers):**

Apps declare a permission level via manifest `level` field:

| Level | Name | Capabilities |
|---|---|---|
| L0 | Pure Compute | No external access, HTML/CSS/JS only |
| L1 | Runtime (default) | `papr.db` + `papr.fs` + AI Agent (read-only tools: read/grep/list/lsp) |
| L2 | Network | + `papr.http` + Agent web search + MCP tools |
| L3 | System | + file write/terminal/git. Requires global user enable in Settings |

Resolution: `effective_level = min(manifest.level, user_override, global_allowLevel3_switch)`. Settings has a new **App Tab** (`AppPermissionsTab.tsx`): global default level selector, Level 3 global toggle, per-app override dropdowns.

**Backend URL Injection:**

`handle_app_protocol` detects the `port` field in manifest and injects `window.__PAPR_BACKEND_URL = 'http://localhost:{port}'` into HTML responses. Generated backend app HTML uses `const API = window.__PAPR_BACKEND_URL || ""` as API base URL. SDK's `papr.app.info()` returns `backendUrl`. Frontend always loads via `codepapr-app://` protocol (SDK auto-injected), backend only serves API endpoints.

**CSP Fix:** Added `codepapr-app:` to `frame-src` and `script-src` in `tauri.conf.json` CSP, fixing white screen when iframe loads custom protocol URLs that were blocked by CSP.

## 5. Character and Voice System

### 5.1 Character Roleplay

The character system allows users to create, import, and activate AI personas. When activated, a character's profile is injected into the LLM system prompt.

**CharacterProfile data model:** name, avatar, description, personality, scenario, first message, example messages, system prompt, tags, creator, version.

**Core capabilities:**
- **Manual creation**: Fill in name, description, personality, scenario, first message, example dialog, etc.
- **Import character cards**: Supports PNG (embedded chara-card-v3 JSON) and JSON file imports; compatible with SillyTavern and other tools using the CCv3 spec
- **Export character cards**: Export characters as PNG cards with JSON embedded in tEXt/iTXt chunks
- **Activate character**: When activated, the character's profile is injected via `buildCharacterSystemPrompt()` into the Session Bootstrap, **not** the ImmutablePrefix (preserving cache)

**Roleplay format convention:** The system prompt instructs the LLM to wrap actions/narration in `*single asterisks*` (not spoken), keep spoken dialogue as plain text (read aloud), use `**double asterisks**` for emphasis (spoken with stress), and use `(parenthetical)` tone indicators like `(whispering)` (not spoken).

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

During voice playback, the currently-spoken paragraph is highlighted in the chat interface. Each AI reply has a "Replay" button on hover to re-speak that message. Cancelling the current Agent message stops ongoing playback.

On Apple Silicon Macs, users can manually click "GPU Warmup" in the Voice Tab of the character editor to pre-compile Metal GPU kernels, avoiding 5-15 seconds of first-synthesis delay.

## 6. Sub-Agents

### 6.1 Built-in Sub-Agents

| Agent | Purpose | Model | Tools |
|-------|------|------|------|
| explore | Read-only code analysis | fast | read, read_image, list, lsp, diagnostics, grep |
| scout | Web search + download | fast | websearch, webfetch, browser, read_image |
| mentor | Architecture/algorithm guidance | Configurable independent model | None |

> The Goal autonomous loop's verifier is a standalone no-tools model call configured in Advanced settings (`verifierModelTier`). It is not a built-in sub-agent and is never exposed via the `task` tool.

The `task` tool only exposes agents whose `mode` is `subagent` / `all`; agents with `mode: primary` (only usable as an @-mentioned primary agent) or `internal: true` never appear in the delegation list.

### 6.2 Sub-Agent Independent Context

**Each sub-agent gets a fresh Session**, with no access to the main Agent's conversation history:

- Creates a new `AppendOnlyLog` — blank log
- Tool set is filtered by the allowlist in the definition (Explore has 6 tools)
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

### 8.1 Design Intent

`.CodePapr/memory.md` is the project's **cross-session long-term memory**, distinct from TodoList (short-term working memory) and ProjectGraph (semantic index). It stores:

- User profile and preferences (language, toolchain, code style)
- Project conventions (build/deploy/config conventions)
- Error patterns and solutions (recurring pitfalls)
- Architecture decision rationale
- Lessons learned

### 8.2 Write Mechanism

The Agent has no dedicated memory tool - it uses the generic `write` tool to append entries through prompt conventions in these scenarios:

1. It discovers project directory structure, tech stack, or build/lint/test commands worth reusing across sessions
2. The same error was encountered twice in the current session
3. A project-specific build/deploy/config convention was discovered
4. The user explicitly asks to remember

Each entry starts with `## YYYY-MM-DD Topic`, pure Markdown, manually editable.

> The write conditions are intentionally relaxed: project structure and build commands are the highest-value cross-session facts and must not be banned as "routine findings." General knowledge and temporary state are still not written.

### 8.3 Load Mechanism

On session start, `agentStore.sendMessage` invokes Tauri `read_text_file` to read `.CodePapr/memory.md` (capped at 50KB), and the result is injected into the second layer Session Bootstrap via `buildSessionBootstrapPrompt`, not into ImmutablePrefix. This ensures:

- Memory content changes do not break system prompt caching
- All sessions get full load at startup, no on-demand retrieval (keeps it simple)

**Cold-start auto-generation**: If `memory.md` is missing or empty at session start and a ProjectGraph cache summary is available, `bootstrapMemoryContent` is triggered asynchronously in the background. It uses the fast model to generate an initial memory (project structure / tech stack / build commands / key conventions) from the ProjectGraph summary + project rules + the user's first message, then writes it to `.CodePapr/memory.md`. The task is fire-and-forget, does not block the current session, and is deduped via a module-level `memoryBootstrapInFlight` guard. If the ProjectGraph cache is also empty, it is skipped until the next session. This breaks the "explore from zero every session" cold-start loop.

### 8.4 Auto-Consolidation

Memory files grow monotonically and need periodic consolidation to prevent bloat. Three triggers:

| Trigger | Timing | Action |
|---|---|---|
| T1 | session start, after reading memory.md | Lines > 200 → mark `_pendingMemoryConsolidation = true` |
| T2 | context compaction succeeds (auto or `/compact`) | Same flag |
| T3 | after each agent reply completes | pending? → async consolidation → write back |

### 8.5 Consolidation Flow

Consolidation is a fire-and-forget async task that does not block the current session:

```
agent reply completes
  └─ pending? → clear flag → re-read memory.md (get latest)
                 ├─ still > 200 lines?
                 │    ├─ yes → invoke fast model to consolidate (merge/dedup/compress)
                 │    │       ├─ success → write_text_file back
                 │    │       └─ failure → rule-based fallback (dedup by `## ` sections + truncate by date to 200 lines)
                 │    └─ no → skip (agent already trimmed during session)
                 └─ silently catch, no impact on main flow
```

Consolidation reuses the `selectContextCompactionModelRoute` fast-model route, sharing configuration with context compaction (`compactionModel` / `compactionMaxTokens` / `compactionTemperature`).

### 8.6 Key Invariants

- **No new tools**: All reads/writes go through generic `read_text_file` / `write_text_file` Tauri commands; the model is unaware of consolidation logic, no prefix changes
- **Cache-safe**: Consolidation always triggers **after** agent reply; the written-back memory is only loaded on the **next** session start; current session's ImmutablePrefix is unaffected
- **Current session uses old memory**: Async consolidation means benefits are deferred to next session; advantage: zero startup latency, low-quality consolidation risk is isolated
- **Silent degradation**: LLM fails → rule-based dedup (deduplicate by title, keep latest by date, truncate to 200 lines); rule degradation also fails → keep original file unchanged

### 8.7 Key Source Locations

- `packages/@codepapr/ui/src/utils/memoryConsolidation.ts`: Consolidation logic, cold-start bootstrap, trilingual prompts, LLM calls, rule-based fallback
- `packages/@codepapr/ui/src/store/internals/types.ts`: `_pendingMemoryConsolidation: boolean` state
- `packages/@codepapr/ui/src/store/agentStore.ts`: Three consolidation trigger points (startup/compaction/post-reply) + cold-start bootstrap trigger (after startup read)
- `packages/@codepapr/core/src/agent/promptSystem.ts`: Write-condition prompts, Memory section bootstrap rendering

## 9. ProjectGraph Semantic Analysis

### 9.1 Tool Definition

`graph` is a unified project semantic graph tool accessed via the `action` parameter. **Now hidden from the LLM (UI-only)**: LLM-facing code intelligence is provided by the `lsp` tool (9 navigation actions, LSP-first with AST project-graph fallback) and `list` (directory tree + per-file lightweight symbols); `graph`'s fine-grained handlers stay registered to serve UI panels and act as the AST fallback backend for `lsp` point queries.

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

- Core function in `core/src/tool/workspace/graphQuery.ts` (~2,400 lines)
- CLI and UI each implement handler branches
- Explore sub-agent system prompt lists all actions

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
2. ProjectGraph Summary
3. Custom Guidance (user long-term preference prompt)
4. Character profile (currently active CharacterProfile)

**Layer 3: Runtime User Prompt (current turn user message)**
Built on each user input:
1. Mode Header
2. User Input
3. Diagnostics Section (placed last to avoid prefix jitter)

### 10.2 Key Invariants

- User custom prompts go into session bootstrap, not per-turn user prompt
- Skills go into bootstrap, not system prefix
- Character profile goes into bootstrap, not system prefix (switching characters does not break cache)
- Workspace path appears only once in system prompt
- Custom guidance appears only once in bootstrap
- `topP`, `temperature`, `maxTokens`, `thinkingEnabled` are frozen together in ImmutablePrefix; any change breaks the cache hash
- Session bootstrap is cached per "session × stable signature"; volatile disk state (memory.md / project graph) does not trigger rebuilds (see §13.6)
- Per-turn dynamic content (date / diagnostics) is placed at the tail, not in the existing prefix

## 11. Model Routing

Currently active routing functions (old planner/summary routes removed):

| Scenario | Function | Model | Temperature |
|---|---|---|---|
| Main Agent conversation | `selectTaskModelRoute` | Primary model | User-configured |
| Slash commands (declaring `model: 'fast'`) | `selectTaskModelRoute(..., 'fast')` | Fast model (falls back to primary if disabled) | User-configured |
| Context compaction | `selectContextCompactionModelRoute` | Fast/Primary model | User-configured `compactionTemperature` |
| Sub-agent execution | `selectSubagentExecutionRoute` | Determined by task weight | User-configured `subagentTemperature` |
| Primary model fallback | `buildPrimaryModelRoute` | Primary model | User-configured |

Slash command `model` field (declared in `BUILTIN_PROMPT_COMMANDS` or `.CodePapr/commands/<name>.md` frontmatter) is passed as `preferredTier` to routing: `'fast'` routes to fast model; UI uses `selectTaskModelRoute(..., 'fast')`, CLI uses `createEphemeralAgent` for a temporary fast Agent.

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

### 13.3 Mid-Loop Overflow → Compaction

Context grows with tool results during the tool loop. `Agent.chat` performs an overflow check **before building each round's request** (`estimateContextTokens`: a rough estimate of prefix bytes + log bytes / 4):

1. When the effective threshold (`contextCompaction.maxContextTokens`) is exceeded, the injected compaction handler runs:
   - Convert the current log (core `IMessage`) into ui `ContextMessageLike` (`coreMessagesToContextMessages`, re-attaching tool results to the assistant's `toolInvocations`, round-trip faithful);
   - Run the same pipeline as between-turn compaction (`maybeGenerateContextCheckpoint` produces the checkpoint summary and freezes the current TodoList digest);
   - `buildEffectiveContextMessages` replaces history with the checkpoint + prunes old tool results in the tail;
   - `Session.replaceLog` resets the log (`AppendOnlyLog.reset` + reload) and `RequestBuilder.resetLogTracking` resets append-only tracking to avoid false violations;
   - Merge the compaction's cacheStats, emit a `context-compacted` stream event, and continue the loop.
2. **Check timing: round-start only.** Tool results are appended at the end of a round; the overflow they cause is caught at the **next round's start** — no LLM request is ever sent with an over-limit context; the tool-calling task continues after compaction from "summary + recent tail".
3. **No mid-tool-execution compaction:** a round's multiple tool calls are executed atomically before compacting at the round boundary, preserving tool-call↔result pairing.
4. **Anti-loop:** `lastCompactionRound` guarantees at least 2 rounds between compactions; a null handler result does not reset it.
5. **Defense in depth:** `toolOutputTruncation` bounds each tool result to ~50KB (or spills to disk with a preview), so per-round growth is bounded and cannot blow the provider's hard limit in a single round.

### 13.4 Pruning Is a Compaction Sub-Step (Not a Separate Mechanism)

`pruneOldToolResults` replaces large old tool results (beyond the protection window `pruneProtectRounds`, default 6 rounds, and ≥ `pruneMinChars`, default 20KB) with a placeholder. It has **no independent trigger**; it runs only inside `buildEffectiveContextMessages` (at compaction/rebuild) as an internal slimming sub-step of compaction (mirroring OpenCode's `SessionCompaction.prune`). The only trigger is the context threshold:

```
context reaches threshold → compaction (shouldCompact) → rebuild agent → prune at the end of buildEffectiveContextMessages
```

Compaction summarizes away the head (incl. old tool results); pruning slims the retained tail. The pruning settings (`pruneOldToolResults` / `pruneProtectRounds` / `pruneMinChars`) are internal tuning knobs, not exposed in the UI. Note this differs from `compactionMaxTokens` (the compaction summary's output limit): the latter is how long the summary LLM call may write, not a trigger threshold.

### 13.5 Effective Context Threshold (provider-aware)

`maxContextTokens` (default **500K**, tuned for DeepSeek's 1M context) is the compaction trigger threshold. To avoid compaction lagging behind the limit (causing 400s) on smaller-context providers, the effective value is clamped per provider (`effectiveMaxContextTokens`):

```
effectiveMaxContextTokens = min(maxContextTokens, providerContextLimit − maxTokens)
```

| Provider | Hard context limit | Default effective threshold |
| --- | --- | --- |
| DeepSeek | ~1M | 500K |
| Claude | 200K | ≈ 200K − maxTokens |
| OpenAI | 128K | ≈ 128K − maxTokens |

Higher threshold → fewer compactions → fewer epoch resets → higher hit rate (cache reads are cheap). This effective value is used for both between-turn compaction (`planContextCompaction`) and the mid-loop overflow check.

### 13.6 Prefix-Stability Guarantees (avoiding per-round prefix breaks)

These measures keep the prefix byte-stable within an epoch (any break invalidates everything from that point on):

| Guarantee | Implementation |
| --- | --- |
| No per-request prefix mutation | Pruning runs only at compaction/rebuild, not as a sliding window on every request build |
| Byte-identical rebuild serialization | `toCoreTailMessages` uses `sortedStringify` for object tool results (matching the live path `Message.tool`); empty assistant content is `''` (not `' '`) |
| Fewer rebuilds | Session bootstrap is cached per "session × stable signature" (`resolveSessionBootstrap`); volatile disk state (memory.md / project graph) no longer triggers rebuilds |
| Stable reasoning round-trip | `reasoning_content` is round-tripped based on "presence + model capability (`supportsThinkingPayload`)", decoupled from the per-request thinking toggle, so rebuilds don't add/remove reasoning on history |
| Frozen TodoList digest | The current digest is frozen into the checkpoint payload at generation and reused on rebuild instead of re-rendered live |
| Frozen parameters | topP / temperature / maxTokens / thinkingEnabled are frozen in ImmutablePrefix; any change flips the hash |
| Dynamic content placed at the tail | Per-turn dynamic content (date / diagnostics) goes into the new user message (tail), not the existing prefix |

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


## 14. Settings Structure

The settings panel has six tabs. Full parameter reference: `packages/@codepapr/core/docs/CONFIGURATION.md`.

| Tab | Content |
|---|---|
| General | Language selection, debug toggle, license |
| LLM | API type, model name, fast model, temperature, topP, maxTokens, thinking mode, maxToolRounds |
| Search | Self-hosted SearXNG first, with automatic fallback to built-in multi-source aggregation when unavailable; engine selector removed from UI; category/time/language/safe search parameters moved to collapsible Advanced Options section |
| Mentor | Mentor sub-agent independent API key, Base URL, model selection |
| Advanced | Context compaction (model/temperature/summary output tokens/context limit/conversation rounds), TodoList max retries, ProjectGraph depth/file limits. The context limit `maxContextTokens` defaults to 500K; its effective value is clamped to the selected provider's context limit (see §13.5) |
| App | .papr app permission management — global default level, Level 3 global toggle, per-app level overrides |

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

## 16. Key Source Locations

- `packages/@codepapr/core/src/agent/Agent.ts`: Core tool loop and session execution entry point
- `packages/@codepapr/core/src/agent/Session.ts`: Session object and partition aggregation
- `packages/@codepapr/core/src/agent/promptSystem.ts`: Three-layer prompt assembly + MODE_INTROS + character profile injection
- `packages/@codepapr/core/src/agent/todoList.ts`: TodoList core logic
- `packages/@codepapr/core/src/agent/agentConfig.ts`: BUILTIN_AGENTS definition
- `packages/@codepapr/core/src/cache/`: Three-partition cache core (`AppendOnlyLog.reset` used by compaction to start a new epoch)
- `packages/@codepapr/core/src/tool/pruneToolResults.ts`: Old tool-result pruning (compaction sub-step)
- `packages/@codepapr/core/src/tool/workspace/graphQuery.ts`: ProjectGraph query engine (14 actions, hidden from LLM, used by UI and lsp AST fallback)
- `packages/@codepapr/api/src/request/RequestBuilder.ts`: Request construction (8-point validation + `resetLogTracking`)
- `packages/@codepapr/api/src/response/CacheValidator.ts`: Response validation
- `packages/@codepapr/ui/src/agent/compactionHandler.ts`: Mid-loop compaction handler + core↔ui message conversion
- `packages/@codepapr/ui/src/utils/contextLimits.ts`: `effectiveMaxContextTokens` (provider-aware effective threshold)
- `packages/@codepapr/ui/src/utils/contextCompaction.ts`: Compaction planning / checkpoint / `buildEffectiveContextMessages`
- `packages/@codepapr/ui/src/store/internals/contextCheckpoint.ts`: Checkpoint generation (`maybeGenerateContextCheckpoint`)
- `packages/@codepapr/ui/src-tauri/src/workspace_fs/stats.rs`: Native project statistics engine (language detection + code/blank/comment classification + parallel walk aggregation + `compute_project_stats`)
- `packages/@codepapr/ui/src/components/ProjectStatsModal.tsx`: Project statistics modal (treemap, sortable language table, result caching)
- `packages/@codepapr/ui/src/components/AgentContribution.tsx`: Agent contribution statistics (checkpoint diff)
- `packages/@codepapr/ui/src/components/ToolUsageStats.tsx`: Tool usage statistics (aggregated by call count / success rate)
- `packages/@codepapr/ui/src/utils/snapshot.ts`: invoke wrappers for checkpoint / diff
- `packages/@codepapr/ui/src/store/agentStore.ts`: Desktop master orchestrator (with three memory consolidation trigger points)
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
