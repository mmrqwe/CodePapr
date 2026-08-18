# 使用手册

## 快速上手

### 前提条件

- 已完成依赖安装与构建（`npm install && npm run build`）
- 至少一种可用的模型提供商
- 对应的 API key
- 一个你准备分析或修改的本地项目目录

### 三步启动

1. **配置**：在桌面端设置中填写 API key、provider 和模型。
2. **选入口**：使用桌面工作台。
3. **选模式**：Ask（解释分析）、Plan（拆解方案）、Agent（实际执行）、App（生成可视化应用）。

## 四种工作模式

| 模式 | 适合 | 行为 |
|------|------|------|
| **Ask** | 解释、分析、建议 | 只读，不改文件不跑命令 |
| **Plan** | 复杂任务拆解 | 先出方案和可选项，确认后执行 |
| **Agent** | Bug 修复、功能实现 | 自主执行：搜索→修改→验证 |
| **App** | 数据可视化、交互应用 | 即时生成交互式 HTML 应用；支持 Papr SDK（`window.papr`）调用 Agent/存储/HTTP/文件系统 |

Plan 模式下，当需求模糊时 Agent 会调用 `question` 工具向你提问，而不是猜测。

Ask / Plan 是只读模式：变更类工具（write/edit/patch/bash/git/app_* 等）会在**工具注册层被直接屏蔽**——既不下发给模型，也无法执行，从机制上杜绝误改文件，而非仅靠提示词约束。

## Papr App 开发

Papr 是 CodePapr 的应用运行时。AI 生成的 App 可以直接在桌面端运行，通过 SDK 调用 CodePapr 的能力。

### .papr 格式

App 是 `.CodePapr/apps/<appId>/` 目录下的两个文件（使用 papr.db 后还会生成 `db.sqlite` 存放应用数据）：

```
.CodePapr/apps/my-app/
├── manifest.json     ← 元数据 + 权限 + Agent
├── index.html        ← 入口 HTML
└── db.sqlite         ← papr.db 数据（运行时生成）
```

manifest.json 示例：

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
    "systemPrompt": "你是一个任务管理助手",
    "tools": ["read", "websearch"],
    "maxToolRounds": 20
  }]
}
```

### Papr SDK API

HTML 中自动注入 `window.papr`，无需手动引入：

```javascript
// 键值存储（按 app 隔离，数据存于 .CodePapr/apps/<appId>/db.sqlite）
await papr.db.set('theme', 'dark');
const theme = await papr.db.get('theme');

// AI Agent 调用（带进度回调）
const result = await papr.agent.run(
  { agent: 'assistant', task: '分析数据' },
  (event) => { console.log(event.type); }
);
// → { content: "...", steps: [{name:'read', status:'success'}, ...] }

// HTTP 请求
const data = await papr.http.get('https://api.example.com/data');

