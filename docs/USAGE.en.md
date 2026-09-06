# User Manual

## Quick Start

### Prerequisites

- Dependencies installed and built (`npm install && npm run build`)
- At least one usable model provider
- Corresponding API key
- A local project directory you intend to analyze or modify

### Three Steps

1. API key, provider, and model in settings
2. Open a project folder
3. Ask / Plan / Agent / App

## Four Working Modes

| Mode | Best For | Behavior |
|------|------|------|
| **Ask** | Explanation, analysis, suggestions | Read-only; no file modifications or command execution |
| **Plan** | Complex task decomposition | Output a plan with options, execute after confirmation |
| **Agent** | Bug fixes, feature implementation | Autonomous execution: search → modify → verify |
| **App** | Data visualization, interactive apps | Instantly generates interactive apps; supports Papr SDK (`window.papr`) for Agent/storage/HTTP/filesystem |

In Plan mode, when requirements are ambiguous, the Agent will call the `question` tool to ask you instead of guessing.

Ask is a read-only mode: mutating tools (write/edit/patch/bash/git/app_*, etc.) are **blocked at the tool-registration layer** — neither exposed to the model nor executable — preventing accidental file changes by construction, not by prompt alone. Plan mode enables the `question` interactive decision tool to clarify requirements before execution.

## Papr App Development

Papr is CodePapr's application runtime. AI-generated apps run directly in the desktop client, using the SDK to call CodePapr capabilities.

### .papr Format

An app is a small source tree under `.CodePapr/apps/<appId>/` (once papr.db is used, a `db.sqlite` appears holding app data):

```
.CodePapr/apps/my-app/
├── manifest.json     ← Metadata + permissions + agents
├── index.html        ← Shell (link CSS + module entry)
├── css/theme.css
├── js/main.js        ← ES module entry
├── js/db.js / ui.js / agent.js / api.js  ← Split by responsibility
└── db.sqlite         ← papr.db data (created at runtime)
```

manifest.json example:

```json
{
  "spec": "papr/0.1",
  "name": "Todo App",
  "version": "0.1.0",
  "local": "read",
  "network": true,
  "agents": [{
    "name": "assistant",
    "model": "main",
    "systemPrompt": "You are a task assistant",
    "tools": ["read", "websearch"],
    "maxToolRounds": 20
  }]
}
```

### Papr SDK API

`window.papr` is auto-injected into the HTML — no manual import needed:

```javascript
// Key-value storage (per-app isolation, stored in .CodePapr/apps/<appId>/db.sqlite)
await papr.db.set('theme', 'dark');
const theme = await papr.db.get('theme');

// AI Agent invocation (with progress callback)
const result = await papr.agent.run(
  { agent: 'assistant', task: 'Analyze the data' },
  (event) => { console.log(event.type); }
);
// → { content: "...", steps: [{name:'read', status:'success'}, ...] }

// HTTP requests
const data = await papr.http.get('https://api.example.com/data');
const updated = await papr.http.request({
  method: 'PUT',
  url: 'https://api.example.com/item',
  headers: { Authorization: 'Bearer …', 'Content-Type': 'application/json' },
  body: JSON.stringify({ ok: true }),
});

// File I/O (restricted to the app data directory; writeFile auto-creates parent dirs; use encoding: 'base64' for binary)
await papr.fs.writeFile('config.json', JSON.stringify(config));
await papr.fs.writeFile('icon.png', pngBase64, { encoding: 'base64' });
const exists = await papr.fs.exists('icon.png');
const files = await papr.fs.list();

// Receive pushes from the coding Agent (app_publish tool → papr://event)
const off = papr.events.on('cards', (evt) => {
  // evt: { channel, seq, ts, payload }
  applyToBoard(evt.payload);
});
// On startup, replay history first (last 200 events kept), then listen live
const history = await papr.db.get('inbox:cards');
```

**`papr.agent.run` round & timeout limits:**

- **Tool rounds**: bounded by the manifest `agents[].maxToolRounds` (defaults to 50 when omitted, and any declared value is capped at 50). Search calls such as websearch/webfetch count toward the total — there is no separate search-round limit.
- **Timeout**: a **300-second idle timeout** (consistent across all three layers: iframe SDK, main thread, Worker). As long as the Agent keeps emitting progress events (streaming output, tool calls) the run continues uninterrupted; only 300s of total silence is treated as a timeout. Multi-round search / long analysis tasks no longer hit a fixed 5-minute ceiling.

### Creating Apps

Switch to **App mode** and describe the app you want in natural language. The Agent uses `write` / `edit` / `patch` to put `manifest.json`, a shell `index.html`, and `css/` + `js/` in `.CodePapr/apps/<appId>/`, then calls `app_render({ appId })` to open it. `app_render` only mounts an app already on disk; it does not write files. Call it again after edits to refresh (you can still export a zip from the dock).

### Agent Push (app_publish + inbox)

For "Agent works, App displays" scenarios — kanban boards, progress panels, artifact galleries — use the `app_publish` tool:

1. **The app declares a channel contract** — add `inbox` to `manifest.json` when the coding Agent should push (this is opt-in: the contract is copied into Agent session context; self-refreshing tickers/clocks must not declare it):

