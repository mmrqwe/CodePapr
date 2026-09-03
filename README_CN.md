# CodePapr

> **[codepapr.com](https://codepapr.com/)** — 官网 / 下载 / 文档

**本地优先的编码 Agent 运行时。Tauri 桌面工作台 + 本地 `codepapr-server` 宿主。**

CodePapr 是一个基于 LLM 前缀缓存优化的本地编码 Agent 系统。主 Agent 调度 **Explore**（代码分析）、**Scout**（网页搜索）、**Mentor**（架构指导）三个内置子代理协作，另有 **Verifier**（Goal 验收）与 **Compactor**（上下文压缩）两个运行时内部代理，支持自定义扩展。文件读写、命令执行、Git 操作、浏览器预览、LSP 诊断——全在本地完成。

---

> [English](README.md)

---

## 核心能力

| 能力 | 说明 |
|------|------|
| **Ask / Plan / Agent / App 四种模式** | 同一个 Runtime，从解释到执行再到交互式应用生成 |
| **宿主 / 客户端拆分** | 桌面端、CLI 以及未来的客户端都用 JSON-RPC 说话同一个本地 `codepapr-server` |
| **多 Agent 协作** | 主 Agent 通过 `task` 工具调度 Explore/Scout/Mentor 及自定义子代理 |
| **TodoList 任务规划** | Agent 自动创建并跟踪任务清单，支持进度汇报与重规划 |
| **项目记忆（零审核）** | 偏好、约束与已验证事实自动写入。短指令进每次会话的 Bootstrap，踩坑经验按回合 Recall，网页引用只进搜索。记忆面板是 SQLite 账本上唯一给人看的面。 |
| **代码智能（LSP + AST）** | `lsp` 工具 9 个导航 action（跳转定义、引用、hover、文件/工作区符号、实现、调用层级），LSP 优先并自动降级 AST 项目图（结果带 source/confidence）；`list` 浏览目录树并附带逐文件轻量符号。ProjectGraph（UI 侧）另支持死代码检测、循环依赖、重构建议等 |
| **LLM 前缀缓存** | 三层提示词注入策略，最大化缓存命中降低成本 |
| **SEARCH/REPLACE Diff** | 先校验再写入，支持原子性多文件 patch |
| **MCP 协议支持** | 集成外部 MCP 工具服务器（stdio / SSE / Streamable HTTP）；内置 DuckDuckGo Search、Postgres、SQLite 预设；MCP 市场一键安装官方注册表服务器；逐服务器权限模式（只读 / 读写 / 危险）与变更操作确认流 |
| **App / 插件市场** | 从官方注册表安装 .papr 应用到**全局**或**项目**作用域，每个应用有独立 origin、CSP 与 SQLite 存储 |
| **Git 深度集成** | 8 个 Git action + diff 面板 + 安全回退（备份引用+撤销） |
| **对话重置** | 一键重置代码和对话到任意历史消息；恢复前预览受影响的文件 |
| **对话轮次导航** | 右侧轮次指示条，悬停展开面板，点击跳转到任意轮次 |
| **全局搜索** | 工具栏搜索框，支持对话搜索和文件搜索双 Tab，键盘全操作 |
| **TaskChecklist 折叠** | 任务全部完成后自动折叠，新任务到达自动展开 |

## 架构

CodePapr **不是**单体 Tauri 应用。Rust 领域逻辑住在共享库 crate，由独立的宿主守护进程对外服务，每个客户端都只是瘦 JSON-RPC 调用方。

```
  ┌──────────────────────────┐        ┌──────────────────────────┐
  │  桌面客户端                │        │  codepapr-cli            │
  │  packages/@codepapr/ui   │        │  crates/codepapr-cli     │
  │  React + Monaco (WebView)│        │  ping/doctor/git/fs/     │
  │  @codepapr/core（Agent    │        │  shell/lsp/chat          │
  │  循环、缓存、工具）        │        └────────────┬─────────────┘
  │  src-tauri（bin codepapr）│                     │
  └────────────┬─────────────┘                     │
               │  JSON-RPC 2.0，行分隔             │
               │  TCP 127.0.0.1（或 stdio）        │
               └──────────────┬────────────────────┘
                              ▼
            ┌─────────────────────────────────────┐
            │  codepapr-server（宿主守护进程）       │
            │  crates/codepapr-server             │
            │  handler.rs → 159 个 RPC 方法        │
            │  + initialize / ping                │
            └──────────────────┬──────────────────┘
                               ▼
            ┌─────────────────────────────────────┐
            │  codepapr-core（领域库）              │
            │  workspace_fs · git_operations      │
            │  shell · lsp · symbols · snapshot   │
            │  db（SQLite）· mcp_host · web         │
            │  agent_runtime（Node sidecar）        │
            └─────────────────────────────────────┘
```

桌面客户端只保留 GUI 必须自己拿的那部分：`codepapr-app://` 协议处理、内置 / 无头浏览器、TTS、Stronghold 密钥保险箱、文件导出对话框、App 安装与端口探测。其余能力在 `src-tauri/src/commands.rs` 里都是 RPC 代理。

### 进程生命周期

| 阶段 | 实际行为 |
|------|---------|
| **挂接** | 设了 `CODEPAPR_SERVER_URL` 就直接连该地址，不拉子进程 |
| **拉起** | 否则定位二进制（`CODEPAPR_SERVER_BIN` → 与应用可执行文件同目录 → Tauri `resourceDir` → `target/{debug,release}` → `PATH`），执行 `codepapr-server --port 0 --port-file <temp>/codepapr-server-<pid>.port` |
| **握手** | 从 port-file 或 stderr 行 `[codepapr-server] listening on <addr>` 读出绑定端口（15s 超时、40ms 轮询），然后发 `initialize` |
| **事件** | 宿主事件以 JSON-RPC 通知回传（method 为 `event`，params 为 `{ event, payload }`），客户端原样转发到 Tauri 事件总线 |
| **关闭** | `lsp/stopAll` → `agent/stopAll` → `fs/stopWatcher` → `shell/stopAllBackground` → `mcp/disconnectAll`，然后 kill 并回收托管的子进程 |

支持自己跑宿主——先 `codepapr-server --port 9090`，再用 `CODEPAPR_SERVER_URL=127.0.0.1:9090` 启动桌面端。

完整职责表、数据流与市场内部机制见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 快速开始

### 环境要求

- Node.js 20.19+
- npm 9+
- Rust toolchain + Cargo — **`npm run build` 就需要**，因为 `@codepapr/ui` 的构建会编译 `codepapr-server` sidecar
- DeepSeek API Key（或 OpenAI/Claude 兼容端点）

### 安装

```bash
npm install
npm run build
npm run verify
```

`npm run build` 会扇出到每个 workspace 包；`@codepapr/ui` 的 build 是 `typecheck && build:host-server && build:sidecar && build:frontend`，先编译 `codepapr-server`，再打包 Node agent runtime，最后构建 Vite 前端。

> Tree-sitter 语法包从 crates.io 拉取最新兼容版本。桌面端 / CLI 构建不再依赖 `--recurse-submodules`。

### 启动桌面端

```bash
npm run debug      # 开发模式（热重载）
npm run release    # 直接运行优化构建
npm run publish    # 生成安装包 (.dmg/.msi)
```

三条都走 `scripts/run-desktop-workflow.mjs`：缺 `node_modules` 自动装，Rust toolchain 坏了自动修，release / publish 额外检查 .NET SDK。

### 直接跑宿主与 CLI

```bash
cargo build -p codepapr-server            # 宿主守护进程
cargo build -p codepapr-cli               # CLI 客户端

cargo run -p codepapr-server -- --port 9090          # TCP 宿主
cargo run -p codepapr-server                         # stdio 宿主

cargo run -p codepapr-cli -- doctor                  # 环境 + 服务 + git 体检
cargo run -p codepapr-cli -- --server 127.0.0.1:9090 status
```

CLI 子命令：`ping`、`doctor`、`status`、`git`、`fs`、`shell`、`lsp`、`server start|info`、`chat`（别名 `run`）。全局参数：`-C/--workspace`、`--server`、`--json`、`-v/--verbose`。不传 `--server` 时自动拉一个 stdio 守护进程。

## 四种工作模式

| 模式 | 适合 | 行为 |
|------|------|------|
| **Ask** | 解释、分析、建议 | 只读，不改文件不跑命令 |
| **Plan** | 复杂任务拆解 | 先出方案和可选项，确认后执行 |
| **Agent** | Bug 修复、功能实现 | 自主执行：搜索→修改→验证 |
| **App** | 数据可视化、探索 | 即时生成交互式应用；在沙箱面板渲染 D3/ECharts/Mermaid 等图表 |

## App / 插件市场

.papr 应用从官方注册表（`mmrqwe/codepapr-apps` → `registry.json`）安装到两个作用域之一：

| 作用域 | 位置 | 适合 |
|--------|------|------|
| `global` | `~/.codepapr/apps/<appId>/` | 跨项目通用工具 |
| `workspace` | `<workspace>/.CodePapr/apps/<appId>/` | 项目专属，可随仓库分发 |

发现时先扫全局再扫工作区——**同 `appId` 的工作区应用覆盖全局应用**。运行时目录解析走同一套优先级，所以一个应用的前端、后端和存储不会跨作用域错位。一个目录要算应用，必须同时满足：目录名是合法 app id、`manifest.json` 可解析、入口文件（`manifest.entry`，默认 `index.html`）存在。

每个应用有独立 origin `codepapr-app://<appId>/`、由权限推导的 CSP，以及紧邻 `manifest.json` 的私有 `db.sqlite`（永远不会通过协议输出）。权限是两轴模型——**本地访问 × 网络**——全局默认加逐应用覆盖，在`设置 → App`里配；manifest 另声明细粒度权限字符串，如 `storage:read`、`storage:write`、`http:get`、`fs:read`、`fs:write`、`agent:run:<agent>`。

## 项目配置

在项目根目录创建 `.CodePapr/` 目录：

| 文件/目录 | 用途 |
|-----------|------|
| `.CodePapr/AGENTS.md` | 全项目规则，注入所有 Agent 和子代理的系统提示词 |
| `.CodePapr/project.sqlite`（`memory_entries`） | 跨会话项目记忆（面板为唯一给人看的面；会话引导从账本渲染） |
| `.CodePapr/agents/*.md` | 自定义子代理（YAML frontmatter + Markdown 正文） |
| `.CodePapr/skills/*/SKILL.md` | 可复用技能（搜索策略、排错流程、发布检查）；也支持平铺布局 `.CodePapr/skills/<name>.md`；技能市场一键安装 GitHub 技能 |
| `.CodePapr/commands/*.md` | 自定义提示词模板（`/name` 调用） |
| `.CodePapr/apps/<appId>/` | 工作区作用域的 .papr 应用（manifest、入口文件、私有 `db.sqlite`） |

全局状态住在 `~/.codepapr/`：`codepapr.sqlite`（设置）、`apps/`（全局应用）、`voices/` 与 `gpt-sovits/`（TTS 资源）。

### 内置命令

输入 `/` 呼出命令面板：

**主模型（深度推理）：** `/review` `/fix` `/test` `/explain` `/diagnose` `/refactor` `/doc` `/new` `/optimize` `/build`

**快速模型（更快、更便宜）：** `/search` `/lint` `/clean` `/commit` `/summary`

**本地（零 token）：** `/help` `/commands` `/undo`

**自主循环（双模型 Worker+Verifier）：** `/goal exec:<验证命令>` — 启动自主循环，Worker 执行 + Verifier 验收 + 客观条件判定，直到验证条件通过或限制耗尽。示例：`/goal exec:npm test`、`/goal 修复 auth 测试 | exec:npm test match:"\\d+ passed"`

按命令的 `model` 字段自动路由：声明 `model: 'fast'` 时走快速模型，未声明则使用主模型；自定义命令同样支持。

## 设置面板

`General / LLM / Search / Mentor / 高级 / App` 六个标签页：

- **General**：语言、调试、许可证
- **LLM**：主模型、快速模型、temperature、topP、maxTokens、thinking 模式、maxToolRounds
- **Search**：自部署 SearXNG 搜索（优先使用，失败自动降级到内置 Bing / Mojeek / Qwant / Wikipedia 等多源聚合）
- **Mentor**：子代理选择、自定义提示词、子代理参数（temperature/topP/thinking/maxTokens/maxToolRounds/maxDepth）、独立 Mentor 模型配置
- **高级**：上下文压缩（模型/温度/token/上下文上限/对话轮数）、TodoList 最大重试、ProjectGraph 深度/文件数限制
- **App**：.papr 应用权限管理——全局默认（本地访问 × 网络）与逐应用两轴覆盖

详见 `packages/@codepapr/core/docs/CONFIGURATION.md` 完整参数参考。

## 内置子代理

| Agent | 用途 | 模型 | 工具 |
|-------|------|------|------|
| **explore** | 只读代码分析 | fast | read, read_image, list, graph, glob, lsp, diagnostics, grep |
| **scout** | 网页搜索 + 下载 | fast | websearch, webfetch, browser, read_image |
| **mentor** | 架构/算法指导 | 可配置独立模型 | 无 |
| **verifier**（内部） | Goal 验收——只读核实 Worker 是否真正达成目标（`/goal`） | `verifierModelTier` 档位（fast/primary/mentor） | read, grep, glob, list |
| **compactor**（内部） | 上下文压缩——生成可恢复检查点 | `compactionModel` 档位（fast/primary） | 无 |

主 Agent 通过 `task` 工具调度子代理。每个子代理拥有**独立的 Session 和空白上下文**，只接收委派的任务描述，不受主 Agent 历史对话污染。子代理有 5 分钟整体超时，单次工具调用有 90 秒超时保护。

> **Verifier** 与 **Compactor** 是运行时控制的内部代理（`internal: true`）——不经 `task` 工具暴露。Verifier 由 GoalRunner 验收循环调用；Compactor 由上下文压缩管线（轮间 + mid-loop）调用。Compactor 零工具纯推理（基于 transcript），墙钟预算沿用子代理默认 20 分钟。

## 验证

```bash
npm run verify    # verify:ci + check:tauri
npm run verify:ci # lint + audit + build + test
npm test          # 仅运行测试
npm run lint      # ESLint
cargo check --workspace   # core + server + cli + 桌面 crate
```

## 项目结构

```
crates/                    # Rust workspace（见根 Cargo.toml）
├── codepapr-core          # 领域库：fs/git/shell/lsp/symbols/db/snapshot/mcp/web/agent
├── codepapr-server        # 宿主守护进程（bin: codepapr-server）— JSON-RPC over TCP 或 stdio
└── codepapr-cli           # CLI 客户端（bin: codepapr-cli）

packages/
├── @codepapr/types        # 共享类型
├── @codepapr/common       # 日志等通用工具
├── @codepapr/core         # Agent/Session/缓存/ToolRegistry/BUILTIN_AGENTS/TodoList
├── @codepapr/api          # Provider (DeepSeek/OpenAI/Claude) 抽象
├── @codepapr/editor       # 编辑器集成
└── @codepapr/ui           # Tauri 桌面端 (React + Monaco)
    └── src-tauri/         # 桌面客户端 crate（bin: codepapr）
                           #   host.rs      — 连 codepapr-server 的 JSON-RPC 客户端
                           #   commands.rs  — Tauri 命令，大多是 RPC 代理
                           #   app_runtime* — codepapr-app:// 协议、App 扫描、端口
                           #   papr_runtime/— manifest、权限、SDK 注入、存储
```

Cargo workspace 成员为 `crates/codepapr-core`、`crates/codepapr-server`、`crates/codepapr-cli` 与 `packages/@codepapr/ui/src-tauri`。SQLite 持久化归 `codepapr-core::db` 所有，桌面端通过 RPC 访问——不再住在 Tauri crate 里。