// 文件读写（限定 app data 目录；writeFile 自动创建父目录，如 'posts/x.md'）
await papr.fs.writeFile('config.json', JSON.stringify(config));
const files = await papr.fs.list();
```

**`papr.agent.run` 的轮数与超时限制：**

- **工具轮数**：受 manifest `agents[].maxToolRounds` 限制（未声明时默认 50，声明值也封顶 50），websearch/webfetch 等搜索调用计入总轮数，没有单独的搜索轮数限制
- **超时**：采用 **300 秒空闲超时**（iframe SDK、主线程、Worker 三层一致）——只要 Agent 持续产出进度事件（流式输出、工具调用）就会一直运行下去，不会被掐断；仅当连续 300 秒没有任何事件才判定超时。因此多轮搜索/长分析任务无需担心固定 5 分钟上限

### 创建 App

切换 **App 模式**，用自然语言描述想要的 App。Agent 会自动调用 `app_render` 工具生成完整的 manifest.json 和 index.html，注册到应用面板。相同 appId 再次调用会覆盖更新。

### 权限（两轴模型）

App 的访问权限由**两个正交轴**组成，在 `app_render`（或 manifest）中声明：

| 轴 | 取值 | 能力 |
|---|---|---|
| `local` | `none` | 纯计算，仅 `papr.db` / `papr.fs`（app 自有沙箱，永远可用） |
| `local` | `read` | + 读取项目文件（Agent 只读工具 read/grep/list/lsp/diagnostics 等） |
| `local` | `write` | + 修改项目文件并执行命令（Agent write/edit/patch/bash，直接写项目文件） |
| `network` | `true` | + 访问公网（papr.http + Agent websearch/webfetch + MCP） |
| `network` | `false` | 完全断网（iframe CSP + 后端沙箱强制，JS 无法绕过） |

- `papr.db` / `papr.fs` 是 app 自有沙箱，**永远可用，无需任何权限**
- 后端服务（`command`）要求 `local` 至少为 `read`
- 推荐组合：计算器 `{none, 关}`、Todo/笔记 `{none, 关}`、数据分析看板 `{read, 开}`、重构工具 `{write, 关}`
- 旧 `level` 字段（0-3）仍兼容：0→`{none,关}`、1→`{read,关}`、2→`{read,开}`、3→`{write,开}`

Agent 工具白名单（在 `agents[].tools` 声明，必须落在访问档内）：`read`、`grep`、`list`、`lsp`、`diagnostics`、`read_image`、`skill_load`、`todo`、`local_time_now`（local≥read 或内置）、`websearch`、`webfetch`（需 network）、`write`、`edit`、`patch`、`bash`（需 local=write）。

设置 → **App Tab** 可调整全局默认（本地访问 × 网络）并逐 app 覆盖（覆盖只能收窄）。

### 应用管理面板

右侧面板的 **应用 Tab** 显示所有已注册的 .papr App：

- **绿点** = 运行中，**红点** = 已停止
- 单击行选中，双击打开
- 底部按钮栏：▶ 启动 / 打开 / ■ 停止 / 🗑 删除
- 后端 app 必须先"启动"才能"打开"

### App Agent 管理工具

LLM 可通过 4 个工具管理 app：

- `app_list` — 列出所有 app
- `app_start <appId>` — 启动后端
- `app_stop <appId>` — 停止后端
- `app_delete <appId>` — 彻底删除

## 配置

### 配置存放位置

| 层级 | 路径 | 作用 |
| --- | --- | --- |
| 应用级 | `~/.codepapr/codepapr.sqlite` | provider、model、API key、采样参数、语言 |
| 项目级 | `<workspace>/.CodePapr` | 项目状态、会话消息、缓存统计、规则、Agents、Skills、命令 |

### 设置面板

六个标签页：

- **General**：语言、调试、许可证
- **LLM**：主模型、快速模型、temperature、topP、maxTokens、thinking 模式、maxToolRounds
- **Search**：自部署 SearXNG 优先，失败自动降级到内置多源聚合（Bing / Mojeek / Qwant / Wikipedia）；分类/时间/语言/安全搜索等高级参数收入折叠区，搜索引擎选择器已移除
- **Mentor**：Mentor 子代理独立 API key、Base URL、模型选择
- **高级**：上下文压缩（模型/温度/摘要输出 token/上下文上限/对话轮数）、TodoList 最大重试、ProjectGraph 限制、流式与工具输出（流空闲超时默认 300 秒、中间截断保留字符数默认 20000）、工具上下文模式（完整/摘要/自动，默认完整）。工具上下文模式只作用于历史上下文：工具结果产生当轮始终把完整输出发给模型（大小由截断管线约束），变成历史后按模式替换为结构化摘要（成功/失败+关键信息+头尾预览，完整输出已落盘可用 read 回读）；完整模式历史也保留全文，等价旧版行为。上下文上限 `maxContextTokens` 默认 500K，达到后自动压缩：把较早消息摘要成 checkpoint 并清理旧工具结果，近期对话（含工具调用↔结果配对）原文保留在 checkpoint 之后；该值对 DeepSeek / OpenAI 兼容 / Claude 三种服务商统一生效，不再按服务商钳制
- **App**：.papr 应用权限管理——全局默认（本地访问 × 网络）与逐应用两轴覆盖（覆盖只能收窄；保存后按新权限重启正在运行的后端）

语音配置不在主设置面板，而在角色编辑面板（CharacterModal 的 Voice Tab）中按角色独立设置。

顶部 AgentOps 工具栏还提供 **审查** 按钮，可打开可视化 Code Review 面板。

完整参数参考见 `packages/@codepapr/core/docs/CONFIGURATION.md`。

## 内置子代理

| Agent | 用途 | 模型 | 工具 |
|-------|------|------|------|
| **explore** | 只读代码分析 | fast | read, read_image, list, graph, glob, lsp, diagnostics, grep |
| **scout** | 网页搜索 + 下载 | fast | websearch, webfetch, browser, read_image |
| **mentor** | 架构/算法指导 | 可配置独立模型 | 无 |
| **verifier**（内部） | Goal 验收——只读核实 Worker 是否真正达成目标 | `verifierModelTier` 档位 | read, grep, glob, list |
| **compactor**（内部） | 上下文压缩——生成可恢复检查点 | `compactionModel` 档位 | 无（纯推理） |

主 Agent 通过 `task` 工具调度子代理。每个子代理拥有独立的 Session，只接收委派的任务描述，不受历史对话污染。主 Agent 的 TodoList 指令会提示它主动委派代码分析给 Explore、网页搜索给 Scout。

> Goal 自主循环的验收器（Verifier）是一个内置的只读子代理（工具白名单 read/grep/glob/list，可亲自核实 Worker 的改动），在高级设置中配置（`verifierModelTier` 可选快速/主模型/导师模型）。它是内部代理（`internal: true`），不经 `task` 工具暴露给主 Agent，仅供 GoalRunner 内部调用。主观目标（无 `exec:` 条件）默认使用导师模型验收，未配置导师模型时静默降级为主模型。

> 上下文压缩（Compactor）同样是内置内部代理（`internal: true`），零工具纯推理——压缩输入（transcript）已含全部事实。它由运行时压缩管线（轮间压缩与 mid-loop 压缩）直接调用，不经 `task` 工具暴露；模型档位与参数复用压缩配置（`compactionModel` / `compactionTemperature` / `compactionMaxTokens`，fast 档未启用快速模型时跳过 LLM 走规则降级）。墙钟预算沿用子代理默认 20 分钟。

子代理有 **5 分钟整体 wall-clock 超时**（超时自动取消），单次工具调用有 **90 秒超时保护**，Worker IPC 通信有 **120 秒超时保护**。超时返回错误给 LLM 自主决策，而非永久等待。

## Goal 自主循环

`/goal` 是控制命令（与 `/compact` 同级），启动 **Worker + Evaluator 双模型自主循环**，直到机器可验证的验收条件通过。

### 基本用法

```
/goal exec:npm test                          # npm test 退出码为 0
/goal exec:npm test match:"\d+ passed"       # 退出码 0 且 stdout 匹配正则
/goal exec:npm run lint && exec:npm test     # 复合条件，全部满足
/goal 修复 auth 测试 | exec:npm test          # 自然语言目标 + 验收条件
```

### 运作机制

1. **Worker**（主 Agent）执行一轮工作：规划、写代码、跑测试
2. **条件评估**：系统自动执行验收命令，获取客观结果（退出码 + stdout）
3. **Verifier**（内置只读子代理，read/grep/glob/list）读取 Worker 的执行记录并可亲自核实文件，检查是否伪造成功
4. **双保险判定**：条件函数判定 + Verifier 反伪造，两者都通过才算 SATISFIED；主观模式（无验收命令）要求 Verifier 判 SATISFIED 且完成度达标（一般 ≥0.9 / 宽松 ≥0.7），避免"有进展"被误判为"已完成"
5. 未达成 → 生成反馈（含真实验收输出）注入下一轮 → 继续循环

### 与 TodoList 的关系

- `todo`：Worker 内部的短期规划（可选）
- `goal`：用户设定的硬性验收目标（外循环）
- 两者正交，Worker 在 goal 循环内可自由使用 `todo` 管理自己的子步骤

### 限制参数（高级设置）

| 参数 | 默认 | 说明 |
|------|------|------|
| 最大迭代轮数 | 20 | 外循环最大轮数 |
| 最大运行时间 | 30 分钟 | 墙钟超时自动停止 |
| Verifier 模型 | 快速模型 | 可切换为主模型/导师模型；主观目标默认升级导师模型 |
| Verifier Token 上限 | 1000 | 单次回复最大 token |
| Verifier 温度 | 0.1 | 越低越确定 |

运行期间顶部显示 **GoalBanner** 状态条（轮次、Verifier 判定、耗时、停止按钮），随时可中断。状态持久化到 `.CodePapr/goal-state.md` 防上下文腐烂。

## TodoList 任务清单

Agent 模式下，复杂任务会自动创建 TodoList：

- Agent 调用 `todo` 工具初始化任务列表（2-8 个原子任务）
- 逐项标记 running → completed/failed
- 失败任务自动重试（次数可配置，默认 3 次）
- 计划有误时可直接重写整个列表（re-plan）
- 全部完成后自动折叠为一行摘要，新任务到达自动展开

**与 task 工具的协作**：`todo` 维护计划，`task` 把单条任务委派给子代理。主 Agent 的提示词会主动判断哪些任务该委派。

## 对话重置

Hover 任意用户消息 → 下方出现"重置到此点"和"复制"按钮：

- **重置到此点**：将该消息之后的所有对话和代码变更全部回退。每次用户发消息自动创建快照（排除 `node_modules/`、`dist/` 等），重置时显示恢复计划预览（恢复/删除/不变文件数），确认后执行（自动创建备份引用，支持撤销）。
- **复制**：一键复制消息原文到剪贴板。

## 对话轮次导航

对话区域右侧中间有一个紧凑的**轮次指示条**，每条横线对应一个用户消息轮次：

- **悬停**指示条 → 自动展开轮次面板，列出所有对话轮次
- 每行显示 `#1` 轮次编号 + 用户输入的第一句话
- 当前可视轮次在指示条和面板中同步**高亮**
- **点击**面板内任意轮次 → 平滑滚动跳转到对应消息位置
- 鼠标移开指示条或面板即消失（200ms 延迟防误关）

