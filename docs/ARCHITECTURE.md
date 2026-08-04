# CodePapr 系统设计文档

## 1. 文档目的

描述 CodePapr 的正式系统设计，重点回答：

- 系统要解决什么问题
- 核心设计目标和非目标是什么
- 组件如何分层、如何协作
- Agent runtime 的执行链路和关键不变量是什么
- DeepSeek 前缀缓存友好性如何保证
- 子代理、TodoList、项目记忆、ProjectGraph 的架构定位

## 2. 设计目标

### 2.1 核心目标

- 单一 runtime，多入口复用
- 本地优先执行，项目上下文尽量不离开工作区
- 多轮任务中保持稳定上下文和可验证执行链路
- 允许在不重写核心 runtime 的前提下扩展新 provider、新工具宿主和新入口
- 最大化 DeepSeek 自动前缀缓存命中率

### 2.2 非目标

- 不是多租户云端代理平台
- 不是纯网页聊天产品
- 不是把 CLI 和桌面端分别实现成两套独立系统

## 3. 逻辑分层

### 3.1 包级职责

| 包 | 角色 | 主要责任 |
| --- | --- | --- |
| @codepapr/types | 共享协议层 | 统一消息、请求、响应、工具和统计类型 |
| @codepapr/common | 公共基础设施 | 日志、哈希与通用工具 |
| @codepapr/core | 运行时核心 | Agent、Session、ToolRegistry、缓存分区、ProjectGraph、TodoList、Built-in Agents |
| @codepapr/api | provider 适配层 | RequestBuilder、CacheValidator、provider 实现 |
| @codepapr/db | 持久化层 | SQLite 封装与 repository |
| @codepapr/editor | 编辑器契约 | 框架无关的 Monaco 类型、标记、导航与静态检查契约 |
| @codepapr/ui | 桌面工作台 | React、Zustand、Tauri、WorkerBackedAgent |

## 4. 核心组件

### 4.1 Shared Agent Runtime

- **Agent**：驱动单轮或多轮工具执行链路
- **Session**：持有 ImmutablePrefix、AppendOnlyLog、VolatileScratch 和 ToolRegistry
- **ToolRegistry**：维护可调用工具定义与执行入口
- **RequestBuilder**：构造 provider 请求并做一致性校验
- **CacheValidator**：解析响应、校验缓存相关元数据并归一化 usage

### 4.2 桌面端 Agent 桥接

桌面端通过 `WorkerBackedAgent` 将 LLM 聊天循环卸载到 Web Worker：

```
ChatPanel → agentStore.sendMessage()
  ├─ 乐观更新：用户消息立即 set() 到 UI（~50ms），不等任何 I/O
  ├─ 后台：refreshProjectDiagnostics（不阻塞）、load_projectgraph_cache、
  │        read_text_file(.CodePapr/memory.md)、loadMcpToolDefinitions
  ├─ WorkerBackedAgent.chat()
  │    ├─ Worker Thread: Agent.chat() → LLM
  │    └─ Main Thread: tool execution → Tauri invoke
  └─ gitCheckpointCreate（锚定到已显示的消息）
```

**关键文件：**
- `packages/@codepapr/ui/src/agent/WorkerBackedAgent.ts`：Worker 代理包装器
- `packages/@codepapr/ui/src/agent/agentRuntime.worker.ts`：Worker 端运行时
- `packages/@codepapr/ui/src/agent/agentWorkerProtocol.ts`：消息协议定义

### 4.3 桌面端状态层

桌面端在 UI 和 shared runtime 之间维护一层状态管理：

- **agentStore**（Zustand）：主编排器，负责 sendMessage（乐观 UI）、模型路由、流式消息、会话恢复、TodoList 管理、对话重置
- **contextCompaction**：长会话后生成 context checkpoint，控制上下文压缩
- **projectStorage**：项目级快照持久化到 `.CodePapr/project.sqlite`
- **workspaceTools**：桌面端工具调用桥接到 Tauri 原生命令
- **permissionStore**：外部文件访问权限管理，对项目外绝对路径的 `read` / `list` 操作显式弹窗授权
- **toastStore**：全局 Toast 通知队列，info / success / warning / error 四色，支持自动消失与手动关闭
- **reviewStore**：代码审查状态管理，按 `baseRef..headRef` 缓存 diff 文件列表、行级评论与审批状态

### 4.4 Rust 后端领域模块

Tauri Rust 后端已从单文件 `main.rs` 拆分为多个领域模块，每个模块职责单一：

| 模块 | 文件 | 责任 |
| --- | --- | --- |
| `browser` | `src-tauri/src/browser/` | 基于 headless_chrome 的浏览器自动化（open / navigate / click / type / screenshot / read） |
| `shell` | `src-tauri/src/shell/` | bash 工具后端：shell 命令执行（穿过 shell）、后台进程管理与命令安全守卫 |
| `web` | `src-tauri/src/web/` | HTTP fetch、网页正文提取、多引擎搜索（SearXNG 优先，失败自动降级到 Bing / Mojeek / Qwant / Wikipedia 等内置多源聚合） |
| `workspace_fs` | `src-tauri/src/workspace_fs/` | 文件列表、文本读取、写入、SEARCH/REPLACE diff、文本/路径搜索 |
| `task_queue` | `src-tauri/src/task_queue/mod.rs` | 重 I/O 操作串行化队列，前端通过 `task_id` 轮询结果 |
| `db` | `src-tauri/src/db/mod.rs` | 应用与项目级 SQLite 持久化、会话与缓存统计 |
| `tts` | `src-tauri/src/tts/` | GPT-SoVITS TTS 子系统：server 管理、语音合成、WebSocket 批量合成、音频播放、安装器、微调 |
| `lsp` | `src-tauri/src/lsp.rs` | LSP server 进程管理、stdin/stdout JSON-RPC 桥接 |
| `symbol_provider` | `src-tauri/src/symbol_provider.rs` | tree-sitter fallback 符号提取 |
| `mcp_host` | `src-tauri/src/mcp_host.rs` | MCP 工具服务器宿主（stdio / sse / streamable-http）；动态工具发现（`mcp__<serverId>__<toolName>`）；3 种权限模式（read-only / read-write / dangerous）；变更操作确认流；工具定义 24h 缓存；MCP 市场（官方注册表一键安装） |
| `shared` | `src-tauri/src/shared/` | 路径归一化、workspace 路径解析、运行时封装、字符串/时间工具 |
| `papr_runtime` | `src-tauri/src/papr_runtime/` | .papr 应用运行时：manifest 加载、权限校验、SDK 注入、存储/HTTP/FS 命令、app 上下文注册 |
| `app_runtime` | `src-tauri/src/app_runtime.rs` | 自定义 URI scheme `codepapr-app://`、app 发现与扫描、SDK 注入、workspace 注册 |

### 4.5 任务队列

所有重 I/O 的 Tauri 命令（文件列表、读取、命令执行等）通过单消费者 channel 串行执行：

- 命令立即返回 `task_id`，不阻塞前端
- 前端轮询 `poll_workspace_task` 获取结果
- 避免多线程并发读写同一工作区，简化锁模型

### 4.6 工具架构

LLM 可调用 30 个独立工具（含 `task` / `todo` 两个动态工具），每个职责单一，有 `action` 的 7 个均带 `enum` 约束。文件读取/写入/SEARCH/REPLACE 的单次上限为 20MB：

