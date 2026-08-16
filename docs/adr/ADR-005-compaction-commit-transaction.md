# ADR-005: 压缩事务由主线程 Store 统一持久化（commit 顺序 + 崩溃恢复）

- 状态: Accepted
- 日期: 2026-08-16
- 关联: ADR-002, ADR-003

## 背景

压缩有两个入口：

```text
A. 回合间：sendMessage → maybeGenerateContextCheckpoint()（已在主线程）
B. Worker 内 mid-loop：Agent.chat() 轮首溢出 → createContextCompactionHandler()
```

若两条路径各自写 DB，会出现双事务顺序、Worker/主线程并发写、
checkpoint 已写但 surface 未切等中间态。

## 决策

**主线程 Store 是唯一 DB 写者。** 统一流程：

```text
Worker / main runtime
  → 产生 Compaction Intent
  → 主线程校验（schema 有效 / 有效缩容 / pinned 内容保留，校验器 PR3 补全）
  → 主线程将 checkpoint 合成消息插入 session 消息数组 → saveMessageBatch 持久化
  → Rust commit_context_compaction（PR1 实现）单 unchecked_transaction 内提交
  → 主线程返回 committed surface + materialized messages
  → runtime 用 committed surface 重建 AppendOnlyLog（replaceLog + resetLogTracking）
```

回合间路径内联进既有 save 流程；mid-loop 路径走
`CommitContextCompactionRequest / CommitContextCompactionResponse` 协议
（agentWorkerProtocol.ts，PR1 接线）。

### 冻结的 commit 事务顺序

```text
1. LLM/local 生成 checkpoint（无任何 DB 写入）
2. 主线程校验 intent
3. checkpoint 消息随消息批进入 archive（允许与 surface 提交之间有崩溃窗口）
4. 单事务内：
   INSERT context_compactions(status='started')
   → INSERT surface generation + nodes
   → UPDATE status='completed' + target_generation
   → 一步提交
```

推论：**不存在 started 行残留**（SQLite 事务原子性），崩溃恢复简化为防御性清理：

```text
启动时：
1. 检测 status='started' 的残留行（理论不存在，防御）→ 标记 failed:interrupted
2. 孤儿 checkpoint 消息（archive 有、surface 不引用）→ 无害，防御性清理
3. active surface = 最新 completed generation；无 completed → 按 legacy 生成 generation 0
```

## 后果

- Rust 新增专用命令 `commit_context_compaction`（PR1），不复用 saveMessageBatch 之外的 JS 侧多步写。
- Worker 侧 compaction handler 变为「生成 intent + 等待主线程 commit」。
