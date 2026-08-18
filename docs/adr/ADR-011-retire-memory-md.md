# ADR-011: 退役 memory.md，账本 + 面板为唯一记忆面

- 状态: Accepted
- 日期: 2026-08-18
- 关联: 取代 [ADR-008](./ADR-008-memory-dual-zone.md) 的双区文件投影；保留 [ADR-010](./ADR-010-memory-zero-inbox.md) 的零审核写入与 [ADR-009](./ADR-009-memory-recall-b3.md) 的 Recall

## 背景

ADR-008 用 `memory.md` 双区投影给人看、给 Bootstrap 读：User Zone 手写、Managed Zone 机器投影。结果是两套面（文件 + 面板）不同步，citation / procedure 在文件里看不见，手写笔记又绕过面板。产品要求：**所有记忆必须在系统面板可见**，不再维护独立的 `memory.md`。

## 决策

**SQLite `memory_entries` 是唯一存储；记忆面板是唯一给人看/改的面。Bootstrap 从账本渲染冻结字符串，不再读文件。**

| 种类 | 面板分组 | 请求层 |
|---|---|---|
| user-note、preference、constraint、fact、convention、verification、decision、api、general | 每次会话 | Session Bootstrap（会话启动 / 压缩 epoch 从账本渲染；当前前缀不因新写入重建） |
| procedure | 按需召回 | Turn-scoped Recall / `memory_search` |
| citation | 仅搜索 | 仅 `memory_search` |
| forgotten | 勾选「含已遗忘」 | 不进请求 |
| drop（注入 / 密钥等） | 不出现 | 从未落盘 |

手写笔记只在面板新增/编辑（`source: user`，`category: user-note`）。Agent `memory_write` 自称 user-note 会改成 `general`。`memory_forget` 不能删 user-note。

遗留 `.CodePapr/memory.md`：`ingest_legacy_memory_md` 把 User Zone（账本为空则整文件）收成一条 user-note，然后删除文件。无文件则 no-op。

Agent 仍 `write` / `patch` `.CodePapr/memory.md` 时拦截、不落盘，走 `planMemoryWrite`。

## 后果

- 面板是完整目录，没有「文件里有、面板没有」的缺口。
- 前缀缓存行为不变：账本渲染结果排除在 `bootstrapSignature` 外，按 (session × 稳定签名) 冻结。
- ADR-008 的双区文件布局只作为一次性迁移格式保留在 ingest 路径。