| 合并工具 | Action | 委托工具 |
|---|---|---|
| `read` | 行范围/窗口/上下文读取 | workspace_read_file |
| `read_image` | 图片文件读取（PNG/JPEG/WebP/GIF） | workspace_read_image |
| `write` | 创建/覆写文件 | workspace_write_file |
| `edit` | SEARCH/REPLACE 单文件修改 | workspace_apply_patch |
| `patch` | 多文件原子 SEARCH/REPLACE | workspace_apply_diff |
| `grep` | 正则搜索文件内容；`semantic:true` 切换 LSP workspace symbol 语义检索（无 LSP 降级正则） | workspace_search_text / workspace_workspace_symbol |
| `glob` | 文件名模式搜索 | workspace_search_files |
| `list` | 浏览目录树，逐文件嵌入轻量符号（extractSymbols，AST）；无 AST 语言仅返回路径 | workspace_list_files |
| `graph` | **对 LLM 隐藏（UI-only）**：full / overview / lookup / implementations / dependency / entrypoints / impact / smart_context / dead_code / circular_deps / type_hierarchy / suggest_refactors / test_impact / generate_tests | graphQuery |
| `lsp` | goToDefinition / findReferences / hover / documentSymbol / workspaceSymbol / goToImplementation / prepareCallHierarchy / incomingCalls / outgoingCalls（LSP 优先、AST 项目图兜底，结果带 source/confidence） | workspace_symbol_definition / references / hover / document_symbol / workspace_symbol / implementation / prepare_call_hierarchy / incoming_calls / outgoing_calls |
| `lsp_edit` | rename / code_action / format | workspace_rename_symbol / workspace_apply_code_action / workspace_format_files |
| `diagnostics` | 单文件 LSP 诊断 / 项目级诊断 | workspace_lsp_diagnostics / workspace_project_diagnostics |
| `git` | status / diff / log / branch / stage / commit / restore / reset | workspace_git_* |
| `bash` | 在项目环境执行 shell 命令（穿过 shell）；action: run/list/stop/stop_all；background:true 后台运行 | workspace_run_shell_command / workspace_start_shell_background_command / workspace_*_background_processes |
| `browser` | open / navigate / reload / close / click / type / read / screenshot / get | browser_* |
| `websearch` | 在线搜索 | websearch（原生直接注册）|
| `webfetch` | 读取网页正文转纯文本；`save: true` 下载原始内容到项目并返回路径 | web_fetch_url / web_download_file |
| `app_render` | 渲染 .papr App | app_render |
| `app_list` | 列出所有已注册 app | app_list |
| `app_start` | 启动 app 后端 | app_start |
| `app_stop` | 停止 app 后端 | app_stop |
| `app_delete` | 删除 app | app_delete |
| `skill` | 加载 Skill 文档 | skill_load |
| `question` | 向用户提问 | question |
| `task` | 委派子代理执行子任务 | subagent |
| `todo` | tasks / updates 任务规划 | TodoList |

30 个工具统一注册在 ToolRegistry 中，冻结后 hash 确保缓存一致性。`todo` 和 `task` 为动态生成。

Ask / Plan 只读模式使用 `FilteringToolRegistry`（`ToolRegistry` 子类）：注册时按谓词跳过变更类工具（`MUTATING_TOOL_NAMES`：write/edit/patch/lsp_edit/bash/git/app_*），使其既不出现在工具集也不注册 handler——硬拦截而非提示词软约束。Agent / App 模式使用普通 `ToolRegistry`。

**外部路径权限**：桌面端对 `read` / `list` 操作的项目外绝对路径会弹出 `PermissionDialog`，由用户选择“拒绝 / 允许此文件 / 允许此文件夹”，授权结果保存在 `permissionStore` 白名单中。CLI 的读取路径边界相对宽松，写入仍限制在工作区内。

### 4.7 Papr App Runtime

Papr 是 CodePapr 的应用运行时——AI 生成的 `.papr` App 可以直接在桌面端运行，通过 SDK 调用 Agent、LLM、存储、HTTP、文件系统等能力。

**目录结构：**

```
.CodePapr/apps/<appId>/
├── manifest.json     ← 应用元数据 + 权限 + Agent 定义
└── index.html        ← 入口 HTML（可自定义，见 manifest.entry）
```

**manifest.json 规范：**

```json
{
  "spec": "papr/0.1",
  "name": "Todo App",
  "version": "0.1.0",
  "permissions": ["storage:read", "storage:write", "agent:run:assistant"],
  "agents": [{
    "name": "assistant",
    "model": "deepseek",
    "systemPrompt": "你是一个任务管理助手",
    "tools": ["read", "websearch"],
    "maxToolRounds": 20
  }]
}
```

10 种权限：`storage:read/write`、`http:get/post`、`fs:read/write`、`llm:chat`、`workspace:read/write/exec`、`agent:run:<name>`。

**Papr SDK（`window.papr`）：**

注入到每个 app iframe 的 JavaScript SDK，提供统一 API：

| API | 说明 |
|---|---|
| `papr.db.get(key)` / `papr.db.set(key, value)` / `papr.db.delete(key)` / `papr.db.keys()` | 键值持久化存储（按 app 隔离） |
| `papr.agent.run({agent, task}, onProgress?)` | 调用 manifest 中定义的 Agent（流式事件 + steps 追踪） |
| `papr.http.get(url)` / `papr.http.post(url, body)` | HTTP 请求 |
| `papr.fs.readFile(path)` / `papr.fs.writeFile(path, content)` / `papr.fs.list(path)` / `papr.fs.delete(path)` | 文件读写（限定 .CodePapr/apps/<appId>/data/） |
| `papr.app.info()` | 获取应用元数据 |

**IPC 桥接：** iframe 内 SDK 通过 `window.parent.postMessage()` 发送 `{__papr:true, reqId, type, payload}` 协议消息，React 主窗口 `usePaprBridge` hook 监听 → 权限首检 → 路由到 `invoke()`（Rust）或 Worker（Agent）。

**权限系统（两层）：**

1. **React 首检** — `usePaprBridge` 根据 manifest.permissions 做快速拒绝
2. **Rust 权威** — 每个 `papr_*` Tauri 命令开头调 `check_permission(manifest, capability)`，即使绕过 SDK 直接 postMessage 也被拦截

工具权限映射（`check_tool_permission`）：`read/grep/list` → `workspace:read`、`write/edit` → `workspace:write`、`bash` → `workspace:exec`、`websearch/webfetch` → `http:get`。

**App Agent 系统：**

与内置子代理（explore/scout/mentor）独立，走专用 Agent loop：
- manifest `agents[].tools` 声明白名单（仅 15 个允许工具）
- Worker 端 `handleRunAppAgent` 构建完整 `Session`（`ImmutablePrefix` + `AppendOnlyLog` + `ToolRegistry`）
- 走 `Agent.chat()` 多轮工具循环（`maxToolRounds` 默认 20，上限 50）
- 三层 300s **空闲**超时（iframe SDK / 主线程 `WorkerBackedAgent` / Worker `withIdleTimeout`）：任一流式事件到达即重置定时器，持续有产出的长任务不会被掐断，仅当连续 300 秒无任何事件才判定挂起。工具 IPC proxy 到主线程
- 流式事件通过 `app-agent-stream` 消息转发到 iframe

**协议层 SDK 注入：** `app_runtime.rs::handle_app_protocol` 在返回 HTML 时自动在 `<head>` 后注入 `<script src="__papr_sdk.js">`，SDK 内容编译时嵌入 Rust binary（`include_str!`）。

**Rust 模块（`papr_runtime/`）：**

| 文件 | 责任 |
|---|---|
| `manifest.rs` | manifest 加载、校验、缓存 |
| `permission.rs` | 权限矩阵 + 工具权限映射 |
| `sdk_inject.rs` | SDK 注入 HTML 响应 + SDK 文件服务 |
| `app_context.rs` | app_id → workspace_path 内存注册表 |
| `app_storage.rs` | `papr_storage_*` Tauri 命令（权限校验 + SQLite CRUD） |
| `services.rs` | `papr_http_*` / `papr_fs_*` Tauri 命令（权限校验 + fs/http 操作） |
| `protocol.rs` | postMessage 协议类型（预留） |

**存储隔离：**

```
papr.db.set('key', value) → project.sqlite.app_storage(app_id, key, value)
```

不同 app 同名 key 完全隔离，通过 `app_id` 主键前缀保证。

**App 管理工具：**

LLM 可通过 4 个工具管理 app 生命周期（在 `workspaceTools.ts` 注册为 merge tool）：

| 工具 | 参数 | 功能 |
|---|---|---|
| `app_list` | 无 | 列出所有已注册 app（appId、title、hasBackend、isRunning） |
| `app_start` | `appId` | 启动后端服务（检查端口 → `start_workspace_background_command` → `setAppRunning`） |
| `app_stop` | `appId` | 停止后端服务（`stop_background_process` → `setAppStopped`） |
| `app_delete` | `appId` | 彻底删除（停止 + `papr_delete_app` 删文件 + `closeApp`） |

**AppDockPanel — 应用管理面板：**

应用列表 + 底部固定按钮栏。列表项：绿/红状态圆点 + emoji 图标 + app 名称。底部栏：▶ 启动 / 打开 / ■ 停止 / 🗑 删除。按钮根据选中 app 的状态自动启用/禁用。纯前端 app 的"打开"始终可用；后端 app 的"打开"仅在已启动时可用。

