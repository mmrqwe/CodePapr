/**
 * Database: SQLite 数据库连接管理器
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Logger } from '@codepapr/common';

const log = new Logger('Database');
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class DSDatabase {
  private db: Database.Database;
  private initialized: boolean = false;

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    log.info(`Database opened: ${dbPath}`);
  }

  /**
   * 初始化数据库 schema
   */
  init(): void {
    if (this.initialized) return;

    // 优先从源 SQL 文件读取，找不到则使用内置 schema
    let schema: string;
    try {
      const schemaPath = join(__dirname, 'schema', 'schema.sql');
      schema = readFileSync(schemaPath, 'utf-8');
    } catch {
      schema = INLINE_SCHEMA;
    }

    this.db.exec(schema);
    this.initialized = true;
    log.info('Database initialized');
  }

  /**
   * 准备 SQL 语句（自动缓存）
   */
  prepare(sql: string): Database.Statement {
    return this.db.prepare(sql);
  }

  /**
   * 执行原始 SQL
   */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  /**
   * 事务执行
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * 关闭数据库
   */
  close(): void {
    this.db.close();
    log.info('Database closed');
  }

  /**
   * 获取底层 Database 实例
   */
  getRaw(): Database.Database {
    return this.db;
  }
}

// 内置 schema（防止文件读取失败）
const INLINE_SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, model TEXT NOT NULL,
  provider TEXT NOT NULL, system_prompt TEXT NOT NULL,
  prefix_hash TEXT, prefix_bytes INTEGER, prefix_frozen_at INTEGER,
  parameters TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL, last_modified INTEGER NOT NULL, is_archived INTEGER DEFAULT 0,
  total_cache_creation_tokens INTEGER DEFAULT 0,
  total_cache_read_tokens INTEGER DEFAULT 0,
  total_input_tokens INTEGER DEFAULT 0,
  total_output_tokens INTEGER DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_name ON sessions(name);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message_index INTEGER NOT NULL,
  role TEXT NOT NULL, content TEXT NOT NULL,
  tool_calls TEXT, tool_call_id TEXT, tool_result TEXT, tool_result_success INTEGER,
  metadata TEXT, content_hash TEXT NOT NULL,
  message_created_at INTEGER NOT NULL, recorded_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  UNIQUE(session_id, message_index)
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

CREATE TABLE IF NOT EXISTS tools (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, name TEXT NOT NULL,
  description TEXT, parameters_schema TEXT NOT NULL, definition_hash TEXT NOT NULL,
  frozen_at INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  UNIQUE(session_id, name)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL,
  data_type TEXT DEFAULT 'string', updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cache_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, timestamp INTEGER NOT NULL,
  prefix_hash TEXT, prefix_bytes INTEGER,
  log_messages INTEGER, log_bytes INTEGER,
  cache_creation_tokens INTEGER, cache_read_tokens INTEGER,
  input_tokens INTEGER, output_tokens INTEGER, cache_hit_rate REAL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cache_stats_session ON cache_stats(session_id, timestamp);

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, snapshot_type TEXT NOT NULL,
  prefix_state TEXT, log_state TEXT, message_count INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY, value TEXT NOT NULL,
  expires_at INTEGER, created_at INTEGER NOT NULL
);
`;
