# CodePapr System Design

> This revision is rewritten around the **host / client split**. Every claim below was checked against the tree at `c4597827c403e59d6ff0ae52f897a70f9feca685`.
> TypeScript-side topics — context layering, memory, cache partitions, TodoList, sub-agents — live in `docs/adr/ADR-001` … `ADR-016`, `docs/web/context-architecture.en.html`, and `docs/USAGE.en.md`.

## 1. Positioning

CodePapr is a local-first coding agent runtime. It is **not** a monolithic Tauri app:

- domain capabilities (filesystem, Git, shell, LSP, symbols, SQLite, snapshots, MCP, web, agent runtime) are implemented in the library crate `codepapr-core`;
- the only process that serves them is `codepapr-server`;
- the desktop (Tauri) app and the CLI are both **JSON-RPC clients**.

Rationale and trade-offs: [ADR-012](./adr/ADR-012-host-client-split.md).

## 2. Process topology

```
  ┌──────────────────────────┐        ┌──────────────────────────┐
  │  Desktop  bin: codepapr  │        │  CLI  bin: codepapr-cli  │
  │  WebView: React + Monaco │        │  ping/doctor/status/git/ │
  │  @codepapr/core agent    │        │  fs/shell/lsp/server/chat│
  │  src-tauri/src/host.rs   │        └────────────┬─────────────┘
  └────────────┬─────────────┘                     │
               │   JSON-RPC 2.0 (line-delimited)   │
               │   TCP 127.0.0.1   or   stdio      │
               └──────────────┬────────────────────┘
                              ▼
         ┌────────────────────────────────────────┐
         │  codepapr-server  (host)                │
         │  main.rs   : --port / --port-file /     │
         │              stdio                      │
         │  handler.rs: initialize + ping + 159    │
         │  tasks.rs  : serial task queue          │
         └──────────────────┬─────────────────────┘
                            ▼
         ┌────────────────────────────────────────┐
         │  codepapr-core  (domain library)        │
         │  workspace_fs  git_operations  shell    │
         │  lsp / lsp_fallback / symbol_provider   │
         │  db (SQLite)  snapshot  mcp_host  web   │
         │  agent_runtime → Node agent-runtime.mjs│
         └────────────────────────────────────────┘
```

Four kinds of executables are involved at runtime: clients (`codepapr` / `codepapr-cli`), the host (`codepapr-server`), the Node agent sidecar (`agent-runtime.mjs`, launched by **the host**), and the child processes the host manages (LSP servers, shells, MCP stdio servers).

## 3. Packages and crates

### 3.1 Cargo workspace (root `Cargo.toml`)

| Member | bin | Responsibility |
|---|---|---|
| `crates/codepapr-core` | — (lib) | Domain implementation; no Tauri dependency, testable on its own |
| `crates/codepapr-server` | `codepapr-server` | RPC routing, transport, event broadcast, task queue |
| `crates/codepapr-cli` | `codepapr-cli` | CLI client (clap `name = "codepapr"`) |
| `packages/@codepapr/ui/src-tauri` | `codepapr` | Desktop client; GUI-only capabilities plus RPC proxies |

### 3.2 npm workspace

| Package | Responsibility |
|---|---|
| `@codepapr/types` | Shared types |
| `@codepapr/common` | Logging and common utilities |
| `@codepapr/core` | Agent / Session / cache partitions / ToolRegistry / BUILTIN_AGENTS / TodoList |
| `@codepapr/api` | Provider (DeepSeek / OpenAI / Claude) abstraction and request building |
| `@codepapr/editor` | Editor types and helpers |
| `@codepapr/ui` | Tauri desktop (React + Monaco), contains `src-tauri` |

Note the agent loop, prompt assembly, and cache partitioning are on the **TypeScript side** (`@codepapr/core`); every side effect they need (reading files, running commands, resolving symbols) is performed by the host.

## 4. Host protocol

### 4.1 Transport

Line-delimited JSON-RPC 2.0, one JSON object per line. `codepapr-server` has two shapes:

- `--port <N>` → TCP; `--port 0` lets the kernel pick, `--port-file <path>` writes the bound port to disk;
- no `--port` → stdio (the shape the CLI auto-spawns).

`--workspace <path>` supplies a default workspace. When a request omits `workspacePath` the host falls back to it; if neither exists the error is `workspacePath is required in params or via --workspace flag`.