**权限分级（4 级）：**

app 可通过 manifest 的 `level` 字段声明权限级别：

| Level | 名称 | 可用能力 |
|---|---|---|
| L0 | 纯计算 | 无外部访问，仅 HTML/CSS/JS 渲染 |
| L1 | Runtime（默认） | `papr.db` + `papr.fs` + AI Agent（只读工具：read/grep/list/lsp） |
| L2 | 联网 | + `papr.http` + Agent 联网搜索 + MCP 工具 |
| L3 | 系统 | + 文件写入/终端/Git。需用户在设置中全局开启 |

权限解析：`effective_level = min(manifest.level, user_override, global_allowLevel3_switch)`。设置面板新增 **App Tab**（`AppPermissionsTab.tsx`）：全局默认级别选择器、Level 3 全局开关、逐 app 覆盖下拉框。

**后端 URL 注入：**

`handle_app_protocol` 检测 manifest 中的 `port` 字段，在 HTML 响应中注入 `window.__PAPR_BACKEND_URL = 'http://localhost:{port}'`。生成的后端 app HTML 使用 `const API = window.__PAPR_BACKEND_URL || ""` 作为 API base URL。SDK 的 `papr.app.info()` 返回 `backendUrl` 字段。前端始终通过 `codepapr-app://` 协议加载（SDK 自动注入），后端只提供 API 端点。

**CSP 修复：** `tauri.conf.json` 的 `frame-src` 和 `script-src` 中添加 `codepapr-app:` 协议，解决 iframe 加载自定义协议 URL 时被 CSP 拦截导致白屏的问题。

## 5. 角色与语音系统

### 5.1 角色扮演

角色系统允许用户创建、导入和激活 AI 角色，激活后角色人设会被注入到 LLM 系统提示词中。

**角色数据结构（CharacterProfile）：** 名称、头像、描述、个性、场景、开场白、示例对话、系统提示词、标签、创作者、版本号。

**核心能力：**
- **手动创建角色**：填写名称、描述、个性、场景、开场白、示例对话等字段
- **导入角色卡**：支持 PNG（嵌入 chara-card-v3 JSON）和 JSON 文件的导入，兼容 SillyTavern 等工具的 CCv3 规范
- **导出角色卡**：将角色导出为 PNG 角色卡，JSON 写入 tEXt/iTXt chunk
- **启用角色**：激活后，角色人设通过 `buildCharacterSystemPrompt()` 注入到 Session Bootstrap 中，不进入 ImmutablePrefix（不破坏缓存）

**角色扮演格式约定：** 系统提示词要求 LLM 将动作/叙述用 `*星号*` 包裹（不朗读），纯文本直接对话（可朗读），`**加粗**` 表示重读（朗读时加重），`（括号）` 表示语气提示（不朗读）。

### 5.2 语音合成（TTS）

语音系统基于 GPT-SoVITS 实现本地语音克隆与实时合成。

**架构：**
```
ChatPanel → useTtsPlayer hook → Rust TTS Module → GPT-SoVITS Python Server → rodio 播放
```

**关键组件：**
- **Rust TTS 模块**（`tts/`）：管理 Python server 进程生命周期、HTTP/WebSocket 合成请求、rodio 音频播放、模型管理、微调、训练数据生成
- **useTtsPlayer hook**（React）：流式文本输入、句子分割、队列管理、播放模式切换
- **TtsInstaller 组件**：一键安装 GPT-SoVITS（克隆仓库、pip 安装、下载预训练模型）
- **TtsPanel 组件**：TTS 服务器状态指示

**播放模式：**

当前 UI 采用 `ws-batch`（WebSocket 批量流式）作为默认且唯一实际生效的模式：所有句子通过一条持久 WebSocket 连接批量发送、逐个返回，首字延迟约 1-2 秒。代码层保留了 `whole`、`streamed-pipeline`、`streamed-pcm` 三种模式，但设置面板暂未开放切换，用户无需关注。

**语音配置（VoiceConfig）：**
- 参考音频（`referenceSamplePath`）+ 文本（`referenceText`）用于声音克隆
- 语速（`speed`，0.5-2.0）、采样步数（`sampleSteps`，仅 4/8/16 三档：4=极速、8=均衡、16=最高质量）、句数合并（`sentencesPerChunk`，1-5）
- 支持微调模型（`fineTunedModelPath`）：自动生成训练数据 → 后台微调 → 产出 .pth 模型

### 5.3 字幕交互

语音播放过程中，当前被朗读的段落会在聊天界面高亮。每条 AI 回复旁提供重播按钮，可重新朗读该条内容。若需中断，取消当前 Agent 消息即可停止朗读。Apple Silicon Mac 用户可在角色编辑面板手动点击"GPU 预热"，提前编译 Metal kernel，避免首次合成卡顿 5-15 秒。

## 6. 子代理

### 6.1 内置子代理

| Agent | 用途 | 模型 | 工具 |
|-------|------|------|------|
| explore | 只读代码分析 | fast | read, read_image, list, graph, glob, lsp, diagnostics, grep |
| scout | 网页搜索 + 下载 | fast | websearch, webfetch, browser, read_image |
| mentor | 架构/算法指导 | 可配置独立模型 | 无 |

> **主代理工具集**：主代理拥有全部读写/执行工具（read/write/edit/patch/grep/glob/list/lsp/lsp_edit/diagnostics/git/bash/browser/webfetch/skill/question/todo/task 等），但 `graph` 对其**软隐藏**——项目结构与符号导航改由 `list` + `lsp` 承担，跨模块依赖/影响分析则委派给 Explore。`graph` 的定义与 handler 仍保留注册，子代理（Explore）可经白名单选取并执行。

> Goal 自主循环的验收器（Verifier）是一个独立的无工具模型调用，在高级设置中配置（`verifierModelTier`），不属于内置子代理，也不经 `task` 工具暴露。

`task` 工具只暴露 `mode` 为 `subagent` / `all` 的 agent；`mode: primary`（仅作 @ 提及主代理）与 `internal: true` 的 agent 都不会出现在委派列表。

### 6.2 子代理的独立上下文

**每个子代理拥有全新的 Session**，不继承主 Agent 的历史对话：

- 创建全新的 `AppendOnlyLog` — 空白日志
- 工具集按定义中的白名单过滤（Explore 有 8 个工具）
- 只接收 `task.prompt` 传入的任务描述作为唯一下文
- 嵌套深度上限可配置（`subagentMaxDepth`，默认 2；explore/scout 可分别用 `exploreMaxDepth` / `scoutMaxDepth` 覆盖）

设计意图：子代理是"专注执行一条任务的无状态工人"，不受主 Agent 上下文窗口污染。

**单一逻辑来源**：主线程（`uiTaskTool.ts`）与 Worker（`agentRuntime.worker.ts`）两条子代理路径共享 `@codepapr/core` 的 `subagentConfig.ts`——`resolveSubagentExecution`（解析模型路由/参数/深度/轮数/mentor 配置）与 `runSubagentSession`（构建 Session + Agent 并执行）。两条路径仅注入差异部分：ToolRegistry（直接执行 vs IPC）与 Provider（含 mentor 构建），避免逻辑漂移。

### 6.3 模型路由

子代理通过 `selectSubagentExecutionRoute` 选模型：
- 子代理定义的 `model: 'fast'` → 快速模型（默认 deepseek-v4-flash）
- 任务包含执行动词（fix/implement/build）→ 主模型
- Mentor 默认使用主模型，可配置独立 API key 和模型；未单独配置 API key 时回退到主 API key
- 自定义子代理在 frontmatter 声明的 `temperature` 会生效（作为路由温度），explore/scout 各有默认温度（0.5 / 0.3）
- Explore / Scout 支持按设置里的 `exploreModelTier` / `scoutModelTier` 在 `primary` 与 `fast` 之间切换

### 6.4 子代理超时保护

子代理无需等待永久——多层超时机制确保及时止损：

