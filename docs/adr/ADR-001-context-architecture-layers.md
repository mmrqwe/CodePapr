# ADR-001: Context 架构分层（Archive / Surface / ActiveLog / Checkpoint / Project Memory / Recall）

- 状态: Accepted
- 日期: 2026-08-16
- 关联: ADR-002 ~ ADR-010

## 背景

当前 CodePapr 的模型上下文是动态推导的：扫描消息数组 → 找最新 checkpoint → 取 tail →
执行 prune / repair / core 转换 → 生成 effective context。正常运行没问题，但无法支撑
checkpoint 来源追踪、压缩事务恢复、重启字节稳定重建、session recall 与 memory evidence。

## 决策

正式冻结六层结构：

```text
L0. Archive（SQLite messages）
    原始对话真相：UI、搜索、回放、恢复。唯一 raw 文本权威。

L1. Context Surface（SQLite context_surfaces + nodes）
    当前模型历史选择的唯一权威：checkpoint + retained tail 的 message ID 序列。
    可持久化、可审计、带 generation。

L2. Active Runtime Cache（AppendOnlyLog）
    当前 Agent 执行时的快速读取缓存。由 Surface 经确定性编译器重放重建。
    压缩后 reset 是合法 epoch 重置。

L3. Session Checkpoint（ContextCheckpointPayload）
    当前任务状态合并，不等于完整历史。

L4. Project Memory（SQLite memory ledger + .CodePapr/memory.md 双区投影）
    跨 session 的稳定知识，不等于当前任务状态。零审核自动写入；
    citation / procedure 不进 Bootstrap（ADR-010）。

L5. Turn-scoped Memory Recall（SQLite memory_recalls + request-time insertion）
    request-time augmentation 层，不是持久模型上下文层。按回合检索一次、
    锚定插入到当前 user 消息之前，不进入 AppendOnlyLog / Archive / Surface。
```

渲染链路：

```text
Canonical Archive messages
  → Current Context Surface（message ID 序列 + 冻结渲染参数）
  → Hydrate 引用的 UI messages
  → Context compiler（tool pair repair / contextContent 选择 / core IMessage 转换）
  → Runtime AppendOnlyLog
  → RequestBuilder（+ anchored insertions + suffix）
```

最终请求结构：

```text
[Immutable Prefix]        system prompt / tools / model parameters
[Session Bootstrap]       frozen AGENTS / skills / epoch memory snapshot（永远在 Surface 外）
[Surface Materialization] checkpoint + retained model-visible history
[Turn-scoped Recall]      anchored before current user message（B3，见 ADR-009）
[Current User Message]    canonical message in AppendOnlyLog
[Current Turn History]    assistant/tool messages
[Suffix]                  continuation / question-answer mechanics only
```

## Per-request transform 边界

以下转换是「请求构建时的纯函数」，不属于任何持久层，也不允许被渲染快照固化：

- `applyHistoryToolSummaries`（latest-batch flip，RequestBuilder.ts:96-113）
- `stripConsumedImages`（只保留最后一条带图 user 消息）

## 后果

- 新 Surface/Compaction/Recall 数据必须明确归属到某一层，禁止出现第二份 raw 文本权威。
- 任何「模型可见内容」的来源必须可追溯到 Archive message ID 或派生规则。
