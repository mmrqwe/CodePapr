# CodePapr 参数配置参考

本文档列出 CodePapr 所有可配置参数及其说明。

## LLM 模型设置

| 参数 | 类型 | 默认值 | 范围 | 说明 |
|---|---|---|---|---|
| `apiMode` | 枚举 | `deepseek` | `deepseek` / `custom` / `local` | API 模式：DeepSeek 官方 / 自定义 API / 本地模型 |
| `apiFormat` | 枚举 | `openai` | `openai` / `claude` | API 格式（仅在 `custom` 模式下生效） |
| `baseURL` | 字符串 | `''` | 任意 URL | 自定义 API 端点地址 |
| `apiKey` | 字符串 | `''` | — | API 密钥 |
| `model` | 字符串 | `deepseek-v4-pro` | — | 主模型名称 |
| `fastModel` | 字符串 | `deepseek-v4-flash` | — | 快速模型名称（用于子代理和不需深度推理的任务） |
| `fastModelEnabled` | 布尔 | `true` | — | 启用快速模型 |
| `thinkingEnabled` | 布尔 | `true` | — | 启用推理模式（仅 DeepSeek 官方 API 生效） |
| `thinkingEffort` | 枚举 | `max` | `high` / `max` | 推理强度 |
| `temperature` | 数字 | `0.7` | `0` - `2` | 生成温度，越高输出越随机，越低越确定 |
| `topP` | 数字 | `0.9` | `0` - `1` | 核采样参数，控制 token 候选池大小。0 仅保留最高概率 token，1 保留全部 |
| `maxTokens` | 数字 | `200000` | `100` - `200000` | 单次响应最大输出 token 数。实际下发前按服务商输出上限自动钳制：DeepSeek 200K、Claude 64K、OpenAI 32K（超出会被供应商拒绝为 400，故请求层自动收敛） |
| `maxToolRounds` | 数字 | `500` | `1` - `∞` | 单次对话中 Agent 连续调用工具的最大轮数 |
| `systemPrompt` | 字符串 | `''` | — | 自定义系统提示词。留空则使用内置默认 |
| `agentToolProfile` | 枚举 | `default` | `default` / `minimal` | Agent 工具面档位。`default`= 全量工具（仍按模式过滤）；`minimal`= 仅暴露 7 项核心工具 `read/edit/write/grep/bash/websearch/webfetch`（mode ∩ profile；极简≠沙箱，bash 仍可任意执行；App 模式需 `default`）。单源常量 `MINIMAL_AGENT_TOOLS`，CLI `--tools-preset` 可覆盖 |

## 上下文压缩设置（v4：骨架引擎）

压缩触发只有一条线：**usage ≥ `maxContextTokens` × 90%**（常量 `COMPACT_TRIGGER_RATIO`，不可配置）。旧版的「对话轮数上限」与「软预算 prune 分层」已移除。

主压缩**不经过 LLM**：更早的回合被折叠为确定性骨架（每回合保留「用户问题（截断 300 字）+ 最终结论（头 300 + 尾 100 字）+ 丢弃工具调用计数」），最近 5 个回合逐字保留（含工具调用/结果）；预算仍不足时逐字轮数按 4→3→2→1 降级，再不足则对当前回合做轮内折叠（保留最后 3/2/1 个工具轮组，更早的折成活动行）。只有当以上全部装不下时，才调用一次 Compactor 对骨架做**二级摘要**（输入经确定性预瘦身，失败/不可用时降级为按行截断——绝不递归压缩）。TodoList 权威清单作为 pinned 信息独立注入检查点正文，不参与折叠。所有入口（回合末自动压缩、`/compact`、Goal 循环、mid-loop、task 子代理 headless）共用同一引擎与同一提交路径。

| 参数 | 类型 | 默认值 | 范围 | 说明 |
|---|---|---|---|---|
| `compactionModel` | 枚举 | `fast` | `fast` / `primary` | 二级摘要的模型档位（Compactor 内部子代理；fast 档未启用快速模型时跳过 LLM，走确定性截断降级） |
| `compactionMaxTokens` | 数字 | `8000` | `100` - `100000` | Compactor 子代理的最大输出 token（二级摘要写多长，非触发阈值） |
| `compactionTemperature` | 数字 | `0.1` | `0` - `2` | Compactor 子代理的温度，越低越确定 |
| `maxContextTokens` | 数字 | `200000` | `1000` - `1000000` | 模型输入上下文窗口（token）。达到其 90% 触发压缩；`max(1000, 设定值)`，对 DeepSeek / OpenAI 兼容 / Claude 等统一生效 |

## ProjectGraph 设置