- **单次工具调用 90 秒超时**：`Agent.ts` 中每次 `toolRegistry.execute()` 由 `withTimeout` 包裹，超时返回 `{ error: '工具执行超时' }` 给 LLM 自主决策
- **子代理整体 wall-clock 超时**：`subagentConfig.ts` 的 `runSubagentSession` 内置超时（Worker 路径 5 分钟），超时调用 `agent.cancel()` 终止循环
- **Worker IPC 120 秒超时**：`requestToolExecution` 的 Promise 内置超时清理 waiter，防止主线程不回信时永久挂起
- **App Agent 300 秒空闲超时**：`papr.agent.run` 链路三层（iframe SDK、主线程 `WorkerBackedAgent`、Worker `withIdleTimeout`）均为空闲语义——每收到一个流式事件就重置定时器，任务持续产出即可运行任意时长；仅当连续 300 秒无任何事件才超时终止

超时不是静默失败——错误信息会返回给 LLM，LLM 可看到超时原因并自行决定重试、换策略、或向用户汇报。

## 7. TodoList

### 7.1 设计定位

TodoList 是主 Agent 的"短期工作记忆"，替代了旧的三工具（todo_write/todo_update/todo_complete）和旧的编排系统（agentOrchestration.ts）。

### 7.2 单工具两种模式

```
todo 工具
├── tasks 参数 → 全量覆盖（初始化 / re-plan）
└── updates 参数 → 部分更新（进度汇报 / 完成标记 / 失败报告）
```

- 标记任务 completed 时自动推进到下一条 pending 任务
- 失败任务按 maxRetries 自动重试（可配置，默认 3 次）
- 每次调用返回完整 TodoList 快照，LLM 无需依赖系统提示词就能看到当前状态

### 7.3 与 task 工具的分工

- `todo`：维护主 Agent 自己的计划
- `task`：把单条任务委派给子代理执行
- 两者正交协作，不冲突

### 7.4 UI 交互

- **TaskChecklist** 组件实时展示任务进度条和状态
- 只显示标题（不显示描述和状态标签），紧凑布局
- **自动折叠**：全部完成后 + Agent 停止时自动折叠为一行摘要
- **自动展开**：新任务到达或状态更新时自动展开
- 手动点击可展开/折叠

### 7.5 对话重置（Shadow Git 回退）

Hover 用户消息 → 显示"重置到此点"按钮：

- **Shadow Git 架构**：CodePapr 在 `.CodePapr/git/` 维护独立的内部 Git 仓库（不与用户项目的 `.git` 冲突），所有 git 操作通过 libgit2 实现，**不依赖系统 Git CLI**
- **快照引擎**：每次用户发消息时，`IgnoreResolver`（`ignore` crate）遍历工作区文件（自动排除 `node_modules/`、`dist/`、大文件等），通过 `index.add_path` 逐文件创建快照 commit，验证文件数量 > 0
- **恢复引擎**（三阶段）：`restore_plan` 计算文件变更 → 显示预览（恢复/删除/不变文件数） → 用户确认 → `restore_execute` 执行（创建备份 ref `refs/codepapr-backup-before-reset` + 拒绝空 tree）
- **撤销**：`restore_undo` 通过备份 ref 恢复到 reset 前的状态
- **消息截断**：删除该消息之后的所有对话；回填被截消息的输入内容和图片
- **Checkpoint Timeline**：`project.sqlite` 中的 `checkpoint_timeline` 表记录每次快照的 message_id、sha、文件数、时间戳
- **确认对话框**：防止误操作

## 8. 项目记忆系统 (Project Memory)

### 8.1 设计定位

`.CodePapr/memory.md` 是项目的**跨会话长期记忆**，区别于 TodoList（短期工作记忆）和 ProjectGraph（语义索引）。它存放：

- 用户画像与偏好（语言、工具链、代码风格）
- 项目约定（构建/部署/配置约定）
- 错误模式与解法（同一错误多次踩坑的应对）
- 架构决策原因
- 经验教训

### 8.2 写入机制

Agent 没有专用的 memory 工具--通过 prompt 约定，让 Agent 在以下场景下用通用 `write` 工具追加条目：

1. 发现项目目录结构、技术栈、构建/lint/test 命令等值得跨会话复用的事实
2. 同一错误在本次会话中踩了两次
3. 发现项目特有的构建/部署/配置约定
4. 用户明确要求记住

每条以 `## YYYY-MM-DD 主题` 起始，纯 Markdown，可手动编辑。

> 写入条件刻意放宽：项目结构、构建命令等"项目特定事实"是跨会话复用价值最高的内容，不应归为"常规发现"被禁止写入。通用知识与临时状态仍不写入。

### 8.3 加载机制

会话启动时，`agentStore.sendMessage` 调用 Tauri `read_text_file` 读取 `.CodePapr/memory.md`（上限 50KB），结果通过 `buildSessionBootstrapPrompt` 注入第二层 Session Bootstrap，不进入 ImmutablePrefix。这样：

- Memory 内容变化不会破坏 system prompt 缓存
- 所有会话启动时都是一次性全量加载，不做按需检索（保持简单）

**冷启动自动生成**：若读取发现 `memory.md` 不存在或为空，且 ProjectGraph 缓存摘要可用，则在后台异步触发 `bootstrapMemoryContent`：用快速模型基于 ProjectGraph 摘要 + 项目规则 + 用户首条消息生成初始记忆（项目结构/技术栈/构建命令/关键约定），写入 `.CodePapr/memory.md`。该任务 fire-and-forget，不阻塞当前会话；用模块级 `memoryBootstrapInFlight` 标志防重入。若 ProjectGraph 缓存也为空则跳过，等下次会话。这避免了"每次都从零探索项目"的冷启动死循环。

### 8.4 自动整理

Memory 文件单调增长，需要周期性整理避免膨胀。三个触发点：

| 触发 | 时机 | 行为 |
|---|---|---|
| T1 | session 启动，读完 memory.md | 行数 > 200 → 标记 `_pendingMemoryConsolidation = true` |
| T2 | 上下文压缩成功（自动或 `/compact`） | 同上标记 |
| T3 | 每次 agent 回复完成后 | pending? → 异步整理 → 写回文件 |

### 8.5 整理流程

整理是 fire-and-forget 的异步任务，不阻塞当前会话：

```
agent 回复完成
  └─ pending? → 关标记 → 重读 memory.md（获取最新内容）
                 ├─ 仍 > 200 行？
                 │    ├─ 是 → 调 fast model 整理（合并/去重/压缩）
                 │    │       ├─ 成功 → write_text_file 写回
                 │    │       └─ 失败 → 规则降级（按 `## ` 分节去重 + 按日期排序截断）
                 │    └─ 否 → skip（agent 期间已自行精简）
                 └─ 静默 catch，不影响主流程
