-- 参考 DDL（PR1 落库时以 db/mod.rs 的最终实现为准；本文件仅供评审与对齐）
-- 原则：不对 messages 建外键（ADR-002）；全部 CREATE TABLE IF NOT EXISTS 增量迁移。
--
-- ⚠️ 历史快照：`memory_recalls` 段（ADR-009）已随 v9 迁移（ADR-016）删除；
--    memory_entries / memory_candidates 同理，正文保留仅作评审历史。

-- ---------------------------------------------------------------------------
-- Context Surface：当前模型历史选择的唯一权威（ADR-001/003）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS context_surfaces (
  session_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  parent_generation INTEGER,
  compaction_id TEXT,
  -- 冻结渲染参数（ADR-006）：JSON 序列化的 { pruneParams, renderVersion }
  render_params TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, generation)
);

CREATE TABLE IF NOT EXISTS context_surface_nodes (
  session_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  position INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  node_kind TEXT NOT NULL,           -- 'checkpoint' | 'conversation' | 'injected'
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, generation, position)
);

CREATE INDEX IF NOT EXISTS idx_context_surface_nodes_message
  ON context_surface_nodes(message_id);

-- ---------------------------------------------------------------------------
-- Compaction 事务（ADR-005：单事务内 started → surface → completed 一步提交）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS context_compactions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,              -- 'started' | 'completed' | 'failed'
  trigger TEXT NOT NULL,             -- 'round-limit' | 'token-limit' | 'manual' | 'provider-overflow'
  source_generation INTEGER NOT NULL,
  target_generation INTEGER,
  checkpoint_message_id TEXT,
  parent_checkpoint_message_id TEXT,
  source_start_message_id TEXT,
  source_end_message_id TEXT,
  retained_tail_start_message_id TEXT,
  source_message_count INTEGER NOT NULL DEFAULT 0,
  retained_message_count INTEGER NOT NULL DEFAULT 0,
  estimated_tokens_before INTEGER,
  estimated_tokens_after INTEGER,
  source_tokens INTEGER,
  checkpoint_tokens INTEGER,
  summary_mode TEXT NOT NULL,        -- 'llm' | 'local-fallback'
  summary_provider TEXT,
  summary_model TEXT,
  failure_code TEXT,
  failure_message TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_context_compactions_session_time
  ON context_compactions(session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_context_compactions_checkpoint
  ON context_compactions(checkpoint_message_id);

-- ---------------------------------------------------------------------------
-- Memory Recall（ADR-009：request-only，B3；PR5 落库）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_recalls (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  anchor_message_id TEXT NOT NULL,   -- 应用级引用（主线程 user 消息 ID）
  query_text TEXT NOT NULL,
  rendered_content TEXT NOT NULL,
  items_json TEXT NOT NULL,          -- items: id/source/score/confidence/trust/provenance
  estimated_tokens INTEGER NOT NULL,
  retrieval_strategy TEXT NOT NULL,
  retrieval_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'  -- 'active' | 'archived'
);

CREATE INDEX IF NOT EXISTS idx_memory_recalls_session_anchor
  ON memory_recalls(session_id, anchor_message_id);

CREATE INDEX IF NOT EXISTS idx_memory_recalls_workspace_time
  ON memory_recalls(workspace_id, created_at DESC);