适合长对话中快速定位之前的问题和上下文。

## 代码审查面板

桌面端顶部工具栏点击 **审查** 可打开可视化 Code Review 面板：

- 默认对比 `HEAD~1..HEAD` 的 diff（当前版本固定范围）
- 左侧文件列表显示新增/修改/删除/重命名状态
- 中间 Monaco diff 编辑器展示 original / modified 两侧内容
- 点击行号边栏可在 original 或 modified 侧添加行级评论
- 评论支持“未解决 / 已解决”状态
- 可标记整体审批状态：待审查 / 已批准 / 需修改 / 已评论

> 代码审查状态保存在内存中的 `reviewStore`，按 `baseRef..headRef` 分组，不持久化到磁盘。

## 全局搜索

顶部工具栏搜索框支持**对话搜索**和**文件搜索**，通过 Tab 切换：

### 对话搜索

- 搜索当前会话所有消息，支持范围过滤：`全部 | 你 | AI`
- 每条结果显示角色标签、轮次编号、时间、匹配上下文（关键词高亮）
- `↑↓` 选择结果、`Enter` 跳转到消息、`Esc` 关闭面板

### 文件搜索

- **内容模式**：搜索工作区文件内部文本，调用 Tauri 后端遍历项目文件
- **文件名模式**：搜索文件路径和名称
- 每条结果展示文件名 + 行号 + 匹配行预览
- 点击结果 → 打开文件并在编辑器中跳转到对应行
- 搜索结果最多 50 条，超出时提示细化关键词
- 搜索面板**视口居中**弹出，300ms 防抖，仅在该 Tab 激活时才执行搜索