```

整理用的 fast model 路由复用 `selectContextCompactionModelRoute`，与上下文压缩共享配置（`compactionModel` / `compactionMaxTokens` / `compactionTemperature`）。

### 8.6 关键不变量

- **不新增工具**：所有读写都走通用 `read_text_file` / `write_text_file` Tauri 命令；模型不感知整理逻辑，无 prefix 变更
- **不破坏缓存**：整理永远在 agent 回复**之后**触发，写回的新 memory 在下次会话启动时才被加载；当前会话的 ImmutablePrefix 不受影响
- **当前会话用旧记忆**：异步整理意味着收益延迟到下次会话；好处是启动延迟为零，且整理质量低的风险被隔离
- **静默降级**：LLM 失败 → 规则去重（按标题去重、按日期保留最近的，截断到 200 行）；规则降级也失败 → 保持原文件不动

### 8.7 关键源码定位

- `packages/@codepapr/ui/src/utils/memoryConsolidation.ts`：整理逻辑、冷启动生成、三语 prompt、LLM 调用、规则降级
- `packages/@codepapr/ui/src/store/internals/types.ts`：`_pendingMemoryConsolidation: boolean` 状态
- `packages/@codepapr/ui/src/store/agentStore.ts`：三个整理触发点（启动/压缩/回复后）+ 冷启动生成触发点（启动读取后）
- `packages/@codepapr/core/src/agent/promptSystem.ts`：写入条件 prompt、Memory section 的 bootstrap 渲染

## 9. ProjectGraph 语义分析

### 9.1 工具定义

`graph` 是统一的项目语义图工具，通过 `action` 参数选择操作。**对主代理 LLM 软隐藏**：主代理侧的代码智能改由 `lsp` 工具（9 个导航 action，LSP 优先、AST 项目图兜底）与 `list`（目录树 + 逐文件轻量符号）承担，跨模块依赖/影响分析委派给 Explore 子代理。`graph` 的定义与 handler 保留注册——Explore 子代理经白名单选取它做影响/依赖分析，同时服务 UI 面板并作为 `lsp` 点查询的 AST 兜底后端。

**建图缓存**：UI 侧 `buildIntelligenceProjectGraph`（workspaceTools.ts）缓存完整建图结果——以“建图参数 + 工作区”为键，TTL 60s，任一工作区写入经 `notifyWorkspaceMutation` 清空，同键在途构建去重、上限 3 条 FIFO 淘汰。`lookup→dependency→impact` 等连续 action 只建一次图。

**基础导航（7 个 action）：**
| Action | 功能 |
|---|---|
| `full` / `overview` | 生成完整 ProjectGraph（目录树 + 代码结构骨架 + 依赖图） |
| `lookup` | 按名称/路径查找符号 |
| `dependency` | 提取依赖子图 |
| `entrypoints` | 查找入口文件 |
| `impact` | 反向影响分析 |
| `implementations` | 查找接口/基类实现 |
| `smart_context` | 任务感知的智能上下文 |

**高级分析（6 个 action，新增）：**
| Action | 功能 |
|---|---|
| `dead_code` | 检测未使用的符号 |
| `circular_deps` | 检测循环导入依赖 |
| `type_hierarchy` | 构建类型继承层次 |
| `suggest_refactors` | 重构建议（提取方法 + 独立文件） |
| `test_impact` | 变更影响的测试选择 |
| `generate_tests` | 测试骨架生成 |

### 9.2 实现位置

- 核心函数在 `core/src/tool/workspace/graphQuery.ts`（~2,400 行）
- CLI 和 UI 分别实现 handler 分支
- Explore 子代理经白名单（`graph: true`）选取本工具，其系统提示词中列出常用 action

## 10. Prompt 组装与 DeepSeek 缓存优化

### 10.1 三层结构

**第一层：System Prompt（ImmutablePrefix）**
完全固定、跨会话复用的前缀：
1. Base Identity
2. Mode Intro（Agent/Plan/Ask 约束）
3. Workspace Path
4. Core Constraints
5. Tool Constraints（按可用工具动态生成）

**第二层：Session Bootstrap（AppendOnlyLog 首条 assistant 消息）**
跨轮次稳定：
1. Skills Section
2. Custom Guidance（用户长期偏好提示词）
3. 角色人设（当前启用的 CharacterProfile）

**第三层：Runtime User Prompt（当前轮 user 消息）**
每次用户输入时构建：
1. Mode Header
2. User Input
3. Runtime Context（日期/时区）
4. TodoList Digest（背景进度，标注"以用户最新消息为准"）

项目结构概览与项目诊断**不再注入每轮 user prompt**：user 消息位于请求尾部、永远无法命中前缀缓存，大项目下概览可达数万 token/轮。改由 agent 按系统提示词约束自行调用 `graph`（"先拿地图再行动"）/ `diagnostics`（改后终检）工具按需获取；write/edit/patch 改完仍自动返回单文件诊断。

### 10.2 关键不变量

- 用户自定义提示词进入 session bootstrap 而非每轮 user prompt
- Skills 进入 bootstrap 而非 system prefix
- 角色人设进入 bootstrap 而非 system prefix（切换角色不破坏缓存）
- ProjectGraph Summary 不进入主 Agent 每轮 user prompt（token 浪费），由 `graph` 工具按需获取；仅子代理 bootstrap 与 memory.md 冷启动生成仍使用
- Workspace 路径只在 system prompt 出现一次
- Custom guidance 只在 bootstrap 出现一次
- `topP`、`temperature`、`maxTokens`、`thinkingEnabled` 一起冻结在 ImmutablePrefix 中，任意变化都会破坏缓存 hash
- session bootstrap 按"会话 × 稳定签名"缓存，memory.md 等易变磁盘状态变化不触发重建（见 §13.6）；mid-loop 压缩时 memory 会随 bootstrap 一起刷新（反正 epoch 重写，无额外缓存代价）
- 每轮 user prompt 的动态内容（日期 / TodoList digest）置于尾部，不改既有前缀

## 11. 模型路由

当前存活的路由函数（旧规划器/总结路由已删除）：

| 场景 | 函数 | 模型 | 温度 |
|---|---|---|---|
| 主 Agent 对话 | `selectTaskModelRoute` | 主模型 | 用户配置 |
| Slash 命令（声明 `model: 'fast'`） | `selectTaskModelRoute(..., 'fast')` | 快速模型（未启用时回退主模型） | 用户配置 |
| 上下文压缩 | `selectContextCompactionModelRoute` | 快速/主模型 | 用户配置 `compactionTemperature` |
| 子代理执行 | `selectSubagentExecutionRoute` | 按任务重量判断 | 用户配置 `subagentTemperature` |
| 主模型降级 | `buildPrimaryModelRoute` | 主模型 | 用户配置 |

Slash 命令的 `model` 字段（在 `BUILTIN_PROMPT_COMMANDS` 或 `.CodePapr/commands/<name>.md` frontmatter 中声明）作为 `preferredTier` 传入路由：声明 `'fast'` 时路由到快速模型；UI 走 `selectTaskModelRoute(..., 'fast')`，CLI 走 `createEphemeralAgent` 创建临时快速 Agent。

## 12. 执行模型

### 12.1 请求链路

```
User → Surface → Agent.chat() → RequestBuilder → Provider → CacheValidator → Tool Execution → State Persist → Response
```

### 12.2 多轮工具循环

- 只要检测到 tool call，就继续下一轮
- 由 `maxToolRounds` 限制（可配置，默认 500）
- tool 结果写入 AppendOnlyLog，后续请求基于完整执行历史
- **每轮构建请求前做上下文溢出检查**：超过有效阈值则压缩（重置日志开启新 epoch）后继续，保证任何请求都不用超限上下文（见 §13.3）

## 13. 缓存优先架构（Cache-First Architecture）

CodePapr 的核心架构决策是**围绕 DeepSeek 隐式前缀缓存做提示词分区与上下文管理**。DeepSeek 按字节前缀逐字匹配自动缓存（无显式断点）：请求的 `tools → system → messages` 前缀只要与上一次逐字节相同，命中部分按缓存价计费（约 0.025 元/M），仅新增尾部按输入价计费。因此架构的第一性原则是：

> **epoch 内前缀字节稳定（只追加），epoch 之间通过压缩有意重置。**

### 13.1 三分区结构

| 分区 | 内容 | 设计目的 |
| --- | --- | --- |
| ImmutablePrefix | 系统提示词、工具定义、模型参数（含 topP/temperature/maxTokens/thinkingEnabled） | 锁定前缀字节序列，agent 生命周期内不变 |
| AppendOnlyLog | 用户消息、助手消息、工具结果 | 只追加，不可回写 |
| VolatileScratch | 临时推理、中间计划、轮次草稿 | 隔离不稳定内容，不进入请求 |

### 13.2 Context Epoch 模型

一个 **epoch** = 一个 agent 生命周期内、前缀保持字节稳定的跨度。epoch 内：

- ImmutablePrefix 不变（系统提示词无动态内容，由 `RequestBuilder.validateStaticSystemPrompt` 强制校验，禁止模板插值 / 时间戳占位等）。
- 工具定义冻结并排序（`canonicalToolDefinition` + `localeCompare`），`validateToolsImmutable` 校验逐字节不变。
- AppendOnlyLog 只追加：每一轮工具循环把 assistant 消息与 tool 结果追加到尾部，前缀（之前的所有消息）逐字节复用 → 工具循环内多次调用天然高命中。

**epoch 边界 = 上下文压缩**。压缩是**唯一**被许可的前缀重置：达到上下文阈值时，把历史摘要成 checkpoint + 保留尾部，开启新 epoch（一次性 miss，之后重新稳定累积命中）。这对齐 OpenCode 的 Context Epoch 与 Claude Code 的 auto-compact 设计。

压缩后的有效上下文 = `[checkpoint 摘要, ...保留尾部]`。checkpoint **按保留边界插入**（`planContextCompaction.insertIndex`，经 `insertCheckpointAtRetainedBoundary` 落到 UI 消息边界），而非追加到列表末尾——`buildEffectiveContextMessages` 取 checkpoint **之后**的消息作为保留尾部，因此最近若干轮（含工具调用↔结果配对）原文保留在 checkpoint 之后，只有更早的消息被摘要。保留边界在 **UI 消息粒度**选取（每个 assistant+tools 组是原子单元），不会切出孤儿 tool 消息。checkpoint 在有效上下文中以 **user 轮**发出（非 assistant），避免压缩后出现"首条 / 连续 assistant"，提升跨 provider（OpenAI / Claude）正确性；checkpoint 识别基于 `contextCheckpoint` payload，与角色无关。

### 13.3 中途溢出 → 压缩（mid-loop compaction）

工具循环内上下文会随 tool 结果增长。`Agent.chat` 在**每轮构建请求之前**做溢出检查（`estimateContextTokens`：前缀字节 + 日志字节 / 4 的粗估）：

1. 超过有效阈值（`contextCompaction.maxContextTokens`）时，调用注入的压缩 handler：
   - 把当前日志（core `IMessage`）转成 ui `ContextMessageLike`（`coreMessagesToContextMessages`，tool 结果回填到 assistant 的 `toolInvocations`，往返保真）；
   - 走与轮间压缩相同的管线（`maybeGenerateContextCheckpoint` 生成 checkpoint 摘要，并冻结当前 TodoList digest）；
   - `buildEffectiveContextMessages` 在保留边界插入 checkpoint（其后保留近期尾部原文，含工具调用）+ 剪枝尾部旧 tool 结果；
   - `Session.replaceLog` 重置日志（`AppendOnlyLog.reset` + 重载），`RequestBuilder.resetLogTracking` 重置 append-only 跟踪避免误报；
   - 合并压缩的 cacheStats，发出 `context-compacted` 流事件，循环继续。
2. **检查时机：仅轮首**。tool 结果在一轮末尾追加，其导致的超限在**下一轮轮首**被拦截——任何 LLM 请求都不会用超限上下文发送；工具调用任务在压缩后基于"摘要 + 近期尾部"继续。
3. **不在工具执行中途压缩**：一轮内多个工具调用原子执行完再到轮边界压缩，避免破坏"工具调用↔结果"配对。
4. **防死循环**：`lastCompactionRound` 保证两次压缩至少间隔 2 轮；handler 返回 null 不重置。
5. **防御纵深**：`toolOutputTruncation` 把单个 tool 结果限制在 ~100KB（或落盘留预览），单轮增长有界，不会单轮撑爆 provider 硬上限。中间截断保留字符数默认为 20k，可通过 `toolOutputMiddleKeepChars` 配置。工具上下文模式（完整/摘要/自动，默认完整）不影响当轮——工具结果始终以全文（受本截断管线约束）发给 LLM；它只控制结果变成历史后是否替换为冻结摘要，见 §13.10。

### 13.4 剪枝是压缩的子步骤（非独立机制）

`pruneOldToolResults` 把超出保护窗口（`pruneProtectRounds`，默认 6 轮）的大块旧 tool 结果（≥ `pruneMinChars`，默认 20KB）替换为占位符。它**没有独立触发器**，只在 `buildEffectiveContextMessages`（压缩 / 重建时）作为压缩的内部瘦身子步骤执行（对齐 OpenCode 的 `SessionCompaction.prune`）。触发器只有上下文阈值一个：

```
上下文达到阈值 → 压缩(shouldCompact) → 重建 agent → buildEffectiveContextMessages 末尾剪枝
```

压缩摘要掉头部旧消息（含旧 tool 结果），剪枝给保留尾部瘦身。剪枝设置（`pruneOldToolResults` / `pruneProtectRounds` / `pruneMinChars`）为内部调参，不在 UI 暴露。注意它与 `compactionMaxTokens`（压缩摘要的输出上限）是两个不同概念：后者是压缩那次 LLM 调用能写多长的摘要，不是触发阈值。

### 13.5 有效上下文阈值（用户配置优先）

`maxContextTokens`（默认 **500K**）是压缩触发阈值，对 DeepSeek / OpenAI 兼容 / Claude 三种服务商**统一生效**，不再按 provider 硬上限钳制（`effectiveMaxContextTokens`）：

```
effectiveMaxContextTokens = maxContextTokens
```

OpenAI/Claude 兼容端点常是转发网关（如 OpenAI 网关转发 DeepSeek 大上下文模型），按名义服务商钳制会导致长任务频繁触发压缩；上限由用户对该配置项的取值负责（设置 → 高级 → 最大上下文(输入)）。

阈值越高 → 压缩越少 → epoch 重置越少 → 命中率越高（缓存读取廉价）。该有效值同时用于轮间压缩（`planContextCompaction`）与中途溢出检查。

### 13.6 前缀稳定性保障（避免每轮断前缀）

以下措施确保 epoch 内前缀逐字节稳定（任一破坏都会从破坏点起整段 miss）：

| 保障 | 实现 |
| --- | --- |
| 无每请求前缀改动 | 剪枝只在压缩 / 重建时执行，不在每次请求构建时滑动剪枝 |
| 重建序列化字节一致 | `toCoreTailMessages` 对象 tool 结果用 `sortedStringify`（与实时路径 `Message.tool` 一致）；空助手内容为 `''`（非 `' '`） |
| 降低重建频率 | session bootstrap 按"会话 × 稳定签名"缓存（`resolveSessionBootstrap`）；memory.md 等易变磁盘状态变化不触发重建；mid-loop 压缩时 memory 随 bootstrap 一起刷新（利用 epoch 重写窗口，零额外代价） |
| reasoning 回传稳定 | `reasoning_content` 按"是否存在 + 模型能力（`supportsThinkingPayload`）"回传，与每请求 thinking 开关解耦，避免重建时给历史消息增删 reasoning |
| TodoList digest 冻结 | checkpoint 生成时冻结当前 digest 进 payload，重建时复用而非实时重渲染 |
| 参数冻结 | topP / temperature / maxTokens / thinkingEnabled 冻结在 ImmutablePrefix，变化即换 hash |
| 动态内容置于尾部 | 每轮 user prompt 的日期 / TodoList digest 等动态内容放在新 user 消息（尾部），不改既有前缀 |
| 大体量上下文按需获取 | 项目结构概览与项目诊断不注入每轮 user prompt（尾部内容永不命中前缀缓存，大项目下每轮数万 token）；由 agent 通过 `graph` / `diagnostics` 工具按需获取 |

### 13.7 哈希与校验

- ImmutablePrefix 的 SHA256 hash 包含整个 `parameters` 对象——`temperature`、`topP`、`maxTokens`、`thinkingEnabled` 全部参与哈希。任意参数变化 → hash 变化 → 缓存 miss。
- `RequestBuilder` 8 点校验：系统提示词无动态内容、工具定义不变、运行时工具与冻结前缀一致、日志只追加（`validateAppendOnly`）、前缀未变等。
- `resetLogTracking`：压缩重置日志后重置 append-only 跟踪（`lastLogMessagesHash` / `lastLogMessageCount`），使下一次构建以新日志为基线，不误报"历史被改写"；前缀 / 工具跟踪保留（前缀未变）。
- `CacheValidator` 解析响应的 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`，归一化命中率统计。

