# ADR-014: 冷启动记忆摘要退役与重复记忆收敛

- 状态: Accepted
- 日期: 2026-09-11
- 关联: [ADR-008](./ADR-008-memory-dual-zone.md)（双区）、[ADR-009](./ADR-009-memory-recall-b3.md)（Recall）、[ADR-010](./ADR-010-memory-zero-inbox.md)（零审核写入）

## 背景

ADR-010 的写入门表里，「冷启动 LLM 摘要」是 `reported`：以事实入账但不进固定前缀，只按需召回。
线上一个 iOS 项目暴露了三件事叠在一起的后果（21 条同源摘要、8 条 Recall 全是同一段目录清单）：

1. **幂等守卫读的集合永远不包含它写的集合。** 冷启动的触发条件是
   `loadMemoryBootstrapSection()` 为空，而该函数走 `buildMemoryProjection()`，后者
   `confidence !== 'confirmed'` 一律跳过。M8 把冷启动产物降级成 `reported` 时没有同步
   这个守卫，于是「账本里还没有 Bootstrap 记忆」恒为真——**每条用户消息**重新生成一次
   摘要、重新落一条。在飞标记 `memoryBootstrapInFlight` 只挡并发，`finally` 里就清了。
2. **去重只认精确 hash。** `contentHash = sha256(原文)`，LLM 每次措辞不同就是新条目；
   M4 的近义合并阈值是字符 bigram Jaccard ≥ 0.8，而 80 行文档改述后 Jaccard 被并集稀释
   （实测 21 条两两最高 0.783），数学上打不到。
3. **内容本身没有记忆价值。** prompt 强制覆盖「目录结构 + 技术栈」并要求 80 行 blob；
   这些结构 project-graph 缓存里现成可取，规则文件也已另有其人（`AGENTS.md`）。大 blob
   同时破坏了原子性：既不能按条预算，也不能差异化召回。

后果是 Recall 的 5 个槽位被同一份目录清单的 5 个变体占满（≈1100 token / 1200 预算），
真正有用的 constraint / decision 永远挤不进来。

## 决策

### 1. 冷启动 LLM 摘要整条退役

`bootstrapMemoryContent()`（`utils/memoryConsolidation.ts`）与 `sendMessage` 里的冷启动
分支一并删除。project-graph 摘要仍保留，但只给 explore / scout 子代理注入（主会话
Bootstrap 早已不含它）。`'cold-start-bootstrap'` 这个 source 留在枚举里只为解析历史条目。

**不再需要「Bootstrap 是否已生成」这个判断**——没有生成器，就没有幂等守卫可错。

### 2. reported 必须是原子事实

`planMemoryWrite` 新增 `MEMORY_REPORTED_MAX_CHARS = 400`：`reported`（Agent 自报）内容
超限直接 drop（`reported-too-long`）。`confirmed`（用户原话 / 工具输出 / 面板手写）仍按
全局 8000。`memory_write` 的入队上限与描述同步收紧，并明写「目录清单 / 依赖列表 /
技术栈概述这类可即时探测的信息一律不记」。

### 3. 重复记忆的三层收敛

| 层 | 位置 | 规则 |
|---|---|---|
| 同源单例 | `admit_memory_candidate` | `origin` 以 `cold-start-` 开头的派生条目只允许一条 active，新者胜，旧的 `superseded` |
| 近义合并 | `is_near_duplicate` | 短文本仍用 Jaccard ≥ 0.8；长文本（≥60 bigram）改用 containment ≥ 0.85 且长度比 ≥ 0.6 |
| 存量迁移 | `user_version` 7 → 8 | 打开项目库时对 `trust='derived'` 条目跑一遍同源 + 近义收敛，计数写进 `project_meta.memory_dupes_collapsed` |

containment 只用于长文本，是因为它在短事实上会误合：「触控偏下」vs「触控偏上」
containment 0.857，但两者是互斥事实。长度比门槛挡住「摘要 ⊂ 全文」这种包含关系。
`user-note` / `trust='trusted'` / `'workspace'` 条目永不被自动收敛。

遗忘保护从精确 hash 扩展到近义：用户忘掉一份摘要后，换个说法的变体不算新内容。

### 4. Recall 侧的多样性

`selectDiverseRecallItems()`（`utils/memoryRecall.ts`）在渲染前过滤：与已选条目
bigram containment ≥ 0.85 视为重复跳过，单一 category 每轮最多 3 条。搜索候选量从
8/10 提到 16，避免过滤后凑不满槽位。自动 Recall 与 `memory_search` 两条路径共用。
嵌套的 checkpoint（一条摘要把另一条整段包进去）被同一条规则顺带吃掉。

## 后果

- 每个项目的重复派生记忆收敛到 1 条；Recall 预算重新分给真实事实。
- 记忆写入的唯一入口变成「有来源、够短、可验证」——LLM 不再批量生产项目概览。
- `PROJECT_SCHEMA_VERSION` 升到 8；老项目首次打开时自动收敛，面板另有「清理重复」
  与多选批量遗忘作为兜底。
- 工具描述变更会改 tool schema → prefix hash → 一次性缓存失效（可接受）。
