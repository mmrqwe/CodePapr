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
| @codepapr/cli | CLI Automation Host | Assembles provider, workspace tools, engineering debugging entry point |
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
| `shell` | `src-tauri/src/shell/` | Foreground commands, background processes, persistent shell sessions, command safety guards |
| `web` | `src-tauri/src/web/` | HTTP fetch, web page content extraction, multi-engine search (SearXNG first, with automatic fallback to built-in multi-source aggregation: Bing / Mojeek / Qwant / Wikipedia) |
| `workspace_fs` | `src-tauri/src/workspace_fs/` | File listing, text reading, writing, SEARCH/REPLACE diff, text/path search |
| `task_queue` | `src-tauri/src/task_queue/mod.rs` | Heavy I/O serialization queue; frontend polls `task_id` for results |
| `db` | `src-tauri/src/db/mod.rs` | Application and project-level SQLite persistence, session and cache statistics |
| `tts` | `src-tauri/src/tts/` | GPT-SoVITS TTS subsystem: server management, voice synthesis, WebSocket batch synthesis, audio playback, installer, fine-tuning |
| `lsp` | `src-tauri/src/lsp.rs` | LSP server process management, stdin/stdout JSON-RPC bridging |
| `symbol_provider` | `src-tauri/src/symbol_provider.rs` | tree-sitter fallback symbol extraction |
| `mcp_host` | `src-tauri/src/mcp_host.rs` | MCP tool server host (stdio / sse / streamable-http) |
| `shared` | `src-tauri/src/shared/` | Path normalization, workspace path resolution, runtime helpers, string/time utilities |

### 4.5 Task Queue

All heavy-I/O Tauri commands (file listing, reading, command execution, etc.) execute serially through a single-consumer channel:

- Commands return `task_id` immediately without blocking the frontend
- Frontend polls `poll_workspace_task` for results
- Avoids multi-threaded concurrent reads/writes to the same workspace

### 4.6 Tool Architecture

The LLM can invoke 25 discrete tools (including `task`/`todo` as dynamic tools), each with a single responsibility. The 7 tools with `action` parameters all use `enum` constraints. File read/write/SEARCH/REPLACE operations have a 20MB cap:

| Unified Tool | Action | Delegated Tool |
|---|---|---|
| `read` | Line range / window / context read | workspace_read_file |
| `write` | Create / overwrite file | workspace_write_file |
| `edit` | SEARCH/REPLACE single-file modification | workspace_apply_patch |
| `patch` | Multi-file atomic SEARCH/REPLACE | workspace_apply_diff |
| `grep` | Regex search file contents | workspace_search_text |
| `glob` | Filename pattern search | workspace_search_files |
| `list` | Directory tree browsing | workspace_list_files |
| `graph` | full / overview / lookup / implementations / dependency / entrypoints / impact / smart_context / dead_code / circular_deps / type_hierarchy / suggest_refactors / test_impact / generate_tests | graphQuery |
| `lsp` | definition / references | workspace_symbol_definition / workspace_symbol_references |
| `lsp_edit` | rename / code_action / format | workspace_rename_symbol / workspace_apply_code_action / workspace_format_files |
| `diagnostics` | Single-file LSP diagnostics / project-level diagnostics | workspace_lsp_diagnostics / workspace_project_diagnostics |
| `git` | status / diff / log / branch / stage / commit / restore / reset | workspace_git_* |
| `exec` | Foreground / background command execution | workspace_run_command / workspace_start_background_command |
| `shell` | open / send / read / close / list persistent sessions | shell_* |
| `proc` | Background process management | workspace_list_background_processes / workspace_stop_background_process |
| `browser` | open / navigate / reload / close / click / type / read / screenshot / get | browser_* |
| `web_search` | Online search | web_search |
| `web_fetch` | Read web page content | web_fetch_url |
| `web_download` | Download file to project | web_download_file |
| `open` | Open URL/HTML in system browser | workspace_open_in_browser |
| `skill` | Load skill documentation | skill_load |
| `time` | Get local time | local_time_now |
| `question` | Ask user a question | question |
| `task` | Delegate subtask to sub-agent | subagent |
| `todo` | tasks / updates task planning | TodoList |

