# CodePapr

> **[codepapr.com](https://codepapr.com/)** — Website / Download / Docs

**Local-first coding agent runtime. Tauri desktop + CLI automation.**

CodePapr is a local coding agent system built with DeepSeek cache optimization. The main agent orchestrates three built-in sub-agents — **Explore** (code analysis), **Scout** (web search), and **Mentor** (architecture guidance) — with support for custom extensions. File I/O, command execution, Git operations, browser preview, and LSP diagnostics all run locally.

---

> [中文文档](README_CN.md)

---

## Core Capabilities

| Capability | Description |
|-----------|-------------|
| **Ask / Plan / Agent / App modes** | Single runtime for explanation, execution, and interactive HTML app generation |
| **Multi-agent collaboration** | Main agent dispatches Explore/Scout/Mentor and custom sub-agents via the `task` tool |
| **TodoList task planning** | Agents auto-create and track task lists with progress reporting and re-planning |
| **Project memory auto-management** | `.CodePapr/memory.md` is auto-generated on cold start from ProjectGraph (structure/commands/conventions); accumulates error patterns and project conventions across sessions; auto-deduplicates with a fast model once exceeding 200 lines, without blocking the session |
| **Code intelligence (LSP + AST)** | `lsp` tool with 9 navigation actions (go-to-definition, references, hover, document/workspace symbols, implementations, call hierarchy) — LSP-first with automatic AST project-graph fallback tagged by source/confidence; `list` shows the directory tree with per-file lightweight symbols. The ProjectGraph (UI-facing) further supports dead code detection, circular dependency checks, and refactoring suggestions |
| **DeepSeek prefix cache optimization** | Three-layer prompt injection strategy to maximize cache hits and reduce costs |
| **SEARCH/REPLACE Diff** | Validate before writing, with atomic multi-file patch support |
| **MCP protocol support** | Integrate external MCP tool servers (stdio / SSE / Streamable HTTP); built-in DuckDuckGo Search, Postgres, SQLite presets; MCP marketplace with one-click install from the official registry; per-server permission modes (read-only / read-write / dangerous) and mutating-tool confirmation flow |
| **Deep Git integration** | 8 Git actions + diff panel + safe rollback with backup ref + undo |
| **Conversation reset** | One-click reset code and conversation to any point; restore plan preview shows affected files before execution |
| **Conversation turn navigation** | Right-side turn indicator bar with hover-to-expand panel and click-to-jump |
| **Global search** | Toolbar search with conversation and file search tabs, fully keyboard-operable |
| **TaskChecklist collapse** | Auto-collapse when all tasks complete, auto-expand when new tasks arrive |

## Architecture

```
┌──────────────────────────┐  ┌──────────────────────┐
│  Tauri 2 Desktop         │  │  CLI Terminal        │
│  React + Monaco          │  │  Node.js             │
└───────────┬──────────────┘  └─────────┬────────────┘
            │                           │
            └─────────────┬─────────────┘
                          │
             ┌────────────▼─────────────┐
             │      @codepapr/core      │
             │    Agent / Session       │
             │    3-Zone Caching        │
             │    BUILTIN_AGENTS        │
             │    TodoList / Graph      │
             └────────────┬─────────────┘
                          │
             ┌────────────▼─────────────┐
             │   Rust Backend (Tauri)   │
             │   Workspace IO · LSP     │
             │   SQLite Persistence     │
             │   ProjectGraph Cache     │
             │   Browser · Web Search   │
             └──────────────────────────┘
```

## Quick Start

### Prerequisites

- Node.js 18+
- npm 9+
- Rust toolchain + Cargo (desktop build only)
- DeepSeek API Key (or OpenAI/Claude-compatible endpoint)

### Install

```bash
npm install
npm run build
npm run verify
```

### Launch Desktop

```bash
npm run debug      # Dev mode (hot reload)
npm run release    # Run optimized build directly
npm run publish    # Generate installer (.dmg/.msi)
```

## Four Work Modes

| Mode | Best for | Behavior |
|------|----------|----------|
| **Ask** | Explanation, analysis, suggestions | Read-only — no file edits or command execution |
| **Plan** | Complex task breakdown | Proposes a plan and options, then executes on confirmation |
| **Agent** | Bug fixes, feature implementation | Autonomous execution: search → modify → verify |
| **App** | Data visualization, exploration | Instantly generates interactive HTML apps; renders D3/ECharts/Mermaid in a sandboxed panel |

## Project Configuration

Create a `.CodePapr/` directory at the project root:

| File/Directory | Purpose |
|----------------|---------|
| `.CodePapr/AGENTS.md` | Project-wide rules injected into the system prompt of all agents and sub-agents |
| `.CodePapr/memory.md` | Cross-session project memory; cold-start auto-generated from ProjectGraph, auto-appended by agents, auto-compacted after 200 lines |
| `.CodePapr/agents/*.md` | Custom sub-agents (YAML frontmatter + Markdown body) |
| `.CodePapr/skills/*/SKILL.md` | Reusable skills (search strategies, debugging workflows, release checklists); also supports flat layout `.CodePapr/skills/<name>.md`; skill marketplace with one-click install from GitHub |
| `.CodePapr/commands/*.md` | Custom prompt templates (invoked with `--name`) |

### Built-in Commands

Type `/` to bring up the command palette (`/` format is backward-compatible):

**Main model (deep reasoning):** `/review` `/fix` `/test` `/explain` `/diagnose` `/refactor` `/doc` `/new` `/optimize`

**Fast model (faster, cheaper):** `/search` `/lint` `/clean` `/commit` `/summary` `/build`

**Local (zero tokens):** `/help` `/commands` `/compact`

**Autonomous loop (dual-model Worker+Verifier):** `/goal exec:<verify command>` — Launches an autonomous loop where the Worker executes and the Verifier validates against an objective condition, continuing until the condition passes or limits are exhausted. Examples: `/goal exec:npm test`, `/goal fix auth tests | exec:npm test match:"\\d+ passed"`

Commands auto-route by `model` field: commands declaring `model: 'fast'` use the fast model; otherwise the main model is used. Custom commands support the same routing.

## Settings Panel

Six tabs — `General / LLM / Search / Mentor / Advanced / App`:

- **General**: Language, debug, license
- **LLM**: Main model, fast model, temperature, topP, maxTokens, thinking mode, maxToolRounds
- **Search**: Self-hosted SearXNG search (preferred, with automatic fallback to built-in Bing / Mojeek / Qwant / Wikipedia multi-source aggregation)
- **Mentor**: Sub-agent selection, custom prompts, sub-agent parameters (temperature/topP/thinking/maxTokens/maxToolRounds/maxDepth), independent Mentor model configuration
- **Advanced**: Context compression (model/temperature/tokens/context limit/turn count), TodoList max retries, ProjectGraph depth/file limits
- **App**: .papr app permission management — global default level, Level 3 global toggle, per-app level overrides

See `packages/@codepapr/core/docs/CONFIGURATION.md` for the full parameter reference.

## Built-in Sub-agents

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| **explore** | Read-only code analysis | fast | read, read_image, list, lsp, diagnostics, grep |
| **scout** | Web search + download | fast | web_search, web_fetch, web_download, browser, read_image |
| **mentor** | Architecture/algorithm guidance | Configurable model | None |

The main agent dispatches sub-agents via the `task` tool. Each sub-agent has its own **isolated session and blank context**, receiving only the delegated task description — uncontaminated by the main agent's conversation history. Sub-agents have a 5-minute overall timeout and a 90-second per-tool-call timeout.

## Verify

```bash
npm run verify    # build + test + lint
npm test          # run tests only
npm run lint      # ESLint
```

## Project Structure

```
packages/
├── @codepapr/types       # Shared types
├── @codepapr/common       # Logging and common utilities
├── @codepapr/core         # Agent/Session/Cache/ToolRegistry/BUILTIN_AGENTS/TodoList
├── @codepapr/api          # Provider (DeepSeek/OpenAI/Claude) abstraction
├── @codepapr/db           # SQLite data layer
├── @codepapr/editor       # Editor integration
├── @codepapr/ui           # Tauri desktop (React + Monaco)
│   └── src-tauri/         # Rust backend
```