```json
{
  "spec": "papr/0.1",
  "name": "Team Kanban",
  "kind": "plugin",
  "inbox": {
    "cards": {
      "description": "Kanban card operations",
      "example": { "op": "add", "card": { "title": "Fix login", "column": "todo" } }
    }
  }
}
```

2. **The app subscribes** — `papr.events.on('cards', cb)` receives live events; on startup, replay history with `papr.db.get('inbox:cards')` (an array of `{seq, ts, payload}`, last 200 kept).
3. **The Agent pushes** — from any writable mode (Agent/Plan/App), call `app_publish({ appId, channel, payload })`. The coding Agent does **not** call `app_list` first: session context "## Enabled plugins" lists only **enabled targets that declared `inbox`** (plus fullscreen apps that declared inbox). Push using that `appId` / channel / example. Self-refreshing widgets without inbox stay out of context — do not publish to them.

Properties:

- **Persistent + live dual channel**: each event is atomically appended to the app's `db.sqlite` (concurrency-safe, no lost events); if the app is mounted it is also delivered live via `papr://event`. When unmounted, the event additionally enters a short (~30s) live queue (`queued`) so an app that mounts moments later (e.g. auto-revealed by the publish) still receives it live; later opens replay history from the db. Live events can overlap with replay — apps should dedupe by `seq`.
- **Session catalog**: only enabled plugins that declared `inbox` (plus fullscreen apps that declared inbox) are copied into session context; examples are truncated so the catalog stays small
- **Contract validation**: pushing to an undeclared channel is rejected with the list of valid channels and their descriptions, letting the Agent self-correct.
- `inbox:*` keys are written only by `app_publish` — the app side is read-only. `payload` is capped at 256KB.
- Sub-agents can use `app_publish` by default (custom sub-agents may add/remove it via their `tools` whitelist). It is disabled in read-only Ask mode.

### Permissions (two-axis model)

App access is declared by two orthogonal axes in the manifest:

| Axis | Value | Capability |
|---|---|---|
| `local` | `none` | Pure compute; only `papr.db` / `papr.fs` (app-owned sandbox, always available) |
| `local` | `read` | + read project files (Agent read tools: read/grep/list/lsp/diagnostics, etc.) |
| `local` | `write` | + modify project files and execute commands (Agent write/edit/patch/bash, writing project files directly) |
| `network` | `true` | + access the public internet (papr.http + Agent websearch/webfetch + remote MCP servers; **stdio/local MCP servers count as a local capability and require `local ≥ read`**) |
| `network` | `false` | fully offline (enforced by iframe CSP + backend sandbox; JS cannot bypass — **process-level bash/backend isolation is macOS-only**, see below) |

> **Platform limit (C-5)**: the `sandbox-exec` process sandbox is currently enforced on **macOS only**. On Windows / Linux, an app declaring `network: false` / `local ≤ read` still has its **bash tool and backend processes** outside those two axes (iframe-side CSP/storage isolation still applies); a warning is pushed to the debug log when such an app launches or its agent runs. A cross-platform process sandbox is a separate work item.

- `papr.db` / `papr.fs` are app-owned sandbox and always available — no permission needed
- Backend services (`command`) require `local` to be at least `read`
- Recommended combos: calculator `{none, off}`, Todo/notes `{none, off}`, data dashboard `{read, on}`, refactoring tool `{write, off}`
- The legacy `level` field (0-3) still works: 0→`{none,off}`, 1→`{read,off}`, 2→`{read,on}`, 3→`{write,on}`

Agent tool whitelist (declare in `agents[].tools`, must fall within the access profile): `read`, `grep`, `list`, `lsp`, `diagnostics`, `read_image`, `skill_load`, `todo`, `local_time_now` (built-in), `websearch`, `webfetch` (require network), `write`, `edit`, `patch`, `bash` (require local=write). Note: `todo` is accepted by validation for backward compatibility but is no longer mounted for app agents at runtime (its host session is invisible to users — see audit D-12); stdio MCP servers count on the local axis and cannot be called with `local: none` (see D-11).

Settings → **App Tab** sets the **default when undeclared** (local × network) and per-app overrides (overrides can only narrow a declared profile). Apps that already declare `local`/`network` in their manifest are **not** capped or granted by this fallback.

### Application Management Panel

The right panel's **Apps Tab** shows all registered .papr apps:

- **Green dot** = backend running, **Red dot** = backend stopped, **Gray dot** = frontend-only (no backend; always openable)
- Click to select, double-click to open
- Bottom button bar: ▶ Start / Open / ■ Stop / 🗑 Delete
- Backend apps must be "started" before "open"

### App Agent Management Tools

LLM manages apps via 4 tools (App mode only):

- `app_list` — list all apps (duplicate check before create; not how the coding Agent discovers publish contracts)
- `app_start <appId>` — start backend
- `app_stop <appId>` — stop backend
- `app_delete <appId>` — full delete

## Configuration

### Configuration Storage Locations

