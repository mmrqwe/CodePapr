# ADR-015: 上下文压缩 v4 —— 骨架引擎与统一 epoch 提交

- 状态: Accepted
- 日期: 2026-09-11
- 关联: [ADR-001](./ADR-001-context-architecture-layers.md)（分层）、[ADR-005](./ADR-005-compaction-commit-transaction.md)（提交事务）、[ADR-006](./ADR-006-render-parameter-freeze.md)（渲染参数冻结，**部分被本 ADR 废止**）、[ADR-007](./ADR-007-checkpoint-payload-v3.md)（v3 结构化 payload，**被本 ADR 取代**）

## 背景

v2/v3 压缩（软预算 0.7 + prune-first / 硬预算 LLM 结构化合并 / 轮数上限 24）在线上暴露：

1. **主压缩烧 LLM 且常白烧**：22/31 次压缩降级为 local-fallback，v3 状态合并的
   schema 校验、pinned 验证、失败码全在为「一次摘要」服务；触发分层（软/硬/轮数）
   让压缩时机难以解释。
2. **五条路径行为不一致**：回合末与 Goal 的 surface 提交是 fire-and-forget（失败
   异步回滚与下一回合竞态）；Goal 的「每 5 迭代压缩」不重建 agent、不刷 Bootstrap，
   对运行时上下文几乎无效（假压缩）；task 子代理完全没有压缩，只有按字符截断；
   mid-loop 刷新 Bootstrap 失败会产出**无记忆前缀的 epoch**（测试明文允许）。
3. **记忆新鲜度被压缩频率绑架**：Bootstrap 冻结换前缀缓存是刻意契约（ADR-001/004），
   但刷新点只在中途压缩一处兑现，epoch 语义在多数路径落空。

## 决策

### 1. 单一触发线

删除轮数触发（`maxConversationRounds`）与软硬分层（`0.7` 软预算、`prune-tool-results`
动作）。唯一规则：**usage ≥ `maxContextTokens` × 90%**（常量 `COMPACT_TRIGGER_RATIO`）。
provider 实测与估算取大者；`/compact`/Goal force 可越过触发线，但无效缩容仍被拒。

### 2. 骨架优先（确定性，零 LLM）

核心引擎 `core/src/agent/compactionEngine.ts`（纯函数，所有入口共用）：

- 回合 = user 消息 + 其后全部 assistant/tool；
- 更早回合折叠为骨架行：`问：`截断 300 字 + `答：`（最后一条可见结论，头 300 尾 100）
  + 丢弃工具调用计数；
- 最近 **5 回合逐字**（含工具调用/结果）；超预算时 tail 5→4→…→1 降级，再超则对
  最后一轮做**轮内折叠**（checkpoint 边界落进回合内部，保最后 3/2/1 个工具轮组，
  早期轮折成活动行、用户问题重建为 `[当前任务]` 行）；
- 以上全失败才有**一次** LLM 二级摘要（输入 `preSizeSummaryInput` 确定性预瘦身；
  失败/不可用走 `deterministicSummary` 按行截断）；压缩链深度封顶 1，绝不递归；
- TodoList 权威 digest 是 pinned 信息，独立注入检查点正文，不参与任何折叠；
- 单条巨型输出仍由入口护栏约束（工具输出截断 + artifact 外置），设置不再暴露
  字符类参数（`toolContext*`、`toolOutputMiddleKeepChars` 内置化）。

### 3. checkpoint payload v4

`version: 4`：`skeleton[]` + 可选 `summaryBlock` / `activityText`；`summary` /
`renderedContent` 字段保持（检索语料与 surface 渲染不破）。v2/v3 行只读，下一次
压缩把旧块文本当作 `priorFoldedText` 并入新块首（不摘要套摘要）。

### 4. 统一 epoch 提交（所有主线程入口）

`applyEpochCompaction`：重读账本重渲染 Bootstrap → prime 缓存 + 写回 runtime config
→ 基座校验插 checkpoint → 就地重建 agent → **await** `commitCheckpointOrdered`
（ADR-005 单事务，失败回滚）。回合末、`/compact`、Goal 循环全部走这一条路；
Goal 每 5 迭代的压缩自此成为真压缩。mid-loop 在 worker 侧同引擎、主线程校验通过后
原子提交；Bootstrap 刷新失败时**沿用压缩前冻结的 bootstrap 消息**，
「无记忆前缀的 epoch」不再可能。

### 5. 子代理 headless 压缩（同引擎）

task 子代理注入 `createHeadlessCompaction`（core）：同一 90% 线、同一骨架、轮内
折叠、一次二级摘要（摘要器由 UI/worker 侧注入 Compactor 会话）；不写 surface /
archive / bootstrap prime（前缀在 ImmutablePrefix，不在 log）。internal 代理
（compactor/verifier）不接入。父子的压缩经「工具结果边界」天然正交。嵌套深度沿用
既有 `SUBAGENT_MAX_DEPTH = 2`（超限 task 调用直接报错）。

## 后果

- 正面：主压缩零 LLM 成本零失败模式；触发条件一句话说得清；Goal/子代理不再是
  压缩盲区；void 提交竞态消灭；记忆 epoch 在每条路径兑现。
- 代价：A 抽取是截断而非理解（长结论中段有损，靠 `[第 n 轮 · N 次工具调用]` 注记 +
  `history_read_artifact` + checkpoint 检索语料兜底）；prune 层删除后，保留回合内
  的旧工具结果不再瘦身（由入口护栏与 5 轮上限约束）；`decideContextBudgetAction`
  的 prune 分支成为死代码（soft == hard），物理删除留作后续清理。
- 设置迁移：`maxConversationRounds` / `prune*` 字段从设置与类型中移除，旧存档值被
  normalizer 静默忽略；`compactionModel` 系列仅服务二级摘要。
