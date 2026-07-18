-- CodePapr SQLite Schema
-- 严格保证 Append-Only 语义

-- 会话表
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  system_prompt TEXT NOT NULL,

  prefix_hash TEXT,
  prefix_bytes INTEGER,
  prefix_frozen_at INTEGER,

  parameters TEXT NOT NULL DEFAULT '{}',

  created_at INTEGER NOT NULL,
  last_modified INTEGER NOT NULL,
  is_archived INTEGER DEFAULT 0,

  total_cache_creation_tokens INTEGER DEFAULT 0,
  total_cache_read_tokens INTEGER DEFAULT 0,
  total_input_tokens INTEGER DEFAULT 0,
  total_output_tokens INTEGER DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_name ON sessions(name);

-- 消息表 (Append-Only Log)
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_index INTEGER NOT NULL,

  role TEXT NOT NULL,
  content TEXT NOT NULL,

  tool_calls TEXT,
  tool_call_id TEXT,
  tool_result TEXT,
  tool_result_success INTEGER,

  metadata TEXT,
  content_hash TEXT NOT NULL,

  message_created_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,

  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  UNIQUE(session_id, message_index)
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role);

-- 工具定义表
CREATE TABLE IF NOT EXISTS tools (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  parameters_schema TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  frozen_at INTEGER,

  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  UNIQUE(session_id, name)
);

-- 配置表
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  data_type TEXT DEFAULT 'string',
  updated_at INTEGER NOT NULL
);

-- 缓存统计表
CREATE TABLE IF NOT EXISTS cache_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,

  prefix_hash TEXT,
  prefix_bytes INTEGER,
  log_messages INTEGER,
  log_bytes INTEGER,

  cache_creation_tokens INTEGER,
  cache_read_tokens INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,

  cache_hit_rate REAL,

  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cache_stats_session ON cache_stats(session_id, timestamp);

-- 会话快照表
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  snapshot_type TEXT NOT NULL,

  prefix_state TEXT,
  log_state TEXT,
  message_count INTEGER,

  created_at INTEGER NOT NULL,

  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- 通用缓存表（替代 localStorage，键值 + TTL）
CREATE TABLE IF NOT EXISTS cache (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  expires_at  INTEGER,
  created_at  INTEGER NOT NULL
);