| Level | Path | Purpose |
| --- | --- | --- |
| Application | `~/.codepapr/codepapr.sqlite` | provider, model, API key, sampling parameters, language |
| Project | `<workspace>/.CodePapr` | Project state, session messages, cache stats, rules, Agents, Skills, commands |

### Settings

- **General**: language, agent tools (Default/Minimal), experimental features, license
- **LLM**: models, sampling, thinking
- **Search**: SearXNG; falls back to built-in aggregation
- **Sub-agents**: Explore / Scout / Mentor
- **Advanced**: compaction, Goal, ProjectGraph, tool context
- **App**: default access for undeclared apps

**Agent tools** (Settings → General): "Default" = the current full desktop tool set (still filtered by Ask/Plan/Agent/App mode); "Minimal" = only 7 tools exposed — `read / edit / write / grep / bash / websearch / webfetch` — fewer tools, closer to a minimal coding harness (note: bash can still run arbitrary commands; minimal ≠ sandbox). Combinations take mode ∩ profile (Minimal+Ask also drops write/bash; app-specific tools are gone under Minimal, so App mode needs the Default profile). Web capability rules: under **Default**, enabling MCP search replaces the native `websearch`/`webfetch` with MCP search tools; under **Minimal no MCP is loaded at all**, so native `websearch`/`webfetch` are always kept (never a search-less surface). Takes effect on the next message after saving; does not interrupt the running stream. On the CLI, `codepapr run --tools-preset minimal` shares one allowlist (`MINIMAL_AGENT_TOOLS`) with the UI.

Voice lives on the character panel. Full parameter list: `packages/@codepapr/core/docs/CONFIGURATION.md`.

## Built-in Sub-Agents

| Agent | Purpose | Model | Tools |
|-------|------|------|------|
| **explore** | Read-only code analysis | fast | read, read_image, list, graph, glob, lsp, diagnostics, grep |
| **scout** | Web search + download | fast | websearch, webfetch, browser, read_image |
| **mentor** | Architecture/algorithm guidance | Configurable independent model | None |
| **verifier** *(internal)* | Goal acceptance — read-only audit of the Worker's work | `verifierModelTier` tier | read, grep, glob, list |
| **compactor** *(internal)* | Context compaction — recoverable checkpoint generation | `compactionModel` tier | None (pure reasoning) |

The main Agent dispatches sub-agents via the `task` tool. Each sub-agent has an independent Session and only receives the delegated task description, free from history pollution. The main Agent's TodoList instructions encourage it to proactively delegate code analysis to Explore and web search to Scout.

> The Goal autonomous loop's verifier is a built-in read-only sub-agent (tools whitelist: read/grep/glob/list — it can independently verify the Worker's changes), configured in Advanced settings (`verifierModelTier`: fast, primary, or mentor). It is an internal agent (`internal: true`), never exposed to the main Agent via the `task` tool, and only invoked internally by GoalRunner. Subjective goals (no `exec:` condition) default to the mentor model, silently falling back to the primary model when no mentor is configured.

> Context compaction (Compactor) is likewise a built-in internal agent (`internal: true`) with zero tools — pure reasoning, since the compaction input (transcript) already contains all facts. It is invoked directly by the runtime compaction pipeline (between-turn and mid-loop compaction), never exposed via the `task` tool; model tier and parameters reuse the compaction settings (`compactionModel` / `compactionTemperature` / `compactionMaxTokens`; when the fast tier is selected but the fast model is disabled, the LLM call is skipped in favor of rule-based fallback). The wall-clock budget keeps the sub-agent default of 20 minutes.

Sub-agents have a **5-minute overall wall-clock timeout** (auto-cancels on timeout), individual tool calls have a **90-second timeout**, and Worker IPC has a **120-second timeout**. Timeouts return errors to the LLM instead of hanging indefinitely.

## TodoList Task Planning

In Agent mode, complex tasks automatically create a TodoList:

- Agent calls the `todo` tool to initialize a task list (2-8 atomic tasks)
- Tasks are marked running → completed/failed
- Failed tasks auto-retry (configurable count, default 3)
- If the plan is wrong, the entire list can be rewritten (re-plan)
- Auto-collapses to a one-line summary when all done; auto-expands on new tasks

**Cooperation with the task tool**: `todo` maintains the plan, `task` delegates single tasks to sub-agents. The main Agent's prompt proactively determines which tasks should be delegated.

## Conversation Reset

Hover any user message → "Reset to here" and "Copy" buttons appear below:

- **Reset to here**: Rolls back all conversation and code changes after that message. Auto-snapshot created on every user message (excluding `node_modules/`, `dist/`, etc.). Reset shows a restore plan preview (files to restore/delete/unchanged), then executes after confirmation (auto-creates backup reference, supports undo).
- **Copy**: One-click copy of the message text to clipboard.

## Round Navigation Indicator

A compact **round indicator bar** sits on the right-middle edge of the chat area. Each horizontal tick represents a user message round:

- **Hover** the bar → round panel opens automatically, listing all conversation rounds
- Each row shows `#1` round number + the user's first sentence
- The currently visible round is **highlighted** in both the indicator bar and panel
- **Click** any round in the panel → smooth-scroll to that message
- Panel disappears when mouse leaves the bar or panel (200ms delay prevents accidental closing)

