# CodePapr 系统设计文档

> 本版本围绕**宿主 / 客户端拆分**重写，所有结论均对照 `c4597827c403e59d6ff0ae52f897a70f9feca685` 的树内代码核实。
> 上下文分层、记忆、缓存分区、TodoList、子代理等 TypeScript 侧主题，见 `docs/adr/ADR-001` … `ADR-011`、`docs/web/context-architecture.html` 与 `docs/USAGE.md`。

## 1. 定位

CodePapr 是本地优先的编码 Agent 运行时。它**不是**单体 Tauri 应用：

- 领域能力（文件系统、Git、Shell、LSP、符号、SQLite、快照、MCP、Web、Agent 运行时）实现在库 crate `codepapr-core`；
- 唯一对外服务的宿主进程是 `codepapr-server`；
- 桌面端（Tauri）和 CLI 都只是 **JSON-RPC 客户端**。

决策背景与取舍见 [ADR-012](./adr/ADR-012-host-client-split.md)。

## 2. 进程拓扑

```
  ┌──────────────────────────┐        ┌──────────────────────────┐
  │  桌面客户端 bin: codepapr │        │  CLI bin: codepapr-cli   │
  │  WebView: React + Monaco │        │  ping/doctor/status/git/ │
  │  @codepapr/core Agent 循环 │       │  fs/shell/lsp/server/chat│
  │  src-tauri/src/host.rs    │        └────────────┬─────────────┘
  └────────────┬─────────────┘                     │
               │   JSON-RPC 2.0（行分隔 JSON）    │
               │   TCP 127.0.0.1  或  stdio        │
               └──────────────┬────────────────────┘
                              ▼
         ┌────────────────────────────────────────┐
         │  codepapr-server（宿主）                  │
         │  main.rs   : --port / --port-file / stdio│
         │  handler.rs: initialize + ping + 159 方法 │
         │  tasks.rs  : 串行任务队列                 │
         └──────────────────┬─────────────────────┘
                            ▼
         ┌────────────────────────────────────────┐
         │  codepapr-core（领域库）                  │
         │  workspace_fs  git_operations  shell     │
         │  lsp / lsp_fallback / symbol_provider    │
         │  db（SQLite）  snapshot  mcp_host  web     │
         │  agent_runtime → Node agent-runtime.mjs │
         └────────────────────────────────────────┘
```

运行时一共涉及四类可执行体：客户端（`codepapr` / `codepapr-cli`）、宿主（`codepapr-server`）、Node agent sidecar（`agent-runtime.mjs`，由**宿主**拉起）、以及宿主管理的各类子进程（LSP server、shell、MCP stdio server）。

## 3. 包与 crate 职责

### 3.1 Cargo workspace（根 `Cargo.toml`）

| 成员 | bin | 职责 |
|---|---|---|
| `crates/codepapr-core` | —（lib） | 领域实现；不依赖 Tauri，可单独 `cargo test` |
| `crates/codepapr-server` | `codepapr-server` | RPC 路由 + 传输 + 事件广播 + 任务队列 |
| `crates/codepapr-cli` | `codepapr-cli` | 命令行客户端（clap `name = "codepapr"`） |
| `packages/@codepapr/ui/src-tauri` | `codepapr` | 桌面客户端；GUI 专属能力 + RPC 代理 |

### 3.2 npm workspace

| 包 | 职责 |
|---|---|
| `@codepapr/types` | 共享类型 |
| `@codepapr/common` | 日志等通用工具 |
| `@codepapr/core` | Agent / Session / 缓存分区 / ToolRegistry / BUILTIN_AGENTS / TodoList |
| `@codepapr/api` | Provider（DeepSeek / OpenAI / Claude）抽象与请求构造 |
| `@codepapr/editor` | 编辑器类型与工具 |
| `@codepapr/ui` | Tauri 桌面端（React + Monaco），含 `src-tauri` |

注意：Agent 循环、提示词组装、缓存分区在 **TypeScript 侧**（`@codepapr/core`）；它要的一切副作用（读写文件、跑命令、查符号）都由宿主完成。

