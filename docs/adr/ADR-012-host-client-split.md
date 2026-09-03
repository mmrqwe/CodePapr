# ADR-012: 桌面端与 codepapr-server 拆成宿主 / 客户端

- 状态: Accepted
- 日期: 2026-09-03
- 关联: 影响 [docs/ARCHITECTURE.md](../ARCHITECTURE.md) 的分层描述；App 作用域见 [ADR-013](./ADR-013-app-install-scope.md)

## 背景

早期 Rust 能力（工作区 IO、Git、Shell、LSP、SQLite、MCP、Agent sidecar）全部实现在 `packages/@codepapr/ui/src-tauri` 里，只有桌面进程能用。带来的问题：

- CLI 想复用同一套能力，只能重写一遍或者链一个巨型 Tauri crate；
- 领域逻辑和 GUI 生命周期绑死，`cargo test` 要拖起 Tauri；
- 无法把「宿主」放到另一个进程（未来远程 / 容器工作区没有路径）。

## 决策

**领域能力下沉到 `crates/codepapr-core`；`crates/codepapr-server` 作为唯一宿主进程对外暴露 JSON-RPC；桌面端 `src-tauri` 退化成瘦客户端。**

Cargo workspace（根 `Cargo.toml`）成员：

| 成员 | 角色 |
|---|---|
| `crates/codepapr-core` | 领域库：`workspace_fs` / `git_operations` / `shell` / `lsp` / `symbols` / `db` / `snapshot` / `mcp_host` / `web` / `agent_runtime` |
| `crates/codepapr-server` | 宿主守护进程，bin `codepapr-server`，RPC 路由在 `src/handler.rs` |
| `crates/codepapr-cli` | 命令行客户端，bin `codepapr-cli`（clap `name = "codepapr"`） |
| `packages/@codepapr/ui/src-tauri` | 桌面客户端，bin `codepapr` |

### 协议

行分隔 JSON-RPC 2.0。`codepapr-server` 有两种传输：

- `--port <N>`：TCP（`--port 0` 让内核选端口，`--port-file <path>` 把实际端口写盘）；
- 不传 `--port`：stdio。

`handler::handle_request` 当前路由 `initialize`、`ping` 和 159 个带命名空间的方法：`fs/*`(23)、`git/*`(8)、`shell/*`(17)、`lsp/*`(12)、`symbols/*`(8)、`db/*`(59)、`snapshot/*`(11)、`mcp/*`(10)、`agent/*`(5)、`web/*`(3)、`task/*`(2)、`secrets/import`。未命中返回 `Unknown JSON-RPC method: <name>`。

### 启动

`src-tauri/src/host.rs::start()`：

1. 有 `CODEPAPR_SERVER_URL` → 直接 `connect_tcp`（连外部宿主，不托管子进程）；
2. 否则 `spawn_and_connect`：定位二进制后以 `--port 0 --port-file <temp>/codepapr-server-<pid>.port` 拉起 sidecar，`stdout` 丢弃、`stderr` 管道化，Windows 加 `CREATE_NO_WINDOW`；
3. `wait_for_bound_port`：15s 超时、40ms 轮询，端口来源二选一——port-file，或 stderr 行 `[codepapr-server] listening on <addr>`；
4. 连上后发 `initialize`，句柄同时存进 Tauri state 和 `GLOBAL` `OnceLock`。

二进制查找顺序（`find_server_binary`）：`CODEPAPR_SERVER_BIN` → 与当前 exe 同目录 → `resourceDir/`、`resourceDir/bin/`、`resourceDir/_up_/` → `target/{debug,release}` → `../../../../target/{debug,release}` → `PATH`。

### 事件

宿主侧 `EventSink` 产生的事件以 JSON-RPC 通知回传：`{"jsonrpc":"2.0","method":"event","params":{"event":"<name>","payload":<value>}}`。客户端 `dispatch_incoming_line` 把它原样 `app.emit(event, payload)` 到 Tauri 事件总线，前端监听名不变。

### 关闭

`HostHandle::shutdown()` 按序发 `lsp/stopAll` → `agent/stopAll` → `fs/stopWatcher` → `shell/stopAllBackground {source:"host-exit"}` → `mcp/disconnectAll`，然后 `kill()` + `wait()` 托管的子进程。`Drop` 兜底再 `kill()` 一次。连 `CODEPAPR_SERVER_URL` 时 `child` 为 `None`，只清理会话不杀外部进程。

### 例外：仍留在客户端的能力

桌面 crate 仍直接依赖 `codepapr-core`（path 依赖），因此少数能力不走 RPC：

- Papr App 存储（`papr_runtime/app_storage.rs`）直接调 `codepapr_core::db::papr_storage_*` / `papr_inbox_append`；
- 密钥：Stronghold vault + keyring 在客户端解密，再通过 `secrets/import` 单向推给宿主内存态 `InMemorySecretStorage`；
- 只有 GUI 能做的事：`codepapr-app://` 协议、内置浏览器（`headless_chrome` / WKWebView）、TTS、文件导出对话框、asset scope、App 安装落盘与端口探测。

## 后果

- CLI 与桌面端共享同一份行为：`codepapr-cli` 通过 `--server` 连已有宿主，否则自动拉 stdio 守护进程。
- `codepapr-core` 可以脱离 Tauri 单测。
- 代价：多一个进程和一次本地回环序列化；宿主崩溃后所有 pending 请求会以 `codepapr-server closed the connection` 失败，客户端当前不自动重连。
- `CODEPAPR_SERVER_URL` 让开发时能挂到手工启动的 `codepapr-server --port <N>` 上调试，桌面端不再重复拉起。
