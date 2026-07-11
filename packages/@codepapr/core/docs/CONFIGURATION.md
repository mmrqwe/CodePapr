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
| `maxTokens` | 数字 | `393216` | `100` - `393216` | 单次响应最大输出 token 数 |
| `maxToolRounds` | 数字 | `500` | `1` - `∞` | 单次对话中 Agent 连续调用工具的最大轮数 |
| `debugEnabled` | 布尔 | `false` | — | 调试模式，记录完整提示词 |
| `systemPrompt` | 字符串 | `''` | — | 自定义系统提示词。留空则使用内置默认 |

## 上下文压缩设置

| 参数 | 类型 | 默认值 | 范围 | 说明 |
|---|---|---|---|---|
| `compactionModel` | 枚举 | `fast` | `fast` / `primary` | 执行上下文压缩的模型 |
| `compactionMaxTokens` | 数字 | `1800` | `100` - `100000` | 压缩 LLM 调用的最大输出 token |
| `compactionTemperature` | 数字 | `0.1` | `0` - `2` | 压缩 LLM 调用的温度，越低越确定 |
| `maxContextTokens` | 数字 | `200000` | `1000` - `1000000` | 上下文窗口 token 上限，超出时触发压缩 |
| `maxConversationRounds` | 数字 | `24` | `2` - `500` | 触发上下文压缩前保留的最大对话轮数 |

## TodoList 设置

| 参数 | 类型 | 默认值 | 范围 | 说明 |
|---|---|---|---|---|
| `todoMaxRetries` | 数字 | `3` | `0` - `10` | 单条 TodoList 任务失败后的最大重试次数。0 表示不重试 |

## ProjectGraph 设置

| 参数 | 类型 | 默认值 | 范围 | 说明 |
|---|---|---|---|---|
| `projectGraphMaxDepth` | 数字 | `8` | `1` - `∞` | 目录扫描最大深度 |
| `projectGraphMaxFiles` | 数字 | `120` | `1` - `∞` | 参与图谱构建的最大文件数 |
| `projectGraphMaxEdges` | 数字 | `960` | `1` - `∞` | 关系边（导入/调用/继承）数量上限 |
| `projectGraphMaxSymbolsPerFile` | 数字 | `24` | `1` - `∞` | 每文件提取的符号上限 |
| `projectGraphMaxFileBytes` | 数字 | `180000` | `1000` - `∞` | 单文件最大字节数，超大文件不扫描 |
| `projectGraphMaxTreeEntries` | 数字 | `320` | `20` - `∞` | 目录树最大条目数 |

## 子代理设置

| 参数 | 类型 | 默认值 | 范围 | 说明 |
|---|---|---|---|---|
| `subagentTemperature` | 数字 | `0.5` | `0` - `2` | 子代理生成温度 |
| `subagentTopP` | 数字 | `0.9` | `0` - `1` | 子代理核采样参数 |
| `subagentMaxTokens` | 数字 | `393216` | `100` - `393216` | 子代理单次响应最大输出 token |
| `subagentThinkingEnabled` | 布尔 | `true` | — | 子代理启用推理模式 |
| `subagentMaxToolRounds` | 数字 | `100` | `1` - `500` | 子代理最大工具调用轮数 |
| `subagentMaxDepth` | 数字 | `2` | `1` - `5` | 子代理嵌套深度上限。子代理可委派其他子代理，此值限制嵌套层数 |
| `explorePrompt` | 字符串 | `''` | — | Explore 子代理的自定义系统提示词 |
| `scoutPrompt` | 字符串 | `''` | — | Scout 子代理的自定义系统提示词 |
| `mentorPrompt` | 字符串 | `''` | — | Mentor 子代理的自定义系统提示词 |

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

## 硬编码常量（不可通过设置面板配置）

| 常量 | 值 | 位置 | 说明 |
|---|---|---|---|
| `EditHistory` 撤销栈上限 | `100` | `editHistory.ts:29` | 编辑历史最多记录 100 次编辑操作 |
| 自定义提示词最大长度 | `8000` 字符 | `agentConfig.ts:161` | 防止恶意长输入 |
| 拖拽文件最大大小 | `1` MB | `ChatPanel.tsx:55` | 文件拖拽上传的大小限制 |

## 语言设置

| 参数 | 类型 | 默认值 | 可选值 | 说明 |
|---|---|---|---|---|
| `lang` | 枚举 | `zh-CN` | `zh-CN` / `zh-TW` / `en` | 界面与提示词语言 |