All 25 tools are registered in ToolRegistry, frozen and hashed for cache consistency. `todo` and `task` are dynamically generated.

**External path permissions**: The desktop app shows a `PermissionDialog` for `read`/`list` operations on absolute paths outside the project. The user can choose "Deny / Allow this file / Allow this folder". Authorizations are stored in the `permissionStore` allowlist. CLI read boundaries are more permissive; writes remain workspace-scoped.

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
| explore | Read-only code analysis | fast | read, graph, lsp, diagnostics, time |
| scout | Web search + download | fast | web_search, web_fetch, web_download, browser, open, time |
| mentor | Architecture/algorithm guidance | Configurable independent model | None |

### 6.2 Sub-Agent Independent Context

**Each sub-agent gets a fresh Session**, with no access to the main Agent's conversation history:

- Creates a new `AppendOnlyLog` — blank log
- Tool set is filtered by the allowlist in the definition (Explore has only 5 tools)
- Only receives the task description from `task.prompt` as its sole context
- Nesting depth is configurable (`subagentMaxDepth`, default 2)

Design intent: sub-agents are "stateless workers focused on a single task", isolated from the main Agent's context window pollution.

### 6.3 Model Routing

Sub-agents select models via `selectSubagentExecutionRoute`:
- Sub-agent definition `model: 'fast'` → fast model (default deepseek-v4-flash)
- Task contains execution verbs (fix/implement/build) → primary model
- Mentor defaults to primary model, configurable with independent API key and model
- Explore / Scout support tier switching between `primary` and `fast` via settings

### 6.4 Sub-Agent Timeout Protection

Sub-agents never wait indefinitely — multiple layers of timeout ensure timely failure:

- **90-second per-tool timeout**: each `toolRegistry.execute()` call in `Agent.ts` is wrapped with `withTimeout`; on timeout, returns `{ error: 'tool execution timeout' }` to the LLM for autonomous decision
- **5-minute overall wall-clock timeout**: `agent.chat()` in `agentRuntime.worker.ts` and `uiTaskTool.ts` is wrapped with `withWallClockTimeout`; timeout calls `agent.cancel()` to terminate the loop
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

### 7.5 Conversation Reset (Git Rollback)

Hover a user message → "Reset to here" button appears:

- **Code rollback**: Auto `git commit` checkpoint after each Agent response; reset uses `git reset --hard` to target commit, atomically restoring all files
- **Non-Git fallback**: Automatically degrades to EditHistory per-file undo
- **Message truncation**: Deletes all conversation after that message
- **State cleanup**: Resets TodoList, EditHistory, Agent session
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

The Agent has no dedicated memory tool — it uses the generic `write` tool to append entries through prompt conventions in three cases:

1. The same error was encountered twice in the current session
2. A project-specific build/deploy/config convention was discovered
3. The user explicitly asks to remember

Each entry starts with `## YYYY-MM-DD Topic`, pure Markdown, manually editable.

### 8.3 Load Mechanism

On session start, `agentStore.sendMessage` invokes Tauri `read_text_file` to read `.CodePapr/memory.md` (capped at 50KB), and the result is injected into the second layer Session Bootstrap via `buildSessionBootstrapPrompt`, not into ImmutablePrefix. This ensures:

- Memory content changes do not break system prompt caching
- All sessions get full load at startup, no on-demand retrieval (keeps it simple)

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

- `packages/@codepapr/ui/src/utils/memoryConsolidation.ts`: Consolidation logic, trilingual prompts, LLM calls, rule-based fallback
- `packages/@codepapr/ui/src/store/internals/types.ts`: `_pendingMemoryConsolidation: boolean` state
- `packages/@codepapr/ui/src/store/agentStore.ts`: Three trigger points (startup/compaction/post-reply)
- `packages/@codepapr/core/src/agent/promptSystem.ts`: Write-condition prompts, Memory section bootstrap rendering

