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
| `shell` | `src-tauri/src/shell/` | 前台命令、后台进程、持久 Shell 会话与命令安全守卫 |
| `web` | `src-tauri/src/web/` | HTTP fetch、网页正文提取、多引擎搜索（SearXNG 优先，失败自动降级到 Bing / Mojeek / Qwant / Wikipedia 等内置多源聚合） |
| `workspace_fs` | `src-tauri/src/workspace_fs/` | 文件列表、文本读取、写入、SEARCH/REPLACE diff、文本/路径搜索 |
| `task_queue` | `src-tauri/src/task_queue/mod.rs` | 重 I/O 操作串行化队列，前端通过 `task_id` 轮询结果 |
| `db` | `src-tauri/src/db/mod.rs` | 应用与项目级 SQLite 持久化、会话与缓存统计 |
| `tts` | `src-tauri/src/tts/` | GPT-SoVITS TTS 子系统：server 管理、语音合成、WebSocket 批量合成、音频播放、安装器、微调 |
| `lsp` | `src-tauri/src/lsp.rs` | LSP server 进程管理、stdin/stdout JSON-RPC 桥接 |
| `symbol_provider` | `src-tauri/src/symbol_provider.rs` | tree-sitter fallback 符号提取 |
| `mcp_host` | `src-tauri/src/mcp_host.rs` | MCP 工具服务器宿主（stdio / sse / streamable-http） |
| `shared` | `src-tauri/src/shared/` | 路径归一化、workspace 路径解析、运行时封装、字符串/时间工具 |
| `papr_runtime` | `src-tauri/src/papr_runtime/` | .papr 应用运行时：manifest 加载、权限校验、SDK 注入、存储/HTTP/FS 命令、app 上下文注册 |
| `app_runtime` | `src-tauri/src/app_runtime.rs` | 自定义 URI scheme `codepapr-app://`、app 发现与扫描、SDK 注入、workspace 注册 |

### 4.5 任务队列

所有重 I/O 的 Tauri 命令（文件列表、读取、命令执行等）通过单消费者 channel 串行执行：

- 命令立即返回 `task_id`，不阻塞前端
- 前端轮询 `poll_workspace_task` 获取结果
- 避免多线程并发读写同一工作区，简化锁模型

### 4.6 工具架构

LLM 可调用 26 个独立工具（含 `task` / `todo` 两个动态工具），每个职责单一，有 `action` 的 7 个均带 `enum` 约束。文件读取/写入/SEARCH/REPLACE 的单次上限为 20MB：

| 合并工具 | Action | 委托工具 |
|---|---|---|
| `read` | 行范围/窗口/上下文读取 | workspace_read_file |
| `read_image` | 图片文件读取（PNG/JPEG/WebP/GIF） | workspace_read_image |
| `write` | 创建/覆写文件 | workspace_write_file |
| `edit` | SEARCH/REPLACE 单文件修改 | workspace_apply_patch |
| `patch` | 多文件原子 SEARCH/REPLACE | workspace_apply_diff |
| `grep` | 正则搜索文件内容 | workspace_search_text |
| `glob` | 文件名模式搜索 | workspace_search_files |
| `list` | 目录树浏览 | workspace_list_files |
| `graph` | full / overview / lookup / implementations / dependency / entrypoints / impact / smart_context / dead_code / circular_deps / type_hierarchy / suggest_refactors / test_impact / generate_tests | graphQuery |
| `lsp` | definition / references | workspace_symbol_definition / workspace_symbol_references |
| `lsp_edit` | rename / code_action / format | workspace_rename_symbol / workspace_apply_code_action / workspace_format_files |
| `diagnostics` | 单文件 LSP 诊断 / 项目级诊断 | workspace_lsp_diagnostics / workspace_project_diagnostics |
| `git` | status / diff / log / branch / stage / commit / restore / reset | workspace_git_* |
| `exec` | 前台/后台命令执行 | workspace_run_command / workspace_start_background_command |
| `shell` | open / send / read / close / list 持久会话 | shell_* |
| `proc` | 后台进程管理 | workspace_list_background_processes / workspace_stop_background_process |
| `browser` | open / navigate / reload / close / click / type / read / screenshot / get | browser_* |
| `web_search` | 在线搜索 | web_search |
| `web_fetch` | 读取网页内容 | web_fetch_url |
| `web_download` | 下载文件到项目 | web_download_file |
| `open` | 系统浏览器打开 URL/HTML | workspace_open_in_browser |
| `skill` | 加载 Skill 文档 | skill_load |
| `time` | 获取本地时间 | local_time_now |
| `question` | 向用户提问 | question |
| `task` | 委派子代理执行子任务 | subagent |
| `todo` | tasks / updates 任务规划 | TodoList |

26 个工具统一注册在 ToolRegistry 中，冻结后 hash 确保缓存一致性。`todo` 和 `task` 为动态生成。

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
    "tools": ["read", "web_search"],
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

工具权限映射（`check_tool_permission`）：`read/grep/list` → `workspace:read`、`write/edit` → `workspace:write`、`exec/shell` → `workspace:exec`、`web_search/web_fetch` → `http:get`。

**App Agent 系统：**

与内置子代理（explore/scout/mentor）独立，走专用 Agent loop：
- manifest `agents[].tools` 声明白名单（仅 15 个允许工具）
- Worker 端 `handleRunAppAgent` 构建完整 `Session`（`ImmutablePrefix` + `AppendOnlyLog` + `ToolRegistry`）
- 走 `Agent.chat()` 多轮工具循环（`maxToolRounds` 默认 20，上限 50）
- 300s wall-clock 超时 + 工具 IPC proxy 到主线程
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
| explore | 只读代码分析 | fast | read, read_image, graph, lsp, diagnostics, time |
| scout | 网页搜索 + 下载 | fast | web_search, web_fetch, web_download, browser, read_image, open, time |
| mentor | 架构/算法指导 | 可配置独立模型 | 无 |