## 项目记忆（零审核自动写入）

分层与时间线（给人看的版本）见 [`docs/web/context-architecture.html`](../web/context-architecture.html)。

项目记忆不是「整段塞进模型」。权威数据在 SQLite `memory_entries`；记忆面板是唯一给人看/改的面。不同种类的记忆进上下文的**不同层**，变化时机也不一样。

| 种类 | 存在哪 | 进哪一层 | 何时进当前会话的模型 | 怎么变 |
|---|---|---|---|---|
| 用户手写笔记 | 账本；面板「每次会话」 | Session Bootstrap（稳定前缀） | 会话启动从账本渲染；压缩 epoch 会刷新 | 你在面板增改立刻落库；**当前会话前缀不重建**，下次会话或压缩后才带上 |
| 偏好 / 约束 / 项目事实 | 账本；面板「每次会话」 | 同上，Bootstrap | 同上：本回合写入账本，**下一次 Bootstrap 刷新**才进前缀 | 你说「记住 / 必须 / 不要」、工作区实证、测试成功、冷启动、Agent `memory_write` → 立刻 persist，无需点同意 |
| 踩坑经验 (`procedure`) | 账本；面板「按需召回」 | Turn-scoped Recall / `memory_search` | 写入后的**下一用户回合**，若检索命中 | 同一错误踩两次等；不进每次会话的前缀 |
| 网页 / MCP 引用 (`citation`) | 账本；面板「仅搜索」 | 仅 `memory_search` | 模型主动搜索才会看到 | web / MCP / `https` 证据；**永不进 Bootstrap，自动 Recall 也跳过** |
| 当前任务目标 / 待办 | Session Checkpoint | Session State | 压缩后作为检查点 | 随压缩 epoch 变；**不是**跨会话项目记忆 |
| 大段工具输出 | `.CodePapr/tool-output/` | 不自动注入 | `read_artifact` 按需 | 写时冻结 |