## 4. 宿主协议

### 4.1 传输

行分隔 JSON-RPC 2.0，一行一个 JSON 对象。`codepapr-server` 两种形态：

- `--port <N>` → TCP；`--port 0` 交给内核选端口，`--port-file <path>` 把实际端口写盘；
- 不传 `--port` → stdio（CLI 默认自动拉起的形态）。

另有 `--workspace <path>` 提供默认工作区；请求参数里没带 `workspacePath` 时回退到它，两者都没有则报 `workspacePath is required in params or via --workspace flag`。

### 4.2 启动（`src-tauri/src/host.rs`）

```
host::start(app)
  ├─ 有 CODEPAPR_SERVER_URL → connect_tcp(addr, child=None)
  └─ 否则 spawn_and_connect()
        ├─ find_server_binary()
        │    CODEPAPR_SERVER_BIN
        │  → 与 current_exe 同目录
        → resourceDir/  、 resourceDir/bin/  、 resourceDir/_up_/
        │  → target/{debug,release}
        │  → ../../../../target/{debug,release}
        │  → PATH
        ├─ spawn: --port 0 --port-file <temp>/codepapr-server-<pid>.port
        │        stdin=null, stdout=null, stderr=piped，Windows 加 CREATE_NO_WINDOW
        ├─ wait_for_bound_port(): 15s 截止、40ms 轮询
        │        来源 A = port-file 内容
        │        来源 B = stderr 行 "[codepapr-server] listening on <addr>"
        └─ connect_tcp("127.0.0.1:<port>", child=Some)
  └─ invoke("initialize") → 存入 Tauri state + GLOBAL OnceLock
```

拿不到端口报 `Timed out waiting for codepapr-server to bind a TCP port`；找不到二进制报 `Could not locate 'codepapr-server' binary. Build it with 'cargo build -p codepapr-server' or set CODEPAPR_SERVER_BIN.`

`initialize` 返回 `serverInfo`（name / version）、`capabilities`（fs / git / shell / lsp / agent / db / snapshot / mcp / web / harness）与默认 `workspace`。`ping` 返回 `"pong"`。

`codepapr run`（外部 harness 路径）在此之上有独立的 sidecar 帧握手：CLI 先发 `harness/ping`，sidecar（`agentRuntime.sidecar.ts` 里的 headless mediator）以 `harness-pong` 应答，之后 `harness/init` / `harness/run` 在 **sidecar 进程内**用与桌面同源的装配函数（core `isPromptToolVisible`、`buildRuntimeSystemPrompt`、`buildSessionBootstrapPrompt`、`toWorkerAgentSettings`）合成与桌面逐字节同构的 init/chat 帧喂给同一个 `agentRuntimeLoop`。工具执行仍走 `RUST_HOSTED_TOOLS`；UI-bound 工具（question/todo/其余 unsupported）由 mediator 就地应答，绝不依赖 WebView。sidecar 缺少 harness 帧时 CLI 硬失败（exit 1），不降级到旧 REPL 的固定工具表。详见 `docs/USAGE.md`「外部 Harness」。

CLI 侧（`crates/codepapr-cli/src/rpc_client.rs`）同构：`--server` → TCP；`CODEPAPR_SERVER_URL` → TCP；都没有则 spawn stdio 守护进程。

### 4.3 请求 / 响应

客户端自增 `id`（`AtomicU64`，从 1 开始），把 `oneshot::Sender` 放进 `pending` 表，写一行 JSON。读侧单任务逐行 dispatch：

- 带 `id` → 从 `pending` 取出 sender；有 `error` 则回 `RPC error [<code>]: <message>`，否则回 `result`；
- 无 `id`（或 `id: null`）→ 当作通知处理。

连接断开时所有 pending 请求以 `codepapr-server closed the connection` 失败。**当前不做自动重连**。

### 4.4 事件

宿主侧的 `codepapr_core::events::EventSink` 发出的事件，以 JSON-RPC 通知回传：

```json
{ "jsonrpc": "2.0", "method": "event", "params": { "event": "<name>", "payload": <value> } }
```

