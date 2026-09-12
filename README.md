# CodePapr

> **[codepapr.com](https://codepapr.com/)** — Website / Download / Docs

**Local-first coding agent runtime. Tauri desktop workbench over a local `codepapr-server` host.**

CodePapr is a local coding agent system built around LLM prefix-cache efficiency. The main agent dispatches three built-in sub-agents — **Explore** (code analysis), **Scout** (web search), and **Mentor** (architecture guidance) — plus three runtime-internal agents (**Verifier** for goal acceptance, **Compactor** for context compaction, **memory-curator** for `.CodePapr/MEMORY.md`); custom sub-agents are supported too. File I/O, command execution, Git operations, browser preview, and LSP diagnostics all run locally.

---

> [中文文档](README_CN.md)

---

## Core Capabilities

| Capability | Description |
|-----------|-------------|
| **Ask / Plan / Agent / App modes** | Single runtime for explanation, execution, and interactive app generation |
| **Host-client split** | Desktop, CLI, and future clients all speak JSON-RPC to the same local `codepapr-server` host |
| **Multi-agent collaboration** | Main agent dispatches Explore/Scout/Mentor and custom sub-agents via the `task` tool |
| **TodoList task planning** | Agents auto-create and track task lists with progress reporting and re-planning |
| **Project memory (auto-maintained)** | Preferences, constraints, and verified facts are curated into `.CodePapr/MEMORY.md`. It is readable, editable, and diffable; the panel is the file's editor, and saves take effect next turn. |
| **Code intelligence (LSP + AST)** | `lsp` tool with 9 navigation actions (go-to-definition, references, hover, document/workspace symbols, implementations, call hierarchy) — LSP-first with automatic AST project-graph fallback tagged by source/confidence; `list` shows the directory tree with per-file lightweight symbols. The ProjectGraph (UI-facing) further supports dead code detection, circular dependency checks, and refactoring suggestions |
| **LLM prefix cache** | Three-layer prompt injection strategy to maximize cache hits and reduce costs |
| **SEARCH/REPLACE Diff** | Validate before writing, with atomic multi-file patch support |
| **MCP protocol support** | Integrate external MCP tool servers (stdio / SSE / Streamable HTTP); built-in DuckDuckGo Search, Postgres, SQLite presets; MCP marketplace with one-click install from the official registry; per-server permission modes (read-only / read-write / dangerous) and mutating-tool confirmation flow |
| **App / plugin marketplace** | Install .papr apps from the official registry into a **global** or **per-project** scope, each with its own origin, CSP, and SQLite storage |
| **Git integration** | 8 Git actions + diff panel + safe rollback with backup ref + undo |
| **Conversation reset** | One-click reset code and conversation to any point; restore plan preview shows affected files before execution |
| **Conversation turn navigation** | Right-side turn indicator bar with hover-to-expand panel and click-to-jump |
| **Global search** | Toolbar search with conversation and file search tabs, fully keyboard-operable |
| **TaskChecklist collapse** | Auto-collapse when all tasks complete, auto-expand when new tasks arrive |

## Architecture

CodePapr is **not** a monolithic Tauri app. Rust domain logic lives in a shared library crate and is served by a standalone host daemon; clients only call into it over JSON-RPC.

```
  ┌──────────────────────────┐        ┌──────────────────────────┐
  │  Desktop client          │        │  codepapr-cli            │
  │  packages/@codepapr/ui   │        │  crates/codepapr-cli     │
  │  React + Monaco (WebView)│        │  ping/doctor/git/fs/     │
  │  @codepapr/core (agent   │        │  shell/lsp/chat          │
  │  loop, cache, tools)     │        └────────────┬─────────────┘
  │  src-tauri (bin codepapr)│                     │
  └────────────┬─────────────┘                     │
               │  JSON-RPC 2.0, line-delimited     │
               │  TCP 127.0.0.1 (or stdio)         │
               └──────────────┬────────────────────┘
                              ▼
            ┌─────────────────────────────────────┐
            │  codepapr-server  (host daemon)     │
            │  crates/codepapr-server             │
            │  handler.rs → 159 RPC methods       │
            │  + initialize / ping                │
            └──────────────────┬──────────────────┘
                               ▼
            ┌─────────────────────────────────────┐
            │  codepapr-core  (domain library)    │
            │  workspace_fs · git_operations      │
            │  shell · lsp · symbols · snapshot   │
            │  db (SQLite) · mcp_host · web       │
            │  agent_runtime (Node sidecar)       │
            └─────────────────────────────────────┘
```

The desktop client keeps only what a GUI must own: the `codepapr-app://` protocol handler, the embedded/headless browser, TTS, the Stronghold secrets vault, file-export dialogs, and app install/port probing. Everything else is an RPC proxy in `src-tauri/src/commands.rs`.

### Process lifecycle

| Phase | What happens |
|-------|--------------|
| **Attach** | If `CODEPAPR_SERVER_URL` is set, the client connects to that address and never spawns a child |
| **Spawn** | Otherwise it locates the binary (`CODEPAPR_SERVER_BIN` → next to the app executable → Tauri `resourceDir` → `target/{debug,release}` → `PATH`) and runs `codepapr-server --port 0 --port-file <temp>/codepapr-server-<pid>.port` |
| **Handshake** | The bound port is read from the port file or from the stderr line `[codepapr-server] listening on <addr>` (15 s deadline, 40 ms poll), then `initialize` is sent |
| **Events** | Host events arrive as JSON-RPC notifications with method `event` and params `{ event, payload }`, and are re-emitted verbatim onto the Tauri event bus |
| **Shutdown** | `lsp/stopAll` → `agent/stopAll` → `fs/stopWatcher` → `shell/stopAllBackground` → `mcp/disconnectAll`, then the spawned child is killed and reaped |

Running the host yourself is supported — `codepapr-server --port 9090`, then start the desktop with `CODEPAPR_SERVER_URL=127.0.0.1:9090`.

See [docs/ARCHITECTURE.en.md](docs/ARCHITECTURE.en.md) for the full responsibility table, data flow, and marketplace internals.

## Quick Start

### Prerequisites

- Node.js 20.19+
- npm 9+
- Rust toolchain + Cargo — **required for `npm run build`**, because the `@codepapr/ui` build compiles the `codepapr-server` sidecar
- DeepSeek API Key (or OpenAI/Claude-compatible endpoint)

### Install

```bash
npm install
npm run build
npm run verify
```

`npm run build` fans out to every workspace package; the `@codepapr/ui` build is `typecheck && build:host-server && build:sidecar && build:frontend`, so it compiles `codepapr-server`, bundles the Node agent runtime, then builds the Vite frontend.

> Tree-sitter grammars are pulled from crates.io (latest compatible releases). A git clone no longer needs `--recurse-submodules` for the desktop/CLI build.

### Launch Desktop

```bash
npm run debug      # Dev mode (hot reload)
npm run release    # Run optimized build directly
npm run publish    # Generate installer (.dmg/.msi)
```

All three go through `scripts/run-desktop-workflow.mjs`, which auto-installs missing `node_modules`, repairs a broken Rust toolchain, and (for release/publish) checks the .NET SDK.

### Host and CLI directly

```bash
cargo build -p codepapr-server            # host daemon
cargo build -p codepapr-cli               # CLI client

cargo run -p codepapr-server -- --port 9090          # TCP host
cargo run -p codepapr-server                         # stdio host

cargo run -p codepapr-cli -- doctor                  # env + server + git report
cargo run -p codepapr-cli -- --server 127.0.0.1:9090 status
```

CLI subcommands: `ping`, `doctor`, `status`, `git`, `fs`, `shell`, `lsp`, `server start|info`, `chat` (alias `run`). Global flags: `-C/--workspace`, `--server`, `--json`, `-v/--verbose`. With no `--server` it auto-spawns a stdio daemon.

## Four Work Modes

| Mode | Best for | Behavior |
|------|----------|----------|
| **Ask** | Explanation, analysis, suggestions | Read-only — no file edits or command execution |
| **Plan** | Complex task breakdown | Proposes a plan and options, then executes on confirmation |
| **Agent** | Bug fixes, feature implementation | Autonomous execution: search → modify → verify |
| **App** | Data visualization, exploration | Instantly generates interactive apps; renders D3/ECharts/Mermaid in a sandboxed panel |

## App / Plugin Marketplace

.papr apps are installed from the official registry (`mmrqwe/codepapr-apps` → `registry.json`) into one of two scopes:

| Scope | Location | Use for |
|-------|----------|---------|
| `global` | `~/.codepapr/apps/<appId>/` | Cross-project tools |
| `workspace` | `<workspace>/.CodePapr/apps/<appId>/` | Project-specific apps, shippable with the repo |

Discovery scans global first, then the workspace — **a workspace app with the same `appId` overrides the global one**. Runtime directory resolution follows the same precedence, so the frontend, backend, and storage of an app never split across scopes. A directory only counts as an app when its name is a valid app id, `manifest.json` parses, and the entry file (`manifest.entry`, default `index.html`) exists.

Each app gets its own origin `codepapr-app://<appId>/`, a CSP derived from its permissions, and a private `db.sqlite` next to its `manifest.json` (never servable over the protocol). Permissions are two-axis — **local access × network** — with global defaults plus per-app overrides in `Settings → App`; manifests additionally declare fine-grained strings such as `storage:read`, `storage:write`, `http:get`, `fs:read`, `fs:write`, `agent:run:<agent>`.

## Project Configuration

Create a `.CodePapr/` directory at the project root:

| File/Directory | Purpose |
|----------------|---------|
| `.CodePapr/AGENTS.md` | Project-wide rules injected into the system prompt of all agents and sub-agents |
| `.CodePapr/MEMORY.md` | Cross-session project memory, maintained by the memory curator; the panel is its editor, and it is injected into the session bootstrap every turn |
| `.CodePapr/project.sqlite` | Project-level state: sessions, checkpoints, ProjectGraph cache |
| `.CodePapr/agents/*.md` | Custom sub-agents (YAML frontmatter + Markdown body) |
| `.CodePapr/skills/*/SKILL.md` | Reusable skills (search strategies, debugging workflows, release checklists); also supports flat layout `.CodePapr/skills/<name>.md`; skill marketplace with one-click install from GitHub |
| `.CodePapr/commands/*.md` | Custom prompt templates (invoked with `/name`) |
| `.CodePapr/apps/<appId>/` | Workspace-scoped .papr apps (manifest, entry file, private `db.sqlite`) |

Global state lives under `~/.codepapr/`: `codepapr.sqlite` (settings), `apps/` (global apps), `voices/` and `gpt-sovits/` (TTS assets).

### Built-in Commands

Type `/` to bring up the command palette:

**Main model (deep reasoning):** `/review` `/fix` `/test` `/explain` `/diagnose` `/refactor` `/doc` `/new` `/optimize` `/build`

**Fast model (faster, cheaper):** `/search` `/lint` `/clean` `/commit` `/summary`

**Local (zero tokens):** `/help` `/commands` `/undo`

**Autonomous loop (dual-model Worker+Verifier):** `/goal exec:<verify command>` — Launches an autonomous loop where the Worker executes and the Verifier validates against an objective condition, continuing until the condition passes or limits are exhausted. Examples: `/goal exec:npm test`, `/goal fix auth tests | exec:npm test match:"\\d+ passed"`

Commands auto-route by `model` field: commands declaring `model: 'fast'` use the fast model; otherwise the main model is used. Custom commands support the same routing.

## Settings Panel

Six tabs — `General / LLM / Search / Mentor / Advanced / App`:

- **General**: Language, debug, license
- **LLM**: Main model, fast model, temperature, topP, maxTokens, thinking mode, maxToolRounds
- **Search**: Self-hosted SearXNG search (preferred, with automatic fallback to built-in Bing / Mojeek / Qwant / Wikipedia multi-source aggregation)
- **Mentor**: Sub-agent selection, custom prompts, sub-agent parameters (temperature/topP/thinking/maxTokens/maxToolRounds/maxDepth), independent Mentor model configuration
- **Advanced**: Context compaction (second-level summary model/temperature/output cap; trigger line is fixed at window × 90%), Goal loop, verifier, ProjectGraph depth/file limits
- **App**: .papr app permission management — global defaults (local access × network) and per-app two-axis overrides

See `packages/@codepapr/core/docs/CONFIGURATION.md` for the full parameter reference.

## Built-in Sub-agents

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| **explore** | Read-only code analysis | fast | read, read_image, list, graph, glob, lsp, diagnostics, grep |
| **scout** | Web search + download | fast | websearch, webfetch, browser, read_image |
| **mentor** | Architecture/algorithm guidance | Configurable model | None |
| **verifier** *(internal)* | Goal acceptance — read-only audit of the work done by the Worker (`/goal`) | `verifierModelTier` (fast/primary/mentor) | read, grep, glob, list |
| **compactor** *(internal)* | Context compaction — one second-level summary when the deterministic skeleton still overflows | `compactionModel` tier (fast/primary) | None |
| **memory-curator** *(internal)* | Maintains `.CodePapr/MEMORY.md` at turn delivery / pre-compaction | `compactionModel` tier | None (pure reasoning) |

The main agent dispatches sub-agents via the `task` tool. Each sub-agent runs in its own **isolated session with a blank context** and only sees the delegated task description, so the main agent's history never leaks in. Sub-agents have a 5-minute overall timeout and a 90-second per-tool-call timeout.

> **Verifier**, **Compactor**, and **memory-curator** are runtime-controlled internal agents (`internal: true`) — never exposed via the `task` tool. Verifier is invoked by the GoalRunner acceptance loop; Compactor by the context-compaction pipeline (between-turn and mid-loop), as a single second-level summary once the deterministic skeleton still overflows; memory-curator by the memory pipeline at the delivery / pre-compaction checkpoints. Compactor and memory-curator run with zero tools (pure reasoning) and keep the sub-agent default 20-minute wall-clock budget.

## Verify

```bash
npm run verify    # verify:ci + check:tauri
npm run verify:ci # lint + audit + build + test
npm test          # run tests only
npm run lint      # ESLint
cargo check --workspace   # core + server + cli + desktop crate
```

## Project Structure

```
crates/                    # Rust workspace (see root Cargo.toml)
├── codepapr-core          # Domain library: fs/git/shell/lsp/symbols/db/snapshot/mcp/web/agent
├── codepapr-server        # Host daemon (bin: codepapr-server) — JSON-RPC over TCP or stdio
└── codepapr-cli           # CLI client (bin: codepapr-cli)

packages/
├── @codepapr/types        # Shared types
├── @codepapr/common       # Logging and common utilities
├── @codepapr/core         # Agent/Session/Cache/ToolRegistry/BUILTIN_AGENTS/TodoList
├── @codepapr/api          # Provider (DeepSeek/OpenAI/Claude) abstraction
├── @codepapr/editor       # Editor integration
└── @codepapr/ui           # Tauri desktop (React + Monaco)
    └── src-tauri/         # Desktop client crate (bin: codepapr)
                           #   host.rs      — JSON-RPC client to codepapr-server
                           #   commands.rs  — Tauri commands, mostly RPC proxies
                           #   app_runtime* — codepapr-app:// protocol, app scan, ports
                           #   papr_runtime/— manifest, permissions, SDK injection, storage
```

The Cargo workspace members are `crates/codepapr-core`, `crates/codepapr-server`, `crates/codepapr-cli`, and `packages/@codepapr/ui/src-tauri`. SQLite persistence is owned by `codepapr-core::db` and reached over RPC by the desktop client — it no longer lives in the Tauri crate.