| 参数 | 类型 | 默认值 | 范围 | 说明 |
|---|---|---|---|---|
| `projectGraphMaxDepth` | 数字 | `0` | `0` - `∞` | 目录扫描最大深度。0 表示不限制 |
| `projectGraphMaxFiles` | 数字 | `0` | `0` - `∞` | 参与图谱构建的最大文件数。0 表示不限制 |
| `projectGraphMaxEdges` | 数字 | `0` | `0` - `∞` | 关系边（导入/调用/继承）数量上限。0 表示不限制 |
| `projectGraphMaxSymbolsPerFile` | 数字 | `0` | `0` - `∞` | 每文件提取的符号上限。0 表示不限制 |
| `projectGraphMaxFileBytes` | 数字 | `0` | `0` - `∞` | 单文件最大字节数，超大文件不扫描。0 表示不限制 |
| `projectGraphMaxTreeEntries` | 数字 | `0` | `0` - `∞` | 目录树最大条目数。0 表示不限制 |

## 子代理设置

### Explore（代码分析子代理）

| 参数 | 类型 | 默认值 | 范围 | 说明 |
|---|---|---|---|---|
| `exploreTemperature` | 数字 | `0.5` | `0` - `2` | Explore 生成温度 |
| `exploreTopP` | 数字 | `0.9` | `0` - `1` | Explore 核采样参数 |
| `exploreMaxTokens` | 数字 | `200000` | `100` - `200000` | Explore 单次响应最大输出 token |
| `exploreMaxToolRounds` | 数字 | `200` | `1` - `500` | Explore 最大工具调用轮数 |
| `exploreMaxDepth` | 数字 | `2` | `1` - `5` | Explore 嵌套深度上限 |
| `exploreThinkingEnabled` | 布尔 | `true` | — | Explore 启用推理模式 |
| `explorePrompt` | 字符串 | `''` | — | Explore 的自定义系统提示词 |

### Scout（网页搜索子代理）

| 参数 | 类型 | 默认值 | 范围 | 说明 |
|---|---|---|---|---|
| `scoutTemperature` | 数字 | `0.3` | `0` - `2` | Scout 生成温度 |
| `scoutTopP` | 数字 | `0.9` | `0` - `1` | Scout 核采样参数 |
| `scoutMaxTokens` | 数字 | `200000` | `100` - `200000` | Scout 单次响应最大输出 token |
| `scoutMaxToolRounds` | 数字 | `200` | `1` - `500` | Scout 最大工具调用轮数 |
| `scoutMaxDepth` | 数字 | `2` | `1` - `5` | Scout 嵌套深度上限 |
| `scoutThinkingEnabled` | 布尔 | `false` | — | Scout 启用推理模式 |
| `scoutPrompt` | 字符串 | `''` | — | Scout 的自定义系统提示词 |

### 自定义子代理

| 参数 | 类型 | 默认值 | 范围 | 说明 |
|---|---|---|---|---|
| `SUBAGENT_DEFAULT_MAX_TOOL_ROUNDS` | 数字 | `50` | — | 自定义子代理默认最大工具调用轮数 |
| `SUBAGENT_MAX_DEPTH` | 数字 | `2` | `1` - `5` | 子代理嵌套深度上限。子代理可委派其他子代理，此值限制嵌套层数 |

## Mentor 设置

| 参数 | 类型 | 默认值 | 范围 | 说明 |
|---|---|---|---|---|
| `mentorEnabled` | 布尔 | `false` | — | 启用 Mentor 子代理 |
| `mentorModel` | 字符串 | `''` | — | Mentor 使用的模型 |
| `mentorBaseURL` | 字符串 | `''` | — | Mentor API 端点 |
| `mentorApiKey` | 字符串 | `''` | — | Mentor API 密钥 |
| `mentorApiFormat` | 枚举 | `openai` | `openai` / `claude` | Mentor API 格式 |
| `mentorMaxTokens` | 数字 | `10000` | `100` - `∞` | Mentor 单次响应最大输出 token |
| `maxMentorConsultations` | 数字 | `2` | `0` - `∞` | 单次对话中 Mentor 最大咨询次数 |
| `mentorPrompt` | 字符串 | `''` | — | Mentor 的自定义系统提示词 |
| `mentorThinkingEnabled` | 布尔 | `false` | — | Mentor 启用推理模式 |

## 硬编码常量（不可通过设置面板配置）

| 常量 | 值 | 位置 | 说明 |
|---|---|---|---|
| `EditHistory` 撤销栈上限 | `100` | `editHistory.ts:29` | 编辑历史最多记录 100 次编辑操作 |
| 自定义提示词最大长度 | `32000` 字符 | `agentConfig.ts` | 防止恶意长输入 |
| 拖拽文件最大大小 | `1` MB | `ChatPanel.tsx:55` | 文件拖拽上传的大小限制 |

## 语言设置

| 参数 | 类型 | 默认值 | 可选值 | 说明 |
|---|---|---|---|---|
| `lang` | 枚举 | `zh-CN` | `zh-CN` / `zh-TW` / `en` | 界面与提示词语言 |