### 13.8 已知限制

- **服务端缓存 TTL**：DeepSeek 前缀缓存有存活时间，用户长时间空闲后首次调用会重新 miss 整段前缀（ unavoidable，与客户端无关）。阈值越高，TTL 过期后的重 miss 代价越大。
- **压缩是有损的**：checkpoint 摘要会丢失部分细节；`maxContextTokens` 越高，单次压缩覆盖的历史越多，摘要压力越大。

### 13.9 与业界方案对照

| 方案 | 缓存机制 | 上下文收敛 |
| --- | --- | --- |
| OpenCode | Context Epoch + Anthropic 缓存断点（last tool / system / user message） | 每 turn 前 `isOverflow` 检查 → 压缩（含 `SessionCompaction.prune`） |
| Claude Code | Anthropic 提示缓存（前缀稳定 + 断点） | ~95% 上下文时 auto-compact 摘要 |
| CodePapr | DeepSeek 隐式前缀缓存（三分区 + epoch 内字节稳定） | 轮间压缩 + 中途轮首溢出检查 → 压缩（含剪枝子步骤） |

共同原则：**用"溢出触发的压缩"约束上下文，压缩之间保持前缀字节稳定；绝不每轮改动已发送前缀。**

### 13.10 工具上下文模式（当轮全文 / 历史摘要）

