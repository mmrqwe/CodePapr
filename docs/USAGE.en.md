# User Manual

## Quick Start

### Prerequisites

- Dependencies installed and built (`npm install && npm run build`)
- At least one usable model provider
- Corresponding API key
- A local project directory you intend to analyze or modify

### Three Steps

1. **Configure**: Enter API key, provider, and model in desktop settings.
2. **Choose entry**: Use the desktop workbench.
3. **Choose mode**: Ask (explain/analyze), Plan (decompose strategy), Agent (actually execute), App (generate visualization apps).

## Four Working Modes

| Mode | Best For | Behavior |
|------|------|------|
| **Ask** | Explanation, analysis, suggestions | Read-only; no file modifications or command execution |
| **Plan** | Complex task decomposition | Output a plan with options, execute after confirmation |
| **Agent** | Bug fixes, feature implementation | Autonomous execution: search → modify → verify |
| **App** | Data visualization, interactive apps | Instantly generates interactive HTML apps; supports Papr SDK (`window.papr`) for Agent/storage/HTTP/filesystem |

In Plan mode, when requirements are ambiguous, the Agent will call the `question` tool to ask you instead of guessing.

Ask / Plan are read-only modes: mutating tools (write/edit/patch/bash/git/app_*, etc.) are **blocked at the tool-registration layer** — neither exposed to the model nor executable — preventing accidental file changes by construction, not by prompt alone.

## Papr App Development

Papr is CodePapr's application runtime. AI-generated apps run directly in the desktop client, using the SDK to call CodePapr capabilities.

### .papr Format

An app is two files under `.CodePapr/apps/<appId>/` (once papr.db is used, a `db.sqlite` appears holding app data):

```
.CodePapr/apps/my-app/
├── manifest.json     ← Metadata + permissions + agents
├── index.html        ← Entry HTML
└── db.sqlite         ← papr.db data (created at runtime)
```

manifest.json example:

```json
{
  "spec": "papr/0.1",
  "name": "Todo App",
  "version": "0.1.0",
  "level": 2,
  "permissions": ["storage:read", "storage:write", "agent:run:assistant"],
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

// File I/O (restricted to app data directory)
await papr.fs.writeFile('config.json', JSON.stringify(config));
const files = await papr.fs.list();
```

**`papr.agent.run` round & timeout limits:**

- **Tool rounds**: bounded by the manifest `agents[].maxToolRounds` (defaults to 50 when omitted, and any declared value is capped at 50). Search calls such as websearch/webfetch count toward the total — there is no separate search-round limit.
- **Timeout**: a **300-second idle timeout** (consistent across all three layers: iframe SDK, main thread, Worker). As long as the Agent keeps emitting progress events (streaming output, tool calls) the run continues uninterrupted; only 300s of total silence is treated as a timeout. Multi-round search / long analysis tasks no longer hit a fixed 5-minute ceiling.

### Creating Apps

Switch to **App mode** and describe the app you want in natural language. The Agent calls `app_render` to generate a complete manifest.json and index.html. Same appId updates in place.

### Permissions (two-axis model)

App access is declared by two orthogonal axes in `app_render` (or the manifest):

| Axis | Value | Capability |
|---|---|---|
| `local` | `none` | Pure compute; only `papr.db` / `papr.fs` (app-owned sandbox, always available) |
| `local` | `read` | + read project files (Agent read tools: read/grep/list/lsp/diagnostics, etc.) |
| `local` | `write` | + modify project files and execute commands (Agent write/edit/patch/bash) |
| `network` | `true` | + access the public internet (papr.http + Agent websearch/webfetch + MCP) |
| `network` | `false` | fully offline (enforced by iframe CSP + backend sandbox; JS cannot bypass) |

- `papr.db` / `papr.fs` are app-owned sandbox and always available — no permission needed
- Backend services (`command`) require `local` to be at least `read`
- Recommended combos: calculator `{none, off}`, Todo/notes `{none, off}`, data dashboard `{read, on}`, refactoring tool `{write, off}`
- The legacy `level` field (0-3) still works: 0→`{none,off}`, 1→`{read,off}`, 2→`{read,on}`, 3→`{write,on}`

Agent tool whitelist (declare in `agents[].tools`, must fall within the access profile): `read`, `grep`, `list`, `lsp`, `diagnostics`, `read_image`, `skill_load`, `todo`, `local_time_now` (built-in), `websearch`, `webfetch` (require network), `write`, `edit`, `patch`, `bash` (require local=write).

Settings → **App Tab** adjusts the global default (local access × network) and per-app overrides (overrides can only narrow).

### Application Management Panel

The right panel's **Apps Tab** shows all registered .papr apps:

