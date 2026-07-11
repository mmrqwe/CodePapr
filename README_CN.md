# CodePapr

> **[codepapr.com](https://codepapr.com/)** — 官网 / 下载 / 文档

**本地优先的编码 Agent 运行时。Tauri 桌面 + CLI 自动化。**

CodePapr 是一个基于 DeepSeek 缓存优化的本地编码 Agent 系统。主 Agent 调度 **Explore**（代码分析）、**Scout**（网页搜索）、**Mentor**（架构指导）三个内置子代理协作，支持自定义扩展。文件读写、命令执行、Git 操作、浏览器预览、LSP 诊断——全在本地完成。

---

> [English](README.md)

---

## 核心能力

| 能力 | 说明 |
|------|------|
| **Ask / Plan / Agent 三种模式** | 同一个 Runtime，从解释到执行 |
| **多 Agent 协作** | 主 Agent 通过 `task` 工具调度 Explore/Scout/Mentor 及自定义子代理 |
| **TodoList 任务规划** | Agent 自动创建并跟踪任务清单，支持进度汇报与重规划 |
| **项目记忆自动整理** | `.CodePapr/memory.md` 跨会话累积用户画像、错误模式、项目约定；超 200 行后异步用快速模型去重合并，不阻塞会话 |
| **ProjectGraph 语义分析** | 项目级代码结构骨架 + 符号 + 依赖关系图，支持死代码检测、循环依赖、重构建议等 13 个 action |
| **DeepSeek 前缀缓存优化** | 三层提示词注入策略，最大化缓存命中降低成本 |
| **SEARCH/REPLACE Diff** | 先校验再写入，支持原子性多文件 patch |
| **MCP 协议支持** | 集成外部 MCP 工具服务器，支持 DuckDuckGo Search、Postgres、SQLite 等 |
| **Git 深度集成** | 8 个 Git action + diff 面板 + 安全回退 + 备份分支 |
| **对话重置** | 一键将代码和对话重置到任意历史消息位置 |
| **对话轮次导航** | 右侧轮次指示条，悬停展开面板，点击跳转到任意轮次 |
| **全局搜索** | 工具栏搜索框，支持对话搜索和文件搜索双 Tab，键盘全操作 |
| **TaskChecklist 折叠** | 任务全部完成后自动折叠，新任务到达自动展开 |

## 架构

```
┌──────────────────────────┐  ┌──────────────────────┐
│  Tauri 2 桌面            │  │  CLI 终端入口        │
│  React + Monaco          │  │  Node.js             │
└───────────┬──────────────┘  └─────────┬────────────┘
            │                           │
            └─────────────┬─────────────┘
                          │
             ┌────────────▼─────────────┐
             │      @codepapr/core      │
             │    Agent / Session       │
             │    三层缓存分区          │
             │    BUILTIN_AGENTS        │
             │    TodoList / Graph      │
             └────────────┬─────────────┘
                          │
             ┌────────────▼─────────────┐
             │   Rust 后端 (Tauri)      │
             │   工作区 IO · LSP        │
             │   SQLite 持久化          │
             │   ProjectGraph 缓存      │
             │   浏览器 · Web 搜索      │
             └──────────────────────────┘
```

## 快速开始

### 环境要求

- Node.js 18+
- npm 9+
- Rust toolchain + Cargo（仅桌面端编译需要）
- DeepSeek API Key（或 OpenAI/Claude 兼容端点）

### 安装

```bash
npm install
npm run build
npm run verify
```

### 启动桌面端

```bash
npm run debug      # 开发模式（热重载）
npm run release    # 直接运行优化构建
npm run publish    # 生成安装包 (.dmg/.msi)
```

## 三种工作模式

| 模式 | 适合 | 行为 |
|------|------|------|
| **Ask** | 解释、分析、建议 | 只读，不改文件不跑命令 |
| **Plan** | 复杂任务拆解 | 先出方案和可选项，确认后执行 |
| **Agent** | Bug 修复、功能实现 | 自主执行：搜索→修改→验证 |

## 项目配置

在项目根目录创建 `.CodePapr/` 目录：

| 文件/目录 | 用途 |
|-----------|------|
| `.CodePapr/AGENTS.md` | 全项目规则，注入所有 Agent 和子代理的系统提示词 |
| `.CodePapr/memory.md` | 跨会话项目记忆，Agent 自动追加，超 200 行后自动整理 |
| `.CodePapr/agents/*.md` | 自定义子代理（YAML frontmatter + Markdown 正文） |
| `.CodePapr/skills/*/SKILL.md` | 可复用技能（搜索策略、排错流程、发布检查） |
| `.CodePapr/commands/*.md` | 自定义提示词模板（`--name` 调用） |

### 内置命令

输入 `/` 呼出命令面板（`/` 格式兼容旧版）：

**主模型（深度推理）：** `/review` `/fix` `/test` `/explain` `/diagnose` `/refactor` `/doc` `/new` `/optimize`

**快速模型（更快、更便宜）：** `/search` `/lint` `/clean` `/commit` `/summary` `/build`

**本地（零 token）：** `/help` `/commands` `/compact` `/goal`

**自主循环（双模型 Worker+Verifier）：** `/goal exec:<验证命令>` — 启动自主循环，Worker 执行 + Verifier 验收 + 客观条件判定，直到验证条件通过或限制耗尽。示例：`/goal exec:npm test`、`/goal 修复 auth 测试 | exec:npm test match:"\\d+ passed"`

按命令的 `model` 字段自动路由：声明 `model: 'fast'` 时走快速模型，未声明则使用主模型；自定义命令同样支持。

## 设置面板

`General / LLM / Search / Mentor / 高级` 五个标签页：

- **General**：语言、调试、许可证
- **LLM**：主模型、快速模型、temperature、topP、maxTokens、thinking 模式、maxToolRounds
- **Search**：自部署 SearXNG 搜索（优先使用，失败自动降级到内置 Bing / Mojeek / Qwant / Wikipedia 等多源聚合）
- **Mentor**：子代理选择、自定义提示词、子代理参数（temperature/topP/thinking/maxTokens/maxToolRounds/maxDepth）、独立 Mentor 模型配置
- **高级**：上下文压缩（模型/温度/token/上下文上限/对话轮数）、TodoList 最大重试、ProjectGraph 深度/文件数限制

详见 `packages/@codepapr/core/docs/CONFIGURATION.md` 完整参数参考。

## 内置子代理

| Agent | 用途 | 模型 | 工具 |
|-------|------|------|------|
| **explore** | 只读代码分析 | fast | read, graph, lsp, diagnostics, time |
| **scout** | 网页搜索 + 下载 | fast | web_search, web_fetch, web_download, browser, open, time |
| **mentor** | 架构/算法指导 | 可配置独立模型 | 无 |

主 Agent 通过 `task` 工具调度子代理。每个子代理拥有**独立的 Session 和空白上下文**，只接收委派的任务描述，不受主 Agent 历史对话污染。子代理有 5 分钟整体超时，单次工具调用有 90 秒超时保护。

## 验证

```bash
npm run verify    # build + test + lint
npm test          # 仅运行测试
npm run lint      # ESLint
```

## 项目结构

```
packages/
├── @codepapr/types       # 共享类型
├── @codepapr/common       # 日志等通用工具
├── @codepapr/core         # Agent/Session/缓存/ToolRegistry/BUILTIN_AGENTS/TodoList
├── @codepapr/api          # Provider (DeepSeek/OpenAI/Claude) 抽象
├── @codepapr/db           # SQLite 数据层
├── @codepapr/cli          # CLI 入口 + 工具实现
├── @codepapr/editor       # 编辑器集成
├── @codepapr/ui           # Tauri 桌面端 (React + Monaco)
│   └── src-tauri/         # Rust 后端
```