Ideal for quickly jumping between questions and context in long conversations.

## Code Review Panel

Click **Review** in the desktop toolbar to open the visual Code Review panel:

- Default comparison is `HEAD~1..HEAD` diff
- Left file list shows added/modified/deleted/renamed status
- Center Monaco diff editor displays original / modified sides
- Click line number gutter to add line-level comments on either side
- Comments support "unresolved / resolved" status
- Overall approval status can be set: pending / approved / changes requested / commented

> Code review state is stored in-memory in `reviewStore`, grouped by `baseRef..headRef`, not persisted to disk.

## Global Search

The toolbar search box supports **conversation search** and **file search**, switched via tabs:

### Conversation Search

- Search all messages in the current session with scope filter: `All | You | AI`
- Each result shows role badge, round number, relative time, and match context (keyword highlighted)
- `↑↓` to navigate, `Enter` to jump to message, `Esc` to close

### File Search

- **Content mode**: Search file contents in the workspace using the Tauri backend to walk project files
- **Filename mode**: Search file paths and names
- Each result shows filename + line number + matching line preview
- Click a result → open the file and jump to the line in the editor
- Search results capped at 50; refine your query if truncated
- Panel is **horizontally centered** in the viewport, 300ms debounced, only runs when the Files tab is active

## Project Memory (zero-review auto-write)

Layering and timing (the human-readable version): [`docs/web/context-architecture.en.html`](../web/context-architecture.en.html).

Project memory is not “dumped into the model as one blob”. The ledger in SQLite `memory_entries` is authoritative; the memory panel is the only human surface. Different kinds of memory enter **different context layers** and change on different clocks.

| Kind | Stored in | Request layer | When it reaches this session’s model | How it changes |
|---|---|---|---|---|
| Hand-written notes | Ledger; panel “every session” | Session Bootstrap (stable prefix) | Rendered from the ledger at session start; refreshed on a compaction epoch | A panel edit hits the ledger immediately; **the current prefix is not rebuilt** until the next session or compaction |
| Preferences / constraints / project facts | Ledger; panel “every session” | Same, Bootstrap | Same: written to the ledger this turn, enters the prefix on the **next Bootstrap refresh** | You said remember / must / don't; workspace-grounded facts; successful tests; cold start; Agent `memory_write` → persist immediately, no admit click |
| Procedures (`procedure`) | Ledger; panel “on-demand” | Turn-scoped Recall / `memory_search` | **Next user turn** after save, if retrieval hits | Same error twice, etc.; never in the every-session prefix |
| Web / MCP citations (`citation`) | Ledger; panel “search only” | `memory_search` only | Only if the model searches | web / MCP / `https` evidence; **never Bootstrap; auto-Recall skips them** |
| Current-task goal / todos | Session Checkpoint | Session State | After compaction, as the checkpoint | Evolves with the epoch; **not** cross-session project memory |
| Large tool output | `.CodePapr/tool-output/` | Not auto-injected | `read_artifact` on demand | Frozen at write time |

**Writes (zero review)**: `planMemoryWrite` either persists or drops. The panel is a full catalog (every-session / on-demand / search-only, forget) — no admit queue. The Agent must not ask you to confirm memories. Injection, secrets, and dangerous commands are dropped. If the Agent still `write`s/`patch`es `.CodePapr/memory.md`, it is intercepted onto the same policy and never written to disk.

**Reads**: the ledger is not dumped into a request. Short instructions already sit in session bootstrap; every user turn (Ask included, capped at 3 items there) token-matches your message (~5 items / 1200 tokens, citations skipped); if that is not enough the Agent calls `memory_search` (includes citations; available in Ask). The catalog listing tool is `memory_list` (at most 40 previews). `memory_search` is not run on every message.

**Load and cache**: At session start, the ledger is rendered into Session Bootstrap (`log[0]`, `isPrefixSystem`), frozen per (session × stable signature). The rendered section is outside the signature, so newly saved memories **do not bust the current prefix cache**. Compaction epochs refresh via `refreshBootstrap`; a new session always re-reads the ledger. Each user turn also runs Recall (citations excluded from automatic Recall).

**Cold start**: If the ledger has no Bootstrap section and a ProjectGraph cache exists, a background job writes a structure / stack / build-command summary into the ledger. It does not block the current session; it enters Bootstrap on the next session or compaction.

**Dedup**: Same-hash active rows are superseded. There is no LLM pass over a standalone memory file.

## Code Intelligence (lsp / list)

LLM-facing code intelligence is provided by the `lsp` tool and `list` (directory tree + per-file lightweight symbols).

**lsp navigation (9 actions, LSP-first with AST project-graph fallback, results tagged with source/confidence)**: `goToDefinition` (jump to definition), `findReferences` (find references), `hover` (type/documentation info), `documentSymbol` (file symbol outline), `workspaceSymbol` (workspace symbol search), `goToImplementation` (jump to implementation), `prepareCallHierarchy` (call hierarchy item), `incomingCalls` (incoming calls), `outgoingCalls` (outgoing calls). When LSP is unavailable or returns nothing, it automatically degrades to the AST project graph; results are tagged with `source` (lsp/ast) and `confidence` (high/medium/low).

