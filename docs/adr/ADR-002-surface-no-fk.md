# ADR-002: Surface / Compaction / Recall 表不对 messages 建外键

- 状态: Accepted
- 日期: 2026-08-16
- 关联: ADR-001, ADR-003, ADR-005, ADR-009

## 背景

`save_message_batch`（db/mod.rs:1328-1332）对当前 session 采用
「DELETE 全部 messages → INSERT 当前完整 messages」的全量替换语义，
且每次打开 DB 都执行 `PRAGMA foreign_keys = ON`（db/mod.rs:199）。

若 Surface 节点表声明 `message_id REFERENCES messages(id) ON DELETE CASCADE`，
每次普通保存都会级联清空该 session 的所有 surface 节点；
compaction 表的 `checkpoint_message_id` 也会被 ON DELETE SET NULL 置空。

## 决策

`context_surfaces` / `context_surface_nodes` / `context_compactions` /
`memory_recalls` 一律**不对 `messages` 建数据库外键**。

- `messages.id` 作为应用级稳定 ID 承担 provenance；
- 引用完整性由应用层维护；
- 不改 `save_message_batch` 的全量替换语义（动最核心持久化路径不值得）。

应用层规则：

1. 加载 Surface 时批量按 ID 从 archive 查找消息；
2. 某 ID 缺失：标记该 generation 为 degraded → 回退 parent generation →
   无 parent 则从 archive 重新生成 generation 0；
3. 不自动删除 archive；
4. 不默默改写 checkpoint；
5. 孤儿 checkpoint（已入 archive 未入 surface）判定为无害（synthetic+hidden，
   Surface 权威下不参与重建），启动时防御性清理。

## 后果

- Rust DDL 更简单；查询需要 JOIN 时由应用层完成。
- 全量替换保存后 surface 不会被动清空；应用层需要在 save 流程中显式维护 surface 节点。
