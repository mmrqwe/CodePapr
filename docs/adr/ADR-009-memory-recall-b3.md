# ADR-009: Memory Recall 采用 B3 —— 独立表 + request-time anchored insertion

- 状态: Superseded by [ADR-016](./ADR-016-memory-v5-memory-md.md)（Retrieval 与锚定插入机制整体退役）
- 日期: 2026-08-16
- 关联: ADR-001（L5 层）, ADR-002, ADR-005

## 背景

Recall Block 的注入位置必须在当前 user 消息之前、同一 tool loop 内字节稳定、
turn 结束后不滞留。曾评估：

- B1（Recall 作为隐藏合成消息 append 进 log）：注入顺序正确，但 append-only 语义下
  无法在 turn 结束时移除，会滞留到 compaction，且污染 round 计数 / transcript /
  search / rebuild 等多处，长期消耗 token。仅作最小 MVP 备选。
- B2（每回合 epoch reset 清除）：每回合都破坏整个前缀缓存，违反 cache-first。**否决**。
- B3（独立 `memory_recalls` 表 + RequestBuilder 请求构建时的 anchored insertion）：
  Recall 不进 log / archive / surface，只在编译产物中临时插入。**采用**。

## 决策（15 条）

1. Recall 是 request-only augmentation，不属于 AppendOnlyLog / Archive messages / Context Surface。
2. Recall 锚定插入到当前 canonical user 消息**之前**。
3. Recall 持久化到独立 `memory_recalls` 表做审计，不作为隐藏合成消息进 messages。
4. 每个用户回合生成一次，该回合 tool loop 内所有请求复用同一 Recall Block。
5. 重启不恢复 Recall（上一回合的 request-only 内容不重放）。
6. Recall 不参与 round 计数、conversation search、checkpoint transcript、compaction source range。
7. Recall 默认不参与 checkpoint merge；只有当前工作中独立验证的事实才能进入
   checkpoint / durable memory。
8. v1 检索引擎 = LIKE/token 检索 + metadata 加权重排；不上 embedding。
   FTS5 runtime probe 已落地（rusqlite bundled 实测含 FTS5）：trigram 索引做
   候选预筛、短 token LIKE 补齐，确定性 scoring 语义不变；中文查询按
   2 字 bigram 切分 token（整句无空格中文不能作单 token 匹配）。
9. Untrusted web / MCP / 原始 artifact 内容默认不自动召回。
10. Recall 有独立 token/item budget：`maxRecallItems=5 / maxRecallTokens=1200 /
    maxSingleRecallItemTokens=350`；紧张时
    `recallBudget = min(configured, remainingSoftBudget * 0.20)`。
11. re-recall 是受控例外：用户显式要求 / `memory_search` / 子任务重置 / 主线程判定原
    Recall 无关时触发，每 turn 至多一次，`order` 递增（新 block 插在旧 block 之后、
    用户消息之前）。
12. 记忆可见性三级：当前回合 = 直接证据；下一用户回合 = RAG Recall；
    下一 epoch / 新 session = frozen bootstrap snapshot。**不设独立 Memory Delta 层。**
13. `RequestContextInsertion` 只作用于 log 段的编译产物，不进入 AppendOnlyLog /
    Archive / Surface / hash 基线（validateAppendOnly 不感知）。
14. **user 消息 ID 由主线程生成并贯穿 store、payload、worker log**
    （废除 worker 内 `MessageFactory.user` 的 `generateUUID` 路径，Message.ts:9-13），
    作为 recall anchor 的稳定引用。这是 B3 的前置管线改造（PR1 落地）。
15. Recall token 计入 `estimateContextTokens`（Agent.ts:504-511）与 PR2 的
    request token breakdown。

### 请求组装

```text
RequestBuilder.build():
  validateAppendOnly(log)          ← log 不含 recall
  compile(log, insertions)         ← anchor 扫描仅作用于 log 段
  + suffixMessages
  stripConsumedImages / applyHistoryToolSummaries（per-request 纯函数，不变）
```

anchor miss 兜底：跳过该 insertion + warn 日志（宁可缺召回，不可错位）。

### 生命周期

```text
用户提交新消息
  → 主线程确定 canonical userMessageId（= 主线程 ID，见第 14 条）
  → 检索 memory ledger / checkpoint / artifact index（LIKE + 重排）
  → 生成 Recall Block → 写 memory_recalls（status='active'）
  → insertion 随 chat payload 下发给 Agent（字段，不进 messages 数组）
  → 该 turn 所有 LLM request 复用同一 insertion（mid-loop replaceLog 后仍存活，存 Agent 字段）
  → turn 结束 → status='archived'，不再作为后续 turn 的 insertion
  → 记录留在 memory_recalls 供审计 / Context Inspector
```

### 检索语料与优先级

```text
1. memory_entries（active，verified 优先，category 加权）
2. 历史 session checkpoint（goal / confirmedFacts / verification 命中）
3. artifact 摘要 / 文件路径（默认不召回全文，需要时 history_read_artifact）
```

### Recall 渲染语义

Recall 是「辅助事实，可能过时，需对照当前 workspace 验证」，
不是「必须遵守的指令」；渲染时必须带 trust/provenance 标记。

## 后果

- PR5 需要：`RequestContextInsertion` 编译能力（RequestBuilder）+ userMessageId 管线 +
  memory_recalls 表 + 检索/重排（Rust 侧 LIKE）。
- 子代理（task 工具）v1 不做 recall；GoalRunner 自主循环复用同一 recall。