**写入（零审核）**：确定性门 `planMemoryWrite` 只做 persist 或 drop。面板是完整目录（每次会话 / 按需召回 / 仅搜索，可遗忘），没有准入队列。Agent 不得让你去确认记忆。注入指令、密钥、危险命令会被丢弃。若 Agent 仍 `write`/`patch` `.CodePapr/memory.md`，会被拦截，走同一策略，不落盘。

**读取**：不会把账本整库塞进请求。短指令已经在会话引导里；每个用户回合（Ask 除外）用你这句话做关键词召回（约 5 条 / 1200 tokens，跳过 citation）；不够时 Agent 调 `memory_search`（含 citation，Ask 也可用）。想看目录才调 `memory_review_candidates`（最多 40 条预览）。`memory_search` 不会每句话自动跑一遍。

**加载与缓存**：会话启动时从账本渲染 Bootstrap 段注入 Session Bootstrap（`log[0]`，`isPrefixSystem`），按「会话 × 稳定签名」冻结。渲染结果排除在签名外，新记住的内容**不拆当前前缀缓存**。压缩 epoch 随 `refreshBootstrap` 刷新；新会话总是重读账本。每用户回合另做一次 Recall（citation 不进入自动 Recall）。

**冷启动**：若账本没有 Bootstrap 段且 ProjectGraph 可用，后台生成项目结构 / 技术栈 / 构建命令摘要写入账本；不阻塞当前会话，下次会话或压缩后进入 Bootstrap。

**去重**：同内容哈希的旧条被 supersede。不再对独立记忆文件做 LLM 整理。

## 代码智能（lsp / list）

LLM 侧的代码智能由 `lsp` 工具与 `list`（目录树 + 逐文件轻量符号）承担。