客户端 `dispatch_incoming_line` 取出 `event` / `payload` 后直接 `app.emit(event, payload)`，**事件名不变**，前端监听方式与拆分前一致。当前树内的事件名：

| 事件名 | 来源 |
|---|---|
| `workspace-files-changed` | `workspace_fs::watcher`（防抖轮询 150ms） |
| `project-stats-progress` | `workspace_fs::stats` |
| `codepapr://lsp-managed-status` | `lsp`（托管 LSP 安装 / 启动进度） |
| `agent-runtime://frame` | `agent_runtime` / `agent_runtime_tools`（流帧） |
| `agent-runtime://exit` | `agent_runtime`（sidecar 退出） |
| `agent-runtime://permission-request` | `agent_runtime_tools` |
| `agent-runtime://permission-cancel` | `agent_runtime_tools` |
| `agent-runtime://workspace-mutated` | `agent_runtime_tools`（工具写过的文件） |
| `mcp-confirm-request` | `mcp_host`（变更类工具确认） |

### 4.5 关闭

`HostHandle::shutdown()` 严格按序：

1. `lsp/stopAll`
2. `agent/stopAll`
3. `fs/stopWatcher`
4. `shell/stopAllBackground { source: "host-exit" }`
5. `mcp/disconnectAll`
6. `child.kill()` + `child.wait()`（仅限自己 spawn 的子进程）

`Drop` 会再 `kill()` 一次兜底。连外部宿主（`CODEPAPR_SERVER_URL`）时 `child` 为 `None`，只做会话清理、不杀进程。

桌面端退出前还有一道设置落盘等待：向 UI 发 `codepapr:flush-settings`，轮询 `db/settingsSaveState`（探测窗 500ms，落盘预算 2000ms），然后 `app.exit(0)`；`RunEvent::Exit` 里先 `enter_fast_child_reap()` 再跑上面的 `shutdown()` 与 TTS / 浏览器 / 电源锁清理。

## 5. 职责矩阵

| 层 | 位置 | 拥有 | 不拥有 |
|---|---|---|---|
| **UI（React）** | `packages/@codepapr/ui/src` | 交互、面板、store 编排、Agent 循环驱动、提示词组装 | 任何直接文件 / 进程 / 数据库访问 |
| **Tauri 客户端** | `src-tauri/src` | `host.rs` RPC 客户端；`commands.rs` 代理；GUI 专属：`codepapr-app://` 协议、内置/无头浏览器、TTS、vault/secrets、`file_export`、`asset_scope`、`character_card`、`power`、App 安装与端口探测 | 文件系统、Git、Shell、LSP、MCP、快照、Web、主 SQLite |
| **codepapr-server** | `crates/codepapr-server` | 方法路由、参数校验、事件广播、内存态密钥、串行任务队列 | 领域实现（全部委派给 core） |
| **codepapr-core** | `crates/codepapr-core` | 所有领域实现与子进程生命周期 | UI、协议层 |

两个必要的例外（桌面 crate 直接 path 依赖 `codepapr-core`，因此可以不走 RPC）：

1. **Papr App 存储**：`papr_runtime/app_storage.rs` 直接调 `codepapr_core::db::papr_storage_get/set/delete/keys` 与 `papr_inbox_append`，先过 `check_permission`。（宿主也同时暴露 `db/paprStorage*`，供 CLI / agent 侧使用。）
2. **密钥**：明文只在客户端的 Stronghold vault + keyring；`host::import_vault_secrets` 启动后把 `api_key` / `mentor_api_key` 经 `secrets/import` 单向推给宿主的 `InMemorySecretStorage`。宿主不落盘密钥。

## 6. RPC 面

`crates/codepapr-server/src/handler.rs` 当前路由 `initialize`、`ping` 与 159 个命名空间方法；未命中返回 `Unknown JSON-RPC method: <name>`。