工具上下文模式（`toolContextDefaultMode` / `toolContextOverrides`，默认 `full`）控制工具输出**变成历史上下文后**的形态，与「发给 LLM 的内容」解耦：

- **当轮永远全文**：工具结果产生时始终以全文进入日志与当前请求（大小由截断管线约束：60k 中间截断 / 100k 落盘 / 150k 硬上限），LLM 完整见过每一条结果并据此推理。
- **写入时冻结摘要**：模式判定需摘要时（`summary`；或 `auto` 且原始字符数 > `toolContextAutoThresholdChars`，默认 5k），写入时一次性计算摘要并冻结进 `message.metadata.toolSummary`。交互类工具（question / todo / skill / task）永不摘要。摘要不是内容切片，而是结构化卡片：`[工具] ✓/✗ | 关键参数` → `规模统计（基于原始输出）` → `头尾预览（前 3 行 + 后 3 行，各 ≤150 字符；≤6 行时单块展示）` → `完整输出: {落盘路径}（可用 read 回读）`（仅当截断管线已落盘，复用其路径不重复写盘），整卡钳制于 `toolContextSummaryMaxChars`（默认 500）。各工具卡片字段：read 带路径与行范围/符号后缀，bash 带命令，edit/patch 带 `-删/+增` 字符数，grep/glob 带 query 与匹配数。
- **请求构建时翻转**：`RequestBuilder` 组装消息时调用纯函数 `applyHistoryToolSummaries`：带冻结摘要的工具消息中，**最新一批**（最后一个带 toolCalls 的 assistant 轮的工具结果）保持全文，其余替换为冻结摘要；只改请求副本，不改 AppendOnlyLog。
- **缓存行为**：翻转点永远贴着尾部，每轮 miss 后缀是有界小常量（一条翻转消息 + 一轮新内容），之前的「摘要稳定区」随对话增长并照常命中；每条消息只翻转一次，仅产生一次性前缀缓存失效——不同于已移除的旧滑动窗口裁剪（窗口每轮移动，每轮整体重缓存保护窗口）。
- **实时/重建字节一致**：冻结摘要随流事件 `contextSummary` 进入 `UIToolInvocation` 持久化；重建时（`buildEffectiveContextMessages`）回填 metadata 并应用同一纯函数规则。与剪枝分层：占位符（最老，剪枝时同时删除摘要，防止复活）< 摘要（中青年）< 全文（最新批）。
- **可进可退**：`full` 不产生冻结摘要，等价纯追加 + 完美缓存（默认值，开箱与旧版零差异）；`summary` / `auto` 启用滚动摘要，按工具 override 启用（内置逐工具默认表已移除，一切随 defaultMode）。

## 14. Settings 结构

设置面板分为六个 tab，完整参数参考 `packages/@codepapr/core/docs/CONFIGURATION.md`：

| 标签页 | 内容 |
|---|---|
| General | 语言选择、调试开关、许可证 |
| LLM | API 类型、模型名称、fast 模型、temperature、topP、maxTokens、thinking 模式、maxToolRounds |
| Search | 自部署 SearXNG 优先，失败自动降级到内置多源聚合；搜索引擎选择器已移除；分类/时间/语言/安全搜索等高级参数收入折叠区 |
| Mentor | Mentor 子代理独立 API key、Base URL、模型选择 |
| 高级 | 上下文压缩（模型/温度/摘要输出 token/上下文上限/对话轮数）、TodoList 最大重试、ProjectGraph 深度/文件限制、流式与工具输出（流空闲超时、中间截断保留字符数）、工具上下文模式（完整/摘要/自动，默认完整；当轮始终全文，仅历史上下文按模式摘要，见 §13.10）。上下文上限 `maxContextTokens` 默认 500K，实际生效值按所选服务商上下文上限自动钳制（见 §13.5） |
| App | .papr 应用权限管理——全局默认级别、Level 3 全局开关、逐应用级别覆盖 |

语音配置不在主设置面板，而是在角色编辑面板（CharacterModal 的 Voice Tab）中按角色独立设置。

## 15. 项目统计系统

项目统计弹窗（`ProjectStatsModal`）提供两类视图：**代码库统计**与 **Agent 贡献统计**。

### 15.1 原生 Rust 统计引擎

代码库统计由 Rust 命令 `compute_project_stats`（`workspace_fs/stats.rs`）一次性计算，替代了早期"前端逐文件经 IPC 读取"的慢方案：

- **gitignore-aware 并行遍历**：复用搜索模块的 `ignore::WalkBuilder`（`.git_ignore(true).git_exclude(true).ignore(true)` + `should_ignore_dir` 过滤），`build_parallel()` 多线程遍历，与项目实际 `.gitignore` 一致（而非硬编码忽略列表）。
- **语言检测**：`language_from_path`（移植自 `editorLanguage.ts`）按文件名特例（dockerfile/makefile/.env 等）与扩展名映射语言 id。
- **code/blank/comment 分类**：每语言注释语法表（`//`、`#`、`--`、`;`、`/* */`、`<!-- -->`、`""" """` 等）+ 跨行块注释状态机；代码+行尾注释的混合行计为代码（cloc 惯例）。
- **二进制排除**：`decode_text_bytes` 拒绝二进制文件（计入 skipped）。
- **聚合**：按语言/顶层目录/文件大小分桶聚合，计算最大文件、平均/中位/最大行数、代码/配置/文档占比。
- **结果结构**：`#[serde(rename_all="camelCase")]` 镜像前端接口，含 `blankLines`/`commentLines` 及每语言 code/blank/comment。

前端 `loadProjectStats` 单次 `invoke('compute_project_stats')` 获取结果，仅在前端补充语言显示名（`formatLanguageLabel`）。

### 15.2 前端可视化与交互

- **目录 Treemap**：自绘平衡分割算法 `computeTreemap`（按行数加权、沿长轴递归对半切分，无第三方依赖）；色块按面积占比渲染，悬停高亮/淡出 + tooltip。
- **可排序/可筛选语言表**：`LanguageTable` 列头点击排序（语言/文件/行数/代码行/空行/注释行，升/降序），语言筛选输入框，行悬停高亮；顶部保留堆叠比例条。
- **结果缓存 + 时间戳**：模块级 `statsCache` 先展示缓存、后台刷新（失败回退缓存不报错），头部显示"统计于 HH:MM:SS"。
- **动效**：分区错峰渐显（`statsReveal`）、treemap 色块弹入（`treemapPop`）、条形生长（`barStretch`），见 `index.css`。

### 15.3 Agent 贡献统计

`AgentContribution` 组件复用**已有后端命令**（无需新 Rust 代码）计算 Agent 改动量：

- **数据来源**：影子 Git 仓库（`.CodePapr/git`）的 checkpoint。每次用户消息触发 `snapshotCreate` 并写入 `checkpoint_timeline` 表。
- **累计贡献**：`loadCheckpointRecords` 取全部检查点，`diffSnapshots(首个 checkpoint → HEAD)` 得到改动文件与增删行数（`FileDiff.additions/deletions`）。
- **展示**：累计卡片（改动文件/新增行/删除行/净增行）、改动最多的文件 Top 8（按 churn 排序，绿/红条）、会话活动（每会话检查点数 + 时间范围）。
- **说明**：基于 Git checkpoint 的累计改动，含 Agent 与手动编辑；无检查点时优雅降级。

### 15.4 工具调用统计

`ToolUsageStats` 组件从 `agentStore.sessionMessages` 聚合全部会话的工具调用记录（`toolInvocations`），服务于工具设计决策：

- **聚合**：`aggregateToolUsage` 按工具名统计调用次数与成功/失败数，按调用次数降序排列。
- **展示**：横向条形图（条形长度按调用次数相对最大值缩放）+ 调用次数 + 成功率（≥90% 绿 / ≥60% 黄 / 其余红）；顶部汇总总调用次数与工具种类数。
- **用途**：直观看出哪些工具高频使用、哪些很少甚至从未被调用（从未调用的工具不会列出），辅助评估工具设计的合理性。

弹窗整体放大至 `w-[min(96vw,1280px)] h-[90vh]`（略小于主界面），并采用多列网格布局（语言表 + 工具统计双列、指标三联、文件大小双列）充分利用宽度。

## 16. 关键源码定位