### 4.2 Startup (`src-tauri/src/host.rs`)

```
host::start(app)
  ├─ CODEPAPR_SERVER_URL set → connect_tcp(addr, child=None)
  └─ otherwise spawn_and_connect()
        ├─ find_server_binary()
        │    CODEPAPR_SERVER_BIN
        │  → next to current_exe
        │  → resourceDir/ , resourceDir/bin/ , resourceDir/_up_/
        │  → target/{debug,release}
        │  → ../../../../target/{debug,release}
        │  → PATH
        ├─ spawn: --port 0 --port-file <temp>/codepapr-server-<pid>.port
        │        stdin=null, stdout=null, stderr=piped; CREATE_NO_WINDOW on Windows
        ├─ wait_for_bound_port(): 15 s deadline, 40 ms poll
        │        source A = port-file contents
        │        source B = stderr line "[codepapr-server] listening on <addr>"
        └─ connect_tcp("127.0.0.1:<port>", child=Some)
  └─ invoke("initialize") → stored in Tauri state + a GLOBAL OnceLock
```

No port in time gives `Timed out waiting for codepapr-server to bind a TCP port`; no binary gives `Could not locate 'codepapr-server' binary. Build it with 'cargo build -p codepapr-server' or set CODEPAPR_SERVER_BIN.`

`initialize` returns `serverInfo` (name / version), `capabilities` (fs, git, shell, lsp, agent, db, snapshot, mcp, web) and the default `workspace`. `ping` returns `"pong"`.

The CLI (`crates/codepapr-cli/src/rpc_client.rs`) mirrors this: `--server` → TCP, `CODEPAPR_SERVER_URL` → TCP, otherwise spawn a stdio daemon.

### 4.3 Requests and responses

The client allocates an `id` (`AtomicU64`, starting at 1), parks a `oneshot::Sender` in a `pending` map, and writes one JSON line. A single reader task dispatches each incoming line:

- with an `id` → take the sender out of `pending`; an `error` becomes `RPC error [<code>]: <message>`, otherwise `result` is returned;
- without an `id` (or `id: null`) → treated as a notification.

When the connection drops, every pending request fails with `codepapr-server closed the connection`. **There is currently no automatic reconnect.**

### 4.4 Events

Events produced through `codepapr_core::events::EventSink` on the host travel back as JSON-RPC notifications:

```json
{ "jsonrpc": "2.0", "method": "event", "params": { "event": "<name>", "payload": <value> } }
```

`dispatch_incoming_line` pulls out `event` / `payload` and calls `app.emit(event, payload)` — **the event name is unchanged**, so frontend listeners look exactly as they did before the split. Event names currently in tree:

| Event | Source |
|---|---|
| `workspace-files-changed` | `workspace_fs::watcher` (150 ms debounce poll) |
| `project-stats-progress` | `workspace_fs::stats` |
| `codepapr://lsp-managed-status` | `lsp` (managed install / startup progress) |
| `agent-runtime://frame` | `agent_runtime` / `agent_runtime_tools` (stream frames) |
| `agent-runtime://exit` | `agent_runtime` (sidecar exit) |
| `agent-runtime://permission-request` | `agent_runtime_tools` |
| `agent-runtime://permission-cancel` | `agent_runtime_tools` |
| `agent-runtime://workspace-mutated` | `agent_runtime_tools` (files a tool wrote) |
| `mcp-confirm-request` | `mcp_host` (mutating-tool confirmation) |

### 4.5 Shutdown

`HostHandle::shutdown()` runs in a fixed order:

1. `lsp/stopAll`
2. `agent/stopAll`
3. `fs/stopWatcher`
4. `shell/stopAllBackground { source: "host-exit" }`
5. `mcp/disconnectAll`
6. `child.kill()` + `child.wait()` (only for a child it spawned itself)

`Drop` calls `kill()` once more as a backstop. When attached to an external host (`CODEPAPR_SERVER_URL`) `child` is `None`, so the session is cleaned up but the process is left alone.

Before that, the desktop waits for settings to flush: it emits `codepapr:flush-settings` to the UI and polls `db/settingsSaveState` (500 ms probe window, 2000 ms flush budget) before `app.exit(0)`. On `RunEvent::Exit` it calls `enter_fast_child_reap()` and then the shutdown sequence above plus TTS / browser / power-lock cleanup.

## 5. Responsibility matrix