- **Green dot** = running, **Red dot** = stopped
- Click to select, double-click to open
- Bottom button bar: ▶ Start / Open / ■ Stop / 🗑 Delete
- Backend apps must be "started" before "open"

### App Agent Management Tools

LLM manages apps via 4 tools:

- `app_list` — list all apps
- `app_start <appId>` — start backend
- `app_stop <appId>` — stop backend
- `app_delete <appId>` — full delete

## Configuration

### Configuration Storage Locations

| Level | Path | Purpose |
| --- | --- | --- |
| Application | `~/.codepapr/codepapr.sqlite` | provider, model, API key, sampling parameters, language |
| Project | `<workspace>/.CodePapr` | Project state, session messages, cache stats, rules, Agents, Skills, commands |

### Settings Panel

Six tabs:

- **General**: Language, debug toggle, license
- **LLM**: Primary model, fast model, temperature, topP, maxTokens, thinking mode, maxToolRounds
- **Search**: Self-hosted SearXNG first, with automatic fallback to built-in multi-source aggregation (Bing / Mojeek / Qwant / Wikipedia); category/time/language/safe search parameters are in the collapsible Advanced section; the engine selector has been removed from the UI
- **Mentor**: Mentor sub-agent independent API key, Base URL, model selection
- **Advanced**: Context compaction (model/temperature/summary output tokens/context limit/conversation rounds), TodoList max retries, ProjectGraph limits, streaming & tool output (stream idle timeout default 300s, middle-truncation keep chars default 20000), tool context mode (full/summary/auto, default full). Tool context mode only affects history context: when a tool result is produced, the full output is always sent to the model for the current round (size bounded by the truncation pipeline); once it becomes history it is replaced by a structured summary per mode (success/failure + key info + head/tail preview, with the full output spilled to disk and readable via read). Full mode keeps full text even in history — identical to the legacy behavior. The context limit `maxContextTokens` defaults to 500K; when reached, context is auto-compacted: earlier messages are summarized into a checkpoint and old tool results cleared, while recent rounds (including tool-call↔result pairs) stay verbatim after the checkpoint. This value applies uniformly to DeepSeek, OpenAI-compatible, and Claude providers (no per-provider clamping)
- **App**: .papr app permission management — global default level, Level 3 global toggle, per-app level overrides

Voice configuration is not in the main settings panel — it is configured per character in the CharacterModal Voice Tab.

The toolbar at the top also provides a **Review** button to open the visual Code Review panel.

Full parameter reference: `packages/@codepapr/core/docs/CONFIGURATION.md`.

## Built-in Sub-Agents

| Agent | Purpose | Model | Tools |
|-------|------|------|------|
| **explore** | Read-only code analysis | fast | read, read_image, list, graph, glob, lsp, diagnostics, grep |
| **scout** | Web search + download | fast | websearch, webfetch, browser, read_image |
| **mentor** | Architecture/algorithm guidance | Configurable independent model | None |

The main Agent dispatches sub-agents via the `task` tool. Each sub-agent has an independent Session and only receives the delegated task description, free from history pollution. The main Agent's TodoList instructions encourage it to proactively delegate code analysis to Explore and web search to Scout.

> The Goal autonomous loop's verifier is a standalone no-tools model call configured in Advanced settings (`verifierModelTier`: fast, primary, or mentor). It is not a built-in sub-agent and is never exposed via the `task` tool. Subjective goals (no `exec:` condition) default to the mentor model, silently falling back to the primary model when no mentor is configured.

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

## Project Memory (Auto-Consolidation)

`.CodePapr/memory.md` is cross-session long-term memory, storing user profiles, preferences, project conventions, error patterns with solutions, and architecture decisions.

**Writing**: The Agent auto-appends (using the generic `write` tool) in these scenarios:

1. It discovers project directory structure, tech stack, or build/lint/test commands worth reusing across sessions
2. The same error was encountered twice in the current session
3. A project-specific build/deploy/config convention was discovered
4. The user explicitly asks to remember

Each entry starts with `## YYYY-MM-DD Topic` and is manually editable.