**Project structure**: `list` browses the directory tree and automatically attaches lightweight per-file symbols (top-level symbols per code file, AST-based, no LSP needed).

> The `graph` tool (full / lookup / dependency / impact / implementations / entrypoints / smart_context / dead_code / circular_deps / type_hierarchy / suggest_refactors / test_impact / generate_tests — 14 actions) is **soft-hidden from the main Agent's LLM** — the main Agent uses `list` + `lsp` for structure and navigation, and delegates cross-module dependency/impact analysis to Explore. `graph` is still provided to the Explore sub-agent via allowlist, and serves UI panels and the AST fallback backend for `lsp` point queries.

## Project-Level Customization

### Project Rules

Reads `.CodePapr/AGENTS.md`. Content is injected into the system prompt (unfilled placeholder lines are stripped first). Opening a workspace writes the default file when it is missing and fills empty Verify commands from detected scripts; an existing file only gets empty Verify lines filled, and a blank file opts out. Suitable for: project conventions, directory structure, off-limits scope, verification criteria. Sub-agents (including Explore) inherit the same project rules.

### Custom Sub-Agents

Declare in `.CodePapr/agents/<name>.md` with YAML frontmatter + body:

```yaml
---
description: Code review, identify risks and suggest minimal fixes
mode: subagent
model: fast
temperature: 0.2
tools:
  read: true
  grep: true
---
You are a reviewer, a read-only code-review sub-agent.
```