### 6.2 子代理的独立上下文

**每个子代理拥有全新的 Session**，不继承主 Agent 的历史对话：

- 创建全新的 `AppendOnlyLog` — 空白日志
- 工具集按定义中的白名单过滤（Explore 只有 5 个工具）
- 只接收 `task.prompt` 传入的任务描述作为唯一下文
- 嵌套深度上限可配置（`subagentMaxDepth`，默认 2）

设计意图：子代理是"专注执行一条任务的无状态工人"，不受主 Agent 上下文窗口污染。

### 6.3 模型路由

子代理通过 `selectSubagentExecutionRoute` 选模型：
- 子代理定义的 `model: 'fast'` → 快速模型（默认 deepseek-v4-flash）
- 任务包含执行动词（fix/implement/build）→ 主模型
- Mentor 默认使用主模型，可配置独立 API key 和模型
- Explore / Scout 支持按设置里的 `exploreModelTier` / `scoutModelTier` 在 `primary` 与 `fast` 之间切换

### 6.4 子代理超时保护

子代理无需等待永久——多层超时机制确保及时止损：

- **单次工具调用 90 秒超时**：`Agent.ts` 中每次 `toolRegistry.execute()` 由 `withTimeout` 包裹，超时返回 `{ error: '工具执行超时' }` 给 LLM 自主决策
- **子代理整体 5 分钟 wall-clock 超时**：`agentRuntime.worker.ts` 和 `uiTaskTool.ts` 中的 `agent.chat()` 由 `withWallClockTimeout` 包裹，超时调用 `agent.cancel()` 终止循环
- **Worker IPC 120 秒超时**：`requestToolExecution` 的 Promise 内置超时清理 waiter，防止主线程不回信时永久挂起

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

`graph` 是统一的项目语义图工具，通过 `action` 参数选择操作。主 Agent 和 Explore 子代理均可调用。

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
- Explore 子代理的系统提示词中列出所有 action

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
2. ProjectGraph Summary
3. Custom Guidance（用户长期偏好提示词）
4. 角色人设（当前启用的 CharacterProfile）

**第三层：Runtime User Prompt（当前轮 user 消息）**
每次用户输入时构建：
1. Mode Header
2. User Input
3. Diagnostics Section（放在最后，避免前缀抖动）

### 10.2 关键不变量

- 用户自定义提示词进入 session bootstrap 而非每轮 user prompt
- Skills 进入 bootstrap 而非 system prefix
- 角色人设进入 bootstrap 而非 system prefix（切换角色不破坏缓存）
- Workspace 路径只在 system prompt 出现一次
- Custom guidance 只在 bootstrap 出现一次
- `topP`、`temperature`、`maxTokens`、`thinkingEnabled` 一起冻结在 ImmutablePrefix 中，任意变化都会破坏缓存 hash

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

## 13. 缓存一致性模型

### 13.1 三分区结构

| 分区 | 内容 | 设计目的 |
| --- | --- | --- |
| ImmutablePrefix | 系统提示词、工具定义、模型参数（含 topP/temperature/maxTokens/thinkingEnabled） | 锁定前缀字节序列 |
| AppendOnlyLog | 用户消息、助手消息、工具结果 | 只追加，不可回写 |
| VolatileScratch | 临时推理、中间计划、轮次草稿 | 隔离不稳定内容 |

### 13.2 哈希计算

ImmutablePrefix 的 SHA256 hash 包含整个 `parameters` 对象——`temperature`、`topP`、`maxTokens`、`thinkingEnabled` 全部参与哈希。任意参数变化 → hash 变化 → 缓存 miss。

## 14. Settings 结构

设置面板分为五个 tab，完整参数参考 `packages/@codepapr/core/docs/CONFIGURATION.md`：

| 标签页 | 内容 |
|---|---|
| General | 语言选择、调试开关、许可证 |
| LLM | API 类型、模型名称、fast 模型、temperature、topP、maxTokens、thinking 模式、maxToolRounds |
| Search | 自部署 SearXNG 优先，失败自动降级到内置多源聚合；搜索引擎选择器已移除；分类/时间/语言/安全搜索等高级参数收入折叠区 |
| Mentor | Mentor 子代理独立 API key、Base URL、模型选择 |
| 高级 | 上下文压缩（模型/温度/token/上下文上限/对话轮数）、TodoList 最大重试、ProjectGraph 深度/文件限制 |

语音配置不在主设置面板，而是在角色编辑面板（CharacterModal 的 Voice Tab）中按角色独立设置。

## 15. 关键源码定位

- `packages/@codepapr/core/src/agent/Agent.ts`：核心工具循环与会话执行入口
- `packages/@codepapr/core/src/agent/Session.ts`：会话对象与分区聚合
- `packages/@codepapr/core/src/agent/promptSystem.ts`：三层 prompt 组装 + MODE_INTROS + 角色人设注入
- `packages/@codepapr/core/src/agent/todoList.ts`：TodoList 核心逻辑
- `packages/@codepapr/core/src/agent/agentConfig.ts`：BUILTIN_AGENTS 定义
- `packages/@codepapr/core/src/cache/`：三分区缓存核心
- `packages/@codepapr/core/src/tool/workspace/graphQuery.ts`：ProjectGraph 查询引擎（14 个 action）
- `packages/@codepapr/api/src/request/RequestBuilder.ts`：请求构造
- `packages/@codepapr/api/src/response/CacheValidator.ts`：响应校验
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