| 命名空间 | 方法数 | 实现位置 | 代表方法 |
|---|---|---|---|
| `fs/*` | 23 | `workspace_fs` | `readTextFile` `writeTextFile` `listFiles` `search` `searchPaths` `startWatcher` `stopWatcher` `computeProjectStats` `grantExternalAccess` |
| `git/*` | 8 | `git_operations` | `status` `diff` `log` `stage` `commit` `branchList` `branchCheckout` `restoreFiles` |
| `shell/*` | 17 | `shell` | `execute` `executeShell` `startBackground` `stopAllBackground` `openSession` `sendCommand` `readOutput` `listSessions` |
| `lsp/*` | 12 | `lsp` / `lsp_managed_tools` | `startServer` `request` `openDocument` `diagnostics` `batchSymbols` `queryAvailability` `stopAll` |
| `symbols/*` | 8 | `symbol_provider` / `lsp_fallback` | `definition` `references` `hover` `resolve` `extractFileSymbols` `checkSyntax` |
| `db/*` | 59 | `db` | `loadSettings` `saveSettings` `settingsSaveState` `saveMessageBatch` `loadSessions` `saveProjectState` `saveProjectgraphCache` `memory*` `paprStorage*` |
| `snapshot/*` | 11 | `snapshot` | `ensure` `create` `list` `diff` `changedFiles` `restorePlan` `restoreExecute` `restoreUndo` |
| `mcp/*` | 10 | `mcp_host` / `mcp_sse` | `listTools` `callTool` `listStatus` `updateSettings` `confirmResponse` `disconnectAll` |
| `agent/*` | 5 | `agent_runtime` | `start` `send` `stop` `stopAll` `respondPermission` |
| `web/*` | 3 | `web` | `search` `fetchUrl` `downloadFile` |
| `task/*` | 2 | `codepapr-server/src/tasks.rs` | `enqueue` `poll` |
| `secrets/import` | 1 | `handler.rs` | 写入内存态密钥 |

参数约定：camelCase；`workspacePath` 可省略（回退到 `--workspace`）；文件路径接受 `path` 或 `relativePath`。

## 7. 数据流

### 7.1 一次工具调用

```
React 组件 / Agent 循环
   │  invoke("read_text_file", { workspacePath, path })
   ▼
src-tauri/src/commands.rs   #[tauri::command]
   │  host::call(app, "fs/readTextFile", params)
   ▼
host.rs  → {"jsonrpc":"2.0","id":N,"method":"fs/readTextFile",...}\n
   ▼  TCP 127.0.0.1
codepapr-server  handler.rs → 参数校验 →
   ▼
codepapr_core::workspace_fs::read::read_text_file(...)
   ▼  原路返回 {"jsonrpc":"2.0","id":N,"result":...}
host.rs → pending[N].send(Ok(result)) → Tauri 命令返回 → UI
```

### 7.2 一条事件

```
codepapr_core::workspace_fs::watcher
   │  sink.emit("workspace-files-changed", {})
   ▼
codepapr-server 封装为通知
   │  {"jsonrpc":"2.0","method":"event",
   │   "params":{"event":"workspace-files-changed","payload":{}}}\n
   ▼
host.rs dispatch_incoming_line → app.emit("workspace-files-changed", {})
   ▼
React listen("workspace-files-changed", ...)
```

Agent 流式输出走同一条通道：`agent/start` 拿到 `runtimeId`，之后每一帧都是 `agent-runtime://frame` 事件。桌面端在 `agent/start` 时把 `resourceDir` 传给宿主，宿主据此定位并拉起 `agent-runtime.mjs`。

## 8. 持久化与 SQLite 所有权

所有 SQLite 由 `codepapr-core::db` 打开，也就是**宿主进程在写**（App 存储除外，见 §5）。三处位置：

| 库 | 路径 | 内容 |
|---|---|---|
| App DB | `~/.codepapr/codepapr.sqlite` | 全局 UI 设置、provider / model / 采样参数、角色、最近工作区 |
| Project DB | `<workspace>/.CodePapr/project.sqlite` | 会话与消息、项目状态、checkpoint、context surface、`memory_entries`、ProjectGraph 缓存 |
| Papr App DB | `<appDir>/db.sqlite` | 单个 .papr 应用的键值存储与 inbox |