`mode` values: `subagent` (default, delegable via the `task` tool), `all` (delegable + `@name` forces delegation), `primary` (only via `@name`; **excluded** from the `task` tool's spontaneous catalog). `@explore check auth` makes the main agent delegate immediately via `task`; `@explore @scout login flow and official docs` asks for parallel `task` calls in the same reply. `@` does not swap the primary agent's identity or system prompt.

Omitting `tools` inherits every tool available to that sub-agent; an empty `tools:` block disables all tools (pure reasoning). A one-line form is also accepted: `tools: read, grep`.

`model` accepts `fast` / `mentor` or a concrete model name; when `mentor` has no dedicated API Key configured, it falls back to the main API Key.

### Skills

Skills are reusable playbooks for the main Agent, placed under `.CodePapr/skills/` in two layouts:

- Nested: `.CodePapr/skills/<name>/SKILL.md`
- Flat: `.CodePapr/skills/<name>.md`

They do not create sub-agents at runtime; instead they serve as project-level context the model can choose from. Only name + description are injected into stable context; full content is loaded on demand via the `skill` tool (max 500KB). Default includes a `search` Skill (search strategy). Enable/disable state is saved in `.CodePapr/project.sqlite`.

**Skill Marketplace**: The desktop app includes a built-in skill marketplace that pulls listings from GitHub (`zerone-agent/agent-use-skills`), supporting one-click install into the project. Installed skills are tracked in `.CodePapr/skills-lock.json` (listing id, written Skill paths, SHA-256). Plugin packs record their sub-skill directories; deleting a local Skill removes it from the lock file.

### Chat Commands (Slash Commands)

Type `/` to open the command autocomplete palette.

**Primary model built-in commands:** `/review` `/fix` `/test` `/explain` `/diagnose` `/refactor` `/doc` `/new` `/optimize` `/build` `/goal`

**Fast model built-in commands:** `/search` `/lint` `/clean` `/commit` `/summary`

**Local commands (zero tokens):** `/help` `/commands` `/compact` `/undo`

### Custom Chat Commands

Declare prompt templates in `.CodePapr/commands/<name>.md` to register them as slash commands `/<name>` in the chat input.

#### 1. Frontmatter Configuration and Template Syntax

```markdown
---
description: Short command description (displayed in / autocomplete menu and /help)
usage: Usage hint (e.g. /mycmd <args>)
example: Example usage (e.g. /mycmd fix animation lag)
model: fast | primary | mentor | <custom-model-id>  # Optional: fast routes to fast model, primary to primary model
agent: <subagent-name>  # Optional: automatically delegate task to specified subagent
---
Prompt template body supporting dynamic placeholders:
- $ARGUMENTS  : Replaced with all arguments entered after the command
- $1, $2 ...  : Replaced with the 1st, 2nd positional argument
- @path       : Automatically reads workspace relative file content and embeds it as an inline code block
- !`cmd`      : Executes simple shell command and embeds output into the prompt (simple commands only, no compound operators)
```

#### 2. Practical Examples

##### Example A: Static Page & Rendering Logic Diagnosis (Zero Git Risk)
Ideal for static or pure frontend projects containing `index.html`, CSS, and JS:
```markdown
---
description: Diagnose index.html page structure and visual rendering logic
usage: /pagecheck [observed issue or question]
example: /pagecheck check if animations or style imports have issues
model: fast
---
Please help diagnose the page structure and rendering logic of this static project.

### Page Entrypoint (@index.html)
@index.html

---
### User Question
$ARGUMENTS

### Requirements:
1. Check CSS and JS import paths and tag structure in index.html.
2. Objectively analyze rendering or interaction issues reported by the user and provide actionable suggestions.
```

##### Example B: Dependency & Script Architecture Analysis
```markdown
---
description: Analyze package.json dependencies and scripts
usage: /depcheck [question]
example: /depcheck which scripts are related to testing?
model: fast
---
Please answer the user's question based on the project root configuration.

### Root Config (package.json)
@package.json

---
### User Focus
$ARGUMENTS
```

##### Example C: Git Workspace Review (Safe Read-Only Execution)
```markdown
---
description: Inspect workspace Git status and Diff for code review
usage: /gitcheck [review focus]
model: fast
---
Please review current workspace changes:
Current status: !`git status -s`
Diff:
```diff
!`git diff HEAD`
```
Focus area: $ARGUMENTS
```

#### 3. Creation and Management
- **Method 1 (UI, Recommended)**: Click **Project Config** in the toolbar → switch to the **Commands** tab → enter command name, click **Create Command**, edit in the Monaco editor, and click **Save**.
- **Method 2 (Filesystem)**: Create `.CodePapr/commands/<name>.md` in your project workspace. Changes take effect immediately.
- **Verification & Testing**: Type `/` in the chat input to see autocomplete entries, or run `/help` to view all registered custom commands. If an `@path` file does not exist in the current project, CodePapr gracefully reports the read failure without altering any files.

## External Path Permissions

The desktop app requires explicit authorization for reading/listing absolute paths outside the project:

- When Agent invokes `read` / `list` with an absolute path outside the workspace, a **PermissionDialog** appears
- Options: **Deny**, **Allow this file**, **Allow this folder**
- Authorizations are added to an allowlist; subsequent accesses to the same path don't re-prompt
- For a file directly under the filesystem root (e.g. `/secret.txt`), choosing "Allow this folder" is automatically downgraded to granting that single file only, so one click can never grant the entire filesystem root
- Write, edit, and command execution are still restricted to the workspace regardless

## macOS Command Sandbox

> **macOS only**: on Windows / Linux there is currently **no** equivalent process-level sandbox — a narrowed app profile (`network: false` / `local ≤ read`) does not actually constrain its bash/backend processes (iframe-side CSP isolation is unaffected). The UI debug log pushes a warning when a narrowed profile is detected; a cross-platform sandbox is a separate work item.

On macOS the `bash` tool, shell sessions, and app backend processes run inside a `sandbox-exec` sandbox:

- **Readable**: system dirs (/bin, /usr, /System, /Library, etc.), /opt/homebrew (Homebrew tools), PATH directories, the workspace, and authorized external paths
- **Writable**: the workspace, the temp directory, tool cache dirs (~/.npm, ~/.cache, ~/.cargo, ~/.local, ~/.nvm, ~/.volta), and authorized external paths
- **Always denied** (even in YOLO mode): ~/.ssh, ~/.gnupg, ~/.config, ~/.aws, ~/.azure, ~/.kube, ~/.git, ~/.CodePapr
- Common HOME tool configs (.gitconfig, .npmrc, etc.) are allowed read-only by default; other HOME files require external authorization when needed
- **IPC**: mach-lookup is allowed (`osascript` etc. need to reach system services), along with lsopen (the dedicated operation for `open` to launch apps/files/URLs) and sysctl-read (`ps`/`pgrep` reading the process table); each system service enforces its own authorization, and file/network rules above still apply

## Toast Notifications

The desktop uses non-blocking Toast notifications instead of traditional alerts:

- Four types: `info` / `success` / `warning` / `error`
- Default 4.5s auto-dismiss; `error` type defaults to 8s
- Max 5 simultaneous; oldest discarded when overflowing
- Currently used in file attachment drag-and-drop and other scenarios

## Character Roleplay

> **Experimental feature**: off by default. Enable "Characters" under Settings → General → Experimental features to reveal the toolbar entry.

Create, import, and activate AI personas so the Agent speaks to you with a specific character's identity.

**Creating a character:** Click the character button in the toolbar → "New Character", fill in:
- **Basic info**: Name, avatar (upload image)
- **Persona fields**: Description (appearance/background), Personality (speaking style/traits), Scenario (initial context), First Message
- **Example dialog**: Separate dialog groups with `<START>` to define speaking style
- **Advanced**: System prompt (additional instructions), Tags, Creator, Version

**Importing character cards:** Supports PNG character cards (SillyTavern / CCv3 spec) and JSON file import. JSON data in PNGs is embedded as tEXt/iTXt chunks; the avatar is imported as well.

**Exporting character cards:** Export characters as PNG cards for cross-tool use. Portable voice settings (speed, sample steps, sentences per chunk, playback mode, languages) are written to `extensions.codepapr.voice`; local reference audio and fine-tuned model files are not exported — re-upload a reference audio on the target machine before enabling voice.

**Activating a character:** Click Enable on the character editor — unsaved edits are saved automatically first. Enable applies to the **current session only**; clicking a name in the list opens it for editing and does not activate it. In an empty session, switching characters replaces the greeting with the new character's first message. Opening the panel selects the character already enabled for this session. The profile is injected into the Session Bootstrap (not ImmutablePrefix), so switching characters does not break the DeepSeek system-prefix cache. Default is a coding persona: the character colors tone while still writing code and using tools. Switch to Roleplay in the character panel for stage-play format. In Ask / Plan modes the character is always injected as a coding persona; the roleplay format only applies in Agent mode. New sessions start with no character.

**Roleplay format convention (roleplay mode only):**
- `*Asterisk-wrapped text*` → Actions/narration/scene description (not spoken by TTS)
- Plain text → Character dialogue (spoken by TTS)
- `**Bold text**` → Emphasis/stress (spoken with extra stress)
- `(Parenthetical)` → Tone indicators like `(whispering)` or `（轻声）` (not spoken)

## Text-to-Speech (TTS)

> **Experimental feature**: off by default. Enable "Voice" under Settings → General → Experimental features to reveal voice controls. Auto-read also requires an enabled character (turn on "Characters" too).

The voice system is powered by GPT-SoVITS for local voice cloning, enabling characters to read dialogue aloud.

**Installing GPT-SoVITS:** Click the TTS speaker button in ChatPanel for the first time — if not installed, the installer wizard appears automatically. Or trigger installation from the Voice Tab in the character editor. The installer runs: Python check → clone GPT-SoVITS repo → pip install → download pretrained models (~2GB, using hf-mirror source) → verify. Requires Python 3.10+ installed.

**Configuring voice for a character:**
1. Open the character editor (toolbar character avatar button) → Voice Tab
2. Upload reference audio (3-10s, 5s recommended, clean voice, WAV/MP3/M4A/AAC, 16kHz+)
3. Enter reference text (the exact words spoken in the audio)
4. Select reference audio language and speech language
5. Adjust speed (50%-200%), synthesis speed (4=fastest / 8=balanced / 16=highest quality), sentence chunking (1-5)
6. Click "Test" to preview
7. Finally flip the "Voice Output" switch (it refuses to turn on without a reference audio and transcript)

**Playback modes:** The character panel's Voice Tab exposes four modes; `ws-batch` is the default and recommended one: synthesis runs over a persistent WebSocket where each request carries one chunk (3 merged sentences by default, adjustable 1-5 via "sentence chunking"), ~1-2s to first word. The others: `streamed-pipeline` / `streamed-pcm` (per-sentence HTTP with PCM direct playback) and `whole` (wait for the full reply, slowest start but most coherent).

**Playback controls:**
- Characters with voice enabled auto-read AI replies
- Hover over any AI reply to reveal a "Replay" button to hear it again
- Cancel the current Agent message to stop ongoing playback
- The TTS speaker button in ChatPanel starts the GPT-SoVITS service or shows service logs/status

**GPU warmup:** On Apple Silicon Macs, after first starting the TTS service, manually click "GPU Warmup" in the Voice Tab of the character editor to pre-compile Metal kernels, avoiding 5-15s delay on first synthesis.

**Voice fine-tuning:** In the character editor Voice Tab, "Generate Training Data" (LLM writes character script → synthesize ~2min training audio), then "Start Fine-Tune" (background training, typically 30-60min). Once complete, enable the fine-tuned model for more natural sound and faster synthesis.

## Writing Effective Tasks

Recommended:
> Fix the issue where background processes aren't stopped after preview closes in packages/@codepapr/ui. First find the binding logic between current preview session and background processes, then make minimal changes.

Not great:
> Fix the preview for me.

## Typical Workflows

### 1. Understand First, Then Execute
1. Ask: Explain system structure, locate modules
2. Plan: Output task checklist and verification approach
3. Agent: Execute per the checklist

### 2. Direct Bug Fix
Go straight to Agent mode with a clear objective and affected file scope.

### 3. Generate Data Visualizations
Switch to App mode to let the Agent explore data and generate an interactive app — perfect for database analysis, relationship diagrams, dashboards, and more.

### 4. Conversation Reset Rollback
If the Agent goes off track, hover the previous correct user message and click "Reset to here" to continue from that state.

## Data Locations

| Path | Purpose |
| --- | --- |
| `~/.codepapr/codepapr.sqlite` | Application-level settings |
| `<workspace>/.CodePapr/project.sqlite` | Project-level state, chat history, cache stats |
| `<workspace>/.CodePapr/project.sqlite` `memory_entries` | Cross-session project memory (panel is the only human surface; Bootstrap is rendered from the ledger) |
| `<workspace>/.CodePapr/store` | Project-level text records |
| `<workspace>/.CodePapr/skills` | Project-level skill files |
| `<workspace>/.CodePapr/agents` | Project-level custom sub-agents |
| `<workspace>/.CodePapr/commands` | Project-level custom commands |
| `<workspace>/.CodePapr/apps` | Papr app directory (one subdirectory per app) |
| `~/.codepapr/voices` | Character reference audio files |
| `~/.codepapr/gpt-sovits` | GPT-SoVITS installation and models |

## External Harness (`codepapr run`)

External eval scripts / CI harnesses run tasks through the **same Agent runtime** as
the desktop: the same Node sidecar (`@codepapr/ui/dist-sidecar/agent-runtime.mjs`,
produced by `npm run build:sidecar`), the same agent loop and context pipeline, and
the same Rust tool host (fs/shell/git/lsp/web). The CLI itself only does argv,
event persistence and process lifecycle — it never maintains a second tool table
or prompt.

### Prerequisite builds

```bash
cargo build -p codepapr-cli -p codepapr-server   # CLI + host daemon
npm run build:sidecar -w @codepapr/ui            # shared agent runtime (sidecar)
```

Without `--server` the CLI auto-spawns `codepapr-server` in stdio mode (lookup:
`CODEPAPR_SERVER_BIN` → next to the CLI binary → `target/{debug,release}` → PATH).

### Usage

```bash
codepapr-cli -C /path/to/workspace run \
  --mode agent \
  -m deepseek-chat -p deepseek --api-key "$DEEPSEEK_API_KEY" \
  --yolo --timeout-ms 300000 \
  --events-jsonl ./run.jsonl --result-json ./out.json \
  "add unit tests for src/util.ts"
```

`chat` is the legacy REPL path (kept, but not a harness interface; `chat --json`
is deprecated and emits only the `{response, user}` subset). Harness flows use `run`.

### Exit codes

| code | meaning |
|---|---|
| 0 | finished normally (exitReason=completed) |
| 1 | agent/runtime error (including an old sidecar lacking harness frames — hard failure, no fallback) |
| 2 | `--timeout-ms` exceeded (started tools still get end/cancel events) |
| 3 | permission not approved (no `--yolo` and no allowlist match) |
| 130 | interrupted by signal |

### Key flags

- `--mode ask|plan|agent`: desktop-parity mode filtering (same core `isPromptToolVisible` /
  `MUTATING / PLAN_ONLY / APP_ONLY` sources). Under `ask`, `write/edit/patch/bash` never
  appear in the tool surface; `git` stays but is execution-gated to
  `GIT_READ_ONLY_ACTIONS` (matching the desktop `FilteringToolRegistry`).
- `--yolo` / `--permission allowlist.json`: unattended permission policy. The allowlist
  is a JSON array of rules (`tool` / `operation` / `pathGlob` / `pathContains`); a rule
  matches only when every field it sets matches. Otherwise deny → exit 3 (secure
  default; only external-path access triggers permission requests, same as the host
  path policy).
- `--question-auto` / `--question-answers answers.json`: plan-mode question policy.
  Default `skip`: the question tool fails fast and a `question.skipped` event is
  recorded — answers are never silently fabricated.
- `--session-id <id>`: multi-turn. Each run persists the canonical conversation to the
  project DB (`<workspace>/.CodePapr`); the next `run` with the same id loads that history
  and seeds the sidecar, so separate CLI invocations continue one conversation (compaction
  included). Omitting the flag keeps runs cold-start and writes nothing to the DB.
- `--events-jsonl` / `--result-json`: machine-readable outputs below.

### Event line protocol (`--events-jsonl`, v1)

One JSON object per line with common fields `{"v":1,"ts":<epoch ms>,"sessionId":"...","type":...}`:

| type | extra fields |
|---|---|
| `run.start` | `mode,model,provider,workspace` |
| `tool.start` | `toolCallId,toolName,arguments` |
| `tool.end` | `toolCallId,toolName,success,errorPreview?,outputPreview?` (truncated to 2048 chars) |
| `message.delta` | `channel:"content"|"reasoning",delta` |
| `message.end` | `round,hasToolCalls,contentChars` |
| `permission` | `operation,toolName?,path,approved` |
| `harness` | `name:"question.answered"|"question.skipped"|"tool.unsupported"|"tool.blocked"|"todo.updated",payload` |
| `error` | `error` |
| `run.end` | `exitReason,exitCode` |

### Result document (`--result-json`)

```json
{
  "v": 1, "sessionId": "...", "mode": "agent", "model": "...", "provider": "...",
  "workspace": "...", "finalText": "...",
  "toolCalls": [{ "name": "read", "ok": true, "ms": 8 }],
  "usage": { "newInputTokens": 0, "cacheReadTokens": 0, "outputTokens": 0 },
  "exitReason": "completed|error|timeout|denied|cancelled"
}
```

### Headless boundary (P0)

These UI-bound capabilities are **explicitly unavailable** in the harness (fail fast +
`tool.unsupported` event, never left to hang on the IPC timeout; also absent from the
tool surface so the model cannot see them): the memory admission panel, app
lifecycle/overlay (`app_render/app_publish/...`), project graph, and the WebView
browser. `todo` (in-memory) and `question` (policy-driven) are the only locally
answered interactive tools.
Concurrency note: `agent/start` reuses the server's single live runtime — one server
supports one active run at a time (until eval / multi-runtime lands, run one server
per concurrent task).

### Smoke verification

```bash
node scripts/harness-smoke.mjs   # drives completed / ask-cannot-write / permission-denied / timeout acceptance via a mock provider
```

## FAQ

### No API key on startup
Check that desktop settings are saved and environment variables are set.

### Tests still show old results after code changes
Rebuild affected packages before retesting. Many packages participate in tests through their dist entry points.

### Agent encounters vite/tsc/eslint errors
First assume dependencies aren't installed or local packages aren't built.