| Layer | Location | Owns | Does not own |
|---|---|---|---|
| **UI (React)** | `packages/@codepapr/ui/src` | Interaction, panels, store orchestration, driving the agent loop, prompt assembly | Any direct file / process / database access |
| **Tauri client** | `src-tauri/src` | `host.rs` RPC client; `commands.rs` proxies; GUI-only: `codepapr-app://` protocol, embedded/headless browser, TTS, vault/secrets, `file_export`, `asset_scope`, `character_card`, `power`, app install and port probing | Filesystem, Git, shell, LSP, MCP, snapshots, web, the main SQLite databases |
| **codepapr-server** | `crates/codepapr-server` | Method routing, parameter validation, event broadcast, in-memory secrets, serial task queue | Domain implementation (all delegated to core) |
| **codepapr-core** | `crates/codepapr-core` | Every domain implementation and the lifecycle of its child processes | UI, protocol layer |

Two deliberate exceptions (the desktop crate has a direct path dependency on `codepapr-core`, so it can bypass RPC):

1. **Papr App storage**: `papr_runtime/app_storage.rs` calls `codepapr_core::db::papr_storage_get/set/delete/keys` and `papr_inbox_append` in process, after `check_permission`. (The host also exposes `db/paprStorage*` for CLI / agent callers.)
2. **Secrets**: plaintext lives only in the client-side Stronghold vault + keyring; `host::import_vault_secrets` pushes `api_key` / `mentor_api_key` one-way into the host `InMemorySecretStorage` through `secrets/import`. The host never persists secrets.

## 6. RPC surface

`crates/codepapr-server/src/handler.rs` routes `initialize`, `ping`, and 159 namespaced methods; anything else returns `Unknown JSON-RPC method: <name>`.

| Namespace | Methods | Backed by | Representative methods |
|---|---|---|---|
| `fs/*` | 23 | `workspace_fs` | `readTextFile` `writeTextFile` `listFiles` `search` `searchPaths` `startWatcher` `stopWatcher` `computeProjectStats` `grantExternalAccess` |
| `git/*` | 8 | `git_operations` | `status` `diff` `log` `stage` `commit` `branchList` `branchCheckout` `restoreFiles` |
| `shell/*` | 17 | `shell` | `execute` `executeShell` `startBackground` `stopAllBackground` `openSession` `sendCommand` `readOutput` `listSessions` |
| `lsp/*` | 12 | `lsp` / `lsp_managed_tools` | `startServer` `request` `openDocument` `diagnostics` `batchSymbols` `queryAvailability` `stopAll` |
| `symbols/*` | 8 | `symbol_provider` / `lsp_fallback` | `definition` `references` `hover` `resolve` `extractFileSymbols` `checkSyntax` |
| `db/*` | 45 | `db` | `loadSettings` `saveSettings` `settingsSaveState` `saveMessageBatch` `loadSessions` `saveProjectState` `saveProjectgraphCache` `paprStorage*` |
| `snapshot/*` | 11 | `snapshot` | `ensure` `create` `list` `diff` `changedFiles` `restorePlan` `restoreExecute` `restoreUndo` |
| `mcp/*` | 10 | `mcp_host` / `mcp_sse` | `listTools` `callTool` `listStatus` `updateSettings` `confirmResponse` `disconnectAll` |
| `agent/*` | 5 | `agent_runtime` | `start` `send` `stop` `stopAll` `respondPermission` |
| `web/*` | 3 | `web` | `search` `fetchUrl` `downloadFile` |
| `task/*` | 2 | `codepapr-server/src/tasks.rs` | `enqueue` `poll` |
| `secrets/import` | 1 | `handler.rs` | Populate in-memory secrets |

Parameter conventions: camelCase; `workspacePath` may be omitted (falls back to `--workspace`); file paths accept either `path` or `relativePath`.

## 7. Data flow

### 7.1 One tool call

```
React component / agent loop
   │  invoke("read_text_file", { workspacePath, path })
   ▼
src-tauri/src/commands.rs   #[tauri::command]
   │  host::call(app, "fs/readTextFile", params)
   ▼
host.rs → {"jsonrpc":"2.0","id":N,"method":"fs/readTextFile",...}\n
   ▼  TCP 127.0.0.1
codepapr-server  handler.rs → validate params →
   ▼
codepapr_core::workspace_fs::read::read_text_file(...)
   ▼  back as {"jsonrpc":"2.0","id":N,"result":...}
host.rs → pending[N].send(Ok(result)) → Tauri command returns → UI
```