- `packages/@codepapr/core/src/agent/Agent.ts`：核心工具循环与会话执行入口
- `packages/@codepapr/core/src/agent/Session.ts`：会话对象与分区聚合
- `packages/@codepapr/core/src/agent/promptSystem.ts`：三层 prompt 组装 + MODE_INTROS + 角色人设注入
- `packages/@codepapr/core/src/agent/todoList.ts`：TodoList 核心逻辑
- `packages/@codepapr/core/src/agent/agentConfig.ts`：BUILTIN_AGENTS 定义
- `packages/@codepapr/core/src/cache/`：三分区缓存核心（`AppendOnlyLog.reset` 用于压缩开启新 epoch）
- `packages/@codepapr/core/src/tool/pruneToolResults.ts`：旧 tool 结果剪枝（压缩子步骤）
- `packages/@codepapr/core/src/tool/workspace/graphQuery.ts`：ProjectGraph 查询引擎（14 个 action，对 LLM 隐藏，供 UI 与 lsp AST 兜底）
- `packages/@codepapr/api/src/request/RequestBuilder.ts`：请求构造（8 点校验 + `resetLogTracking`）
- `packages/@codepapr/api/src/response/CacheValidator.ts`：响应校验
- `packages/@codepapr/ui/src/agent/compactionHandler.ts`：中途压缩 handler + core↔ui 消息转换
- `packages/@codepapr/ui/src/utils/contextLimits.ts`：`effectiveMaxContextTokens`（provider-aware 有效阈值）
- `packages/@codepapr/ui/src/utils/contextCompaction.ts`：压缩计划 / checkpoint / `buildEffectiveContextMessages`
- `packages/@codepapr/ui/src/store/internals/contextCheckpoint.ts`：checkpoint 生成（`maybeGenerateContextCheckpoint`）
- `packages/@codepapr/ui/src-tauri/src/workspace_fs/stats.rs`：原生项目统计引擎（语言检测 + code/blank/comment 分类 + 并行遍历聚合 + `compute_project_stats`）
- `packages/@codepapr/ui/src/components/ProjectStatsModal.tsx`：项目统计弹窗（treemap、可排序语言表、结果缓存）
- `packages/@codepapr/ui/src/components/AgentContribution.tsx`：Agent 贡献统计（checkpoint diff）
- `packages/@codepapr/ui/src/components/ToolUsageStats.tsx`：工具调用统计（按调用次数/成功率聚合）
- `packages/@codepapr/ui/src/utils/snapshot.ts`：checkpoint / diff 的 invoke 封装
- `packages/@codepapr/ui/src/store/agentStore.ts`：桌面端主编排器（含 memory 整理三个触发点）
- `packages/@codepapr/ui/src/store/permissionStore.ts`：外部路径访问权限管理
- `packages/@codepapr/ui/src/store/toastStore.ts`：全局 Toast 通知
- `packages/@codepapr/ui/src/store/reviewStore.ts`：代码审查状态
- `packages/@codepapr/ui/src/store/charactersStore.ts`：角色 CRUD 状态管理 + 持久化
- `packages/@codepapr/ui/src/utils/memoryConsolidation.ts`：记忆整理逻辑（LLM + 规则降级）
- `packages/@codepapr/ui/src/utils/codeReview.ts`：代码审查工具函数与类型
- `packages/@codepapr/ui/src/utils/characterTypes.ts`：CharacterProfile / VoiceConfig 类型定义
- `packages/@codepapr/ui/src/utils/characterCard.ts`：CCv3 角色卡 PNG 导入/导出
- `packages/@codepapr/ui/src/hooks/useTtsPlayer.ts`：TTS 播放器 hook（流式文本输入、队列管理）
- `packages/@codepapr/ui/src/hooks/useTtsPlayer.helpers.ts`：TTS 文本解析辅助函数
- `packages/@codepapr/ui/src/components/CharacterModal.tsx`：角色管理 UI（创建/编辑/导入/导出/语音配置）
- `packages/@codepapr/ui/src/components/TtsInstaller.tsx`：GPT-SoVITS 一键安装向导
- `packages/@codepapr/ui/src/components/TtsPanel.tsx`：TTS 服务器状态指示器
- `packages/@codepapr/ui/src/components/ChatPanel.tsx`：聊天界面（含角色头像、TTS 朗读）
- `packages/@codepapr/ui/src/components/ConversationRoundsIndicator.tsx`：对话轮次导航指示器（悬停展开面板、点击跳转）
- `packages/@codepapr/ui/src/components/ConversationSearch.tsx`：全局搜索面板（对话搜索 + 文件搜索双 Tab、Portal 渲染、键盘导航）
- `packages/@codepapr/ui/src/components/AgentOpsPanel.tsx`：顶部工具栏（含全局搜索入口、空闲状态指示）
- `packages/@codepapr/ui/src/agent/WorkerBackedAgent.ts`：Worker 桥接（含崩溃恢复与 stream snapshot）
- `packages/@codepapr/ui/src/tools/workspaceTools.ts`：桌面端工具注册（含合并工具）
- `packages/@codepapr/ui/src/tools/todoListTool.ts`：TodoList UI 桥接
- `packages/@codepapr/ui/src/tools/uiTaskTool.ts`：子代理调度工具
- `packages/@codepapr/ui/src/components/TaskChecklist.tsx`：任务清单 UI
- `packages/@codepapr/ui/src/components/CodeReviewPanel.tsx`：可视化代码审查面板
- `packages/@codepapr/ui/src/components/PermissionDialog.tsx`：外部文件访问授权弹窗
- `packages/@codepapr/ui/src/components/ToastContainer.tsx`：全局 Toast 通知容器
- `packages/@codepapr/ui/src-tauri/src/tts/mod.rs`：TTS 模块编排器（server 管理、语音合成、缓存）
- `packages/@codepapr/ui/src-tauri/src/tts/server.rs`：GPT-SoVITS Python server 子进程管理
- `packages/@codepapr/ui/src-tauri/src/tts/player.rs`：rodio 音频播放引擎
- `packages/@codepapr/ui/src-tauri/src/tts/ws.rs`：WebSocket 批量合成客户端
- `packages/@codepapr/ui/src-tauri/src/tts/installer.rs`：GPT-SoVITS 一键安装器
- `packages/@codepapr/ui/src-tauri/src/tts/finetune.rs`：语音微调运行器
- `packages/@codepapr/ui/src-tauri/src/lsp.rs`：LSP server 管理
- `packages/@codepapr/ui/src-tauri/src/browser/page.rs`：浏览器自动化
- `packages/@codepapr/ui/src-tauri/src/shell/background.rs`：前台/后台命令与 Shell 会话
- `packages/@codepapr/ui/src-tauri/src/web/search/mod.rs`：多引擎搜索聚合（含 SearXNG 优先策略与降级逻辑）
- `packages/@codepapr/ui/src-tauri/src/workspace_fs/mod.rs`：工作区文件系统工具
- `packages/@codepapr/ui/src-tauri/src/task_queue/mod.rs`：串行任务队列
- `packages/@codepapr/ui/src-tauri/src/db/mod.rs`：SQLite 持久化
- `packages/@codepapr/ui/src-tauri/src/shared/paths.rs`：路径归一化与 workspace 路径解析
- `packages/@codepapr/ui/src-tauri/src/papr_runtime/manifest.rs`：.papr manifest 加载、校验、缓存
- `packages/@codepapr/ui/src-tauri/src/papr_runtime/permission.rs`：权限矩阵 + 工具权限映射
- `packages/@codepapr/ui/src-tauri/src/papr_runtime/app_storage.rs`：papr 存储 Tauri 命令
- `packages/@codepapr/ui/src-tauri/src/papr_runtime/services.rs`：papr HTTP/FS Tauri 命令
- `packages/@codepapr/ui/src-tauri/src/papr_runtime/sdk_inject.rs`：SDK 注入 + 文件服务
- `packages/@codepapr/ui/src-tauri/resources/papr-sdk.js`：Papr SDK（注入 iframe 的 window.papr API）
- `packages/@codepapr/ui/src/papr/usePaprBridge.ts`：iframe ↔ 主窗口 IPC 桥接
- `packages/@codepapr/ui/src/papr/agentAdapter.ts`：PaprAgentDef → AgentDefinition 适配器
- `packages/@codepapr/editor/src/index.ts`：编辑器类型与工具函数