**lsp 导航（9 个 action，LSP 优先、AST 项目图兜底，结果带 source/confidence）**：`goToDefinition`（跳转定义）、`findReferences`（查找引用）、`hover`（类型/文档信息）、`documentSymbol`（文件符号大纲）、`workspaceSymbol`（工作区符号检索）、`goToImplementation`（跳转实现）、`prepareCallHierarchy`（调用层级项）、`incomingCalls`（入调用）、`outgoingCalls`（出调用）。LSP 不可用或无结果时自动降级到 AST 项目图，结果以 `source`（lsp/ast）与 `confidence`（high/medium/low）标注精度。

**项目结构**：`list` 浏览目录树并自动附带逐文件轻量符号（每个代码文件的顶层符号，AST 实现，无需 LSP）。

> `graph` 工具（full / lookup / dependency / impact / implementations / entrypoints / smart_context / dead_code / circular_deps / type_hierarchy / suggest_refactors / test_impact / generate_tests 等 14 个 action）对**主代理 LLM 软隐藏**——主代理用 `list` + `lsp` 完成结构与导航，跨模块依赖/影响分析委派给 Explore。`graph` 仍经白名单提供给 Explore 子代理，并供 UI 面板与 `lsp` 点查询的 AST 兜底后端使用。

## 项目级定制

### 项目规则

读取 `.CodePapr/AGENTS.md`，内容注入系统提示词。适合写：项目约定、目录结构、禁止改动的范围、验证标准。

### 自定义子代理

在 `.CodePapr/agents/<name>.md` 中用 YAML frontmatter + 正文声明：

```yaml
---
description: 代码审查，定位风险并给出最小修复建议
mode: subagent
model: fast
temperature: 0.2
tools:
  read: true
  grep: true
---
你是 reviewer，一个只读代码审查子代理。
```

`mode` 取值：`subagent`（默认，可经 `task` 工具委派）、`all`（可委派 + 可作 @ 提及主代理）、`primary`（仅作 @ 提及主代理，**不会**出现在 `task` 工具的委派列表）。`model` 可填 `fast` / `mentor` 或具体模型名；`mentor` 未单独配置 API Key 时自动回退到主 API Key。

### Skills

Skill 是主 Agent 的可复用操作手册，放在 `.CodePapr/skills/` 下，支持两种布局：

- 嵌套：`.CodePapr/skills/<name>/SKILL.md`
- 平铺：`.CodePapr/skills/<name>.md`

运行时不创建子代理，而是作为项目级上下文供模型按需选择。仅 name + description 注入稳定上下文，完整内容通过 `skill` 工具按需加载（上限 500KB）。默认包含 `search` Skill（搜索策略）。启用状态保存在 `.CodePapr/project.sqlite`。

**技能市场**：桌面端内置技能市场，从 GitHub（`zerone-agent/agent-use-skills`）拉取技能列表，支持一键安装到项目。已安装技能记录在 `skills-lock.json` 中（含 SHA-256 校验）。

### 自定义聊天命令

在 `.CodePapr/commands/<name>.md` 中声明模板，支持 `$ARGUMENTS`、`@path`、`` !`cmd` ``。

输入 `/` 弹出命令面板。

**主模型内置命令：** `/review` `/fix` `/test` `/explain` `/diagnose` `/refactor` `/doc` `/new` `/optimize` `/build`

**快速模型内置命令：** `/search` `/lint` `/clean` `/commit` `/summary`

**本地命令（零 token）：** `/help` `/commands` `/compact`

自定义命令可在 frontmatter 声明 `model: fast` 启用快速模型路由：

```markdown
---
description: 快速搜索 TODO
model: fast
---
搜索代码库中所有 TODO 和 FIXME 标记：$ARGUMENTS
```

## 外部路径权限

桌面端对项目外的绝对路径读取/列出操作会触发显式授权：