### 7.2 One event

```
codepapr_core::workspace_fs::watcher
   │  sink.emit("workspace-files-changed", {})
   ▼
codepapr-server wraps it as a notification
   │  {"jsonrpc":"2.0","method":"event",
   │   "params":{"event":"workspace-files-changed","payload":{}}}\n
   ▼
host.rs dispatch_incoming_line → app.emit("workspace-files-changed", {})
   ▼
React listen("workspace-files-changed", ...)
```

Agent streaming uses the same channel: `agent/start` returns a `runtimeId`, and every subsequent frame is an `agent-runtime://frame` event. The desktop passes `resourceDir` in `agent/start` so the host can locate and launch `agent-runtime.mjs`.

## 8. Persistence and SQLite ownership

Every SQLite database is opened by `codepapr-core::db`, i.e. **written by the host process** (app storage is the exception, see §5). Three locations:

| Database | Path | Contents |
|---|---|---|
| App DB | `~/.codepapr/codepapr.sqlite` | Global UI settings, provider / model / sampling parameters, characters, recent workspaces |
| Project DB | `<workspace>/.CodePapr/project.sqlite` | Sessions and messages, project state, checkpoints, context surfaces, ProjectGraph cache |
| Project Memory | `<workspace>/.CodePapr/MEMORY.md` | Cross-session project memory (maintained by the memory curator; injected into Session Bootstrap every turn) |
| Papr App DB | `<appDir>/db.sqlite` | Key-value storage and inbox for a single .papr app |

Directory constants (`crates/codepapr-core/src/db/mod.rs`): `APP_DATA_DIR = ".codepapr"`, `APP_DB_FILE = "codepapr.sqlite"`, `PROJECT_STORAGE_DIR = ".CodePapr"`, `PROJECT_DB_FILE = "project.sqlite"`, `PAPR_APP_DB_FILE = "db.sqlite"`.

Legacy `state.json` / `project.json` are imported into SQLite on first open or save; the legacy memory ledger is exported into a `.CodePapr/MEMORY.md` seed (`confirmed + active` entries, skipped if the file exists) and retired by the v9 migration ([ADR-016](./adr/ADR-016-memory-v5-memory-md.md)).

Settings flushing at exit is not a blind sleep — it polls the request / epoch counters returned by `db/settingsSaveState` (see §4.5).

## 9. Subsystem ownership

| Subsystem | Process | Notes |
|---|---|---|
| Filesystem / watcher | Host | `fs/startWatcher` starts it; debounced changes emit `workspace-files-changed`. External-path access grants (grant / revoke / yolo) are host-side too |
| Shell | Host | Foreground execution, background jobs, and interactive sessions all live in `codepapr-core::shell`; sandbox options travel in a `sandbox` field |
| LSP | Host | `codepapr-core::lsp` starts one stdio server per language family and reuses it within a workspace; managed-install progress rides `codepapr://lsp-managed-status`; when unavailable it degrades to `lsp_fallback` / `symbol_provider` (tree-sitter) |
| MCP | Host | `mcp_host` manages stdio / SSE / Streamable HTTP connections; mutating tools emit `mcp-confirm-request` and are answered with `mcp/confirmResponse` |
| Agent runtime | Host | `agent_runtime` launches the Node `agent-runtime.mjs`; tools are implemented in `agent_runtime_tools` / `agent_runtime_lsp`; permission prompts surface as events and are answered with `agent/respondPermission` |
| Snapshot / rollback | Host | `snapshot` provides shadow-git snapshots, diffs, and restore plan / execute / undo |
| Web | Host | `web` provides multi-engine search aggregation, page fetch, and download |
| Task queue | Host | `task/enqueue` + `task/poll`, serial execution of long jobs |
| Browser (headless / embedded) | Client | `browser/` (headless_chrome) and `embedded_browser/` (multi-WebView; WKWebView screenshots on macOS) |
| TTS | Client | `tts/`: GPT-SoVITS server child process, rodio playback, WebSocket batch synthesis, installer, fine-tuning |
| Secrets | Client | `vault.rs` / `secrets.rs` (Stronghold + keyring), imported one-way into the host |
| Papr App runtime | Client | `app_runtime*.rs` + `papr_runtime/`, see §10 |

## 10. Papr App marketplace and runtime

Full decision: [ADR-013](./adr/ADR-013-app-install-scope.md).