## 9. ProjectGraph Semantic Analysis

### 9.1 Tool Definition

`graph` is a unified project semantic graph tool accessed via the `action` parameter. Available to both main Agent and Explore sub-agent.

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

## 13. Cache Consistency Model

### 13.1 Three-Partition Structure

| Partition | Content | Design Purpose |
| --- | --- | --- |
| ImmutablePrefix | System prompt, tool definitions, model parameters (including topP/temperature/maxTokens/thinkingEnabled) | Lock prefix byte sequence |
| AppendOnlyLog | User messages, assistant messages, tool results | Append only, no rewrite |
| VolatileScratch | Temporary reasoning, intermediate plans, per-turn drafts | Isolate unstable content |

### 13.2 Hash Calculation

ImmutablePrefix SHA256 hash includes the entire `parameters` object — `temperature`, `topP`, `maxTokens`, `thinkingEnabled` all participate in hashing. Any parameter change → hash change → cache miss.

## 14. Settings Structure

The settings panel has five tabs. Full parameter reference: `packages/@codepapr/core/docs/CONFIGURATION.md`.

| Tab | Content |
|---|---|
| General | Language selection, debug toggle, license |
| LLM | API type, model name, fast model, temperature, topP, maxTokens, thinking mode, maxToolRounds |
| Search | Self-hosted SearXNG first, with automatic fallback to built-in multi-source aggregation when unavailable; engine selector removed from UI; category/time/language/safe search parameters moved to collapsible Advanced Options section |
| Mentor | Mentor sub-agent independent API key, Base URL, model selection |
| Advanced | Context compaction (model/temperature/tokens/context limit/conversation rounds), TodoList max retries, ProjectGraph depth/file limits |

Voice configuration is not in the main settings panel — it is configured per character in the CharacterModal Voice Tab.

## 15. Key Source Locations

- `packages/@codepapr/core/src/agent/Agent.ts`: Core tool loop and session execution entry point
- `packages/@codepapr/core/src/agent/Session.ts`: Session object and partition aggregation
- `packages/@codepapr/core/src/agent/promptSystem.ts`: Three-layer prompt assembly + MODE_INTROS + character profile injection
- `packages/@codepapr/core/src/agent/todoList.ts`: TodoList core logic
- `packages/@codepapr/core/src/agent/agentConfig.ts`: BUILTIN_AGENTS definition
- `packages/@codepapr/core/src/cache/`: Three-partition cache core
- `packages/@codepapr/core/src/tool/workspace/graphQuery.ts`: ProjectGraph query engine (14 actions)
- `packages/@codepapr/api/src/request/RequestBuilder.ts`: Request construction
- `packages/@codepapr/api/src/response/CacheValidator.ts`: Response validation
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
- `packages/@codepapr/cli/src/tools/registerCliWorkspaceTools.ts`: CLI tool registration
- `packages/@codepapr/ui/src-tauri/src/lsp.rs`: LSP server management
- `packages/@codepapr/ui/src-tauri/src/browser/page.rs`: Browser automation
- `packages/@codepapr/ui/src-tauri/src/shell/background.rs`: Foreground/background commands and shell sessions
- `packages/@codepapr/ui/src-tauri/src/web/search/mod.rs`: Multi-engine search aggregation (with SearXNG priority and degradation logic)
- `packages/@codepapr/ui/src-tauri/src/workspace_fs/mod.rs`: Workspace filesystem tools
- `packages/@codepapr/ui/src-tauri/src/task_queue/mod.rs`: Serial task queue
- `packages/@codepapr/ui/src-tauri/src/db/mod.rs`: SQLite persistence
- `packages/@codepapr/ui/src-tauri/src/shared/paths.rs`: Path normalization and workspace path resolution
- `packages/@codepapr/editor/src/index.ts`: Editor types and utility functions