目录常量（`crates/codepapr-core/src/db/mod.rs`）：`APP_DATA_DIR = ".codepapr"`、`APP_DB_FILE = "codepapr.sqlite"`、`PROJECT_STORAGE_DIR = ".CodePapr"`、`PROJECT_DB_FILE = "project.sqlite"`、`PAPR_APP_DB_FILE = "db.sqlite"`。

旧版 `state.json` / `project.json` 在首次打开或保存时导入 SQLite；旧版 `.CodePapr/memory.md` 由 `db/ingestLegacyMemoryMd` 收进账本后删除（[ADR-011](./adr/ADR-011-retire-memory-md.md)）。

退出时的设置落盘不靠“盲等”，而是轮询 `db/settingsSaveState` 返回的 requests / epoch 计数（见 §4.5）。

## 9. 子系统所有权

| 子系统 | 进程归属 | 说明 |
|---|---|---|
| 文件系统 / watcher | 宿主 | `fs/startWatcher` 启动，变更防抖后发 `workspace-files-changed`；外部路径访问授权（grant / revoke / yolo）也在宿主 |
| Shell | 宿主 | 前台执行、后台任务、交互式会话全在 `codepapr-core::shell`；沙箱参数走 `sandbox` 字段 |
| LSP | 宿主 | `codepapr-core::lsp` 按语言族拉起 stdio server 并在工作区内复用；托管安装进度走 `codepapr://lsp-managed-status`；不可用时降级 `lsp_fallback` / `symbol_provider`（tree-sitter） |
| MCP | 宿主 | `mcp_host` 管理 stdio / SSE / Streamable HTTP 连接；变更类工具发 `mcp-confirm-request`，答复走 `mcp/confirmResponse` |
| Agent runtime | 宿主 | `agent_runtime` 拉起 Node `agent-runtime.mjs`；工具实现在 `agent_runtime_tools` / `agent_runtime_lsp`；权限请求以事件上抛，`agent/respondPermission` 回答 |
| 快照 / 回退 | 宿主 | `snapshot` 提供 shadow git 快照、diff、restore plan / execute / undo |
| Web | 宿主 | `web` 提供多引擎搜索聚合、抓页、下载 |
| 任务队列 | 宿主 | `task/enqueue` + `task/poll`，串行执行长任务 |
| 浏览器（headless / 内置） | 客户端 | `browser/`（headless_chrome）与 `embedded_browser/`（多 WebView，macOS 下 WKWebView 截图） |
| TTS | 客户端 | `tts/`：GPT-SoVITS server 子进程、rodio 播放、WebSocket 批量合成、安装器、微调 |
| 密钥 | 客户端 | `vault.rs` / `secrets.rs`（Stronghold + keyring），单向 import 到宿主 |
| Papr App 运行时 | 客户端 | `app_runtime*.rs` + `papr_runtime/`，见 §10 |

## 10. Papr App 市场与运行时

完整决策见 [ADR-013](./adr/ADR-013-app-install-scope.md)。

### 10.1 注册表与安装

- 官方注册表：`https://raw.githubusercontent.com/mmrqwe/codepapr-apps/main/registry.json`（`src/tools/marketAppApi.ts`）；
- 前端 `src/tools/marketAppInstall.ts` 逐文件下载后调 Tauri 命令 `papr_install_app_files` 落盘（`src-tauri/src/app_market_install.rs`）；
- 作用域类型 `AppInstallScope = 'global' | 'workspace'`（`src/utils/marketAppTypes.ts`）。

### 10.2 位置与优先级

| 作用域 | 目录 |
|---|---|
| `global` | `~/.codepapr/apps/<appId>/` |
| `workspace` | `<workspace>/.CodePapr/apps/<appId>/` |

`scan_workspace_apps`（`app_runtime_pt3.rs`）先扫全局写入 map，再扫工作区**覆盖同 `appId`**，最后按 `appId` 排序；每项带 `scope` 字段下发。运行时的 `codepapr_core::db::resolve_app_dir` 使用同一优先级（工作区 manifest 优先 → 全局 manifest → 回退路径），保证前端 / 后端 / 存储三者指向同一目录。