**Loading**: Injected once at session start into the Session Bootstrap (`log[0]`, `isPrefixSystem`). The bootstrap is frozen per (session × stable signature), stays byte-stable within the session, and is cached as part of the prefix (folded into Claude's ephemeral system block; the message prefix for DeepSeek/OpenAI). On-disk `memory.md` edits do not trigger an in-session rebuild; they take effect on the next session.

**Cold-start auto-generation**: If `memory.md` is missing or empty at session start and a ProjectGraph cache is available, the fast model auto-generates an initial memory (project structure / tech stack / build commands / key conventions) in the background. It does not block the current session; benefits apply on the next session.

**Auto-consolidation**: Prevents unbounded file growth via three triggers:

| Trigger | Timing |
|---|---|
| T1 | Session start — memory.md > 200 lines |
| T2 | Context compaction succeeds (auto or `/compact`) |
| T3 | After each agent reply completes → if pending flag is set → async consolidation |

Consolidation uses the fast model to deduplicate, merge, and compress memory, writing back to file. On failure, it degrades to rule-based dedup (by title + keep latest by date). Consolidation is fire-and-forget; the current session uses old memory, benefits apply on next startup.

## Code Intelligence (lsp / list)

LLM-facing code intelligence is provided by the `lsp` tool and `list` (directory tree + per-file lightweight symbols).

**lsp navigation (9 actions, LSP-first with AST project-graph fallback, results tagged with source/confidence)**: `goToDefinition` (jump to definition), `findReferences` (find references), `hover` (type/documentation info), `documentSymbol` (file symbol outline), `workspaceSymbol` (workspace symbol search), `goToImplementation` (jump to implementation), `prepareCallHierarchy` (call hierarchy item), `incomingCalls` (incoming calls), `outgoingCalls` (outgoing calls). When LSP is unavailable or returns nothing, it automatically degrades to the AST project graph; results are tagged with `source` (lsp/ast) and `confidence` (high/medium/low).

**Project structure**: `list` browses the directory tree and automatically attaches lightweight per-file symbols (top-level symbols per code file, AST-based, no LSP needed).

> The `graph` tool (full / lookup / dependency / impact / implementations / entrypoints / smart_context / dead_code / circular_deps / type_hierarchy / suggest_refactors / test_impact / generate_tests — 14 actions) is **soft-hidden from the main Agent's LLM** — the main Agent uses `list` + `lsp` for structure and navigation, and delegates cross-module dependency/impact analysis to Explore. `graph` is still provided to the Explore sub-agent via allowlist, and serves UI panels and the AST fallback backend for `lsp` point queries.

## Project-Level Customization

### Project Rules

Reads `.CodePapr/AGENTS.md`. Content is injected into the system prompt. Suitable for: project conventions, directory structure, off-limits scope, verification criteria.

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

`mode` values: `subagent` (default, delegable via the `task` tool), `all` (delegable + usable as an @-mentioned primary agent), `primary` (only as an @-mentioned primary agent; **excluded** from the `task` tool's delegation list). `model` accepts `fast` / `mentor` or a concrete model name; when `mentor` has no dedicated API Key configured, it falls back to the main API Key.

### Skills

Skills are reusable playbooks for the main Agent, placed under `.CodePapr/skills/` in two layouts:

- Nested: `.CodePapr/skills/<name>/SKILL.md`
- Flat: `.CodePapr/skills/<name>.md`

They do not create sub-agents at runtime; instead they serve as project-level context the model can choose from. Only name + description are injected into stable context; full content is loaded on demand via the `skill` tool (max 500KB). Default includes a `search` Skill (search strategy). Enable/disable state is saved in `.CodePapr/project.sqlite`.

**Skill Marketplace**: The desktop app includes a built-in skill marketplace that pulls listings from GitHub (`zerone-agent/agent-use-skills`), supporting one-click install into the project. Installed skills are tracked in `skills-lock.json` (with SHA-256 checksums).

### Custom Chat Commands

Declare templates in `.CodePapr/commands/<name>.md`, supporting `$ARGUMENTS`, `@path`, `` !`cmd` ``.

Type `/` to open the command palette.

**Primary model built-in commands:** `/review` `/fix` `/test` `/explain` `/diagnose` `/refactor` `/doc` `/new` `/optimize`

**Fast model built-in commands:** `/search` `/lint` `/clean` `/commit` `/summary` `/build`

**Local commands (zero tokens):** `/help` `/commands` `/compact`

Custom commands can declare `model: fast` in frontmatter for fast model routing:

```markdown
---
description: Quick TODO search
model: fast
---
Search the codebase for all TODO and FIXME markers: $ARGUMENTS
```

## External Path Permissions

The desktop app requires explicit authorization for reading/listing absolute paths outside the project:

- When Agent invokes `read` / `list` with an absolute path outside the workspace, a **PermissionDialog** appears
- Options: **Deny**, **Allow this file**, **Allow this folder**
- Authorizations are added to an allowlist; subsequent accesses to the same path don't re-prompt
- Write, edit, and command execution are still restricted to the workspace regardless

The CLI has looser read path boundaries (can read any absolute path), but writes remain workspace-scoped.

## macOS Command Sandbox

On macOS the `bash` tool, shell sessions, and app backend processes run inside a `sandbox-exec` sandbox:

- **Readable**: system dirs (/bin, /usr, /System, /Library, etc.), /opt/homebrew (Homebrew tools), PATH directories, the workspace, and authorized external paths
- **Writable**: the workspace, the temp directory, tool cache dirs (~/.npm, ~/.cache, ~/.cargo, ~/.local, ~/.nvm, ~/.volta), and authorized external paths
- **Always denied** (even in YOLO mode): ~/.ssh, ~/.gnupg, ~/.config, ~/.aws, ~/.azure, ~/.kube, ~/.git, ~/.CodePapr
- Common HOME tool configs (.gitconfig, .npmrc, etc.) are allowed read-only by default; other HOME files require external authorization when needed

## Toast Notifications

The desktop uses non-blocking Toast notifications instead of traditional alerts:

- Four types: `info` / `success` / `warning` / `error`
- Default 4.5s auto-dismiss; `error` type defaults to 8s
- Max 5 simultaneous; oldest discarded when overflowing
- Currently used in file attachment drag-and-drop and other scenarios

## Character Roleplay

Create, import, and activate AI personas so the Agent speaks to you with a specific character's identity.

**Creating a character:** Click the character button in the toolbar → "New Character", fill in:
- **Basic info**: Name, avatar (upload image)
- **Persona fields**: Description (appearance/background), Personality (speaking style/traits), Scenario (initial context), First Message
- **Example dialog**: Separate dialog groups with `<START>` to define speaking style
- **Advanced**: System prompt (additional instructions), Tags, Creator, Version

**Importing character cards:** Supports PNG character cards (SillyTavern / CCv3 spec) and JSON file import. JSON data in PNGs is embedded as tEXt/iTXt chunks; the avatar is imported as well.

**Exporting character cards:** Export characters as PNG cards for cross-tool use.

**Activating a character:** Click the character name in the character list to activate. The character's profile is injected into the LLM system prompt, and the Agent responds with the character's identity, tone, and style. The character profile is in the Session Bootstrap, so switching characters does not break DeepSeek caching.

**Roleplay format convention:**
- `*Asterisk-wrapped text*` → Actions/narration/scene description (not spoken by TTS)
- Plain text → Character dialogue (spoken by TTS)
- `**Bold text**` → Emphasis/stress (spoken with extra stress)
- `(Parenthetical)` → Tone indicators like `(whispering)` or `（轻声）` (not spoken)

## Text-to-Speech (TTS)

The voice system is powered by GPT-SoVITS for local voice cloning, enabling characters to read dialogue aloud.

**Installing GPT-SoVITS:** Click the TTS speaker button in ChatPanel for the first time — if not installed, the installer wizard appears automatically. Or trigger installation from the Voice Tab in the character editor. The installer runs: Python check → clone GPT-SoVITS repo → pip install → download pretrained models (~2GB, using hf-mirror source) → verify. Requires Python 3.10+ installed.

**Configuring voice for a character:**
1. Open the character editor (toolbar character avatar button) → Voice Tab → enable "Voice Output"
2. Upload reference audio (3-10s, 5s recommended, clean voice, WAV/MP3/M4A/AAC, 16kHz+)
3. Enter reference text (the exact words spoken in the audio)
4. Select reference audio language and speech language
5. Adjust speed (50%-200%), synthesis speed (4=fastest / 8=balanced / 16=highest quality), sentence chunking (1-5)
6. Click "Test" to preview

**Playback mode:** The current UI uses WebSocket batch streaming (`ws-batch`) as the default and only active mode, with ~1-2s latency to first word. Other modes are retained in the codebase but not yet exposed in the settings UI.

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
Switch to App mode to let the Agent explore data and generate an interactive HTML app — perfect for database analysis, relationship diagrams, dashboards, and more.

### 4. Conversation Reset Rollback
If the Agent goes off track, hover the previous correct user message and click "Reset to here" to continue from that state.

## Data Locations

| Path | Purpose |
| --- | --- |
| `~/.codepapr/codepapr.sqlite` | Application-level settings |
| `<workspace>/.CodePapr/project.sqlite` | Project-level state, chat history, cache stats |
| `<workspace>/.CodePapr/memory.md` | Cross-session project memory (auto-consolidated) |
| `<workspace>/.CodePapr/store` | Project-level text records |
| `<workspace>/.CodePapr/skills` | Project-level skill files |
| `<workspace>/.CodePapr/agents` | Project-level custom sub-agents |
| `<workspace>/.CodePapr/commands` | Project-level custom commands |
| `<workspace>/.CodePapr/apps` | Papr app directory (one subdirectory per app) |
| `~/.codepapr/voices` | Character reference audio files |
| `~/.codepapr/gpt-sovits` | GPT-SoVITS installation and models |

## FAQ

### No API key on startup
Check that desktop settings are saved and environment variables are set.

### Tests still show old results after code changes
Rebuild affected packages before retesting. Many packages participate in tests through their dist entry points.

### Agent encounters vite/tsc/eslint errors
First assume dependencies aren't installed or local packages aren't built.
