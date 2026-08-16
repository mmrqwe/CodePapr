# ADR-004: Bootstrap 永远不属于 Surface

- 状态: Accepted
- 日期: 2026-08-16
- 关联: ADR-001, ADR-003

## 背景

Session bootstrap 的 message ID 是常量 `session-bootstrap`（compactionHandler.ts:108-119），
它不是 `messages` 表里的 archive message。它由 `sessionBootstrapCache` 按
「session × stable signature」冻结（sendMessage.ts:191-226），属于 prefix 层。

## 决策

Surface 只保存：checkpoint + conversation tail + model-visible injected context。

Surface 不保存：

- session bootstrap；
- Immutable Prefix（system prompt / tools schema / model 参数）。

最终请求结构保持 `Prefix + Bootstrap + Surface materialization + suffix`，
bootstrap 继续按 session 冻结、按 epoch 刷新，不污染 Surface。

## 后果

- Surface 节点引用的 message ID 必须都存在于 archive（checkpoint 合成消息也持久化在 archive）。
- 任何类似 bootstrap 的注入内容都不允许进入 surface nodes。