### 10.1 Registry and installation

- Official registry: `https://raw.githubusercontent.com/mmrqwe/codepapr-apps/main/registry.json` (`src/tools/marketAppApi.ts`);
- the frontend `src/tools/marketAppInstall.ts` downloads files one by one and calls the Tauri command `papr_install_app_files` to write them (`src-tauri/src/app_market_install.rs`);
- scope type `AppInstallScope = 'global' | 'workspace'` (`src/utils/marketAppTypes.ts`).

### 10.2 Locations and precedence

| Scope | Directory |
|---|---|
| `global` | `~/.codepapr/apps/<appId>/` |
| `workspace` | `<workspace>/.CodePapr/apps/<appId>/` |

`scan_workspace_apps` (`app_runtime_pt3.rs`) scans global into a map first, then lets the workspace scan **override the same `appId`**, and finally sorts by `appId`; each entry carries a `scope` field. Runtime resolution via `codepapr_core::db::resolve_app_dir` uses the same precedence (workspace manifest → global manifest → fallback path), so frontend, backend, and storage always agree on one directory.

A directory counts as an app only when its name passes `is_valid_app_id`, `manifest.json` parses, and the entry file (`manifest.entry`, default `index.html`) exists.

### 10.3 The `codepapr-app://` protocol

- One origin per app: `codepapr-app://<appId>/<file>` (the legacy form `codepapr-app://localhost/<appId>/<file>` still resolves);
- `__papr_sdk.js` is a reserved path serving the injected Papr SDK (`src-tauri/resources/papr-sdk.js`);
- `is_unservable_app_file` blocks `db.sqlite`, `db.sqlite-wal`, `db.sqlite-shm` and any `.sqlite` (case-insensitive, including nested paths);
- snapshot / export (`papr_snapshot_app` / `papr_export_app`) skip `node_modules`, `.versions`, `data`, and `db.sqlite*`.

### 10.4 Permissions and CSP

Two axes: local access (`PaprLocalAccess`) × network (`bool`), as a global default plus per-app overrides (`papr_get_app_settings` / `papr_set_app_settings`, persisted through `db/paprLoadPermissionSettings` / `db/paprSavePermissionSettings`). The manifest `permissions` array declares fine-grained strings (`storage:read`, `storage:write`, `http:get`, `fs:read`, `fs:write`, `agent:run:<agent>`) enforced by `permission::check_permission` at each command entry point.

`build_app_csp` (`app_runtime_pt3.rs`) derives the document CSP from those axes:

- network **off**: `connect-src 'self'` (plus the app own backend `http://localhost:<port>` / `http://127.0.0.1:<port>`), `form-action 'none'`, `img-src 'self' data: blob:`, and `script-src` does **not** allow `https:`;
- network **on**: adds `https: http: wss: ws:` to connect, `https:` to img, form-action, and script-src (CDN chart libraries);
- always: `default-src 'none'`, `worker-src 'self' blob:`, `frame-src 'self' blob:` (for `<a download>` and hidden download iframes).

### 10.5 Backed apps

A manifest may declare `command` / `args` / `port`. `app_runtime_pt2.rs` probes the port (`port_has_listener`, `check_port_available_detail`), finds the owning PID with `lsof` / `netstat`, and verifies the bind address is loopback; when the declared port is taken, `allocate_app_port` picks another.

## 11. Key source locations

### 11.1 Host and domain layer (Rust)

- `crates/codepapr-server/src/main.rs` — CLI args, TCP and stdio serve loops, port file, `listening on` log
- `crates/codepapr-server/src/handler.rs` — RPC routing and parameter validation (`require_workspace` / `require_path` / `opt_*`)
- `crates/codepapr-server/src/tasks.rs` — serial task queue
- `crates/codepapr-core/src/lib.rs` — module exports and `version()`
- `crates/codepapr-core/src/events.rs` — `EventSink` / `FnEventSink` / `NoopEventSink`
- `crates/codepapr-core/src/workspace_fs/` — read/write, search, watcher (`watcher.rs`), project stats (`stats.rs`)
- `crates/codepapr-core/src/git_operations/` — git2 wrappers
- `crates/codepapr-core/src/shell/` — foreground/background/sessions and `sandbox`
- `crates/codepapr-core/src/lsp.rs`, `lsp_managed_tools.rs`, `lsp_fallback.rs` — LSP management, managed installs, built-in degradation
- `crates/codepapr-core/src/symbol_provider.rs` — tree-sitter symbols and project graph
- `crates/codepapr-core/src/db/mod.rs` — the three SQLite locations, `global_apps_dir()`, `resolve_app_dir()`
- `crates/codepapr-core/src/snapshot/` — shadow-git snapshots and rollback
- `crates/codepapr-core/src/mcp_host.rs`, `mcp_sse.rs` — MCP client and confirmation flow
- `crates/codepapr-core/src/web/` — search aggregation, fetch, download
- `crates/codepapr-core/src/agent_runtime.rs`, `agent_runtime_tools.rs`, `agent_runtime_lsp.rs` — Node sidecar and tool implementations
- `crates/codepapr-cli/src/main.rs`, `rpc_client.rs`, `commands/` — CLI entry and subcommands

