# ADR-003: Surface 是当前模型历史选择的唯一权威

- 状态: Accepted
- 日期: 2026-08-16
- 关联: ADR-001, ADR-002, ADR-004, ADR-006

## 背景

现在运行时上下文通过「扫描消息数组找最新 checkpoint」（`getLatestCheckpoint`,
contextCompaction.ts:170-183）动态推导。引入持久化 Surface 后存在双源真相风险：
archive 里的旧 checkpoint 消息与 surface 表指向的 generation 不一致。

## 决策

一旦某 session 存在 persisted Surface：

- **禁止**再靠扫描「最新 checkpoint」决定当前模型历史；
- 重建链路 = Surface → Hydrate → 确定性编译器重放（ADR-006）；
- 旧的扫描逻辑只保留给没有 Surface 的 legacy session：

```text
if latestSurface exists:
  从 Surface 重建
else:
  旧 checkpoint 扫描逻辑 → 创建 generation 0
```

Surface 负责：哪些 archive message / checkpoint 节点属于当前模型历史及其顺序。
Surface 不负责：直接取代编译逻辑（prune / repair / summaries / contextContent 选择）。

## 后果

- 数组扫描逻辑必须收敛到 legacy bootstrap 路径，不再服务有 Surface 的 session。
- 压缩提交必须同步更新 Surface（ADR-005），否则重建与新 epoch 不一致。