- 当 Agent 调用 `read` / `list` 且路径为工作区外的绝对路径时，弹出 **PermissionDialog**
- 用户可选择：**拒绝**、**允许此文件**、**允许此文件夹**
- 授权结果加入白名单，同目录/文件后续不再询问
- 根目录直属文件（如 `/secret.txt`）选择「允许此文件夹」时自动降级为仅授权该文件本身，避免一次点击授予整个文件系统根
- 写入、编辑、命令执行等操作仍限制在工作区内，不经过此弹窗

## macOS 命令沙箱

macOS 上 `bash` 工具、Shell 会话与 app 后端进程都通过 `sandbox-exec` 沙箱运行：

- **可读**：系统目录（/bin、/usr、/System、/Library 等）、/opt/homebrew（Homebrew 工具）、PATH 中的目录、工作区、已授权的外部路径
- **可写**：工作区、临时目录、工具缓存目录（~/.npm、~/.cache、~/.cargo、~/.local、~/.nvm、~/.volta）、已授权的外部路径
- **始终禁止**（YOLO 模式也不例外）：~/.ssh、~/.gnupg、~/.config、~/.aws、~/.azure、~/.kube、~/.git、~/.CodePapr
- HOME 下的常见工具配置（.gitconfig、.npmrc 等）默认只读放行；其他 HOME 文件需要时通过外部授权放行
- **IPC**：放行 mach-lookup（`osascript` 等需要连接系统服务）、lsopen（`open` 启动 app/文件/URL 的专用操作）与 sysctl-read（`ps`/`pgrep` 读进程表）；各系统服务自带鉴权，文件与网络仍按上述规则约束

## Toast 通知

桌面端使用非阻塞 Toast 通知替代传统 alert：

- 四色：`info` / `success` / `warning` / `error`
- 默认 4.5 秒自动消失，`error` 类型默认 8 秒
- 最多同时显示 5 条，超出时丢弃最早的
- 当前已在文件附件拖拽等场景中使用

## 角色扮演

角色系统可以创建、导入和激活 AI 角色，让 Agent 以特定人设与你对话。

**创建角色：** 点击工具栏角色按钮 → "新建角色"，填写：
- **基本信息**：名称、头像（上传图片）
- **人设字段**：描述（外貌/背景）、个性（说话风格/性格）、场景（初始情境）、开场白
- **示例对话**：用 `<START>` 分隔多组对话，定义角色的说话风格
- **高级**：系统提示词（追加指令）、标签、创作者、版本号

**导入角色卡：** 支持 PNG 角色卡（SillyTavern / CCv3 规范）和 JSON 文件导入。PNG 角色卡中的 JSON 数据以 tEXt/iTXt chunk 嵌入，头像也一并导入。

**导出角色卡：** 将角色导出为 PNG 角色卡，可跨工具使用。

**启用角色：** 在角色列表中点击角色名即可激活。激活后角色人设注入到 LLM 系统提示词中，Agent 会以角色的身份、语气、风格进行回复。角色人设放在 Session Bootstrap 中，切换角色不破坏 DeepSeek 缓存。

**角色扮演格式约定：**
- `*星号包裹*` → 动作/叙述/场景描写（不会被 TTS 朗读）
- 纯文本 → 角色对话（会被 TTS 朗读）
- `**加粗**` → 重读/强调（朗读时加重语气）
- `（括号）` → 语气提示如（低声）、（轻笑）（不会被朗读）

## 语音合成（TTS）

语音系统基于 GPT-SoVITS 实现本地语音克隆，让角色用合成声音朗读对话。

**安装 GPT-SoVITS：** 首次点击 ChatPanel 上的 TTS 喇叭按钮，若未安装会自动弹出安装向导；或在角色编辑面板的 Voice Tab 中触发安装。安装流程自动执行：检查 Python → 克隆 GPT-SoVITS 仓库 → pip 安装依赖 → 下载预训练模型（约 2GB，使用 hf-mirror 源）→ 验证。需要本机已安装 Python 3.10+。