被认为是应用的条件：目录名通过 `is_valid_app_id` + `manifest.json` 可解析 + 入口文件（`manifest.entry`，默认 `index.html`）存在。

### 10.3 `codepapr-app://` 协议

- 每个应用一个 origin：`codepapr-app://<appId>/<file>`（兼容旧形式 `codepapr-app://localhost/<appId>/<file>`）；
- `__papr_sdk.js` 是保留路径，返回注入的 Papr SDK（`src-tauri/resources/papr-sdk.js`）；
- `is_unservable_app_file` 拦住 `db.sqlite`、`db.sqlite-wal`、`db.sqlite-shm` 以及任意 `.sqlite`（大小写不敏感、含子目录）；
- 快照 / 导出（`papr_snapshot_app` / `papr_export_app`）跳过 `node_modules`、`.versions`、`data`、`db.sqlite*`。

### 10.4 权限与 CSP

两轴模型：本地访问（`PaprLocalAccess`）× 网络（`bool`），全局默认 + 逐应用覆盖（`papr_get_app_settings` / `papr_set_app_settings`，持久化走 `db/paprLoadPermissionSettings` / `db/paprSavePermissionSettings`）。manifest 的 `permissions` 声明细粒度权限（`storage:read`、`storage:write`、`http:get`、`fs:read`、`fs:write`、`agent:run:<agent>`），由 `permission::check_permission` 在命令入口校验。

`build_app_csp`（`app_runtime_pt3.rs`）根据两轴生成 CSP：

- 网络**关**：`connect-src 'self'`（加自身后端 `http://localhost:<port>` / `http://127.0.0.1:<port>`）、`form-action 'none'`、`img-src 'self' data: blob:`、`script-src` 不放行 `https:`；
- 网络**开**：追加 `https: http: wss: ws:`、`img-src` 加 `https:`、`form-action` 加 `https:`、`script-src` 加 `https:`（CDN 图表库）；
- 始终：`default-src 'none'`、`worker-src 'self' blob:`、`frame-src 'self' blob:`（供 `<a download>` 与隐藏 iframe 下载）。

### 10.5 后端应用

manifest 可声明 `command` / `args` / `port`。`app_runtime_pt2.rs` 先探测端口（`port_has_listener`、`check_port_available_detail`），用 `lsof` / `netstat` 找占用者 PID，并校验绑定地址是否为回环；声明端口被占时 `allocate_app_port` 另选一个。

## 11. 关键源码定位

### 11.1 宿主与领域层（Rust）

- `crates/codepapr-server/src/main.rs`：CLI 参数、TCP / stdio 两种服务循环、端口写盘与 `listening on` 日志
- `crates/codepapr-server/src/handler.rs`：RPC 路由与参数校验（`require_workspace` / `require_path` / `opt_*`）
- `crates/codepapr-server/src/tasks.rs`：串行任务队列
- `crates/codepapr-core/src/lib.rs`：module 导出与 `version()`
- `crates/codepapr-core/src/events.rs`：`EventSink` / `FnEventSink` / `NoopEventSink`
- `crates/codepapr-core/src/workspace_fs/`：读写、搜索、watcher（`watcher.rs`）、项目统计（`stats.rs`）
- `crates/codepapr-core/src/git_operations/`：git2 封装
- `crates/codepapr-core/src/shell/`：前台/后台/会话与 `sandbox`
- `crates/codepapr-core/src/lsp.rs` / `lsp_managed_tools.rs` / `lsp_fallback.rs`：LSP 管理、托管安装、内建降级
- `crates/codepapr-core/src/symbol_provider.rs`：tree-sitter 符号与项目图
- `crates/codepapr-core/src/db/mod.rs`：三处 SQLite、`global_apps_dir()`、`resolve_app_dir()`
- `crates/codepapr-core/src/snapshot/`：shadow git 快照与回退
- `crates/codepapr-core/src/mcp_host.rs` / `mcp_sse.rs`：MCP 客户端与确认流
- `crates/codepapr-core/src/web/`：搜索聚合、抓页、下载
- `crates/codepapr-core/src/agent_runtime.rs` / `agent_runtime_tools.rs` / `agent_runtime_lsp.rs`：Node sidecar 与工具实现
- `crates/codepapr-cli/src/main.rs` / `rpc_client.rs` / `commands/`：CLI 入口与子命令