### 11.2 Desktop client (Rust)

- `packages/@codepapr/ui/src-tauri/src/host.rs` — JSON-RPC client, sidecar spawn, event forwarding, `shutdown()`
- `.../src/main.rs` — Tauri builder, protocol registration, command registry, exit cleanup
- `.../src/commands.rs` — Tauri commands (mostly `host::call` proxies)
- `.../src/app_runtime.rs` with `app_runtime_pt1/pt2/pt3.rs` — `codepapr-app://` protocol, port probing, CSP, app scan
- `.../src/app_market_install.rs` — marketplace install / uninstall on disk
- `.../src/papr_runtime/` — `manifest.rs`, `permission.rs`, `app_context.rs`, `app_storage.rs`, `services.rs`, `sdk_inject.rs`, `protocol.rs`
- `.../src/vault.rs`, `secrets.rs` — Stronghold vault and keyring
- `.../src/browser/`, `embedded_browser/`, `tts/`, `file_export.rs`, `asset_scope.rs`, `character_card.rs`, `power.rs` — GUI-only capabilities
- `.../resources/papr-sdk.js` — the `window.papr` API injected into app frames

### 11.3 Frontend / TypeScript

- `packages/@codepapr/core/src/agent/Agent.ts` — tool loop and session execution entry
- `packages/@codepapr/core/src/agent/agentConfig.ts` — `BUILTIN_AGENTS`
- `packages/@codepapr/core/src/cache/` — three-zone cache
- `packages/@codepapr/api/src/request/RequestBuilder.ts` — request construction and validation
- `packages/@codepapr/ui/src/store/agentStore.ts` — desktop main orchestrator
- `packages/@codepapr/ui/src/tools/marketAppApi.ts`, `marketAppInstall.ts` — app marketplace
- `packages/@codepapr/ui/src/utils/marketAppTypes.ts` — `AppInstallScope`, `PaprAppListing`
- `packages/@codepapr/ui/src/papr/usePaprBridge.ts` — iframe ↔ main window IPC

### 11.4 Build scripts

- `packages/@codepapr/ui/scripts/prepare-host-server.mjs` — compile and stage `codepapr-server`
- `packages/@codepapr/ui/scripts/build-sidecar.mjs` — esbuild bundle for `agent-runtime.mjs`
- `packages/@codepapr/ui/scripts/tauri-cli.mjs` — pre-hooks for `dev` and `build`
- `scripts/run-desktop-workflow.mjs` — orchestrates `debug` / `release` / `publish` / `root-check-tauri`
- `packages/@codepapr/ui/src-tauri/tauri.conf.json` — `externalBin` (codepapr-server) and `resources` (agent-runtime.mjs)

## 12. Further reading

| Topic | Location |
|---|---|
| Host / client split decision | `docs/adr/ADR-012-host-client-split.md` |
| App dual-scope decision | `docs/adr/ADR-013-app-install-scope.md` |
| Context layering / Surface / compaction transaction / render freeze / checkpoint v3 | `docs/adr/ADR-001` … `ADR-007`, `docs/web/context-architecture.en.html` |
| Project memory (dual zone → zero review → ledger → v5 MEMORY.md file + curator) | `docs/adr/ADR-008` … `ADR-011`, `ADR-014`, `ADR-016` |
| Installation, verification, release, troubleshooting | `docs/SETUP.en.md` |
| Day-to-day usage and tool inventory | `docs/USAGE.en.md`, `docs/web/tool-inventory.en.html` |
| Parameter reference | `packages/@codepapr/core/docs/CONFIGURATION.md` |