**为角色配置语音：**
1. 打开角色编辑面板（工具栏角色头像按钮）→ Voice Tab → 开启"启用语音输出"
2. 上传参考音频（3-10 秒，推荐 5 秒，干净人声，WAV/MP3/M4A/AAC，16kHz+）
3. 填写参考文本（音频中的原话，需逐字对应）
4. 选择参考音频语言和说话语言
5. 调整语速（50%-200%）、合成速度（4=极速 / 8=均衡 / 16=最高质量）、合并句数（1-5）
6. 点击"试听"按钮预览效果

**当前播放模式：** 当前 UI 采用 WebSocket 批量流式（`ws-batch`）作为默认且唯一实际生效的模式，首字延迟约 1-2 秒。其余模式保留在代码层，设置面板暂未开放切换。

**播放控制：**
- 启用语音的角色在 AI 回复时会自动朗读
- 每条 AI 回复 hover 后会出现"重播"按钮，可重新朗读该条内容
- 取消当前 Agent 消息可停止正在进行的朗读
- ChatPanel 上的 TTS 喇叭按钮用于启动 GPT-SoVITS 服务或查看服务日志/状态

**GPU 预热：** 在 Apple Silicon Mac 上，首次启动 TTS 服务后，可在角色编辑面板的 Voice Tab 中手动点击"GPU 预热"按钮，提前编译 Metal kernel，避免首次合成卡顿 5-15 秒。

**语音微调：** 在角色编辑 → Voice Tab 中可"生成训练数据"（LLM 生成角色台词脚本并合成约 2 分钟训练语音），然后"开始微调"（后台训练，通常 30-60 分钟）。完成后可启用微调模型，音质更自然、合成更快。

## 给出有效任务

推荐写法：
> 修复 packages/@codepapr/ui 里预览关闭后后台进程未停止的问题。先找当前预览会话和后台进程的绑定逻辑，再做最小修改。

不够好：
> 帮我修一下预览。

## 典型工作流

### 1. 先理解再执行
1. Ask：解释系统结构、定位模块
2. Plan：输出任务清单和验证方案
3. Agent：按清单实施

### 2. 直接修复问题
直接在 Agent 模式给出明确目标和影响文件范围。

### 3. 生成数据可视化
切换 App 模式，让 Agent 探索数据并生成交互式 HTML 应用——适合数据库分析、关系图、仪表盘等场景。

### 4. 对话重置回退
如果 Agent 走偏了方向，hover 之前正确的用户消息，点击"重置到此点"回到该状态继续。

## 数据位置

| 路径 | 作用 |
| --- | --- |
| `~/.codepapr/codepapr.sqlite` | 应用级设置 |
| `<workspace>/.CodePapr/project.sqlite` | 项目级状态、聊天记录、缓存统计 |
| `<workspace>/.CodePapr/project.sqlite` 的 `memory_entries` | 跨会话项目记忆（面板为唯一给人看的面；Bootstrap 从账本渲染） |
| `<workspace>/.CodePapr/store` | 项目级文本记录 |
| `<workspace>/.CodePapr/skills` | 项目级技能文件 |
| `<workspace>/.CodePapr/agents` | 项目级自定义子代理 |
| `<workspace>/.CodePapr/commands` | 项目级自定义命令 |
| `<workspace>/.CodePapr/apps` | Papr App 目录（每个子目录 = 一个 app；`db.sqlite` 为该 app 的 papr.db 数据） |
| `~/.codepapr/voices` | 角色参考音频文件 |
| `~/.codepapr/gpt-sovits` | GPT-SoVITS 安装与模型 |

## 常见问题

### 启动后提示没有 API key
检查桌面端设置是否已保存、环境变量是否设置。

### 改完代码后测试还是旧结果
重新 build 受影响包再跑验证。不少包通过 dist 入口参与测试。

### Agent 遇到 vite/tsc/eslint 错误
优先当作依赖未安装或本地包未构建处理。