### 11.2 桌面客户端（Rust）

- `packages/@codepapr/ui/src-tauri/src/host.rs`：JSON-RPC 客户端、sidecar 拉起、事件转发、`shutdown()`
- `.../src/main.rs`：Tauri 构建、协议注册、命令登记、退出清理
- `.../src/commands.rs`：Tauri 命令（绝大多数为 `host::call` 代理）
- `.../src/app_runtime.rs` 与 `app_runtime_pt1/pt2/pt3.rs`：`codepapr-app://` 协议、端口探测、CSP、App 扫描
- `.../src/app_market_install.rs`：市场安装 / 卸载落盘
- `.../src/papr_runtime/`：`manifest.rs`、`permission.rs`、`app_context.rs`、`app_storage.rs`、`services.rs`、`sdk_inject.rs`、`protocol.rs`
- `.../src/vault.rs`、`secrets.rs`：Stronghold vault 与 keyring
- `.../src/browser/`、`embedded_browser/`、`tts/`、`file_export.rs`、`asset_scope.rs`、`character_card.rs`、`power.rs`：GUI 专属能力
- `.../resources/papr-sdk.js`：注入 iframe 的 `window.papr` API

### 11.3 前端 / TypeScript

- `packages/@codepapr/core/src/agent/Agent.ts`：工具循环与会话执行入口
- `packages/@codepapr/core/src/agent/agentConfig.ts`：`BUILTIN_AGENTS`
- `packages/@codepapr/core/src/cache/`：三分区缓存
- `packages/@codepapr/api/src/request/RequestBuilder.ts`：请求构造与校验
- `packages/@codepapr/ui/src/store/agentStore.ts`：桌面端主编排器
- `packages/@codepapr/ui/src/tools/marketAppApi.ts` / `marketAppInstall.ts`：应用市场
- `packages/@codepapr/ui/src/utils/marketAppTypes.ts`：`AppInstallScope`、`PaprAppListing`
- `packages/@codepapr/ui/src/papr/usePaprBridge.ts`：iframe ↔ 主窗口 IPC

### 11.4 构建脚本

- `packages/@codepapr/ui/scripts/prepare-host-server.mjs`：编译并 stage `codepapr-server`
- `packages/@codepapr/ui/scripts/build-sidecar.mjs`：esbuild 打包 `agent-runtime.mjs`
- `packages/@codepapr/ui/scripts/tauri-cli.mjs`：`dev` / `build` 前置钩子
- `scripts/run-desktop-workflow.mjs`：`debug` / `release` / `publish` / `root-check-tauri` 编排
- `packages/@codepapr/ui/src-tauri/tauri.conf.json`：`externalBin`（codepapr-server）与 `resources`（agent-runtime.mjs）

## 12. 延伸阅读

| 主题 | 位置 |
|---|---|
| 宿主 / 客户端拆分决策 | `docs/adr/ADR-012-host-client-split.md` |
| App 双作用域决策 | `docs/adr/ADR-013-app-install-scope.md` |
| 上下文分层 / Surface / 压缩事务 / 渲染参数冻结 / checkpoint v3 | `docs/adr/ADR-001` … `ADR-007`、`docs/web/context-architecture.html` |
| 项目记忆（双区 → 零审核 → 账本唯一面） | `docs/adr/ADR-008` … `ADR-011` |
| 安装、验证、发布与排错 | `docs/SETUP.md` |
| 日常使用与工具清单 | `docs/USAGE.md`、`docs/web/tool-inventory.html` |
| 参数参考 | `packages/@codepapr/core/docs/CONFIGURATION.md` |
