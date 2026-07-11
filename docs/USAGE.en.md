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
3. **Choose mode**: Ask (explain/analyze), Plan (decompose strategy), Agent (actually execute).

## Three Working Modes

| Mode | Best For | Behavior |
|------|------|------|
| **Ask** | Explanation, analysis, suggestions | Read-only; no file modifications or command execution |
| **Plan** | Complex task decomposition | Output a plan with options, execute after confirmation |
| **Agent** | Bug fixes, feature implementation | Autonomous execution: search → modify → verify |

In Plan mode, when requirements are ambiguous, the Agent will call the `question` tool to ask you instead of guessing.

## Configuration

### Configuration Storage Locations

| Level | Path | Purpose |
| --- | --- | --- |
| Application | `~/.codepapr/codepapr.sqlite` | provider, model, API key, sampling parameters, language |
| Project | `<workspace>/.CodePapr` | Project state, session messages, cache stats, rules, Agents, Skills, commands |

### Settings Panel

Five tabs:

- **General**: Language, debug toggle, license
- **LLM**: Primary model, fast model, temperature, topP, maxTokens, thinking mode, maxToolRounds
- **Search**: Self-hosted SearXNG first, with automatic fallback to built-in multi-source aggregation (Bing / Mojeek / Qwant / Wikipedia); category/time/language/safe search parameters are in the collapsible Advanced section; the engine selector has been removed from the UI
- **Mentor**: Mentor sub-agent independent API key, Base URL, model selection
- **Advanced**: Context compaction (model/temperature/tokens/context limit/conversation rounds), TodoList max retries, ProjectGraph limits

Voice configuration is not in the main settings panel — it is configured per character in the CharacterModal Voice Tab.

The toolbar at the top also provides a **Review** button to open the visual Code Review panel.

Full parameter reference: `packages/@codepapr/core/docs/CONFIGURATION.md`.

## Built-in Sub-Agents

| Agent | Purpose | Model | Tools |
|-------|------|------|------|
| **explore** | Read-only code analysis | fast | read, graph, lsp, diagnostics, time |
| **scout** | Web search + download | fast | web_search, web_fetch, web_download, browser, open, time |
| **mentor** | Architecture/algorithm guidance | Configurable independent model | None |
| **verifier** | Goal evaluator (internal) | fast | None |

> `verifier` is an internal evaluator for the Goal autonomous loop, not exposed to the main Agent's `task` tool.
The main Agent dispatches sub-agents via the `task` tool. Each sub-agent has an independent Session and only receives the delegated task description, free from history pollution. The main Agent's TodoList instructions encourage it to proactively delegate code analysis to Explore and web search to Scout.

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

- **Reset to here**: Rolls back all conversation and code changes after that message. Uses Git auto-commit checkpoint + `git reset --hard` for atomic file restoration. Non-Git repos automatically degrade to per-file undo.
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

**Writing**: The Agent auto-appends (using the generic `write` tool) in three cases:

1. The same error was encountered twice in the current session
2. A project-specific build/deploy/config convention was discovered
3. The user explicitly asks to remember

Each entry starts with `## YYYY-MM-DD Topic` and is manually editable.

**Loading**: Injected into the bootstrap context on each session start (does not enter system prompt cache).

**Auto-consolidation**: Prevents unbounded file growth via three triggers:

| Trigger | Timing |
|---|---|
| T1 | Session start — memory.md > 200 lines |
| T2 | Context compaction succeeds (auto or `/compact`) |
| T3 | After each agent reply completes → if pending flag is set → async consolidation |

Consolidation uses the fast model to deduplicate, merge, and compress memory, writing back to file. On failure, it degrades to rule-based dedup (by title + keep latest by date). Consolidation is fire-and-forget; the current session uses old memory, benefits apply on next startup.

## ProjectGraph Semantic Analysis

`graph` is the unified project semantic graph tool, callable by both the main Agent and Explore sub-agent.

**Basic navigation**: `full` (complete graph), `overview` (lightweight overview), `lookup` (symbol find), `dependency` (subgraph), `entrypoints` (entry points), `impact` (impact analysis), `implementations` (impl find), `smart_context` (intelligent context)

**Advanced analysis**: `dead_code` (dead code detection), `circular_deps` (circular deps), `type_hierarchy` (type hierarchy), `suggest_refactors` (refactoring suggestions), `test_impact` (change-impact tests), `generate_tests` (test skeleton generation)

## Project-Level Customization

### Project Rules

Read in priority order: `.CodePapr/AGENTS.md` → `.CodePapr/rules.md`. Content is injected into the system prompt. Suitable for: project conventions, directory structure, off-limits scope, verification criteria.

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

### Skills

Skills are reusable playbooks for the main Agent, placed in `.CodePapr/skills/**/SKILL.md`:

- Do not create sub-agents at runtime; instead serve as project-level context the model can choose from
- Default includes a `search` Skill (search strategy)
- Enable/disable state is saved in `.CodePapr/project.sqlite`

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

### 3. Conversation Reset Rollback
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
| `~/.codepapr/voices` | Character reference audio files |
| `~/.codepapr/gpt-sovits` | GPT-SoVITS installation and models |

## FAQ

### No API key on startup
Check that desktop settings are saved and environment variables are set.

### Tests still show old results after code changes
Rebuild affected packages before retesting. Many packages participate in tests through their dist entry points.

### Agent encounters vite/tsc/eslint errors
First assume dependencies aren't installed or local packages aren't built.
