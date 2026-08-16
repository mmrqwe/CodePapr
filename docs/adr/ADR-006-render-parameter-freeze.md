# ADR-006: 渲染参数冻结 + 确定性重放（不做 renderings 快照表）

- 状态: Accepted
- 日期: 2026-08-16
- 关联: ADR-001, ADR-003

## 背景

`buildEffectiveContextMessages()` 里执行的 prune / summary / orphan repair /
`contextContent` / `promptContent` 选择等编译步骤，可能随用户设置变化在重启重放时
产生不同字节，破坏 prefix cache。

曾考虑 `context_surface_renderings` 表保存每个 generation 的最终模型可见形态，
但该方案：

1. 与不变式「surface 不复制消息文本」冲突；
2. 无法覆盖 per-request 纯函数（`applyHistoryToolSummaries` 的 latest-batch flip、
   `stripConsumedImages`），快照本就不等于最终请求字节。

## 决策

**每个 Surface generation 冻结渲染参数（`SurfaceRenderParams`）+ hydrate 时确定性重放。**

排查结论：重启重放唯一受 settings 漂移影响的是 prune（`pruneOptions` 来自
CompactionSettings，compactionHandler.ts:22-30）；summaries 使用 metadata 中冻结的
`toolSummary`、`toCoreTailMessages` 使用持久化的 `contextContent`/`promptContent`，
都已是消息数组的纯函数。

- generation 行存 `pruneParams`（冻结、可序列化）+ `renderVersion`；
- hydrate 时用**冻结参数**重放编译器，忽略当前 settings 的 prune 配置；
- 代码升级导致的字节变化 = 一次性 cache miss，与现状一致，接受；
- per-request transform（summaries / images）永远在 RequestBuilder 构建时执行，不入持久层。

## 后果

- PR1 的 surface 表必须包含冻结参数列（或 JSON 列）。
- 编译器代码升级不再承诺跨版本字节一致（renderVersion 用于标记与调试）。
