//! SQLite persistence for app settings and project state.
//!
//! Three database locations:
//! - **App DB** (`~/.codepapr/codepapr.sqlite`): global UI settings
//! - **Project DB** (`<workspace>/.CodePapr/project.sqlite`): per-workspace state + ProjectGraph cache
//! - **Papr App DB** (`<workspace>/.CodePapr/apps/<appId>/db.sqlite`): per-app key-value
//!   storage backing `papr.db`. Kept inside the app folder so each app stays
//!   self-contained and isolated from CodePapr internal state.
//!
//! This module is pure Rust (rusqlite); no FFI, so unsafe is forbidden.

#![forbid(unsafe_code)]

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use rusqlite::functions::FunctionFlags;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::secrets;
use crate::shared::{canonical_workspace, home_dir, unix_millis};
use crate::vault::AppSecrets;
use tauri::Manager;

// ── Constants ────────────────────────────────────────────────────────

const APP_DATA_DIR: &str = ".codepapr";
const APP_DB_FILE: &str = "codepapr.sqlite";
const APP_SETTINGS_KEY: &str = "ui.settings";
const APP_CHARACTERS_KEY: &str = "ui.characters";
const PAPR_APP_PERMISSION_SETTINGS_KEY: &str = "papr.appPermissionSettings";
const EXTERNAL_ACCESS_POLICY_KEY: &str = "fs.externalAccessPolicy";
const PROJECT_STORAGE_DIR: &str = ".CodePapr";
const PROJECT_DB_FILE: &str = "project.sqlite";
/// 当前 project.sqlite schema 版本。已达此版本的连接跳过全量 DDL 批。
const PROJECT_SCHEMA_VERSION: i64 = 7;
/// 每个 project.sqlite 路径在本进程只跑一次 ADR-005 启动防御清理。
static STARTUP_DEFENSE_DONE: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
const PAPR_APP_DB_FILE: &str = "db.sqlite";
const PROJECT_STATE_KEY: &str = "project.state";
const LEGACY_PROJECT_FILE: &str = ".CodePapr/project.json";
const LEGACY_STATE_FILE: &str = ".CodePapr/state.json";
const MAX_SETTINGS_JSON_BYTES: usize = 200_000;
const MAX_CHARACTERS_JSON_BYTES: usize = 50_000_000;
const MAX_PROJECT_STATE_JSON_BYTES: usize = 20_000_000;

// 缓存带 TTL：本进程内所有写入都走 save_external_access_policy 同步刷新，
// 但跨进程/外部 DB 写入（第二个实例、直接改库）无法触发本进程失效。加
// 1s TTL 让陈旧策略最多存活 1 秒，避免"grant 后命令仍被拒/revoke 后仍放行"
// 的跨实例不一致。
const EXTERNAL_ACCESS_POLICY_CACHE_TTL_MS: i64 = 1000;

static EXTERNAL_ACCESS_POLICY_CACHE: OnceLock<Mutex<Option<(i64, ExternalAccessPolicy)>>> =
    OnceLock::new();

// ── Types ────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppSettingsResult {
    pub(crate) settings_json: Option<String>,
    pub(crate) db_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppCharactersResult {
    pub(crate) characters_json: Option<String>,
    pub(crate) db_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectStateResult {
    pub(crate) state_json: Option<String>,
    pub(crate) db_path: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExternalAccessPolicy {
    pub(crate) yolo: bool,
    pub(crate) allowed_dirs: Vec<String>,
    pub(crate) allowed_files: Vec<String>,
}

fn external_access_policy_cache() -> &'static Mutex<Option<(i64, ExternalAccessPolicy)>> {
    EXTERNAL_ACCESS_POLICY_CACHE.get_or_init(|| Mutex::new(None))
}

pub(crate) fn load_external_access_policy() -> Result<ExternalAccessPolicy, String> {
    let cache = external_access_policy_cache();
    if let Some((cached_at, policy)) = cache
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone()
    {
        if unix_millis()?.saturating_sub(cached_at) < EXTERNAL_ACCESS_POLICY_CACHE_TTL_MS {
            return Ok(policy);
        }
    }

    let (conn, _) = open_app_db()?;
    let policy = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![EXTERNAL_ACCESS_POLICY_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| format!("读取外部文件访问策略失败: {err}"))?
        .and_then(|json| serde_json::from_str::<ExternalAccessPolicy>(&json).ok())
        .unwrap_or_default();

    *cache.lock().unwrap_or_else(|error| error.into_inner()) =
        Some((unix_millis()?, policy.clone()));
    Ok(policy)
}

pub(crate) fn save_external_access_policy(
    policy: &ExternalAccessPolicy,
) -> Result<ExternalAccessPolicy, String> {
    let json = serde_json::to_string(policy)
        .map_err(|err| format!("序列化外部文件访问策略失败: {err}"))?;
    let (conn, _) = open_app_db()?;
    conn.execute(
        "INSERT INTO settings (key, value, data_type, updated_at)
         VALUES (?1, ?2, 'json', ?3)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           data_type = excluded.data_type,
           updated_at = excluded.updated_at",
        params![EXTERNAL_ACCESS_POLICY_KEY, json, unix_millis()?],
    )
    .map_err(|err| format!("保存外部文件访问策略失败: {err}"))?;

    *external_access_policy_cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some((unix_millis()?, policy.clone()));
    Ok(policy.clone())
}

// ── App DB helpers ───────────────────────────────────────────────────

fn app_db_path() -> Result<PathBuf, String> {
    let data_dir = home_dir()?.join(APP_DATA_DIR);
    fs::create_dir_all(&data_dir).map_err(|err| format!("创建数据目录失败: {err}"))?;
    Ok(data_dir.join(APP_DB_FILE))
}

fn open_app_db_at(db_path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(db_path)
        .map_err(|err| format!("打开配置数据库 {} 失败: {err}", db_path.display()))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA busy_timeout = 5000;
         PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS settings (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL,
           data_type TEXT DEFAULT 'string',
           updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS cache (
           key   TEXT PRIMARY KEY,
           value TEXT NOT NULL,
           expires_at INTEGER,
           created_at INTEGER NOT NULL
         );",
    )
    .map_err(|err| format!("初始化配置表失败: {err}"))?;

    Ok(conn)
}

fn open_app_db() -> Result<(Connection, PathBuf), String> {
    let db_path = app_db_path()?;
    let conn = open_app_db_at(&db_path)?;
    Ok((conn, db_path))
}

// ── Project DB helpers ───────────────────────────────────────────────

fn project_db_path(workspace_path: &str) -> Result<(PathBuf, PathBuf), String> {
    let workspace = canonical_workspace(workspace_path)?;
    let project_dir = workspace.join(PROJECT_STORAGE_DIR);
    fs::create_dir_all(&project_dir)
        .map_err(|err| format!("创建项目状态目录 {} 失败: {err}", project_dir.display()))?;
    Ok((workspace, project_dir.join(PROJECT_DB_FILE)))
}

fn open_project_db(workspace_path: &str) -> Result<(Connection, PathBuf, PathBuf), String> {
    let (workspace, db_path) = project_db_path(workspace_path)?;
    let conn = Connection::open(&db_path)
        .map_err(|err| format!("打开项目状态数据库 {} 失败: {err}", db_path.display()))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA busy_timeout = 5000;
         PRAGMA secure_delete = ON;
         PRAGMA foreign_keys = ON;",
    )
    .map_err(|err| format!("设置项目数据库 PRAGMA 失败: {err}"))?;
    register_unicode_lower(&conn)?;

    let version: i64 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|err| format!("读取数据库版本失败: {err}"))?;
    // schema 已是当前版本：跳过全量 CREATE TABLE IF NOT EXISTS 批（每命令固定开销）。
    if version < PROJECT_SCHEMA_VERSION {
        init_project_schema(&conn)?;
        migrate_project_db(&conn, &workspace)?;
    }

    maybe_startup_defense(&conn, &db_path)?;
    Ok((conn, workspace, db_path))
}

fn register_unicode_lower(conn: &Connection) -> Result<(), String> {
    conn.create_scalar_function(
        "unicode_lower",
        1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let text: String = ctx.get(0)?;
            Ok(text.to_lowercase())
        },
    )
    .map_err(|err| format!("注册 unicode_lower 失败: {err}"))
}

fn maybe_startup_defense(conn: &Connection, db_path: &Path) -> Result<(), String> {
    let mut done = STARTUP_DEFENSE_DONE
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !done.insert(db_path.to_path_buf()) {
        return Ok(());
    }
    drop(done);

    // 崩溃恢复（ADR-005）：压缩提交是单事务，正常不残留 started 行；
    // 此 UPDATE 是防御性清理。错误上抛，避免静默留下中断事务。
    conn.execute(
        "UPDATE context_compactions
         SET status = 'failed',
             failure_code = 'interrupted',
             failure_message = '应用在压缩提交完成前退出'
         WHERE status = 'started'",
        [],
    )
    .map_err(|err| format!("压缩中断防御清理失败: {err}"))?;

    cleanup_orphan_checkpoint_messages(conn)
}

/// ADR-005：archive 已有、surface 不引用、且属于失败/中断压缩的 checkpoint 消息。
/// 仅删除 failed/interrupted compaction 指向、且未被任何 surface 节点引用的行。
fn cleanup_orphan_checkpoint_messages(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "DELETE FROM messages
         WHERE id IN (
           SELECT c.checkpoint_message_id
           FROM context_compactions c
           WHERE c.status IN ('failed', 'interrupted')
             AND c.checkpoint_message_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM context_surface_nodes n
               WHERE n.message_id = c.checkpoint_message_id
             )
         )",
        [],
    )
    .map_err(|err| format!("孤儿 checkpoint 防御清理失败: {err}"))?;
    Ok(())
}

fn init_project_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS project_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
          );
           CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER,
            archived_at INTEGER
          );
          CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            message_index INTEGER NOT NULL,
            role TEXT NOT NULL,
            work_mode TEXT,
            content TEXT NOT NULL,
            reasoning_content TEXT,
            tool_invocations TEXT,
            extras TEXT,
            timestamp INTEGER NOT NULL,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
            UNIQUE(session_id, message_index)
          );
          CREATE TABLE IF NOT EXISTS project_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS checkpoint_timeline (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            sha        TEXT NOT NULL,
            label      TEXT NOT NULL,
            file_count INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS idx_cp_timeline_msg
            ON checkpoint_timeline(message_id);
          CREATE INDEX IF NOT EXISTS idx_cp_timeline_session
            ON checkpoint_timeline(session_id);
          CREATE TABLE IF NOT EXISTS context_surfaces (
            session_id TEXT NOT NULL,
            generation INTEGER NOT NULL,
            parent_generation INTEGER,
            compaction_id TEXT,
            render_params TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (session_id, generation)
          );
          CREATE TABLE IF NOT EXISTS context_surface_nodes (
            session_id TEXT NOT NULL,
            generation INTEGER NOT NULL,
            position INTEGER NOT NULL,
            message_id TEXT NOT NULL,
            node_kind TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (session_id, generation, position)
          );
          CREATE INDEX IF NOT EXISTS idx_context_surface_nodes_message
            ON context_surface_nodes(message_id);
          CREATE TABLE IF NOT EXISTS context_compactions (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            status TEXT NOT NULL,
            trigger TEXT NOT NULL,
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
            summary_mode TEXT NOT NULL,
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
          CREATE TABLE IF NOT EXISTS memory_entries (
            id TEXT PRIMARY KEY,
            category TEXT NOT NULL,
            content TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            confidence TEXT NOT NULL,
            trust TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            source_session_id TEXT,
            source_message_ids TEXT,
            evidence TEXT,
            created_at INTEGER NOT NULL,
            verified_at INTEGER,
            superseded_by TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_memory_entries_status
            ON memory_entries(status);
          CREATE INDEX IF NOT EXISTS idx_memory_entries_hash
            ON memory_entries(content_hash);
          CREATE TABLE IF NOT EXISTS memory_candidates (
            id TEXT PRIMARY KEY,
            category TEXT NOT NULL,
            content TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            confidence TEXT NOT NULL,
            trust TEXT NOT NULL,
            source_session_id TEXT,
            source_message_ids TEXT,
            evidence TEXT,
            risk_flags TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at INTEGER NOT NULL,
            decided_at INTEGER,
            rejection_reason TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_memory_candidates_status
            ON memory_candidates(status);
          CREATE TABLE IF NOT EXISTS memory_recalls (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            anchor_message_id TEXT NOT NULL,
            query_text TEXT NOT NULL,
            rendered_content TEXT NOT NULL,
            items_json TEXT NOT NULL,
            estimated_tokens INTEGER NOT NULL,
            retrieval_strategy TEXT NOT NULL,
            retrieval_version INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'active'
          );
          CREATE INDEX IF NOT EXISTS idx_memory_recalls_session_anchor
            ON memory_recalls(session_id, anchor_message_id);
          CREATE INDEX IF NOT EXISTS idx_memory_recalls_workspace_time
            ON memory_recalls(workspace_id, created_at DESC);",
    )
    .map_err(|err| format!("初始化项目状态表失败: {err}"))
}

fn migrate_project_db(conn: &Connection, workspace: &Path) -> Result<(), String> {
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|err| format!("读取数据库版本失败: {err}"))?;

    if version < 1 {
        migrate_project_db_v1(conn, workspace)?;
    }

    if version < 2 {
        // v2: 消息表新增 extras 列，承载恢复上下文所需的 promptContent / synthetic /
        // hidden / carryForwardInContext / contextCheckpoint / question 等字段。
        // 正常重启后 buildEffectiveContextMessages 依赖 contextCheckpoint / synthetic
        // 等标志重建压缩历史与上下文成员资格，缺失会导致已压缩会话重新展开并击穿缓存。
        let has_extras = conn
            .prepare("PRAGMA table_info(messages)")
            .and_then(|mut stmt| {
                let mut names = stmt
                    .query_map([], |row| row.get::<_, String>(1))?
                    .filter_map(|r| r.ok());
                Ok(names.any(|name| name == "extras"))
            })
            .unwrap_or(false);
        if !has_extras {
            conn.execute_batch("ALTER TABLE messages ADD COLUMN extras TEXT;")
                .map_err(|err| format!("迁移 messages.extras 列失败: {err}"))?;
        }
        conn.pragma_update(None, "user_version", 2_i64)
            .map_err(|err| format!("设置数据库版本失败: {err}"))?;
    }

    if version < 3 {
        // v3: sessions 表新增 updated_at 列，会话列表按最近活跃时间排序；
        // 旧数据回填 created_at 保持原有顺序。
        let has_updated_at = conn
            .prepare("PRAGMA table_info(sessions)")
            .and_then(|mut stmt| {
                let mut names = stmt
                    .query_map([], |row| row.get::<_, String>(1))?
                    .filter_map(|r| r.ok());
                Ok(names.any(|name| name == "updated_at"))
            })
            .unwrap_or(false);
        if !has_updated_at {
            conn.execute_batch(
                "ALTER TABLE sessions ADD COLUMN updated_at INTEGER;
                 UPDATE sessions SET updated_at = created_at WHERE updated_at IS NULL;",
            )
            .map_err(|err| format!("迁移 sessions.updated_at 列失败: {err}"))?;
        }
        conn.pragma_update(None, "user_version", 3_i64)
            .map_err(|err| format!("设置数据库版本失败: {err}"))?;
    }

    if version < 4 {
        // v4: papr.db 数据从 project.sqlite 的 app_storage 表迁出，改为每个 app
        // 独立的 .CodePapr/apps/<appId>/db.sqlite，使 app 目录自包含、与内部状态隔离。
        migrate_project_db_v4_papr_storage(conn, workspace)?;
        conn.pragma_update(None, "user_version", 4_i64)
            .map_err(|err| format!("设置数据库版本失败: {err}"))?;
    }

    if version < 5 {
        // v5: memory_entries 新增 forgotten_reason 列（memory_forget 工具溯源）。
        let has_reason = conn
            .prepare("PRAGMA table_info(memory_entries)")
            .and_then(|mut stmt| {
                let mut names = stmt
                    .query_map([], |row| row.get::<_, String>(1))?
                    .filter_map(|r| r.ok());
                Ok(names.any(|name| name == "forgotten_reason"))
            })
            .unwrap_or(false);
        if !has_reason {
            conn.execute_batch("ALTER TABLE memory_entries ADD COLUMN forgotten_reason TEXT;")
                .map_err(|err| format!("迁移 memory_entries.forgotten_reason 列失败: {err}"))?;
        }
        conn.pragma_update(None, "user_version", 5_i64)
            .map_err(|err| format!("设置数据库版本失败: {err}"))?;
    }

    if version < 6 {
        migrate_project_db_v6(conn)?;
        conn.pragma_update(None, "user_version", 6_i64)
            .map_err(|err| format!("设置数据库版本失败: {err}"))?;
    }

    if version < 7 {
        // v7: sessions.archived_at。NULL = 侧栏活跃会话；非 NULL = 已归档，
        // 仍留在同一 project.sqlite，消息/checkpoint 不搬迁。
        let has_archived_at = conn
            .prepare("PRAGMA table_info(sessions)")
            .and_then(|mut stmt| {
                let mut names = stmt
                    .query_map([], |row| row.get::<_, String>(1))?
                    .filter_map(|r| r.ok());
                Ok(names.any(|name| name == "archived_at"))
            })
            .unwrap_or(false);
        if !has_archived_at {
            conn.execute_batch("ALTER TABLE sessions ADD COLUMN archived_at INTEGER;")
                .map_err(|err| format!("迁移 sessions.archived_at 列失败: {err}"))?;
        }
        conn.pragma_update(None, "user_version", 7_i64)
            .map_err(|err| format!("设置数据库版本失败: {err}"))?;
    }

    Ok(())
}

fn migrate_project_db_v6(conn: &Connection) -> Result<(), String> {
    // 清理 FTS5 probe 残表：旧实现在项目库上 CREATE+DROP probe，CREATE 成功
    // DROP 失败会留下 `_codepapr_fts_probe`，下次 probe 因表已存在失败并
    // 把 FTS5_PROBE 缓存成 false，该工作区永久降级全扫。
    conn.execute_batch("DROP TABLE IF EXISTS _codepapr_fts_probe;")
        .map_err(|err| format!("清理 FTS probe 残表失败: {err}"))?;

    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_messages_timestamp
           ON messages(timestamp DESC);
         CREATE INDEX IF NOT EXISTS idx_messages_checkpoint
           ON messages(timestamp DESC)
           WHERE extras LIKE '%\"contextCheckpoint\"%';",
    )
    .map_err(|err| format!("创建 messages 检索索引失败: {err}"))?;

    ensure_memory_fts_schema(conn)
}

fn migrate_project_db_v4_papr_storage(conn: &Connection, workspace: &Path) -> Result<(), String> {
    let has_table: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_storage')",
            [],
            |row| row.get(0),
        )
        .map_err(|err| format!("检查 app_storage 表失败: {err}"))?;
    if !has_table {
        return Ok(());
    }

    let mut stmt = conn
        .prepare("SELECT app_id, key, value, updated_at FROM app_storage")
        .map_err(|err| format!("读取 app_storage 失败: {err}"))?;
    let rows: Vec<(String, String, String, i64)> = stmt
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(|err| format!("查询 app_storage 失败: {err}"))?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);

    let apps_dir = workspace.join(PROJECT_STORAGE_DIR).join("apps");
    let mut by_app: std::collections::HashMap<String, Vec<(String, String, i64)>> =
        std::collections::HashMap::new();
    for (app_id, key, value, updated_at) in rows {
        by_app.entry(app_id).or_default().push((key, value, updated_at));
    }

    for (app_id, kvs) in by_app {
        let app_dir = apps_dir.join(&app_id);
        // app 目录已不存在 = app 已被删除，孤儿数据直接丢弃（与 papr_delete_app 语义一致）
        if !app_dir.is_dir() {
            continue;
        }
        let (app_conn, _) = open_papr_app_db_at(&app_dir)?;
        for (key, value, updated_at) in kvs {
            app_conn
                .execute(
                    "INSERT INTO app_storage (key, value, updated_at)
                     VALUES (?1, ?2, ?3)
                     ON CONFLICT(key) DO UPDATE SET
                       value = excluded.value,
                       updated_at = excluded.updated_at",
                    params![key, value, updated_at],
                )
                .map_err(|err| format!("迁移 app '{app_id}' 存储失败: {err}"))?;
        }
    }

    conn.execute_batch("DROP TABLE app_storage;")
        .map_err(|err| format!("删除 app_storage 表失败: {err}"))?;
    Ok(())
}

// ── Papr per-app DB helpers ─────────────────────────────────────────

/// Opens (and initializes) the per-app papr database at
/// `<workspace>/.CodePapr/apps/<app_id>/db.sqlite`.
fn open_papr_app_db(workspace_path: &str, app_id: &str) -> Result<(Connection, PathBuf), String> {
    if app_id.is_empty() || app_id.contains("..") || app_id.contains('/') || app_id.contains('\\') {
        return Err(format!("非法的 appId: {app_id}"));
    }
    let workspace = canonical_workspace(workspace_path)?;
    let app_dir = workspace.join(PROJECT_STORAGE_DIR).join("apps").join(app_id);
    open_papr_app_db_at(&app_dir)
}

fn open_papr_app_db_at(app_dir: &Path) -> Result<(Connection, PathBuf), String> {
    fs::create_dir_all(app_dir)
        .map_err(|err| format!("创建 app 目录 {} 失败: {err}", app_dir.display()))?;
    let db_path = app_dir.join(PAPR_APP_DB_FILE);
    let conn = Connection::open(&db_path)
        .map_err(|err| format!("打开 app 数据库 {} 失败: {err}", db_path.display()))?;
    // busy_timeout：后端 app 进程（server.js）可能与主进程并发访问同一个库。
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA busy_timeout = 5000;
         CREATE TABLE IF NOT EXISTS app_storage (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL,
           updated_at INTEGER NOT NULL
         );",
    )
    .map_err(|err| format!("初始化 app 存储表失败: {err}"))?;
    Ok((conn, db_path))
}

fn migrate_project_db_v1(conn: &Connection, workspace: &Path) -> Result<(), String> {
    // 获取要迁移的 JSON：先查 project_state 表，再查 legacy 文件
    let legacy_json = match read_project_state_value(conn)? {
        Some(json) => json,
        None => match import_legacy_project_state(conn, workspace)? {
            Some(json) => json,
            None => {
                // 没有任何旧数据，直接标记为已迁移
                conn.pragma_update(None, "user_version", 1_i64)
                    .map_err(|err| format!("设置数据库版本失败: {err}"))?;
                return Ok(());
            }
        },
    };

    let parsed: serde_json::Value = serde_json::from_str(&legacy_json)
        .map_err(|err| format!("解析旧项目状态 JSON 失败: {err}"))?;

    // 收集所有已知 session ID，用于过滤 FK 违规消息
    let sessions = parsed
        .get("sessions")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let known_session_ids: std::collections::HashSet<String> = sessions
        .iter()
        .filter_map(|s| s.get("id").and_then(|v| v.as_str()).map(String::from))
        .collect();

    // 整个迁移在单个事务中执行，保证原子性
    let tx = conn
        .unchecked_transaction()
        .map_err(|err| format!("开启迁移事务失败: {err}"))?;

    for session in &sessions {
        let id = session.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if id.is_empty() {
            continue;
        }
        let name = session.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let provider = session
            .get("provider")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let model = session.get("model").and_then(|v| v.as_str()).unwrap_or("");
        let created_at = session
            .get("createdAt")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);

        tx.execute(
            "INSERT OR IGNORE INTO sessions (id, name, provider, model, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, name, provider, model, created_at],
        )
        .map_err(|err| format!("迁移会话 {id} 失败: {err}"))?;
    }

    let session_messages = parsed.get("sessionMessages").and_then(|v| v.as_object());

    if let Some(sm) = session_messages {
        for (session_id, messages) in sm {
            // 跳过不在 sessions 列表中的消息（避免 FK 违规）
            if !known_session_ids.contains(session_id) {
                continue;
            }
            let msgs = messages.as_array().cloned().unwrap_or_default();
            for (idx, msg) in msgs.iter().enumerate() {
                let msg_id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if msg_id.is_empty() {
                    continue;
                }
                let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("");
                let work_mode = msg.get("workMode").and_then(|v| v.as_str());
                let content = msg.get("content").and_then(|v| v.as_str()).unwrap_or("");
                let reasoning_content = msg.get("reasoningContent").and_then(|v| v.as_str());
                let tool_invocations_raw = msg.get("toolInvocations");
                let tool_invocations = tool_invocations_raw
                    .filter(|v| !v.is_null())
                    .and_then(|v| serde_json::to_string(v).ok());
                let timestamp = msg.get("timestamp").and_then(|v| v.as_i64()).unwrap_or(0);
                let message_index = idx as i64;

                tx.execute(
                    "INSERT OR IGNORE INTO messages (id, session_id, message_index, role, work_mode, content, reasoning_content, tool_invocations, timestamp)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        msg_id, session_id.as_str(), message_index,
                        role, work_mode, content,
                        reasoning_content, tool_invocations,
                        timestamp,
                    ],
                )
                .map_err(|err| format!("迁移消息 {msg_id} 失败: {err}"))?;
            }
        }
    }

    let meta_keys: &[(&str, &str)] = &[
        ("activeSessionId", "active_session_id"),
        ("conversationStats", "conversation_stats"),
        ("sessionConversationStats", "session_conversation_stats"),
        ("sessionTodoLists", "session_todo_lists"),
        ("skillEnabledById", "skill_enabled_by_id"),
        ("projectDiagnosticsReport", "project_diagnostics_report"),
        ("messageCheckpoints", "message_checkpoints"),
        ("cumulativeStats", "cumulative_stats"),
        ("sessionCumulativeStats", "session_cumulative_stats"),
    ];

    let now = unix_millis()?;
    for (json_key, meta_key) in meta_keys {
        if let Some(val) = parsed.get(json_key) {
            if val.is_null() {
                continue;
            }
            let val_str = serde_json::to_string(val)
                .map_err(|err| format!("序列化 {json_key} 失败: {err}"))?;
            tx.execute(
                "INSERT OR IGNORE INTO project_meta (key, value, updated_at)
                 VALUES (?1, ?2, ?3)",
                params![meta_key, val_str, now],
            )
            .map_err(|err| format!("迁移元数据 {json_key} 失败: {err}"))?;
        }
    }

    tx.commit()
        .map_err(|err| format!("提交迁移事务失败: {err}"))?;

    conn.pragma_update(None, "user_version", 1_i64)
        .map_err(|err| format!("设置数据库版本失败: {err}"))?;

    Ok(())
}

fn validate_project_state_json(state_json: &str) -> Result<(), String> {
    if state_json.len() > MAX_PROJECT_STATE_JSON_BYTES {
        return Err(format!(
            "项目状态内容超过上限 {MAX_PROJECT_STATE_JSON_BYTES} bytes"
        ));
    }

    let value: serde_json::Value =
        serde_json::from_str(state_json).map_err(|err| format!("项目状态不是合法 JSON: {err}"))?;
    if !value.is_object() {
        return Err("项目状态 JSON 必须是对象".to_string());
    }

    Ok(())
}

fn read_project_state_value(conn: &Connection) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value FROM project_state WHERE key = ?1",
        params![PROJECT_STATE_KEY],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|err| format!("读取项目状态失败: {err}"))
}

fn write_project_state_value(conn: &Connection, state_json: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO project_state (key, value, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at",
        params![PROJECT_STATE_KEY, state_json, unix_millis()?],
    )
    .map_err(|err| format!("保存项目状态失败: {err}"))?;

    Ok(())
}

fn purge_project_state_deleted_content(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "PRAGMA wal_checkpoint(TRUNCATE);
         VACUUM;
         PRAGMA wal_checkpoint(TRUNCATE);",
    )
    .map_err(|err| format!("清理已删除项目状态内容失败: {err}"))?;

    Ok(())
}

fn read_project_state_value_len(conn: &Connection) -> Result<Option<usize>, String> {
    conn.query_row(
        "SELECT length(CAST(value AS BLOB)) FROM project_state WHERE key = ?1",
        params![PROJECT_STATE_KEY],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .map(|value| value.and_then(|length| usize::try_from(length).ok()))
    .map_err(|err| format!("读取项目状态大小失败: {err}"))
}

fn should_compact_project_state(old_len: Option<usize>, new_len: usize) -> bool {
    let Some(old_len) = old_len else {
        return false;
    };

    old_len > new_len.saturating_add(64 * 1024) || old_len > new_len.saturating_mul(2)
}

fn cleanup_legacy_project_files(workspace: &Path) {
    for relative in [LEGACY_STATE_FILE, LEGACY_PROJECT_FILE] {
        let path = workspace.join(relative);
        match fs::remove_file(&path) {
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {}
        }
    }
}

fn import_legacy_project_state(
    conn: &Connection,
    workspace: &Path,
) -> Result<Option<String>, String> {
    let legacy_state_path = workspace.join(LEGACY_STATE_FILE);
    let legacy_json = match fs::read_to_string(&legacy_state_path) {
        Ok(content) => content,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            return Err(format!(
                "读取旧项目状态文件 {} 失败: {err}",
                legacy_state_path.display()
            ))
        }
    };

    if validate_project_state_json(&legacy_json).is_err() {
        return Ok(None);
    }

    write_project_state_value(conn, &legacy_json)?;
    cleanup_legacy_project_files(workspace);

    Ok(Some(legacy_json))
}

// ── Secret extraction / injection ────────────────────────────────────

/// Names of settings JSON fields that hold API keys and must be diverted to
/// the Stronghold vault instead of being persisted as plaintext in SQLite.
const SECRET_FIELDS: [(&str, &str); 2] = [
    ("apiKey", secrets::PRIMARY_KEY_ACCOUNT),
    ("mentorApiKey", secrets::MENTOR_KEY_ACCOUNT),
];

/// Moves API key values from the settings JSON into the Stronghold vault,
/// replacing them with empty strings in the JSON so nothing sensitive lands
/// in SQLite.  If vault storage fails for a field, the plaintext is left
/// untouched (graceful degradation).
///
/// Returns `true` if any secret was actually stored or removed — 只有发生
/// 真实变更时才值得执行一次 Stronghold 快照落盘（保存代价高且阻塞）。
fn extract_and_store_secrets(app_secrets: &AppSecrets, value: &mut serde_json::Value) -> bool {
    let Some(obj) = value.as_object_mut() else {
        return false;
    };

    let mut changed = false;
    for (field, account) in SECRET_FIELDS {
        // 区分「字段缺失」与「字段被显式清空」：缺失（部分设置更新、回写
        // stripped JSON 等）绝不能删 vault 密钥，否则存储的 key 会被静默销毁；
        // 只有字段存在且为空才视为用户主动清除。
        let Some(raw) = obj.get(field).and_then(|v| v.as_str()) else {
            continue;
        };
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            // User cleared the key — remove from vault, 但仅当确实存在时
            // 才算变更（避免每次保存都触发全量快照写盘）。
            if app_secrets.get_secret(account).is_some() {
                let _ = secrets::delete_secret(app_secrets, account);
                changed = true;
            }
            continue;
        }
        // 前端每次保存都会带回已注入的 key：值与 vault 一致时只做明文剥离，
        // 不重复写库（Stronghold 快照全量落盘代价高），避免每次保存都写 vault。
        if app_secrets.get_secret(account).as_deref() == Some(trimmed) {
            obj.insert(
                (*field).to_string(),
                serde_json::Value::String(String::new()),
            );
            continue;
        }
        if secrets::set_secret(app_secrets, account, trimmed).is_ok() {
            obj.insert(
                (*field).to_string(),
                serde_json::Value::String(String::new()),
            );
            changed = true;
        }
    }
    changed
}

/// Performs one-time migration of legacy plaintext keys (from older versions
/// that stored them directly in SQLite) into the Stronghold vault, then injects
/// the vault values back into the JSON for the frontend to consume.
///
/// Returns `Some(stripped_json)` when migration occurred and the stripped JSON
/// should be re-persisted to SQLite to remove the plaintext. Returns `None`
/// otherwise.
fn migrate_and_inject_secrets(
    app_secrets: &AppSecrets,
    value: &mut serde_json::Value,
) -> Option<String> {
    // Migration phase: move any non-empty plaintext keys to vault.
    let mut migrated = false;
    {
        let obj = value.as_object_mut()?;
        for (field, account) in SECRET_FIELDS {
            let raw = obj.get(field).and_then(|v| v.as_str()).unwrap_or("");
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                if secrets::set_secret(app_secrets, account, trimmed).is_ok() {
                    obj.insert(
                        (*field).to_string(),
                        serde_json::Value::String(String::new()),
                    );
                    migrated = true;
                }
            }
        }
    }

    // Capture stripped JSON for persistence *before* injecting vault values.
    let stripped_json = if migrated {
        Some(serde_json::to_string(value).unwrap_or_default())
    } else {
        None
    };

    // Injection phase: pull the authoritative values from the vault.
    if let Some(obj) = value.as_object_mut() {
        for (field, account) in SECRET_FIELDS {
            let secret = secrets::get_secret(app_secrets, account).unwrap_or_default();
            obj.insert((*field).to_string(), serde_json::Value::String(secret));
        }
    }

    stripped_json
}

// ── Tauri commands ───────────────────────────────────────────────────

#[tauri::command]
pub(crate) fn load_app_settings(app: tauri::AppHandle) -> Result<AppSettingsResult, String> {
    let _guard = app_settings_db_lock()
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    let app_secrets = app.state::<AppSecrets>();
    let (conn, db_path) = open_app_db()?;
    let settings_json = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![APP_SETTINGS_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| format!("读取应用配置失败: {err}"))?;

    let final_json = match settings_json {
        Some(json) => {
            let mut value: serde_json::Value =
                serde_json::from_str(&json).map_err(|err| format!("配置不是合法 JSON: {err}"))?;

            let stripped_for_persistence = migrate_and_inject_secrets(&app_secrets, &mut value);

            // If migration happened, persist the stripped JSON so plaintext keys
            // are removed from SQLite going forward, and flush the vault so the
            // migrated secrets survive a restart. vault 必须先落盘成功再剥离 DB：
            // 若先写空 key 入库而 vault 保存失败，密钥将两头皆空且无报错。
            if let Some(stripped) = stripped_for_persistence {
                if app_secrets.save().is_ok() {
                    let _ = conn.execute(
                        "INSERT INTO settings (key, value, data_type, updated_at)
                         VALUES (?1, ?2, 'json', ?3)
                         ON CONFLICT(key) DO UPDATE SET
                           value = excluded.value,
                           data_type = excluded.data_type,
                           updated_at = excluded.updated_at",
                        params![APP_SETTINGS_KEY, stripped, unix_millis()?],
                    );
                }
            }

            Some(serde_json::to_string(&value).map_err(|err| format!("序列化配置失败: {err}"))?)
        }
        None => None,
    };

    Ok(AppSettingsResult {
        settings_json: final_json,
        db_path: db_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub(crate) async fn save_app_settings(
    app: tauri::AppHandle,
    settings_json: String,
) -> Result<AppSettingsResult, String> {
    if settings_json.len() > MAX_SETTINGS_JSON_BYTES {
        return Err(format!("配置内容超过上限 {MAX_SETTINGS_JSON_BYTES} bytes"));
    }

    let app_secrets = app.state::<AppSecrets>().inner().clone();
    // 同步命令会在主线程执行（vault 快照写盘 + SQLite 会阻塞 UI），
    // 改为在 blocking 线程池上完成；前端已按调用顺序串行化保存，
    // 配合 APP_SETTINGS_DB_LOCK 保证读改写原子性。
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut value: serde_json::Value =
            serde_json::from_str(&settings_json).map_err(|err| format!("配置不是合法 JSON: {err}"))?;
        if !value.is_object() {
            return Err("配置 JSON 必须是对象".to_string());
        }

        // Divert API keys to the Stronghold vault before anything hits SQLite.
        let secrets_changed = extract_and_store_secrets(&app_secrets, &mut value);
        let persisted_json =
            serde_json::to_string(&value).map_err(|err| format!("序列化配置失败: {err}"))?;

        // 必须先持久化 vault 成功，再写"已剥离 key 的 JSON"入库。顺序反了的话：
        // DB 已存空 key 而 vault 落盘失败（磁盘满/权限/文件被占）→ 重启后两头皆空，
        // 用户的 API key 静默永久丢失。vault 失败时 DB 保持原状，用户可重试。
        // 仅当密钥确实变更时才写快照——每次保存都全量重写代价高且没必要。
        if secrets_changed {
            app_secrets
                .save()
                .map_err(|e| format!("保存密钥库失败: {e}"))?;
        }

        let _guard = app_settings_db_lock()
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        let (conn, db_path) = open_app_db()?;
        conn.execute(
            "INSERT INTO settings (key, value, data_type, updated_at)
             VALUES (?1, ?2, 'json', ?3)
             ON CONFLICT(key) DO UPDATE SET
               value = excluded.value,
               data_type = excluded.data_type,
               updated_at = excluded.updated_at",
            params![APP_SETTINGS_KEY, persisted_json, unix_millis()?],
        )
        .map_err(|err| format!("保存应用配置失败: {err}"))?;

        Ok(AppSettingsResult {
            settings_json: Some(persisted_json),
            db_path: db_path.to_string_lossy().to_string(),
        })
    })
    .await;
    // 无论成败都推进纪元：退出流程据此判断"已处理完毕"，无需继续等待。
    SETTINGS_SAVE_EPOCH.fetch_add(1, Ordering::SeqCst);
    result.map_err(|err| format!("保存设置任务失败: {err}"))?
}

// ui.settings 的读-改-写互斥：note_recent_workspace 与 load/save_app_settings
// 并发时可能交错覆盖（一方读到旧 JSON 后回写，丢掉另一方刚写的内容）。
static APP_SETTINGS_DB_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn app_settings_db_lock() -> &'static Mutex<()> {
    APP_SETTINGS_DB_LOCK.get_or_init(|| Mutex::new(()))
}

// 设置保存完成纪元：每次 save_app_settings 处理完毕 +1。退出流程在
// CloseRequested 中等待该值推进，确保最后时刻的 fire-and-forget 保存
// （含前端收到退出信号后重发的保存）在进程终止前真正落库。
static SETTINGS_SAVE_EPOCH: AtomicU64 = AtomicU64::new(0);

pub(crate) fn settings_save_epoch() -> u64 {
    SETTINGS_SAVE_EPOCH.load(Ordering::SeqCst)
}

/// 有界等待设置保存纪元推进（退出前 flush 用）。返回 true 表示 epoch 已推进
/// （一次保存已处理完毕），false 表示超时（前端不可用/无保存发生）。
pub(crate) fn wait_for_settings_save_epoch(epoch_before: u64, timeout: Duration) -> bool {
    wait_for_epoch(&SETTINGS_SAVE_EPOCH, epoch_before, timeout)
}

fn wait_for_epoch(epoch: &AtomicU64, epoch_before: u64, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while epoch.load(Ordering::SeqCst) == epoch_before {
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    true
}

/// 平台感知大小写去重（与前端 recentWorkspaces.ts 的 pathsEquivalent 对齐）：
/// macOS/Windows 上同目录的不同大小写写法是同一目录，不应产生两条记录。
fn recent_paths_equivalent(left: &str, right: &str) -> bool {
    if left == right {
        return true;
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        left.to_lowercase() == right.to_lowercase()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        false
    }
}

fn workspace_display_name(path: &str) -> String {
    path.rsplit(['/', '\\'])
        .find(|segment| !segment.is_empty())
        .unwrap_or(path)
        .to_string()
}

/// 把工作区路径 upsert 进 settings JSON 的 recentWorkspaces（移到首位、
/// 去重、保留 pinned、截断到 10 条），返回更新后的完整 JSON。
fn merge_recent_workspace(settings_json: Option<&str>, path: &str) -> Result<String, String> {
    let mut value: serde_json::Value = match settings_json {
        Some(json) => serde_json::from_str(json)
            .map_err(|err| format!("配置不是合法 JSON: {err}"))?,
        None => serde_json::json!({}),
    };
    if !value.is_object() {
        return Err("配置 JSON 必须是对象".to_string());
    }
    let obj = value
        .as_object_mut()
        .expect("recent_workspace: 已确认是对象");

    let mut recent: Vec<serde_json::Value> = obj
        .get("recentWorkspaces")
        .and_then(|list| list.as_array())
        .cloned()
        .unwrap_or_default();

    let now = unix_millis()?;
    let name = workspace_display_name(path);
    if let Some(pos) = recent.iter().position(|entry| {
        entry
            .get("path")
            .and_then(|p| p.as_str())
            .map(|existing| recent_paths_equivalent(existing, path))
            .unwrap_or(false)
    }) {
        let mut existing = recent.remove(pos);
        if let Some(entry_obj) = existing.as_object_mut() {
            entry_obj.insert("path".into(), serde_json::Value::String(path.to_string()));
            entry_obj.insert("name".into(), serde_json::Value::String(name));
            entry_obj.insert(
                "lastOpenedAt".into(),
                serde_json::Value::Number(serde_json::Number::from(now)),
            );
        }
        recent.insert(0, existing);
    } else {
        recent.insert(
            0,
            serde_json::json!({
                "path": path,
                "name": name,
                "lastOpenedAt": now,
                "pinned": false,
            }),
        );
    }
    recent.truncate(10);
    obj.insert("recentWorkspaces".into(), serde_json::Value::Array(recent));

    serde_json::to_string(&value).map_err(|err| format!("序列化配置失败: {err}"))
}

/// 立即把工作区记入 recentWorkspaces 并落库（同步、原子读改写）。
/// 载入文件夹时由前端 await 调用，确保退出前最近项目已持久化。
fn note_recent_workspace_impl(
    db_path: &Path,
    workspace_path: &str,
) -> Result<AppSettingsResult, String> {
    let path = workspace_path.trim();
    if path.is_empty() {
        return Err("工作区路径不能为空".to_string());
    }

    let _guard = app_settings_db_lock()
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    let conn = open_app_db_at(db_path)?;
    let settings_json = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![APP_SETTINGS_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| format!("读取应用配置失败: {err}"))?;

    let merged = merge_recent_workspace(settings_json.as_deref(), path)?;
    conn.execute(
        "INSERT INTO settings (key, value, data_type, updated_at)
         VALUES (?1, ?2, 'json', ?3)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           data_type = excluded.data_type,
           updated_at = excluded.updated_at",
        params![APP_SETTINGS_KEY, merged, unix_millis()?],
    )
    .map_err(|err| format!("保存应用配置失败: {err}"))?;

    Ok(AppSettingsResult {
        settings_json: Some(merged),
        db_path: db_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub(crate) fn note_recent_workspace(path: String) -> Result<AppSettingsResult, String> {
    let db_path = app_db_path()?;
    note_recent_workspace_impl(&db_path, &path)
}

/// 用前端计算好的列表整体替换 settings JSON 里的 recentWorkspaces
/// （钉住/移除最近项目后由前端 await 调用）：同步、原子读改写，立即落库，
/// 即使随后立刻退出也不会丢。
fn set_recent_workspaces_impl(
    db_path: &Path,
    workspaces_json: &str,
) -> Result<AppSettingsResult, String> {
    let parsed: serde_json::Value = serde_json::from_str(workspaces_json)
        .map_err(|err| format!("recentWorkspaces 不是合法 JSON: {err}"))?;
    let arr = parsed
        .as_array()
        .ok_or_else(|| "recentWorkspaces 必须是数组".to_string())?;

    let now = unix_millis()?;
    let mut normalized: Vec<serde_json::Value> = Vec::new();
    for raw in arr.iter().take(10) {
        let Some(obj) = raw.as_object() else {
            continue;
        };
        let Some(raw_path) = obj.get("path").and_then(|p| p.as_str()) else {
            continue;
        };
        let path = raw_path.trim();
        if path.is_empty() {
            continue;
        }
        let name = obj
            .get("name")
            .and_then(|n| n.as_str())
            .filter(|n| !n.trim().is_empty())
            .map(|n| n.to_string())
            .unwrap_or_else(|| workspace_display_name(path));
        let last_opened_at = obj
            .get("lastOpenedAt")
            .and_then(|v| v.as_i64())
            .unwrap_or(now);
        let pinned = obj.get("pinned").and_then(|v| v.as_bool()).unwrap_or(false);
        normalized.push(serde_json::json!({
            "path": path,
            "name": name,
            "lastOpenedAt": last_opened_at,
            "pinned": pinned,
        }));
    }

    let _guard = app_settings_db_lock()
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    let conn = open_app_db_at(db_path)?;
    let settings_json = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![APP_SETTINGS_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| format!("读取应用配置失败: {err}"))?;

    let mut value: serde_json::Value = match settings_json.as_deref() {
        Some(json) => serde_json::from_str(json)
            .map_err(|err| format!("配置不是合法 JSON: {err}"))?,
        None => serde_json::json!({}),
    };
    if !value.is_object() {
        return Err("配置 JSON 必须是对象".to_string());
    }
    value
        .as_object_mut()
        .expect("set_recent_workspaces: 已确认是对象")
        .insert("recentWorkspaces".into(), serde_json::Value::Array(normalized));
    let merged = serde_json::to_string(&value).map_err(|err| format!("序列化配置失败: {err}"))?;

    conn.execute(
        "INSERT INTO settings (key, value, data_type, updated_at)
         VALUES (?1, ?2, 'json', ?3)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           data_type = excluded.data_type,
           updated_at = excluded.updated_at",
        params![APP_SETTINGS_KEY, merged, unix_millis()?],
    )
    .map_err(|err| format!("保存应用配置失败: {err}"))?;

    Ok(AppSettingsResult {
        settings_json: Some(merged),
        db_path: db_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub(crate) fn set_recent_workspaces(workspaces_json: String) -> Result<AppSettingsResult, String> {
    let db_path = app_db_path()?;
    set_recent_workspaces_impl(&db_path, &workspaces_json)
}

#[tauri::command]
pub(crate) fn load_app_characters() -> Result<AppCharactersResult, String> {
    let (conn, db_path) = open_app_db()?;
    let characters_json = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![APP_CHARACTERS_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| format!("读取角色卡失败: {err}"))?;

    Ok(AppCharactersResult {
        characters_json,
        db_path: db_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub(crate) fn save_app_characters(characters_json: String) -> Result<AppCharactersResult, String> {
    if characters_json.len() > MAX_CHARACTERS_JSON_BYTES {
        return Err(format!(
            "角色卡内容超过上限 {MAX_CHARACTERS_JSON_BYTES} bytes"
        ));
    }

    let value: serde_json::Value = serde_json::from_str(&characters_json)
        .map_err(|err| format!("角色卡不是合法 JSON: {err}"))?;
    if !value.is_object() {
        return Err("角色卡 JSON 必须是对象".to_string());
    }

    let (conn, db_path) = open_app_db()?;
    conn.execute(
        "INSERT INTO settings (key, value, data_type, updated_at)
         VALUES (?1, ?2, 'json', ?3)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           data_type = excluded.data_type,
           updated_at = excluded.updated_at",
        params![APP_CHARACTERS_KEY, characters_json, unix_millis()?],
    )
    .map_err(|err| format!("保存角色卡失败: {err}"))?;

    Ok(AppCharactersResult {
        characters_json: Some(characters_json),
        db_path: db_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub(crate) fn load_project_state(workspace_path: String) -> Result<ProjectStateResult, String> {
    let (conn, workspace, db_path) = open_project_db(&workspace_path)?;
    let state_json = match read_project_state_value(&conn)? {
        Some(state_json) => Some(state_json),
        None => import_legacy_project_state(&conn, &workspace)?,
    };

    if state_json.is_some() {
        cleanup_legacy_project_files(&workspace);
    }

    Ok(ProjectStateResult {
        state_json,
        db_path: db_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub(crate) fn save_project_state(
    workspace_path: String,
    state_json: String,
    purge_deleted_content: Option<bool>,
) -> Result<ProjectStateResult, String> {
    validate_project_state_json(&state_json)?;

    let (conn, workspace, db_path) = open_project_db(&workspace_path)?;
    let old_len = read_project_state_value_len(&conn)?;
    write_project_state_value(&conn, &state_json)?;
    cleanup_legacy_project_files(&workspace);
    if purge_deleted_content.unwrap_or(false)
        || should_compact_project_state(old_len, state_json.len())
    {
        purge_project_state_deleted_content(&conn)?;
    }

    Ok(ProjectStateResult {
        state_json: Some(state_json),
        db_path: db_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub(crate) fn save_session(workspace_path: String, session_json: String) -> Result<(), String> {
    let parsed: serde_json::Value =
        serde_json::from_str(&session_json).map_err(|err| format!("会话 JSON 不合法: {err}"))?;

    let id = parsed.get("id").and_then(|v| v.as_str()).unwrap_or("");
    if id.is_empty() {
        return Err("会话 ID 不能为空".to_string());
    }
    let name = parsed.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let provider = parsed
        .get("provider")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let model = parsed.get("model").and_then(|v| v.as_str()).unwrap_or("");
    let created_at = parsed
        .get("createdAt")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let updated_at = parsed
        .get("updatedAt")
        .and_then(|v| v.as_i64())
        .unwrap_or(created_at);

    let (conn, ..) = open_project_db(&workspace_path)?;
    conn.execute(
        "INSERT INTO sessions (id, name, provider, model, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           provider = excluded.provider,
           model = excluded.model,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at",
        params![id, name, provider, model, created_at, updated_at],
    )
    .map_err(|err| format!("保存会话失败: {err}"))?;

    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionListResult {
    pub(crate) sessions_json: String,
}

fn session_row_to_json(row: &rusqlite::Row<'_>) -> rusqlite::Result<serde_json::Value> {
    let created_at: i64 = row.get(4)?;
    let updated_at: Option<i64> = row.get(5)?;
    let archived_at: Option<i64> = row.get(6)?;
    let mut obj = serde_json::Map::new();
    obj.insert("id".into(), serde_json::Value::String(row.get(0)?));
    obj.insert("name".into(), serde_json::Value::String(row.get(1)?));
    obj.insert("provider".into(), serde_json::Value::String(row.get(2)?));
    obj.insert("model".into(), serde_json::Value::String(row.get(3)?));
    obj.insert("createdAt".into(), serde_json::json!(created_at));
    obj.insert(
        "updatedAt".into(),
        serde_json::json!(updated_at.unwrap_or(created_at)),
    );
    if let Some(ts) = archived_at {
        obj.insert("archivedAt".into(), serde_json::json!(ts));
    }
    Ok(serde_json::Value::Object(obj))
}

fn query_sessions(conn: &Connection, archived: bool) -> Result<Vec<serde_json::Value>, String> {
    let sql = if archived {
        "SELECT id, name, provider, model, created_at, updated_at, archived_at FROM sessions
         WHERE archived_at IS NOT NULL
         ORDER BY archived_at DESC, COALESCE(updated_at, created_at) DESC, id ASC"
    } else {
        "SELECT id, name, provider, model, created_at, updated_at, archived_at FROM sessions
         WHERE archived_at IS NULL
         ORDER BY COALESCE(updated_at, created_at) DESC, created_at DESC, id ASC"
    };
    let mut stmt = conn
        .prepare(sql)
        .map_err(|err| format!("查询会话失败: {err}"))?;
    let sessions: Vec<serde_json::Value> = stmt
        .query_map([], session_row_to_json)
        .map_err(|err| format!("读取会话列表失败: {err}"))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(sessions)
}

#[tauri::command]
pub(crate) fn load_sessions(workspace_path: String) -> Result<SessionListResult, String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    let sessions = query_sessions(&conn, false)?;
    Ok(SessionListResult {
        sessions_json: serde_json::to_string(&sessions)
            .map_err(|err| format!("序列化会话列表失败: {err}"))?,
    })
}

#[tauri::command]
pub(crate) fn load_archived_sessions(workspace_path: String) -> Result<SessionListResult, String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    let sessions = query_sessions(&conn, true)?;
    Ok(SessionListResult {
        sessions_json: serde_json::to_string(&sessions)
            .map_err(|err| format!("序列化归档会话列表失败: {err}"))?,
    })
}

#[tauri::command]
pub(crate) fn archive_session(workspace_path: String, session_id: String) -> Result<(), String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    conn.execute(
        "UPDATE sessions SET archived_at = ?1 WHERE id = ?2 AND archived_at IS NULL",
        params![unix_millis()?, session_id],
    )
    .map_err(|err| format!("归档会话失败: {err}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) fn restore_session(workspace_path: String, session_id: String) -> Result<(), String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    conn.execute(
        "UPDATE sessions SET archived_at = NULL, updated_at = ?1 WHERE id = ?2",
        params![unix_millis()?, session_id],
    )
    .map_err(|err| format!("恢复会话失败: {err}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) fn delete_session(workspace_path: String, session_id: String) -> Result<(), String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|err| format!("开启事务失败: {err}"))?;
    tx.execute(
        "DELETE FROM memory_recalls WHERE session_id = ?1",
        params![session_id],
    )
    .map_err(|err| format!("清理会话 Recall 审计失败: {err}"))?;
    // surface/compaction 表按 ADR-002 不对 sessions 建外键，需手动清理。
    tx.execute(
        "DELETE FROM context_surface_nodes WHERE session_id = ?1",
        params![session_id],
    )
    .map_err(|err| format!("清理会话 surface 节点失败: {err}"))?;
    tx.execute(
        "DELETE FROM context_surfaces WHERE session_id = ?1",
        params![session_id],
    )
    .map_err(|err| format!("清理会话 surface 失败: {err}"))?;
    tx.execute(
        "DELETE FROM context_compactions WHERE session_id = ?1",
        params![session_id],
    )
    .map_err(|err| format!("清理会话压缩记录失败: {err}"))?;
    tx.execute("DELETE FROM sessions WHERE id = ?1", params![session_id])
        .map_err(|err| format!("删除会话失败: {err}"))?;
    tx.commit()
        .map_err(|err| format!("提交删除会话事务失败: {err}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) fn save_message_batch(
    workspace_path: String,
    session_id: String,
    messages_json: String,
) -> Result<(), String> {
    let messages: Vec<serde_json::Value> = serde_json::from_str(&messages_json)
        .map_err(|err| format!("消息列表 JSON 不合法: {err}"))?;

    let (conn, ..) = open_project_db(&workspace_path)?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|err| format!("开启事务失败: {err}"))?;

    // 全量替换语义：先删除该 session 的所有旧消息，再插入新消息。
    // 这样 clearMessages(空数组) 和 resetToMessage(截断数组) 才能正确清理旧数据。
    tx.execute(
        "DELETE FROM messages WHERE session_id = ?1",
        params![session_id],
    )
    .map_err(|err| format!("清理旧消息失败: {err}"))?;

    for (idx, msg) in messages.iter().enumerate() {
        let msg_id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if msg_id.is_empty() {
            continue;
        }
        let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("");
        let work_mode = msg.get("workMode").and_then(|v| v.as_str());
        let content = msg.get("content").and_then(|v| v.as_str()).unwrap_or("");
        let reasoning_content = msg.get("reasoningContent").and_then(|v| v.as_str());
        let tool_invocations_raw = msg.get("toolInvocations");
        let tool_invocations = tool_invocations_raw
            .filter(|v| !v.is_null())
            .and_then(|v| serde_json::to_string(v).ok());
        // extras：恢复上下文所需的非核心字段，整体存为 JSON。缺失这些会导致重启后
        // 压缩状态（contextCheckpoint）与成员资格标志（synthetic/hidden/
        // carryForwardInContext）丢失，使已压缩会话重新展开并击穿前缀缓存。
        let mut extras_map = serde_json::Map::new();
        for key in [
            "promptContent",
            "synthetic",
            "hidden",
            "carryForwardInContext",
            "contextCheckpoint",
            "question",
            "questionAnswered",
            "durationMs",
            "modelTier",
            "modelName",
            "relatedFilePaths",
            "attachedFiles",
        ] {
            if let Some(val) = msg.get(key) {
                if !val.is_null() {
                    extras_map.insert(key.to_string(), val.clone());
                }
            }
        }
        let extras = if extras_map.is_empty() {
            None
        } else {
            serde_json::to_string(&serde_json::Value::Object(extras_map)).ok()
        };
        let timestamp = msg.get("timestamp").and_then(|v| v.as_i64()).unwrap_or(0);
        let message_index = idx as i64;

        // INSERT OR IGNORE：DELETE 已清空当前 session 的消息；
        // 若 id 冲突（来自其他 session），必须失败而非静默跳过，否则本批
        // 少一行、调用方以为全量替换成功。
        let inserted = tx
            .execute(
            "INSERT OR IGNORE INTO messages (id, session_id, message_index, role, work_mode, content, reasoning_content, tool_invocations, extras, timestamp)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                msg_id, session_id.as_str(), message_index,
                role, work_mode, content,
                reasoning_content, tool_invocations, extras,
                timestamp,
            ],
        )
        .map_err(|err| format!("保存消息 {msg_id} 失败: {err}"))?;
        if inserted == 0 {
            return Err(format!(
                "保存消息 {msg_id} 失败: 主键冲突（INSERT OR IGNORE 跳过），已中止本批写入"
            ));
        }
    }

    tx.commit()
        .map_err(|err| format!("提交消息事务失败: {err}"))?;

    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MessageListResult {
    pub(crate) messages_json: String,
}

/// Map a `messages` row (columns: id, role, work_mode, content, reasoning_content,
/// tool_invocations, extras, timestamp at indices 0..=7) into its JSON form,
/// restoring the extras fields. Shared by single-session and batch loads so both
/// stay byte-identical.
fn row_to_message_json(row: &rusqlite::Row) -> rusqlite::Result<serde_json::Value> {
    let tool_raw: Option<String> = row.get(5)?;
    let tool_invocations: serde_json::Value = match tool_raw {
        Some(s) => serde_json::from_str(&s).unwrap_or(serde_json::Value::Null),
        None => serde_json::Value::Null,
    };

    let extras_raw: Option<String> = row.get(6)?;
    let work_mode: Option<String> = row.get(2)?;
    let reasoning: Option<String> = row.get(4)?;

    let mut obj = serde_json::json!({
        "id": row.get::<_, String>(0)?,
        "role": row.get::<_, String>(1)?,
        "content": row.get::<_, String>(3)?,
        "timestamp": row.get::<_, i64>(7)?,
    });

    if let Some(wm) = work_mode {
        obj["workMode"] = serde_json::Value::String(wm);
    }
    if let Some(rc) = reasoning {
        obj["reasoningContent"] = serde_json::Value::String(rc);
    }
    if !tool_invocations.is_null() {
        obj["toolInvocations"] = tool_invocations;
    }
    // 还原 extras（promptContent / synthetic / hidden / carryForwardInContext /
    // contextCheckpoint / question / questionAnswered / durationMs /
    // modelTier / modelName / relatedFilePaths / attachedFiles）。
    if let Some(s) = extras_raw {
        if let Ok(serde_json::Value::Object(map)) = serde_json::from_str(&s) {
            for (key, value) in map {
                obj[key] = value;
            }
        }
    }

    Ok(obj)
}

#[tauri::command]
pub(crate) fn load_session_messages(
    workspace_path: String,
    session_id: String,
) -> Result<MessageListResult, String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, role, work_mode, content, reasoning_content, tool_invocations, extras, timestamp, message_index
             FROM messages WHERE session_id = ?1 ORDER BY message_index ASC",
        )
        .map_err(|err| format!("查询消息失败: {err}"))?;

    let messages: Vec<serde_json::Value> = stmt
        .query_map(params![session_id], row_to_message_json)
        .map_err(|err| format!("读取消息列表失败: {err}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(MessageListResult {
        messages_json: serde_json::to_string(&messages)
            .map_err(|err| format!("序列化消息列表失败: {err}"))?,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AllMessagesResult {
    pub(crate) messages_by_session_json: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolUsageEntry {
    pub(crate) name: String,
    pub(crate) count: i64,
    pub(crate) success: i64,
    pub(crate) error: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolUsageResult {
    pub(crate) usage_json: String,
}

/// Load every session's messages in a single query (one connection open), grouped
/// by session id. Replaces the previous N+1 per-session loads at workspace open.
#[tauri::command]
pub(crate) fn load_all_session_messages(
    workspace_path: String,
) -> Result<AllMessagesResult, String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, role, work_mode, content, reasoning_content, tool_invocations, extras, timestamp, message_index, session_id
             FROM messages ORDER BY session_id ASC, message_index ASC",
        )
        .map_err(|err| format!("查询消息失败: {err}"))?;

    let mut grouped: std::collections::BTreeMap<String, Vec<serde_json::Value>> =
        std::collections::BTreeMap::new();
    let rows = stmt
        .query_map([], |row| {
            let session_id: String = row.get(9)?;
            let msg = row_to_message_json(row)?;
            Ok((session_id, msg))
        })
        .map_err(|err| format!("读取消息列表失败: {err}"))?;
    for row in rows {
        if let Ok((session_id, msg)) = row {
            grouped.entry(session_id).or_default().push(msg);
        }
    }

    Ok(AllMessagesResult {
        messages_by_session_json: serde_json::to_string(&grouped)
            .map_err(|err| format!("序列化消息列表失败: {err}"))?,
    })
}

/// Aggregate tool invocation statistics across every session directly in the
/// backend, so the frontend does not need to keep all sessions' messages
/// resident in memory just to compute usage stats. Only the
/// `tool_invocations` column is read; message bodies never cross the IPC
/// boundary.
#[tauri::command]
pub(crate) fn aggregate_tool_usage(workspace_path: String) -> Result<ToolUsageResult, String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    let mut stmt = conn
        .prepare("SELECT tool_invocations FROM messages WHERE tool_invocations IS NOT NULL")
        .map_err(|err| format!("查询工具调用失败: {err}"))?;

    // name → (count, success, error)
    let mut aggregated: std::collections::BTreeMap<String, (i64, i64, i64)> =
        std::collections::BTreeMap::new();

    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|err| format!("读取工具调用失败: {err}"))?;
    for raw in rows.filter_map(|r| r.ok()) {
        let Ok(serde_json::Value::Array(invocations)) =
            serde_json::from_str::<serde_json::Value>(&raw)
        else {
            continue;
        };
        for invocation in invocations {
            let Some(name) = invocation.get("name").and_then(|v| v.as_str()) else {
                continue;
            };
            let status = invocation
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let entry = aggregated.entry(name.to_string()).or_insert((0, 0, 0));
            entry.0 += 1;
            if status == "success" {
                entry.1 += 1;
            } else if status == "error" {
                entry.2 += 1;
            }
        }
    }

    let usage: Vec<ToolUsageEntry> = aggregated
        .into_iter()
        .map(|(name, (count, success, error))| ToolUsageEntry {
            name,
            count,
            success,
            error,
        })
        .collect();

    Ok(ToolUsageResult {
        usage_json: serde_json::to_string(&usage)
            .map_err(|err| format!("序列化工具统计失败: {err}"))?,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionRuntimeResult {
    pub(crate) runtime_json: String,
}

/// 收尾一个回合：end > start 时把 (end - start) 累加进该会话的运行时长。
fn close_runtime_turn(
    acc: &mut std::collections::BTreeMap<String, i64>,
    session_id: &str,
    turn: &mut Option<(i64, Option<i64>)>,
) {
    if let Some((start, Some(end))) = turn.take() {
        if end > start {
            *acc.entry(session_id.to_string()).or_insert(0) += end - start;
        }
    }
}

/// 在后台聚合每个会话的 Agent 实际执行时长（墙钟，毫秒）：
/// Σ(回合内最后一条非 synthetic 的 assistant/error 消息时间戳 − 发起回合的
/// 非 synthetic user 消息时间戳)。用于回填旧会话缺失的 runtimeMs
/// （session_conversation_stats 旧数据没有该字段），消息体不跨 IPC 边界。
#[tauri::command]
pub(crate) fn aggregate_session_runtime(
    workspace_path: String,
) -> Result<SessionRuntimeResult, String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    let mut stmt = conn
        .prepare(
            "SELECT session_id, role, extras, timestamp
             FROM messages ORDER BY session_id ASC, message_index ASC",
        )
        .map_err(|err| format!("查询消息失败: {err}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|err| format!("读取消息列表失败: {err}"))?;

    let mut runtime_by_session: std::collections::BTreeMap<String, i64> =
        std::collections::BTreeMap::new();
    // 当前打开的回合：(user 消息时间戳, 最后一条候选结束消息时间戳)
    let mut open_turn: Option<(i64, Option<i64>)> = None;
    let mut current_session: Option<String> = None;

    for row in rows {
        let Ok((session_id, role, extras_raw, timestamp)) = row else {
            continue;
        };
        if current_session.as_deref() != Some(session_id.as_str()) {
            if let Some(prev) = current_session.take() {
                close_runtime_turn(&mut runtime_by_session, &prev, &mut open_turn);
            }
            current_session = Some(session_id.clone());
        }
        let synthetic = extras_raw
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|value| value.get("synthetic").and_then(|flag| flag.as_bool()))
            .unwrap_or(false);
        if synthetic {
            continue;
        }
        match role.as_str() {
            "user" => {
                close_runtime_turn(&mut runtime_by_session, &session_id, &mut open_turn);
                open_turn = Some((timestamp, None));
            }
            "assistant" | "error" => {
                if let Some((_, end)) = open_turn.as_mut() {
                    *end = Some(timestamp);
                }
            }
            _ => {}
        }
    }
    if let Some(prev) = current_session {
        close_runtime_turn(&mut runtime_by_session, &prev, &mut open_turn);
    }

    Ok(SessionRuntimeResult {
        runtime_json: serde_json::to_string(&runtime_by_session)
            .map_err(|err| format!("序列化运行时长统计失败: {err}"))?,
    })
}

#[tauri::command]
pub(crate) fn save_project_meta(
    workspace_path: String,
    key: String,
    value: String,
) -> Result<(), String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    conn.execute(
        "INSERT INTO project_meta (key, value, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at",
        params![key, value, unix_millis()?],
    )
    .map_err(|err| format!("保存项目元数据失败: {err}"))?;

    Ok(())
}

#[tauri::command]
pub(crate) fn load_project_meta(
    workspace_path: String,
    key: String,
) -> Result<Option<String>, String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    conn.query_row(
        "SELECT value FROM project_meta WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|err| format!("读取项目元数据失败: {err}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectMetaResult {
    pub(crate) meta_json: String,
}

#[tauri::command]
pub(crate) fn load_all_project_meta(workspace_path: String) -> Result<ProjectMetaResult, String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    let mut stmt = conn
        .prepare("SELECT key, value FROM project_meta")
        .map_err(|err| format!("查询元数据失败: {err}"))?;

    let meta: std::collections::HashMap<String, String> = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|err| format!("读取元数据列表失败: {err}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(ProjectMetaResult {
        meta_json: serde_json::to_string(&meta)
            .map_err(|err| format!("序列化元数据失败: {err}"))?,
    })
}

// ── Checkpoint Timeline ────────────────────────────────────────────────

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckpointRecord {
    pub id: i64,
    pub session_id: String,
    pub message_id: String,
    pub sha: String,
    pub label: String,
    pub file_count: i64,
    pub created_at: i64,
}

#[tauri::command]
pub(crate) fn save_checkpoint_record(
    workspace_path: String,
    session_id: String,
    message_id: String,
    sha: String,
    label: String,
    file_count: i64,
) -> Result<(), String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    conn.execute(
        "INSERT INTO checkpoint_timeline (session_id, message_id, sha, label, file_count, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![session_id, message_id, sha, label, file_count, unix_millis()?],
    )
    .map_err(|err| format!("保存 checkpoint 记录失败: {err}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) fn load_checkpoint_records(
    workspace_path: String,
    session_id: Option<String>,
) -> Result<Vec<CheckpointRecord>, String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    let (sql, params): (String, Vec<rusqlite::types::Value>) = if let Some(ref sid) = session_id {
        (
            "SELECT id, session_id, message_id, sha, label, file_count, created_at
             FROM checkpoint_timeline WHERE session_id = ?1 ORDER BY id"
                .into(),
            vec![sid.clone().into()],
        )
    } else {
        (
            "SELECT id, session_id, message_id, sha, label, file_count, created_at
             FROM checkpoint_timeline ORDER BY id"
                .into(),
            vec![],
        )
    };

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|err| format!("查询 checkpoint 记录失败: {err}"))?;

    let records = stmt
        .query_map(rusqlite::params_from_iter(params.iter()), |row| {
            Ok(CheckpointRecord {
                id: row.get(0)?,
                session_id: row.get(1)?,
                message_id: row.get(2)?,
                sha: row.get(3)?,
                label: row.get(4)?,
                file_count: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|err| format!("读取 checkpoint 记录失败: {err}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(records)
}

#[tauri::command]
pub(crate) fn delete_checkpoint_by_message(
    workspace_path: String,
    message_id: String,
) -> Result<(), String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    conn.execute(
        "DELETE FROM checkpoint_timeline WHERE message_id = ?1",
        params![message_id],
    )
    .map_err(|err| format!("删除 checkpoint 记录失败: {err}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) fn delete_checkpoints_for_session(
    workspace_path: String,
    session_id: String,
) -> Result<(), String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    conn.execute(
        "DELETE FROM checkpoint_timeline WHERE session_id = ?1",
        params![session_id],
    )
    .map_err(|err| format!("删除 checkpoint 记录失败: {err}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) fn save_projectgraph_cache(
    workspace_path: String,
    cache_data: String,
) -> Result<(), String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    conn.execute(
        "INSERT INTO project_state (key, value, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at",
        params!["projectgraph.cache", cache_data, unix_millis()?],
    )
    .map_err(|err| format!("保存 ProjectGraph 缓存失败: {err}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) fn load_projectgraph_cache(workspace_path: String) -> Result<Option<String>, String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    conn.query_row(
        "SELECT value FROM project_state WHERE key = 'projectgraph.cache'",
        [],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|err| format!("读取 ProjectGraph 缓存失败: {err}"))
}

// ── Cache commands (app-level, replaces localStorage) ─────────────────

#[tauri::command]
pub(crate) fn cache_get(key: String) -> Result<Option<String>, String> {
    let (conn, _db_path) = open_app_db()?;
    let now = unix_millis()?;
    let result: Option<(String, Option<i64>)> = conn
        .query_row(
            "SELECT value, expires_at FROM cache WHERE key = ?1",
            params![key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|err| format!("读取缓存失败: {err}"))?;

    match result {
        None => Ok(None),
        Some((_, Some(expires_at))) if expires_at <= now => {
            let _ = conn.execute("DELETE FROM cache WHERE key = ?1", params![key]);
            Ok(None)
        }
        Some((value, _)) => Ok(Some(value)),
    }
}

#[tauri::command]
pub(crate) fn cache_set(key: String, value: String, ttl_ms: Option<i64>) -> Result<(), String> {
    let (conn, _db_path) = open_app_db()?;
    let now = unix_millis()?;
    let expires_at = ttl_ms.map(|ms| now + ms);
    conn.execute(
        "INSERT INTO cache (key, value, expires_at, created_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           expires_at = excluded.expires_at,
           created_at = excluded.created_at",
        params![key, value, expires_at, now],
    )
    .map_err(|err| format!("保存缓存失败: {err}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) fn cache_remove(key: String) -> Result<(), String> {
    let (conn, _db_path) = open_app_db()?;
    conn.execute("DELETE FROM cache WHERE key = ?1", params![key])
        .map_err(|err| format!("删除缓存失败: {err}"))?;
    Ok(())
}

// ── Papr App Storage ─────────────────────────────────────────────────

pub(crate) fn papr_storage_get(
    workspace_path: &str,
    app_id: &str,
    key: &str,
) -> Result<Option<String>, String> {
    let (conn, ..) = open_papr_app_db(workspace_path, app_id)?;
    conn.query_row(
        "SELECT value FROM app_storage WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|err| format!("读取 app_storage 失败: {err}"))
}

pub(crate) fn papr_storage_set(
    workspace_path: &str,
    app_id: &str,
    key: &str,
    value: &str,
) -> Result<(), String> {
    let (conn, ..) = open_papr_app_db(workspace_path, app_id)?;
    conn.execute(
        "INSERT INTO app_storage (key, value, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at",
        params![key, value, unix_millis()?],
    )
    .map_err(|err| format!("保存 app_storage 失败: {err}"))?;
    Ok(())
}

pub(crate) fn papr_storage_delete(
    workspace_path: &str,
    app_id: &str,
    key: &str,
) -> Result<(), String> {
    let (conn, ..) = open_papr_app_db(workspace_path, app_id)?;
    conn.execute("DELETE FROM app_storage WHERE key = ?1", params![key])
        .map_err(|err| format!("删除 app_storage 失败: {err}"))?;
    Ok(())
}

pub(crate) fn papr_storage_keys(workspace_path: &str, app_id: &str) -> Result<Vec<String>, String> {
    let (conn, ..) = open_papr_app_db(workspace_path, app_id)?;
    let mut stmt = conn
        .prepare("SELECT key FROM app_storage ORDER BY key")
        .map_err(|err| format!("查询 app_storage keys 失败: {err}"))?;
    let keys: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|err| format!("读取 app_storage keys 失败: {err}"))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(keys)
}

// ── Papr App Inbox（app_publish）─────────────────────────────────────

/// inbox 追加进程级锁：并行子代理/多会话可能并发 app_publish 同一频道。
/// 读-追加-写回若跨两次独立事务会丢事件（lost update），此锁把整个序列
/// 串行化；跨进程并发再由 BEGIN IMMEDIATE（先抢 SQLite 写锁）兜底。
static PAPR_INBOX_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn papr_inbox_lock() -> &'static Mutex<()> {
    PAPR_INBOX_LOCK.get_or_init(|| Mutex::new(()))
}

pub(crate) const PAPR_INBOX_DEFAULT_CAP: usize = 200;

/// 向 app 的 inbox 频道原子追加一条事件，key = `inbox:<channel>`。
///
/// 存储为 JSON 数组 `[{seq, ts, payload}, ...]`，只保留最近 `cap` 条；
/// seq 在锁内取「现有最大 seq + 1」分配，单调无冲突。返回 (seq, ts)。
///
/// 原子性：进程内 Mutex + 跨进程 `BEGIN IMMEDIATE`（WAL 下全局单 writer，
/// busy_timeout=5000 使竞争方等待而非失败）。
pub(crate) fn papr_inbox_append(
    workspace_path: &str,
    app_id: &str,
    channel: &str,
    payload_json: &str,
    cap: Option<usize>,
) -> Result<(u64, i64), String> {
    if channel.is_empty() || channel.len() > 64 {
        return Err("inbox channel 长度必须在 1-64 之间".to_string());
    }
    let key = format!("inbox:{channel}");
    let cap = cap.unwrap_or(PAPR_INBOX_DEFAULT_CAP).max(1);
    let payload: serde_json::Value = serde_json::from_str(payload_json)
        .map_err(|err| format!("payload 不是合法 JSON: {err}"))?;

    let _guard = papr_inbox_lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (mut conn, ..) = open_papr_app_db(workspace_path, app_id)?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|err| format!("开启 inbox 事务失败: {err}"))?;

    let current = tx
        .query_row(
            "SELECT value FROM app_storage WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| format!("读取 inbox 失败: {err}"))?;

    // 损坏/非数组值按空列表自愈，避免坏数据把频道永久卡死。
    let mut events: Vec<serde_json::Value> =
        current.and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default();

    let seq = events
        .iter()
        .rev()
        .find_map(|event| event.get("seq").and_then(|value| value.as_u64()))
        .map_or(1, |last| last + 1);
    let ts = unix_millis()?;
    events.push(serde_json::json!({ "seq": seq, "ts": ts, "payload": payload }));
    if events.len() > cap {
        let overflow = events.len() - cap;
        events.drain(0..overflow);
    }

    let serialized =
        serde_json::to_string(&events).map_err(|err| format!("序列化 inbox 失败: {err}"))?;
    tx.execute(
        "INSERT INTO app_storage (key, value, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at",
        params![key, serialized, ts],
    )
    .map_err(|err| format!("写入 inbox 失败: {err}"))?;
    tx.commit().map_err(|err| format!("提交 inbox 事务失败: {err}"))?;
    Ok((seq, ts))
}

// ── Papr App Permission Settings ────────────────────────────────────

pub(crate) fn papr_load_permission_settings() -> Result<Option<String>, String> {
    let (conn, _) = open_app_db()?;
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![PAPR_APP_PERMISSION_SETTINGS_KEY],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|err| format!("读取 Papr 权限设置失败: {err}"))
}

// 测试构建下调用方（permission.rs 的 persist_settings）被 #[cfg(not(test))]
// 排除（避免测试污染真实用户 DB），此处仅在测试 profile 静默。
#[cfg_attr(test, allow(dead_code))]
pub(crate) fn papr_save_permission_settings(settings_json: &str) -> Result<(), String> {
    let (conn, _) = open_app_db()?;
    conn.execute(
        "INSERT INTO settings (key, value, data_type, updated_at)
         VALUES (?1, ?2, 'json', ?3)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           data_type = excluded.data_type,
           updated_at = excluded.updated_at",
        params![
            PAPR_APP_PERMISSION_SETTINGS_KEY,
            settings_json,
            unix_millis()?
        ],
    )
    .map_err(|err| format!("保存 Papr 权限设置失败: {err}"))?;
    Ok(())
}

// ── Context Surface / Compaction（ADR-001~007，PR1）────────────────────
//
// 设计约束（docs/adr/）：
// - 不对 messages 建外键：save_message_batch 是全量替换（DELETE+INSERT），
//   级联会每次保存清空 surface 节点；
// - 压缩提交是单事务：started → surface → completed 一步提交，正常不残留
//   started 行（open_project_db 有防御性清理）。

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContextSurfaceNodeResult {
    pub(crate) position: i64,
    pub(crate) message_id: String,
    pub(crate) node_kind: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContextSurfaceResult {
    pub(crate) session_id: String,
    pub(crate) generation: i64,
    pub(crate) parent_generation: Option<i64>,
    pub(crate) compaction_id: Option<String>,
    pub(crate) render_params_json: String,
    pub(crate) created_at: i64,
    pub(crate) nodes: Vec<ContextSurfaceNodeResult>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContextSurfaceNodeInput {
    pub(crate) position: i64,
    pub(crate) message_id: String,
    pub(crate) node_kind: String,
}

fn read_context_surface(
    conn: &Connection,
    session_id: &str,
    generation: Option<i64>,
) -> Result<Option<ContextSurfaceResult>, String> {
    // 两段读（header + nodes）必须在同一读事务内，避免多窗口并发提交
    // 时读到混合 generation 的 header/nodes。
    let tx = conn
        .unchecked_transaction()
        .map_err(|err| format!("开启 surface 读事务失败: {err}"))?;
    let surface = if let Some(target) = generation {
        tx.query_row(
            "SELECT generation, parent_generation, compaction_id, render_params, created_at
             FROM context_surfaces
             WHERE session_id = ?1 AND generation = ?2",
            params![session_id, target],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|err| format!("读取 context surface 失败: {err}"))?
    } else {
        tx.query_row(
            "SELECT generation, parent_generation, compaction_id, render_params, created_at
             FROM context_surfaces
             WHERE session_id = ?1
             ORDER BY generation DESC LIMIT 1",
            params![session_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|err| format!("读取 context surface 失败: {err}"))?
    };

    let Some((generation, parent_generation, compaction_id, render_params, created_at)) = surface
    else {
        return Ok(None);
    };

    let mut stmt = tx
        .prepare(
            "SELECT position, message_id, node_kind
             FROM context_surface_nodes
             WHERE session_id = ?1 AND generation = ?2
             ORDER BY position ASC",
        )
        .map_err(|err| format!("准备 surface 节点查询失败: {err}"))?;
    let nodes = stmt
        .query_map(params![session_id, generation], |row| {
            Ok(ContextSurfaceNodeResult {
                position: row.get(0)?,
                message_id: row.get(1)?,
                node_kind: row.get(2)?,
            })
        })
        .map_err(|err| format!("读取 surface 节点失败: {err}"))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|err| format!("收集 surface 节点失败: {err}"))?;
    drop(stmt);
    tx.commit()
        .map_err(|err| format!("提交 surface 读事务失败: {err}"))?;

    Ok(Some(ContextSurfaceResult {
        session_id: session_id.to_string(),
        generation,
        parent_generation,
        compaction_id,
        render_params_json: render_params,
        created_at,
        nodes,
    }))
}

#[tauri::command]
pub(crate) fn load_context_surface(
    workspace_path: String,
    session_id: String,
    generation: Option<i64>,
) -> Result<Option<ContextSurfaceResult>, String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    read_context_surface(&conn, &session_id, generation)
}

/// ADR-002：degraded generation 回退 parent / 重建 gen 0 时丢弃
/// `generation >= from_generation` 的 surface 行与节点。
#[tauri::command]
pub(crate) fn discard_context_surfaces_from_generation(
    workspace_path: String,
    session_id: String,
    from_generation: i64,
) -> Result<(), String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|err| format!("开启事务失败: {err}"))?;
    tx.execute(
        "DELETE FROM context_surface_nodes WHERE session_id = ?1 AND generation >= ?2",
        params![session_id, from_generation],
    )
    .map_err(|err| format!("丢弃 surface 节点失败: {err}"))?;
    tx.execute(
        "DELETE FROM context_surfaces WHERE session_id = ?1 AND generation >= ?2",
        params![session_id, from_generation],
    )
    .map_err(|err| format!("丢弃 surface generation 失败: {err}"))?;
    tx.commit()
        .map_err(|err| format!("提交丢弃 surface 事务失败: {err}"))?;
    Ok(())
}

/// 维护路径：按当前 model-visible 投影整体替换某一 generation 的节点
/// （全量替换保存语义下，重算比增量 append 更稳）。generation 0 = legacy
/// 引导；compaction 提交应走 commit_context_compaction（单事务）。
#[tauri::command]
pub(crate) fn save_context_surface(
    workspace_path: String,
    session_id: String,
    generation: i64,
    parent_generation: Option<i64>,
    compaction_id: Option<String>,
    render_params_json: String,
    nodes_json: String,
) -> Result<(), String> {
    let nodes: Vec<ContextSurfaceNodeInput> = serde_json::from_str(&nodes_json)
        .map_err(|err| format!("surface 节点 JSON 不合法: {err}"))?;

    let (conn, ..) = open_project_db(&workspace_path)?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|err| format!("开启事务失败: {err}"))?;

    // 维护路径只允许更新节点与 render_params（PR3 prune-first）。
    // compaction_id / parent_generation 是 generation 身份，禁止在此覆写
    // （ADR-002：degraded 自愈不得破坏 generation 语义；压缩提交走
    // commit_context_compaction）。
    tx.execute(
        "INSERT INTO context_surfaces
           (session_id, generation, parent_generation, compaction_id, render_params, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(session_id, generation) DO UPDATE SET
           render_params = excluded.render_params",
        params![
            session_id,
            generation,
            parent_generation,
            compaction_id,
            render_params_json,
            unix_millis()?
        ],
    )
    .map_err(|err| format!("保存 context surface 失败: {err}"))?;

    tx.execute(
        "DELETE FROM context_surface_nodes WHERE session_id = ?1 AND generation = ?2",
        params![session_id, generation],
    )
    .map_err(|err| format!("清理旧 surface 节点失败: {err}"))?;

    for node in &nodes {
        tx.execute(
            "INSERT INTO context_surface_nodes
               (session_id, generation, position, message_id, node_kind, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                session_id,
                generation,
                node.position,
                node.message_id,
                node.node_kind,
                unix_millis()?
            ],
        )
        .map_err(|err| format!("保存 surface 节点失败: {err}"))?;
    }

    tx.commit()
        .map_err(|err| format!("提交 surface 事务失败: {err}"))?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompactionCommitInput {
    pub(crate) id: String,
    pub(crate) session_id: String,
    pub(crate) trigger: String,
    pub(crate) source_generation: i64,
    pub(crate) target_generation: i64,
    pub(crate) checkpoint_message_id: Option<String>,
    pub(crate) parent_checkpoint_message_id: Option<String>,
    pub(crate) source_start_message_id: Option<String>,
    pub(crate) source_end_message_id: Option<String>,
    pub(crate) retained_tail_start_message_id: Option<String>,
    pub(crate) source_message_count: i64,
    pub(crate) retained_message_count: i64,
    pub(crate) estimated_tokens_before: Option<i64>,
    pub(crate) estimated_tokens_after: Option<i64>,
    pub(crate) source_tokens: Option<i64>,
    pub(crate) checkpoint_tokens: Option<i64>,
    pub(crate) summary_mode: String,
    pub(crate) summary_provider: Option<String>,
    pub(crate) summary_model: Option<String>,
    pub(crate) created_at: i64,
    pub(crate) nodes: Vec<ContextSurfaceNodeInput>,
    pub(crate) render_params_json: String,
}

/// 压缩提交（ADR-005）：单事务内 started 行 → surface generation + nodes →
/// completed 行一步提交。任何一步失败整个事务回滚，之前 completed 的
/// generation 保持 active。
#[tauri::command]
pub(crate) fn commit_context_compaction(
    workspace_path: String,
    request_json: String,
) -> Result<serde_json::Value, String> {
    let input: CompactionCommitInput = serde_json::from_str(&request_json)
        .map_err(|err| format!("压缩提交 JSON 不合法: {err}"))?;

    let (conn, ..) = open_project_db(&workspace_path)?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|err| format!("开启事务失败: {err}"))?;

    // 幂等：同一 compaction id 已 completed（IPC 响应丢失后的重试）直接成功。
    let existing: Option<(String, Option<i64>)> = tx
        .query_row(
            "SELECT status, target_generation FROM context_compactions WHERE id = ?1",
            params![input.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|err| format!("查询压缩记录失败: {err}"))?;
    if let Some((status, target_gen)) = existing {
        if status == "completed" {
            return Ok(serde_json::json!({
                "compactionId": input.id,
                "generation": target_gen.unwrap_or(input.target_generation),
            }));
        }
        return Err(format!(
            "压缩提交冲突：compaction {} 状态为 {status}，拒绝覆盖",
            input.id
        ));
    }

    // 乐观并发：最新 generation 必须等于 source_generation，否则是陈旧缓存提交。
    let latest: Option<i64> = tx
        .query_row(
            "SELECT MAX(generation) FROM context_surfaces WHERE session_id = ?1",
            params![input.session_id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .map_err(|err| format!("读取最新 surface generation 失败: {err}"))?;
    let expected_source = latest.unwrap_or(0);
    if expected_source != input.source_generation {
        return Err(format!(
            "压缩提交冲突：期望 source_generation={expected_source}，收到 {}",
            input.source_generation
        ));
    }

    tx.execute(
        "INSERT INTO context_compactions
           (id, session_id, status, trigger, source_generation, target_generation,
            checkpoint_message_id, parent_checkpoint_message_id,
            source_start_message_id, source_end_message_id,
            retained_tail_start_message_id, source_message_count, retained_message_count,
            estimated_tokens_before, estimated_tokens_after, source_tokens, checkpoint_tokens,
            summary_mode, summary_provider, summary_model, created_at)
         VALUES (?1, ?2, 'started', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                 ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
        params![
            input.id,
            input.session_id,
            input.trigger,
            input.source_generation,
            input.target_generation,
            input.checkpoint_message_id,
            input.parent_checkpoint_message_id,
            input.source_start_message_id,
            input.source_end_message_id,
            input.retained_tail_start_message_id,
            input.source_message_count,
            input.retained_message_count,
            input.estimated_tokens_before,
            input.estimated_tokens_after,
            input.source_tokens,
            input.checkpoint_tokens,
            input.summary_mode,
            input.summary_provider,
            input.summary_model,
            input.created_at,
        ],
    )
    .map_err(|err| format!("插入压缩记录失败: {err}"))?;

    // 禁止 ON CONFLICT DO UPDATE：同一 generation 被陈旧提交静默覆盖会破坏
    // parent/compaction/nodes 身份（乐观并发的写侧）。UNIQUE 冲突视为并发失败。
    tx.execute(
        "INSERT INTO context_surfaces
           (session_id, generation, parent_generation, compaction_id, render_params, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            input.session_id,
            input.target_generation,
            input.source_generation,
            input.id,
            input.render_params_json,
            unix_millis()?
        ],
    )
    .map_err(|err| {
        if err.sqlite_error_code() == Some(rusqlite::ErrorCode::ConstraintViolation) {
            format!(
                "压缩提交冲突：generation {} 已存在",
                input.target_generation
            )
        } else {
            format!("插入新 surface generation 失败: {err}")
        }
    })?;

    tx.execute(
        "DELETE FROM context_surface_nodes WHERE session_id = ?1 AND generation = ?2",
        params![input.session_id, input.target_generation],
    )
    .map_err(|err| format!("清理新 generation 节点失败: {err}"))?;

    for node in &input.nodes {
        tx.execute(
            "INSERT INTO context_surface_nodes
               (session_id, generation, position, message_id, node_kind, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                input.session_id,
                input.target_generation,
                node.position,
                node.message_id,
                node.node_kind,
                unix_millis()?
            ],
        )
        .map_err(|err| format!("保存新 generation 节点失败: {err}"))?;
    }

    tx.execute(
        "UPDATE context_compactions
         SET status = 'completed', completed_at = ?1
         WHERE id = ?2",
        params![unix_millis()?, input.id],
    )
    .map_err(|err| format!("标记压缩完成失败: {err}"))?;

    tx.commit()
        .map_err(|err| format!("提交压缩事务失败: {err}"))?;

    Ok(serde_json::json!({
        "compactionId": input.id,
        "generation": input.target_generation,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompactionFailureInput {
    pub(crate) id: String,
    pub(crate) session_id: String,
    pub(crate) trigger: String,
    pub(crate) source_generation: i64,
    pub(crate) summary_mode: String,
    pub(crate) created_at: i64,
    pub(crate) failure_code: String,
    pub(crate) failure_message: String,
}

/// 失败压缩的溯源记录（不变式 5：失败不得破坏上一个 completed surface，
/// 只新增 failed 行供审计）。若事务内已写过 started 行则更新，否则插入。
#[tauri::command]
pub(crate) fn mark_context_compaction_failed(
    workspace_path: String,
    failure_json: String,
) -> Result<(), String> {
    let input: CompactionFailureInput = serde_json::from_str(&failure_json)
        .map_err(|err| format!("失败记录 JSON 不合法: {err}"))?;

    let (conn, ..) = open_project_db(&workspace_path)?;
    // 不得把 completed 行翻成 failed：IPC 响应丢失时提交可能已落库，
    // 审计必须与 active surface 一致（WHERE 使 UPSERT 在 completed 上成为空操作）。
    conn.execute(
        "INSERT INTO context_compactions
           (id, session_id, status, trigger, source_generation,
            summary_mode, created_at, failure_code, failure_message)
         VALUES (?1, ?2, 'failed', ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
           status = 'failed',
           failure_code = excluded.failure_code,
           failure_message = excluded.failure_message
         WHERE context_compactions.status != 'completed'",
        params![
            input.id,
            input.session_id,
            input.trigger,
            input.source_generation,
            input.summary_mode,
            input.created_at,
            input.failure_code,
            input.failure_message,
        ],
    )
    .map_err(|err| format!("记录压缩失败失败: {err}"))?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContextCompactionResult {
    pub(crate) id: String,
    pub(crate) session_id: String,
    pub(crate) status: String,
    pub(crate) trigger: String,
    pub(crate) source_generation: i64,
    pub(crate) target_generation: Option<i64>,
    pub(crate) checkpoint_message_id: Option<String>,
    pub(crate) source_start_message_id: Option<String>,
    pub(crate) source_end_message_id: Option<String>,
    pub(crate) retained_tail_start_message_id: Option<String>,
    pub(crate) source_message_count: i64,
    pub(crate) retained_message_count: i64,
    pub(crate) estimated_tokens_before: Option<i64>,
    pub(crate) estimated_tokens_after: Option<i64>,
    pub(crate) summary_mode: String,
    pub(crate) summary_model: Option<String>,
    pub(crate) failure_code: Option<String>,
    pub(crate) failure_message: Option<String>,
    pub(crate) created_at: i64,
    pub(crate) completed_at: Option<i64>,
}

#[tauri::command]
pub(crate) fn load_context_compactions(
    workspace_path: String,
    session_id: String,
    limit: Option<i64>,
) -> Result<Vec<ContextCompactionResult>, String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    let limit = limit.unwrap_or(50).clamp(1, 500);

    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, status, trigger, source_generation, target_generation,
                    checkpoint_message_id, source_start_message_id, source_end_message_id,
                    retained_tail_start_message_id, source_message_count, retained_message_count,
                    estimated_tokens_before, estimated_tokens_after, summary_mode, summary_model,
                    failure_code, failure_message, created_at, completed_at
             FROM context_compactions
             WHERE session_id = ?1
             ORDER BY created_at DESC LIMIT ?2",
        )
        .map_err(|err| format!("准备压缩记录查询失败: {err}"))?;

    let rows = stmt
        .query_map(params![session_id, limit], |row| {
            Ok(ContextCompactionResult {
                id: row.get(0)?,
                session_id: row.get(1)?,
                status: row.get(2)?,
                trigger: row.get(3)?,
                source_generation: row.get(4)?,
                target_generation: row.get(5)?,
                checkpoint_message_id: row.get(6)?,
                source_start_message_id: row.get(7)?,
                source_end_message_id: row.get(8)?,
                retained_tail_start_message_id: row.get(9)?,
                source_message_count: row.get(10)?,
                retained_message_count: row.get(11)?,
                estimated_tokens_before: row.get(12)?,
                estimated_tokens_after: row.get(13)?,
                summary_mode: row.get(14)?,
                summary_model: row.get(15)?,
                failure_code: row.get(16)?,
                failure_message: row.get(17)?,
                created_at: row.get(18)?,
                completed_at: row.get(19)?,
            })
        })
        .map_err(|err| format!("读取压缩记录失败: {err}"))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|err| format!("收集压缩记录失败: {err}"))?;

    Ok(rows)
}

// ── Memory Ledger（PR4，ADR-008）────────────────────────────────────────
//
// 记忆分层：
// - memory_candidates：内部去重/审计（pending → admitted / rejected）；
// - memory_entries：稳定项目记忆（active / superseded / forgotten）；
// Session Bootstrap 从 memory_entries 渲染，不再写 .CodePapr/memory.md。
// 与 ADR-002 一致：不对 messages/sessions 建外键（应用级引用）。

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryCandidateInput {
    pub(crate) id: String,
    pub(crate) category: String,
    pub(crate) content: String,
    pub(crate) content_hash: String,
    pub(crate) confidence: String,
    pub(crate) trust: String,
    pub(crate) source_session_id: Option<String>,
    pub(crate) source_message_ids: Option<String>,
    pub(crate) evidence: Option<String>,
    pub(crate) risk_flags: Option<String>,
    pub(crate) created_at: i64,
}

/// 保存候选。按 content_hash 去重：同内容候选已存在（pending/admitted/
/// rejected 任一状态）时静默跳过并返回 false——回合后抽取会全量重扫历史
/// 消息，不去重会让同一命令每回合重复入队（候选表线性增长 + 反复准入）。
/// 返回 true 表示新插入。
#[tauri::command]
pub(crate) fn save_memory_candidate(
    workspace_path: String,
    candidate_json: String,
) -> Result<bool, String> {
    let input: MemoryCandidateInput = serde_json::from_str(&candidate_json)
        .map_err(|err| format!("记忆候选 JSON 不合法: {err}"))?;
    let (conn, ..) = open_project_db(&workspace_path)?;

    let duplicate: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM memory_candidates WHERE content_hash = ?1 LIMIT 1",
            params![input.content_hash],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("查询重复候选失败: {err}"))?;
    if duplicate.is_some() {
        return Ok(false);
    }

    conn.execute(
        "INSERT INTO memory_candidates
           (id, category, content, content_hash, confidence, trust,
            source_session_id, source_message_ids, evidence, risk_flags,
            status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pending', ?11)
         ON CONFLICT(id) DO UPDATE SET
           category = excluded.category,
           content = excluded.content,
           content_hash = excluded.content_hash,
           confidence = excluded.confidence,
           trust = excluded.trust,
           source_session_id = excluded.source_session_id,
           source_message_ids = excluded.source_message_ids,
           evidence = excluded.evidence,
           risk_flags = excluded.risk_flags,
           status = 'pending',
           decided_at = NULL,
           rejection_reason = NULL",
        params![
            input.id,
            input.category,
            input.content,
            input.content_hash,
            input.confidence,
            input.trust,
            input.source_session_id,
            input.source_message_ids,
            input.evidence,
            input.risk_flags,
            input.created_at,
        ],
    )
    .map_err(|err| format!("保存记忆候选失败: {err}"))?;
    Ok(true)
}

/// 准入：候选 → entry（单事务），并 supersede 同内容哈希的旧 active entry。
/// 幂等与遗忘保护：同 hash 已有 forgotten entry → 拒绝（候选标记 rejected）；
/// 同 hash 已有 active entry → 不新建条目，仅标记候选 admitted 并返回既有 id。
#[tauri::command]
pub(crate) fn admit_memory_candidate(
    workspace_path: String,
    candidate_id: String,
    entry_id: String,
) -> Result<String, String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|err| format!("开启事务失败: {err}"))?;

    let candidate: (String, String, String, String, String, Option<String>, Option<String>, Option<String>, Option<String>, i64) = tx
        .query_row(
            "SELECT category, content, content_hash, confidence, trust,
                    source_session_id, source_message_ids, evidence, risk_flags, created_at
             FROM memory_candidates WHERE id = ?1 AND status = 'pending'",
            params![candidate_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                ))
            },
        )
        .optional()
        .map_err(|err| format!("读取记忆候选失败: {err}"))?
        .ok_or_else(|| "候选不存在或已处理".to_string())?;

    // risk_flags 只存候选表（准入审计）：带风险标记的内容本就不允许准入，
    // active entry 上不会出现有意义的 risk_flags。
    let (category, content, content_hash, confidence, trust, source_session_id, source_message_ids, evidence, _risk_flags, created_at) = candidate;

    // 已遗忘的同内容条目：遗忘是用户的显式决定，自动重扫（回合后抽取会
    // 对同一命令反复生成候选）不得让它复活。候选标记 rejected 并阻断，
    // 避免每回合重复提议。
    let forgotten: Option<String> = tx
        .query_row(
            "SELECT id FROM memory_entries
              WHERE content_hash = ?1 AND status = 'forgotten' LIMIT 1",
            params![content_hash],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("查询遗忘条目失败: {err}"))?;
    if forgotten.is_some() {
        tx.execute(
            "UPDATE memory_candidates
             SET status = 'rejected', decided_at = ?1, rejection_reason = 'content-forgotten'
             WHERE id = ?2",
            params![unix_millis()?, candidate_id],
        )
        .map_err(|err| format!("标记候选拒绝失败: {err}"))?;
        tx.commit()
            .map_err(|err| format!("提交候选拒绝失败: {err}"))?;
        return Err("候选内容已被遗忘（memory_forget），不再准入".to_string());
    }

    // 同内容 active 条目已存在：幂等准入——不新建条目、不 supersede 抖动，
    // 只把候选标记为 admitted 并返回既有 entry id。
    let existing_active: Option<String> = tx
        .query_row(
            "SELECT id FROM memory_entries
              WHERE content_hash = ?1 AND status = 'active' LIMIT 1",
            params![content_hash],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("查询既有条目失败: {err}"))?;
    if let Some(existing_id) = existing_active {
        tx.execute(
            "UPDATE memory_candidates
             SET status = 'admitted', decided_at = ?1
             WHERE id = ?2",
            params![unix_millis()?, candidate_id],
        )
        .map_err(|err| format!("标记候选已准入失败: {err}"))?;
        tx.commit()
            .map_err(|err| format!("提交准入事务失败: {err}"))?;
        return Ok(existing_id);
    }

    let verified_at = unix_millis()?;

    tx.execute(
        "INSERT INTO memory_entries
           (id, category, content, content_hash, confidence, trust, status,
            source_session_id, source_message_ids, evidence, created_at, verified_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?8, ?9, ?10, ?11)",
        params![
            entry_id,
            category,
            content,
            content_hash,
            confidence,
            trust,
            source_session_id,
            source_message_ids,
            evidence,
            created_at,
            verified_at,
        ],
    )
    .map_err(|err| format!("写入记忆条目失败: {err}"))?;

    tx.execute(
        "UPDATE memory_entries
         SET status = 'superseded', superseded_by = ?1
         WHERE content_hash = ?2 AND status = 'active' AND id != ?1",
        params![entry_id, content_hash],
    )
    .map_err(|err| format!("标记旧条目失败: {err}"))?;

    tx.execute(
        "UPDATE memory_candidates
         SET status = 'admitted', decided_at = ?1
         WHERE id = ?2",
        params![unix_millis()?, candidate_id],
    )
    .map_err(|err| format!("标记候选已准入失败: {err}"))?;

    tx.commit()
        .map_err(|err| format!("提交准入事务失败: {err}"))?;
    Ok(entry_id)
}

#[tauri::command]
pub(crate) fn reject_memory_candidate(
    workspace_path: String,
    candidate_id: String,
    reason: Option<String>,
) -> Result<(), String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    let affected = conn
        .execute(
            "UPDATE memory_candidates
             SET status = 'rejected', decided_at = ?1, rejection_reason = ?2
             WHERE id = ?3 AND status = 'pending'",
            params![unix_millis()?, reason, candidate_id],
        )
        .map_err(|err| format!("拒绝记忆候选失败: {err}"))?;
    if affected == 0 {
        return Err("候选不存在或已处理".to_string());
    }
    Ok(())
}

/// 遗忘（memory_forget 工具，ADR-008）：active entry → forgotten（软删除，
/// 审计可溯源），不再参与投影 / Recall 检索。理由存 forgotten_reason。
#[tauri::command]
pub(crate) fn forget_memory_entry(
    workspace_path: String,
    entry_id: String,
    reason: Option<String>,
) -> Result<(), String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    let affected = conn
        .execute(
            "UPDATE memory_entries
             SET status = 'forgotten', forgotten_reason = ?1
             WHERE id = ?2 AND status = 'active'",
            params![reason, entry_id],
        )
        .map_err(|err| format!("遗忘记忆条目失败: {err}"))?;
    if affected == 0 {
        return Err("记忆条目不存在或已遗忘".to_string());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryEntryResult {
    pub(crate) id: String,
    pub(crate) category: String,
    pub(crate) content: String,
    pub(crate) content_hash: String,
    pub(crate) confidence: String,
    pub(crate) trust: String,
    pub(crate) status: String,
    pub(crate) source_session_id: Option<String>,
    pub(crate) source_message_ids: Option<String>,
    pub(crate) evidence: Option<String>,
    pub(crate) created_at: i64,
    pub(crate) verified_at: Option<i64>,
    pub(crate) superseded_by: Option<String>,
}

#[tauri::command]
pub(crate) fn load_memory_entries(
    workspace_path: String,
    only_active: Option<bool>,
) -> Result<Vec<MemoryEntryResult>, String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    let status_filter = if only_active.unwrap_or(true) {
        "WHERE status = 'active'"
    } else {
        ""
    };
    let sql = format!(
        "SELECT id, category, content, content_hash, confidence, trust, status,
                source_session_id, source_message_ids, evidence, created_at,
                verified_at, superseded_by
         FROM memory_entries {status_filter}
         ORDER BY verified_at DESC, created_at DESC"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|err| format!("准备记忆条目查询失败: {err}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(MemoryEntryResult {
                id: row.get(0)?,
                category: row.get(1)?,
                content: row.get(2)?,
                content_hash: row.get(3)?,
                confidence: row.get(4)?,
                trust: row.get(5)?,
                status: row.get(6)?,
                source_session_id: row.get(7)?,
                source_message_ids: row.get(8)?,
                evidence: row.get(9)?,
                created_at: row.get(10)?,
                verified_at: row.get(11)?,
                superseded_by: row.get(12)?,
            })
        })
        .map_err(|err| format!("读取记忆条目失败: {err}"))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|err| format!("收集记忆条目失败: {err}"))?;
    Ok(rows)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryCandidateResult {
    pub(crate) id: String,
    pub(crate) category: String,
    pub(crate) content: String,
    pub(crate) content_hash: String,
    pub(crate) confidence: String,
    pub(crate) trust: String,
    pub(crate) status: String,
    pub(crate) risk_flags: Option<String>,
    pub(crate) source_session_id: Option<String>,
    pub(crate) source_message_ids: Option<String>,
    pub(crate) created_at: i64,
    pub(crate) decided_at: Option<i64>,
    pub(crate) rejection_reason: Option<String>,
}

#[tauri::command]
pub(crate) fn load_memory_candidates(
    workspace_path: String,
    status: Option<String>,
) -> Result<Vec<MemoryCandidateResult>, String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    let status_filter = match status.as_deref() {
        Some(s) if !s.is_empty() => "WHERE status = ?1",
        _ => "",
    };
    let sql = format!(
        "SELECT id, category, content, content_hash, confidence, trust, status,
                risk_flags, source_session_id, source_message_ids, created_at,
                decided_at, rejection_reason
         FROM memory_candidates {status_filter}
         ORDER BY created_at DESC"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|err| format!("准备记忆候选查询失败: {err}"))?;

    let rows = match status_filter.is_empty() {
        true => stmt
            .query_map([], |row| map_memory_candidate_row(row))
            .map_err(|err| format!("读取记忆候选失败: {err}"))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|err| format!("收集记忆候选失败: {err}"))?,
        false => stmt
            .query_map(params![status], |row| map_memory_candidate_row(row))
            .map_err(|err| format!("读取记忆候选失败: {err}"))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|err| format!("收集记忆候选失败: {err}"))?,
    };
    Ok(rows)
}

fn map_memory_candidate_row(row: &rusqlite::Row) -> rusqlite::Result<MemoryCandidateResult> {
    Ok(MemoryCandidateResult {
        id: row.get(0)?,
        category: row.get(1)?,
        content: row.get(2)?,
        content_hash: row.get(3)?,
        confidence: row.get(4)?,
        trust: row.get(5)?,
        status: row.get(6)?,
        risk_flags: row.get(7)?,
        source_session_id: row.get(8)?,
        source_message_ids: row.get(9)?,
        created_at: row.get(10)?,
        decided_at: row.get(11)?,
        rejection_reason: row.get(12)?,
    })
}

/// 双区投影：保留 user zone，覆盖 managed zone（ADR-008）。
/// 无标记的旧文件整体视为 user zone，原样保留。
///
/// 标题（"## User Notes" 等）渲染在标记**之外**：标记之间的内容会被
/// extract_user_zone 原样回读，若标题在标记内，每次投影都会把上次的
/// 标题当作 user 内容再嵌回去，导致 memory.md 无限增长。
#[tauri::command]
pub(crate) fn project_memory_file(
    workspace_path: String,
    managed_zone_markdown: String,
) -> Result<(), String> {
    let (workspace, ..) = project_db_path(&workspace_path)?;
    let memory_path = workspace.join(".CodePapr").join("memory.md");

    let existing = fs::read_to_string(&memory_path).unwrap_or_default();

    const USER_START: &str = "<!-- CodePapr:user-memory:start -->";
    const USER_END: &str = "<!-- CodePapr:user-memory:end -->";
    const MANAGED_START: &str = "<!-- CodePapr:managed-memory:start -->";
    const MANAGED_END: &str = "<!-- CodePapr:managed-memory:end -->";

    // 旧文件无标记时 extract_user_zone 将整体视为 user zone（绝不丢失用户内容）
    let user_zone = extract_user_zone(&existing);

    let managed_zone = managed_zone_markdown.trim();

    let rendered = [
        "# Project Memory",
        "",
        "## User Notes",
        "",
        USER_START,
        &user_zone,
        USER_END,
        "",
        "## Verified Project Knowledge",
        "",
        MANAGED_START,
        managed_zone,
        MANAGED_END,
    ]
    .join("\n");

    let project_dir = workspace.join(".CodePapr");
    fs::create_dir_all(&project_dir)
        .map_err(|err| format!("创建项目目录失败: {err}"))?;
    // 原子写（temp + rename）：直接 fs::write 在崩溃窗口会把 memory.md
    // 截断成半个文件，而截断内容随后又会被当成 user zone 读回。
    let tmp_path = project_dir.join(format!(".memory.md.tmp.{}", std::process::id()));
    fs::write(&tmp_path, rendered).map_err(|err| format!("写入 memory.md 临时文件失败: {err}"))?;
    fs::rename(&tmp_path, &memory_path).map_err(|err| {
        let _ = fs::remove_file(&tmp_path);
        format!("写入 memory.md 失败: {err}")
    })?;
    Ok(())
}

/// 提取 memory.md 的 user zone 内容。绝不丢失用户内容：
/// 1. 双标记齐全 → 取标记之间；
/// 2. user 标记缺失/残缺但 managed 标记存在 → 取 MANAGED_START 之前的部分
///    （否则整个文件连同 managed 内容会被冻进 user zone）；
/// 3. 无任何标记的旧文件 → 整体视为 user zone。
/// 历史 bug 曾把 "## User Notes" 等标题渲染进标记内，每次投影累积一行；
/// 提取时剥离开头的遗留标题行（迁移清理）。
fn extract_user_zone(existing: &str) -> String {
    const USER_START: &str = "<!-- CodePapr:user-memory:start -->";
    const USER_END: &str = "<!-- CodePapr:user-memory:end -->";
    const MANAGED_START: &str = "<!-- CodePapr:managed-memory:start -->";
    let zone = if existing.contains(USER_START) && existing.contains(USER_END) {
        existing
            .split(USER_START)
            .nth(1)
            .and_then(|after| after.split(USER_END).next())
            .unwrap_or("")
            .trim()
            .to_string()
    } else if let Some(pos) = existing.find(MANAGED_START) {
        existing.get(..pos).unwrap_or("").trim().to_string()
    } else {
        existing.trim().to_string()
    };
    let mut zone = zone.as_str();
    loop {
        let mut changed = false;
        for header in ["## User Notes", "## Verified Project Knowledge", "# Project Memory"] {
            if let Some(rest) = zone.strip_prefix(header) {
                zone = rest.trim_start();
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    zone.trim().to_string()
}

/// ADR-008 第4点：用户手编 memory.md 的 user zone 读入 ledger——trust=trusted /
/// source=user-edit / confidence=confirmed，供 Recall 检索命中。确定性 id
/// （"user-zone"）+ 内容哈希幂等：未变化不写；清空则 forgotten。
#[tauri::command]
pub(crate) fn sync_user_zone_to_ledger(workspace_path: String) -> Result<(), String> {
    const USER_ZONE_ENTRY_ID: &str = "user-zone";
    let (workspace, ..) = project_db_path(&workspace_path)?;
    let memory_path = workspace.join(".CodePapr").join("memory.md");
    let existing = fs::read_to_string(&memory_path).unwrap_or_default();
    let user_zone = extract_user_zone(&existing);

    let (conn, ..) = open_project_db(&workspace_path)?;
    if user_zone.is_empty() {
        conn.execute(
            "UPDATE memory_entries
             SET status = 'forgotten', forgotten_reason = 'user-zone-cleared'
             WHERE id = ?1 AND status = 'active'",
            params![USER_ZONE_ENTRY_ID],
        )
        .map_err(|err| format!("清空 user zone 条目失败: {err}"))?;
        return Ok(());
    }

    use sha2::{Digest, Sha256};
    let hash = {
        let mut hasher = Sha256::new();
        hasher.update(user_zone.as_bytes());
        format!("{:x}", hasher.finalize())
    };

    let existing_row: Option<(String, String)> = conn
        .query_row(
            "SELECT content_hash, status FROM memory_entries WHERE id = ?1",
            params![USER_ZONE_ENTRY_ID],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|err| format!("读取 user zone 条目哈希失败: {err}"))?;
    if let Some((existing_hash, status)) = existing_row.as_ref() {
        if existing_hash == &hash {
            if status == "active" {
                return Ok(());
            }
            // 内容未变但状态非 active（曾被清空标记 forgotten，用户又恢复了
            // 相同内容）：重新激活，否则用户记忆永久不可召回。
            conn.execute(
                "UPDATE memory_entries
                 SET status = 'active', forgotten_reason = NULL, verified_at = ?1
                 WHERE id = ?2",
                params![unix_millis()?, USER_ZONE_ENTRY_ID],
            )
            .map_err(|err| format!("恢复 user zone 条目失败: {err}"))?;
            return Ok(());
        }
    }

    let now = unix_millis()?;
    conn.execute(
        "INSERT INTO memory_entries
           (id, category, content, content_hash, confidence, trust, status,
            evidence, created_at, verified_at)
         VALUES (?1, 'user-note', ?2, ?3, 'confirmed', 'trusted', 'active',
                 '{\"source\":\"user-edit\"}', ?4, ?4)
         ON CONFLICT(id) DO UPDATE SET
           content = excluded.content,
           content_hash = excluded.content_hash,
           status = 'active',
           created_at = excluded.created_at,
           verified_at = excluded.verified_at",
        params![USER_ZONE_ENTRY_ID, user_zone, hash, now],
    )
    .map_err(|err| format!("同步 user zone 到 ledger 失败: {err}"))?;
    Ok(())
}

fn sha256_hex(content: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn insert_user_note_if_new(conn: &Connection, content: &str) -> Result<bool, String> {
    let trimmed = content.trim();
    if trimmed.chars().count() < 8 {
        return Ok(false);
    }
    let hash = sha256_hex(trimmed);
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM memory_entries
              WHERE content_hash = ?1 AND status = 'active' LIMIT 1",
            params![hash],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("查询既有手写笔记失败: {err}"))?;
    if existing.is_some() {
        return Ok(false);
    }
    let id = format!("legacy-note-{}", &hash[..16.min(hash.len())]);
    let now = unix_millis()?;
    conn.execute(
        "INSERT INTO memory_entries
           (id, category, content, content_hash, confidence, trust, status,
            evidence, created_at, verified_at)
         VALUES (?1, 'user-note', ?2, ?3, 'confirmed', 'trusted', 'active',
                 '{\"source\":\"user-edit\",\"origin\":\"legacy-memory-md\"}', ?4, ?4)
         ON CONFLICT(id) DO UPDATE SET
           content = excluded.content,
           content_hash = excluded.content_hash,
           status = 'active',
           verified_at = excluded.verified_at",
        params![id, trimmed, hash, now],
    )
    .map_err(|err| format!("写入遗留手写笔记失败: {err}"))?;
    Ok(true)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IngestLegacyMemoryResult {
    pub ingested: u32,
    pub deleted_file: bool,
}

/// 一次性把旧 `.CodePapr/memory.md` 收进 ledger，然后删除文件。
/// User Zone 变成 user-note；若账本为空则整份文件收成一条笔记。
#[tauri::command]
pub(crate) fn ingest_legacy_memory_md(workspace_path: String) -> Result<IngestLegacyMemoryResult, String> {
    let (workspace, ..) = project_db_path(&workspace_path)?;
    let memory_path = workspace.join(".CodePapr").join("memory.md");
    if !memory_path.is_file() {
        return Ok(IngestLegacyMemoryResult {
            ingested: 0,
            deleted_file: false,
        });
    }
    let existing = fs::read_to_string(&memory_path).unwrap_or_default();
    let user_zone = extract_user_zone(&existing);
    let (conn, ..) = open_project_db(&workspace_path)?;
    let active_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memory_entries WHERE status = 'active'",
            [],
            |row| row.get(0),
        )
        .map_err(|err| format!("统计记忆条目失败: {err}"))?;

    let mut ingested = 0u32;
    if !user_zone.trim().is_empty() {
        if insert_user_note_if_new(&conn, &user_zone)? {
            ingested += 1;
        }
    } else if active_count == 0 {
        let stripped = existing
            .replace("<!-- CodePapr:user-memory:start -->", "")
            .replace("<!-- CodePapr:user-memory:end -->", "")
            .replace("<!-- CodePapr:managed-memory:start -->", "")
            .replace("<!-- CodePapr:managed-memory:end -->", "");
        if insert_user_note_if_new(&conn, &stripped)? {
            ingested += 1;
        }
    }

    fs::remove_file(&memory_path).map_err(|err| format!("删除遗留 memory.md 失败: {err}"))?;
    Ok(IngestLegacyMemoryResult {
        ingested,
        deleted_file: true,
    })
}

/// 面板编辑手写笔记（仅 user-note）。
#[tauri::command]
pub(crate) fn update_memory_entry_content(
    workspace_path: String,
    entry_id: String,
    content: String,
) -> Result<(), String> {
    let trimmed = content.trim();
    if trimmed.chars().count() < 8 {
        return Err("笔记太短".to_string());
    }
    if trimmed.chars().count() > 8_000 {
        return Err("笔记超过 8000 字符上限".to_string());
    }
    let (conn, ..) = open_project_db(&workspace_path)?;
    let category: String = conn
        .query_row(
            "SELECT category FROM memory_entries WHERE id = ?1 AND status = 'active'",
            params![entry_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("读取记忆条目失败: {err}"))?
        .ok_or_else(|| "记忆条目不存在或已遗忘".to_string())?;
    if category != "user-note" {
        return Err("只能编辑手写笔记".to_string());
    }
    let hash = sha256_hex(trimmed);
    let affected = conn
        .execute(
            "UPDATE memory_entries
             SET content = ?1, content_hash = ?2, verified_at = ?3
             WHERE id = ?4 AND status = 'active'",
            params![trimmed, hash, unix_millis()?, entry_id],
        )
        .map_err(|err| format!("更新手写笔记失败: {err}"))?;
    if affected == 0 {
        return Err("记忆条目不存在或已遗忘".to_string());
    }
    Ok(())
}

// ── Memory Recall（PR5，ADR-009 B3）────────────────────────────────────
//
// turn-scoped Recall：主线程每用户回合检索一次（LIKE/token + 确定性加权重排，
// v1 不上 FTS5/embedding），Recall Block 只存 memory_recalls 做审计，
// 不进 messages/surface/log（request-only anchored insertion）。

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryRecallInput {
    pub(crate) id: String,
    pub(crate) workspace_id: String,
    pub(crate) session_id: String,
    pub(crate) anchor_message_id: String,
    pub(crate) query_text: String,
    pub(crate) rendered_content: String,
    pub(crate) items_json: String,
    pub(crate) estimated_tokens: i64,
    pub(crate) retrieval_strategy: String,
    pub(crate) retrieval_version: i64,
    pub(crate) created_at: i64,
}

#[tauri::command]
pub(crate) fn save_memory_recall(
    workspace_path: String,
    recall_json: String,
) -> Result<(), String> {
    let input: MemoryRecallInput = serde_json::from_str(&recall_json)
        .map_err(|err| format!("Recall JSON 不合法: {err}"))?;
    let (conn, ..) = open_project_db(&workspace_path)?;
    conn.execute(
        "INSERT INTO memory_recalls
           (id, workspace_id, session_id, anchor_message_id, query_text,
            rendered_content, items_json, estimated_tokens, retrieval_strategy,
            retrieval_version, created_at, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'active')",
        params![
            input.id,
            input.workspace_id,
            input.session_id,
            input.anchor_message_id,
            input.query_text,
            input.rendered_content,
            input.items_json,
            input.estimated_tokens,
            input.retrieval_strategy,
            input.retrieval_version,
            input.created_at,
        ],
    )
    .map_err(|err| format!("保存 Recall 失败: {err}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) fn archive_memory_recall(
    workspace_path: String,
    recall_id: String,
) -> Result<(), String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    let updated = conn
        .execute(
            "UPDATE memory_recalls SET status = 'archived' WHERE id = ?1",
            params![recall_id],
        )
        .map_err(|err| format!("归档 Recall 失败: {err}"))?;
    if updated == 0 {
        return Err(format!("归档 Recall 失败: 未找到 id {recall_id}"));
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryRecallResult {
    pub(crate) id: String,
    pub(crate) workspace_id: String,
    pub(crate) session_id: String,
    pub(crate) anchor_message_id: String,
    pub(crate) query_text: String,
    pub(crate) rendered_content: String,
    pub(crate) items_json: String,
    pub(crate) estimated_tokens: i64,
    pub(crate) retrieval_strategy: String,
    pub(crate) retrieval_version: i64,
    pub(crate) created_at: i64,
    pub(crate) status: String,
}

#[tauri::command]
pub(crate) fn load_latest_memory_recall(
    workspace_path: String,
    session_id: String,
) -> Result<Option<MemoryRecallResult>, String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    let recall = conn
        .query_row(
            "SELECT id, workspace_id, session_id, anchor_message_id, query_text,
                    rendered_content, items_json, estimated_tokens, retrieval_strategy,
                    retrieval_version, created_at, status
             FROM memory_recalls
             WHERE session_id = ?1
             ORDER BY created_at DESC, id DESC LIMIT 1",
            params![session_id],
            |row| {
                Ok(MemoryRecallResult {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    session_id: row.get(2)?,
                    anchor_message_id: row.get(3)?,
                    query_text: row.get(4)?,
                    rendered_content: row.get(5)?,
                    items_json: row.get(6)?,
                    estimated_tokens: row.get(7)?,
                    retrieval_strategy: row.get(8)?,
                    retrieval_version: row.get(9)?,
                    created_at: row.get(10)?,
                    status: row.get(11)?,
                })
            },
        )
        .optional()
        .map_err(|err| format!("读取 Recall 失败: {err}"))?;
    Ok(recall)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecallSearchInput {
    pub(crate) tokens: Vec<String>,
    pub(crate) limit: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecallSearchItem {
    pub(crate) id: String,
    pub(crate) source: String,
    pub(crate) title: String,
    pub(crate) content: String,
    pub(crate) confidence: String,
    pub(crate) trust: String,
    pub(crate) score: i64,
    pub(crate) session_id: Option<String>,
    pub(crate) message_ids: Option<String>,
    pub(crate) verified_at: Option<i64>,
}

fn token_overlap_score(tokens: &[String], text: &str) -> i64 {
    let lower = text.to_lowercase();
    let mut score = 0i64;
    for token in tokens {
        if lower.contains(token.as_str()) {
            score += 2;
        }
    }
    score
}

/// FTS5 runtime probe（ADR-009 第8条）：rusqlite bundled 是否编译了 FTS5。
/// 在内存库探测，避免污染项目库；残表 `_codepapr_fts_probe` 由 v6 迁移清理。
static FTS5_PROBE: OnceLock<bool> = OnceLock::new();

fn fts5_available() -> bool {
    *FTS5_PROBE.get_or_init(|| {
        Connection::open_in_memory()
            .ok()
            .and_then(|mem| {
                mem.execute_batch(
                    "CREATE VIRTUAL TABLE _codepapr_fts_probe USING fts5(x, tokenize='trigram');",
                )
                .ok()
            })
            .is_some()
    })
}

/// 持久化 FTS 表 + 触发器（v6）：搜索路径不再每次 DELETE+INSERT 全量重建。
/// 写入 unicode_lower(content)，与 Rust to_lowercase / 全扫评分同一套大小写折叠。
fn ensure_memory_fts_schema(conn: &Connection) -> Result<(), String> {
    if !fts5_available() {
        return Ok(());
    }
    conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS memory_entries_fts
           USING fts5(id UNINDEXED, content, tokenize='trigram');
         CREATE TRIGGER IF NOT EXISTS memory_entries_fts_ai
           AFTER INSERT ON memory_entries BEGIN
             INSERT INTO memory_entries_fts(id, content)
               SELECT new.id, unicode_lower(new.content) WHERE new.status = 'active';
           END;
         CREATE TRIGGER IF NOT EXISTS memory_entries_fts_ad
           AFTER DELETE ON memory_entries BEGIN
             DELETE FROM memory_entries_fts WHERE id = old.id;
           END;
         CREATE TRIGGER IF NOT EXISTS memory_entries_fts_au
           AFTER UPDATE ON memory_entries BEGIN
             DELETE FROM memory_entries_fts WHERE id = old.id;
             INSERT INTO memory_entries_fts(id, content)
               SELECT new.id, unicode_lower(new.content) WHERE new.status = 'active';
           END;
         DELETE FROM memory_entries_fts;
         INSERT INTO memory_entries_fts(id, content)
           SELECT id, unicode_lower(content) FROM memory_entries WHERE status = 'active';",
    )
    .map_err(|err| format!("初始化 memory FTS 失败: {err}"))
}

/// FTS5 trigram 候选预筛（确定性 scoring 不变）：
/// - 不可用或尚未建表时返回 None，调用方走全量扫描；
/// - 不再每搜索重建 FTS 表（由触发器维持）；
/// - 短 token（<3 字符）用 unicode_lower LIKE 补齐，与全扫 to_lowercase 对齐。
fn ensure_memory_fts_candidates(
    conn: &Connection,
    tokens: &[String],
) -> Option<HashSet<String>> {
    if !fts5_available() {
        return None;
    }
    let fts_exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_entries_fts')",
            [],
            |row| row.get(0),
        )
        .ok()?;
    if !fts_exists {
        return None;
    }
    // trigram 最小 3 字符：全部 token 都短于 3 时 FTS 帮不上忙。
    let long_tokens: Vec<&str> = tokens
        .iter()
        .filter(|t| t.chars().count() >= 3)
        .map(|t| t.as_str())
        .collect();
    if long_tokens.is_empty() {
        return None;
    }

    let query = long_tokens
        .iter()
        .map(|t| format!("\"{}\"", t.replace('"', "")))
        .collect::<Vec<_>>()
        .join(" OR ");
    let mut stmt = conn
        .prepare("SELECT id FROM memory_entries_fts WHERE memory_entries_fts MATCH ?1")
        .ok()?;
    let rows = stmt
        .query_map(params![query], |row| row.get::<_, String>(0))
        .ok()?;
    let mut ids = HashSet::new();
    for row in rows.flatten() {
        ids.insert(row);
    }

    // 短 token 补齐：trigram 索引不到 <3 字符的 token，用 unicode_lower LIKE
    // 精确补齐（与 Rust to_lowercase 同一套折叠，避免 ASCII lower() 漂移）。
    let short_tokens: Vec<&str> = tokens
        .iter()
        .filter(|t| t.chars().count() < 3)
        .map(|t| t.as_str())
        .collect();
    for token in short_tokens {
        let escaped = escape_like_pattern(token);
        let mut like_stmt = conn
            .prepare(
                "SELECT id FROM memory_entries
                 WHERE status = 'active'
                   AND unicode_lower(content) LIKE '%' || ?1 || '%' ESCAPE '\\'",
            )
            .ok()?;
        let like_rows = like_stmt
            .query_map(params![escaped], |row| row.get::<_, String>(0))
            .ok()?;
        for row in like_rows.flatten() {
            ids.insert(row);
        }
    }
    Some(ids)
}

/// LIKE 模式转义：`\`、`%`、`_` 均为 LIKE 元字符，需加反斜杠保持字面匹配
/// （配合 `ESCAPE '\'` 使用）。recall token 允许含 `_`（代码标识符）。
fn escape_like_pattern(token: &str) -> String {
    let mut out = String::with_capacity(token.len() + 4);
    for c in token.chars() {
        if c == '\\' || c == '%' || c == '_' {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Recall 检索（token 子串匹配 + 确定性加权重排，无 embedding）：
/// FTS5 trigram 可用时做候选预筛（ADR-009 第8条 runtime probe），不可用
/// 回退全量 contains 扫描；scoring 语义两者一致。
/// 1. memory_entries（active，verified 优先）；
/// 2. 历史 session checkpoint（messages.extras 里的 contextCheckpoint.summary）。
/// untrusted 条目直接跳过（准入策略已保证 active 里没有，防御性再过滤）。
#[tauri::command]
pub(crate) fn search_memory_for_recall(
    workspace_path: String,
    query_json: String,
) -> Result<Vec<RecallSearchItem>, String> {
    let input: RecallSearchInput = serde_json::from_str(&query_json)
        .map_err(|err| format!("Recall 查询 JSON 不合法: {err}"))?;
    // 与 TS buildRecallQuery 对齐：保留 `_`/`-`（代码标识符如
    // TEST_COMMAND_PATTERN / oauth-callback 否则永远匹配不到），上限同为 12。
    let tokens: Vec<String> = input
        .tokens
        .iter()
        .filter_map(|t| {
            let cleaned: String = t
                .chars()
                .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
                .collect::<String>()
                .to_lowercase();
            if cleaned.is_empty() || cleaned.len() < 2 {
                None
            } else {
                Some(cleaned)
            }
        })
        .take(12)
        .collect();
    let limit = input.limit.unwrap_or(8).clamp(1, 20);

    if tokens.is_empty() {
        return Ok(Vec::new());
    }

    let (conn, ..) = open_project_db(&workspace_path)?;
    let now = unix_millis()?;
    let mut items: Vec<RecallSearchItem> = Vec::new();

    // PR 检索升级（ADR-009 第8条 runtime probe）：FTS5 trigram 可用时用
    // 倒排索引做候选预筛（scoring 仍走确定性 token_overlap，语义不变）；
    // 不可用或全短 token 时回退全量扫描。
    let fts_candidates = ensure_memory_fts_candidates(&conn, &tokens);

    // ── 语料 1：active memory_entries ──
    {
        let mut stmt = conn
            .prepare(
                "SELECT id, category, content, confidence, trust, source_session_id,
                        source_message_ids, verified_at
                 FROM memory_entries
                 WHERE status = 'active'
                 ORDER BY verified_at DESC, created_at DESC
                 LIMIT 500",
            )
            .map_err(|err| format!("准备记忆条目检索失败: {err}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<i64>>(7)?,
                ))
            })
            .map_err(|err| format!("读取记忆条目检索失败: {err}"))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|err| format!("收集记忆条目检索失败: {err}"))?;

        for (id, category, content, confidence, trust, session_id, message_ids, verified_at) in rows {
            // ADR-009 第9条：untrusted 默认不自动召回。准入策略已挡住
            // 主路径；此处硬跳过是防御纵深（评分 -50 仍可被高 overlap 过线）。
            if trust == "untrusted" {
                continue;
            }
            if let Some(candidates) = &fts_candidates {
                if !candidates.contains(&id) {
                    continue;
                }
            }
            let overlap = token_overlap_score(&tokens, &content);
            if overlap == 0 {
                continue;
            }
            let confidence_weight = match confidence.as_str() {
                "confirmed" => 30,
                "reported" => 10,
                _ => -20,
            };
            let trust_weight = match trust.as_str() {
                "trusted" => 10,
                "workspace" => 5,
                "derived" => 0,
                _ => -50,
            };
            let category_weight = match category.as_str() {
                "verification" | "decision" => 8,
                "constraint" | "preference" => 5,
                _ => 0,
            };
            let recency_weight = match verified_at {
                Some(at) if now - at < 30 * 24 * 3600 * 1000 => 10,
                Some(_) => 0,
                None => 0,
            };
            let score = overlap + confidence_weight + trust_weight + category_weight + recency_weight;
            if score <= 0 {
                continue;
            }
            items.push(RecallSearchItem {
                id,
                source: "stable-memory".to_string(),
                title: category,
                content,
                confidence,
                trust,
                score,
                session_id,
                message_ids,
                verified_at,
            });
        }
    }

    // ── 语料 2：历史 session checkpoint（messages.extras JSON） ──
    {
        let mut stmt = conn
            .prepare(
                "SELECT id, session_id, extras, timestamp
                 FROM messages
                 WHERE extras LIKE '%\"contextCheckpoint\"%'
                 ORDER BY timestamp DESC
                 LIMIT 300",
            )
            .map_err(|err| format!("准备 checkpoint 检索失败: {err}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .map_err(|err| format!("读取 checkpoint 检索失败: {err}"))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|err| format!("收集 checkpoint 检索失败: {err}"))?;

        for (message_id, session_id, extras, timestamp) in rows {
            let Some(extras_json) = extras else { continue };
            let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&extras_json) else {
                continue;
            };
            let summary = parsed
                .get("contextCheckpoint")
                .and_then(|cp| cp.get("summary"))
                .and_then(|s| s.as_str())
                .unwrap_or("");
            if summary.is_empty() {
                continue;
            }
            let overlap = token_overlap_score(&tokens, summary);
            if overlap == 0 {
                continue;
            }
            let recency_weight = if now - timestamp < 90 * 24 * 3600 * 1000 {
                5
            } else {
                0
            };
            let score = overlap + 8 + recency_weight;
            items.push(RecallSearchItem {
                id: format!("cp-{message_id}"),
                source: "session-checkpoint".to_string(),
                title: "历史会话结论".to_string(),
                content: summary.chars().take(400).collect(),
                confidence: "reported".to_string(),
                trust: "derived".to_string(),
                score,
                session_id: Some(session_id),
                message_ids: Some(message_id),
                verified_at: None,
            });
        }
    }

    items.sort_by(|a, b| b.score.cmp(&a.score));
    items.truncate(limit);
    Ok(items)
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers::TestWorkspace;
    use rusqlite::params;
    use std::fs;

    #[test]
    fn should_compact_project_state_when_snapshot_shrinks() {
        assert!(should_compact_project_state(Some(200_000), 80_000));
        assert!(should_compact_project_state(Some(90_000), 20_000));
        assert!(!should_compact_project_state(Some(90_000), 80_000));
        assert!(!should_compact_project_state(None, 20_000));
    }

    #[test]
    fn load_project_state_migrates_legacy_json_into_workspace_sqlite() {
        let workspace = TestWorkspace::new("project-state-migrate");
        let project_dir = workspace.file_path(".CodePapr");
        fs::create_dir_all(&project_dir).expect("should create project dir");

        let legacy_state_json = r#"{
    "version": 1,
    "sessions": [
        {
            "id": "session-1",
            "name": "恢复会话",
            "provider": "deepseek",
            "model": "deepseek-v4-pro",
            "createdAt": 1
        }
    ],
    "activeSessionId": "session-1",
    "sessionMessages": {
        "session-1": [
            {
                "id": "message-1",
                "role": "user",
                "content": "旧历史",
                "timestamp": 1
            }
        ]
    },
    "cumulativeStats": {
        "totalCacheRead": 0,
        "totalCacheCreation": 0,
        "totalInput": 0,
        "totalOutput": 0,
        "rounds": 0
    },
    "projectDiagnosticsReport": null,
    "updatedAt": 1
}"#;

        fs::write(workspace.file_path(LEGACY_STATE_FILE), legacy_state_json)
            .expect("should write legacy state file");
        fs::write(workspace.file_path(LEGACY_PROJECT_FILE), b"{}")
            .expect("should write legacy project file");

        let result = load_project_state(workspace.workspace_arg())
            .expect("load should migrate legacy state");

        assert_eq!(result.state_json.as_deref(), Some(legacy_state_json));
        assert!(!workspace.file_path(LEGACY_STATE_FILE).exists());
        assert!(!workspace.file_path(LEGACY_PROJECT_FILE).exists());
        assert!(workspace.file_path(".CodePapr/project.sqlite").exists());

        let conn = Connection::open(workspace.file_path(".CodePapr/project.sqlite"))
            .expect("should open migrated project db");
        let stored: String = conn
            .query_row(
                "SELECT value FROM project_state WHERE key = ?1",
                params![PROJECT_STATE_KEY],
                |row| row.get(0),
            )
            .expect("should persist migrated state");
        assert_eq!(stored, legacy_state_json);
    }

    #[test]
    fn save_project_state_persists_to_workspace_sqlite_and_cleans_legacy_files() {
        let workspace = TestWorkspace::new("project-state-save");
        let project_dir = workspace.file_path(".CodePapr");
        fs::create_dir_all(&project_dir).expect("should create project dir");
        fs::write(workspace.file_path(LEGACY_STATE_FILE), b"{}")
            .expect("should write legacy state placeholder");
        fs::write(workspace.file_path(LEGACY_PROJECT_FILE), b"{}")
            .expect("should write legacy project placeholder");

        let state_json = r#"{
    "version": 1,
    "sessions": [],
    "activeSessionId": null,
    "sessionMessages": {},
    "cumulativeStats": {
        "totalCacheRead": 0,
        "totalCacheCreation": 0,
        "totalInput": 0,
        "totalOutput": 0,
        "rounds": 0
    },
    "projectDiagnosticsReport": null,
    "updatedAt": 1
}"#;

        let saved = save_project_state(
            workspace.workspace_arg(),
            state_json.to_string(),
            Some(false),
        )
        .expect("save should persist project state");
        assert_eq!(saved.state_json.as_deref(), Some(state_json));

        let loaded =
            load_project_state(workspace.workspace_arg()).expect("load should read sqlite state");
        assert_eq!(loaded.state_json.as_deref(), Some(state_json));
        assert!(!workspace.file_path(LEGACY_STATE_FILE).exists());
        assert!(!workspace.file_path(LEGACY_PROJECT_FILE).exists());
        assert!(workspace.file_path(".CodePapr/project.sqlite").exists());
    }

    #[test]
    fn save_project_state_with_purge_removes_deleted_marker_from_db_and_wal() {
        let workspace = TestWorkspace::new("project-state-purge");
        let deleted_marker = "DELETE-ME-MARKER-2c3d3a6f-2e94-4e1f-9a96-4f7cdf40a6b2";
        let first_state_json = format!(
            "{{\n  \"version\": 1,\n  \"sessions\": [{{\n    \"id\": \"session-1\",\n    \"name\": \"恢复会话\",\n    \"provider\": \"deepseek\",\n    \"model\": \"deepseek-v4-pro\",\n    \"createdAt\": 1\n  }}],\n  \"activeSessionId\": \"session-1\",\n  \"sessionMessages\": {{\n    \"session-1\": [{{\n      \"id\": \"message-1\",\n      \"role\": \"user\",\n      \"content\": \"{deleted_marker}\",\n      \"timestamp\": 1\n    }}]\n  }},\n  \"cumulativeStats\": {{\n    \"totalCacheRead\": 0,\n    \"totalCacheCreation\": 0,\n    \"totalInput\": 0,\n    \"totalOutput\": 0,\n    \"rounds\": 0\n  }},\n  \"projectDiagnosticsReport\": null,\n  \"updatedAt\": 1\n}}"
        );
        let second_state_json = "{\n  \"version\": 1,\n  \"sessions\": [],\n  \"activeSessionId\": null,\n  \"sessionMessages\": {},\n  \"cumulativeStats\": {\n    \"totalCacheRead\": 0,\n    \"totalCacheCreation\": 0,\n    \"totalInput\": 0,\n    \"totalOutput\": 0,\n    \"rounds\": 0\n  },\n  \"projectDiagnosticsReport\": null,\n  \"updatedAt\": 2\n}";

        save_project_state(
            workspace.workspace_arg(),
            first_state_json.clone(),
            Some(false),
        )
        .expect("first save should succeed");

        let db_path = workspace.file_path(".CodePapr/project.sqlite");
        let wal_path = workspace.file_path(".CodePapr/project.sqlite-wal");
        let marker_bytes = deleted_marker.as_bytes();

        let db_before = fs::read(&db_path).expect("should read project db before purge");
        let wal_before = fs::read(&wal_path).unwrap_or_default();
        assert!(
            db_before
                .windows(marker_bytes.len())
                .any(|window| window == marker_bytes)
                || wal_before
                    .windows(marker_bytes.len())
                    .any(|window| window == marker_bytes)
        );

        save_project_state(
            workspace.workspace_arg(),
            second_state_json.to_string(),
            Some(true),
        )
        .expect("purge save should succeed");

        let db_after = fs::read(&db_path).expect("should read project db after purge");
        let wal_after = fs::read(&wal_path).unwrap_or_default();

        assert!(!db_after
            .windows(marker_bytes.len())
            .any(|window| window == marker_bytes));
        assert!(!wal_after
            .windows(marker_bytes.len())
            .any(|window| window == marker_bytes));
    }

    #[test]
    fn aggregate_tool_usage_counts_invocations_across_sessions() {
        let workspace = TestWorkspace::new("aggregate-tool-usage");
        let ws = workspace.workspace_arg();

        save_session(
            ws.clone(),
            r#"{"id":"s-1","name":"会话一","provider":"deepseek","model":"m","createdAt":1}"#
                .to_string(),
        )
        .expect("should save session s-1");
        save_session(
            ws.clone(),
            r#"{"id":"s-2","name":"会话二","provider":"deepseek","model":"m","createdAt":2}"#
                .to_string(),
        )
        .expect("should save session s-2");

        let s1_messages = r#"[
            {"id":"m-1","role":"assistant","content":"","timestamp":1,
             "toolInvocations":[{"id":"t-1","name":"read","status":"success"},{"id":"t-2","name":"read","status":"error"}]},
            {"id":"m-2","role":"assistant","content":"","timestamp":2,
             "toolInvocations":[{"id":"t-3","name":"write","status":"success"}]},
            {"id":"m-3","role":"user","content":"no tools here","timestamp":3}
        ]"#;
        let s2_messages = r#"[
            {"id":"m-4","role":"assistant","content":"","timestamp":1,
             "toolInvocations":[{"id":"t-4","name":"read","status":"success"},{"id":"t-5","name":"search","status":"running"}]}
        ]"#;
        save_message_batch(ws.clone(), "s-1".to_string(), s1_messages.to_string())
            .expect("should save s-1 messages");
        save_message_batch(ws.clone(), "s-2".to_string(), s2_messages.to_string())
            .expect("should save s-2 messages");

        let result = aggregate_tool_usage(ws).expect("should aggregate tool usage");
        let usage: Vec<serde_json::Value> =
            serde_json::from_str(&result.usage_json).expect("usage json should parse");

        let find = |name: &str| {
            usage
                .iter()
                .find(|entry| entry["name"] == name)
                .unwrap_or_else(|| panic!("missing entry for {name}"))
                .clone()
        };
        let read = find("read");
        assert_eq!(read["count"], 3);
        assert_eq!(read["success"], 2);
        assert_eq!(read["error"], 1);
        let write = find("write");
        assert_eq!(write["count"], 1);
        assert_eq!(write["success"], 1);
        let search = find("search");
        assert_eq!(search["count"], 1);
        assert_eq!(search["success"], 0);
        assert_eq!(search["error"], 0);
        assert_eq!(usage.len(), 3);
    }

    #[test]
    fn aggregate_session_runtime_pairs_user_messages_with_turn_ends() {
        let workspace = TestWorkspace::new("aggregate-session-runtime");
        let ws = workspace.workspace_arg();

        save_session(
            ws.clone(),
            r#"{"id":"s-1","name":"会话一","provider":"deepseek","model":"m","createdAt":1}"#
                .to_string(),
        )
        .expect("should save session s-1");
        save_session(
            ws.clone(),
            r#"{"id":"s-2","name":"会话二","provider":"deepseek","model":"m","createdAt":2}"#
                .to_string(),
        )
        .expect("should save session s-2");

        // s-1：两个完整回合（1500ms + 200ms）+ 一条应被忽略的 synthetic 消息。
        let s1_messages = r#"[
            {"id":"m-1","role":"user","content":"q1","timestamp":1000},
            {"id":"m-2","role":"assistant","content":"round1","timestamp":1500},
            {"id":"m-3","role":"assistant","content":"final","timestamp":2500},
            {"id":"m-4","role":"assistant","content":"","timestamp":2600,"synthetic":true},
            {"id":"m-5","role":"user","content":"q2","timestamp":3000},
            {"id":"m-6","role":"error","content":"boom","timestamp":3200}
        ]"#;
        // s-2：synthetic user 不开回合；孤立 assistant 无归属；未闭合回合不计。
        let s2_messages = r#"[
            {"id":"m-7","role":"user","content":"","timestamp":100,"synthetic":true},
            {"id":"m-8","role":"assistant","content":"orphan","timestamp":200},
            {"id":"m-9","role":"user","content":"open turn","timestamp":500}
        ]"#;
        save_message_batch(ws.clone(), "s-1".to_string(), s1_messages.to_string())
            .expect("should save s-1 messages");
        save_message_batch(ws.clone(), "s-2".to_string(), s2_messages.to_string())
            .expect("should save s-2 messages");

        let result = aggregate_session_runtime(ws).expect("should aggregate session runtime");
        let runtime: std::collections::BTreeMap<String, i64> =
            serde_json::from_str(&result.runtime_json).expect("runtime json should parse");

        assert_eq!(runtime.get("s-1"), Some(&1700));
        assert!(!runtime.contains_key("s-2"));
    }

    #[test]
    fn papr_storage_crud_roundtrip() {
        let workspace = TestWorkspace::new("papr-storage-crud");
        let ws = workspace.workspace_arg();
        let app_id = "test-app-storage";

        assert!(papr_storage_get(&ws, app_id, "key1").unwrap().is_none());

        papr_storage_set(&ws, app_id, "key1", "value1").unwrap();
        assert_eq!(
            papr_storage_get(&ws, app_id, "key1").unwrap().as_deref(),
            Some("value1")
        );

        // 数据落在 app 自己的 db.sqlite，而不是 project.sqlite
        assert!(workspace
            .file_path(".CodePapr/apps/test-app-storage/db.sqlite")
            .exists());

        papr_storage_set(&ws, app_id, "key1", "updated").unwrap();
        assert_eq!(
            papr_storage_get(&ws, app_id, "key1").unwrap().as_deref(),
            Some("updated")
        );

        papr_storage_set(&ws, app_id, "key2", "v2").unwrap();
        let keys = papr_storage_keys(&ws, app_id).unwrap();
        assert!(keys.contains(&"key1".to_string()));
        assert!(keys.contains(&"key2".to_string()));

        papr_storage_delete(&ws, app_id, "key1").unwrap();
        assert!(papr_storage_get(&ws, app_id, "key1").unwrap().is_none());
        assert_eq!(
            papr_storage_get(&ws, app_id, "key2").unwrap().as_deref(),
            Some("v2")
        );
    }

    #[test]
    fn papr_storage_app_isolation() {
        let workspace = TestWorkspace::new("papr-storage-isolation");
        let ws = workspace.workspace_arg();

        papr_storage_set(&ws, "app-a", "shared", "data-a").unwrap();
        papr_storage_set(&ws, "app-b", "shared", "data-b").unwrap();

        assert_eq!(
            papr_storage_get(&ws, "app-a", "shared").unwrap().as_deref(),
            Some("data-a")
        );
        assert_eq!(
            papr_storage_get(&ws, "app-b", "shared").unwrap().as_deref(),
            Some("data-b")
        );

        // 每个 app 一个独立 db 文件
        assert!(workspace.file_path(".CodePapr/apps/app-a/db.sqlite").exists());
        assert!(workspace.file_path(".CodePapr/apps/app-b/db.sqlite").exists());
    }

    #[test]
    fn papr_storage_rejects_path_shaped_app_ids() {
        let workspace = TestWorkspace::new("papr-storage-badid");
        let ws = workspace.workspace_arg();
        assert!(papr_storage_set(&ws, "../evil", "k", "v").is_err());
        assert!(papr_storage_set(&ws, "a/b", "k", "v").is_err());
        assert!(papr_storage_get(&ws, "..", "k").is_err());
    }

    #[test]
    fn papr_inbox_append_assigns_monotonic_seq() {
        let workspace = TestWorkspace::new("papr-inbox-seq");
        let ws = workspace.workspace_arg();
        let app_id = "inbox-app";

        let (seq1, ts1) =
            papr_inbox_append(&ws, app_id, "cards", r#"{"op":"add"}"#, None).unwrap();
        let (seq2, ts2) =
            papr_inbox_append(&ws, app_id, "cards", r#"{"op":"move"}"#, None).unwrap();
        assert_eq!(seq1, 1);
        assert_eq!(seq2, 2);
        assert!(ts2 >= ts1);

        // 不同频道独立计数
        let (other_seq, _) =
            papr_inbox_append(&ws, app_id, "log", r#"{"level":"ok"}"#, None).unwrap();
        assert_eq!(other_seq, 1);

        // 落库格式：inbox:<channel> → [{seq, ts, payload}]
        let raw = papr_storage_get(&ws, app_id, "inbox:cards")
            .unwrap()
            .expect("inbox key should exist");
        let events: Vec<serde_json::Value> = serde_json::from_str(&raw).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["seq"], 1);
        assert_eq!(events[0]["payload"]["op"], "add");
        assert_eq!(events[1]["seq"], 2);
        assert_eq!(events[1]["payload"]["op"], "move");
    }

    #[test]
    fn papr_inbox_append_trims_to_cap_keeping_newest() {
        let workspace = TestWorkspace::new("papr-inbox-cap");
        let ws = workspace.workspace_arg();
        let app_id = "inbox-cap";

        for index in 1..=5 {
            papr_inbox_append(&ws, app_id, "feed", &format!(r#"{{"n":{index}}}"#), Some(3))
                .unwrap();
        }

        let raw = papr_storage_get(&ws, app_id, "inbox:feed")
            .unwrap()
            .expect("inbox key should exist");
        let events: Vec<serde_json::Value> = serde_json::from_str(&raw).unwrap();
        assert_eq!(events.len(), 3);
        // 保留最新 3 条（n=3,4,5），最旧两条被裁掉，seq 不回绕
        let ns: Vec<i64> = events
            .iter()
            .map(|event| event["payload"]["n"].as_i64().unwrap())
            .collect();
        assert_eq!(ns, vec![3, 4, 5]);
        assert_eq!(events[2]["seq"], 5);
    }

    #[test]
    fn papr_inbox_append_self_heals_corrupt_value() {
        let workspace = TestWorkspace::new("papr-inbox-heal");
        let ws = workspace.workspace_arg();
        let app_id = "inbox-heal";

        // 预置坏数据：非数组 JSON
        papr_storage_set(&ws, app_id, "inbox:cards", r#"{"broken":true}"#).unwrap();
        let (seq, _) = papr_inbox_append(&ws, app_id, "cards", r#"{"ok":1}"#, None).unwrap();
        assert_eq!(seq, 1);

        let raw = papr_storage_get(&ws, app_id, "inbox:cards").unwrap().unwrap();
        let events: Vec<serde_json::Value> = serde_json::from_str(&raw).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["payload"]["ok"], 1);
    }

    #[test]
    fn papr_inbox_append_rejects_bad_channel_or_payload() {
        let workspace = TestWorkspace::new("papr-inbox-bad");
        let ws = workspace.workspace_arg();
        let app_id = "inbox-bad";

        assert!(papr_inbox_append(&ws, app_id, "", r#"{}"#, None).is_err());
        assert!(papr_inbox_append(&ws, app_id, &"x".repeat(65), r#"{}"#, None).is_err());
        assert!(papr_inbox_append(&ws, app_id, "cards", "not json", None).is_err());
    }

    #[test]
    fn papr_inbox_append_concurrent_threads_lose_no_events() {
        let workspace = TestWorkspace::new("papr-inbox-race");
        let ws = workspace.workspace_arg();
        let app_id = "inbox-race";

        // 8 线程 × 25 条并发追加：锁 + IMMEDIATE 事务下不得丢事件、seq 不得重复
        let threads: Vec<std::thread::JoinHandle<Vec<u64>>> = (0..8)
            .map(|thread_index| {
                let ws = ws.clone();
                std::thread::spawn(move || {
                    (0..25)
                        .map(|event_index| {
                            let payload =
                                format!(r#"{{"t":{thread_index},"e":{event_index}}}"#);
                            let (seq, _) =
                                papr_inbox_append(&ws, app_id, "race", &payload, Some(1000))
                                    .expect("concurrent append should succeed");
                            seq
                        })
                        .collect()
                })
            })
            .collect();

        let mut all_seqs: Vec<u64> = threads
            .into_iter()
            .flat_map(|handle| handle.join().expect("thread should not panic"))
            .collect();
        assert_eq!(all_seqs.len(), 200);
        all_seqs.sort_unstable();
        all_seqs.dedup();
        assert_eq!(all_seqs.len(), 200, "seqs must be unique under concurrency");
        assert_eq!(*all_seqs.last().unwrap(), 200);

        let raw = papr_storage_get(&ws, app_id, "inbox:race").unwrap().unwrap();
        let events: Vec<serde_json::Value> = serde_json::from_str(&raw).unwrap();
        assert_eq!(events.len(), 200, "no event may be lost");
    }

    #[test]
    fn papr_storage_v4_migration_moves_rows_into_per_app_files() {
        let workspace = TestWorkspace::new("papr-storage-migrate");
        let ws = workspace.workspace_arg();

        // 模拟旧库：project.sqlite 里有 app_storage 表（v3 schema），两个 app 有数据，
        // 其中一个 app 目录已不存在（孤儿数据应被丢弃）。
        {
            let (conn, ..) = open_project_db(&ws).unwrap();
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS app_storage (
                   app_id TEXT NOT NULL,
                   key TEXT NOT NULL,
                   value TEXT NOT NULL,
                   updated_at INTEGER NOT NULL,
                   PRIMARY KEY (app_id, key)
                 );
                 INSERT INTO app_storage (app_id, key, value, updated_at) VALUES
                   ('live-app', 'k1', 'v1', 100),
                   ('live-app', 'k2', 'v2', 200),
                   ('gone-app', 'k', 'orphan', 300);",
            )
            .unwrap();
            conn.pragma_update(None, "user_version", 3_i64).unwrap();
        }
        std::fs::create_dir_all(workspace.file_path(".CodePapr/apps/live-app")).unwrap();

        // 重新打开触发 v4 迁移（当前最新版本为 v7，v4 迁移后继续升级）
        {
            let (conn, ..) = open_project_db(&ws).unwrap();
            let version: i64 = conn
                .pragma_query_value(None, "user_version", |row| row.get(0))
                .unwrap();
            assert_eq!(version, 7);
            let table_gone: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_storage')",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(!table_gone, "app_storage 表应在迁移后被删除");
        }

        assert_eq!(
            papr_storage_get(&ws, "live-app", "k1").unwrap().as_deref(),
            Some("v1")
        );
        assert_eq!(
            papr_storage_get(&ws, "live-app", "k2").unwrap().as_deref(),
            Some("v2")
        );
        // 孤儿 app 的数据被丢弃，且不会为它创建目录
        assert!(!workspace.file_path(".CodePapr/apps/gone-app").exists());
    }

    // ── recent workspaces（note_recent_workspace）──

    #[test]
    fn merge_recent_workspace_adds_new_entry_at_front() {
        let input = Some(
            r#"{"lang":"zh-CN","recentWorkspaces":[
                {"path":"/old/a","name":"a","lastOpenedAt":1,"pinned":false}
            ]}"#,
        );
        let merged = merge_recent_workspace(input, "/new/b").expect("merge should succeed");
        let value: serde_json::Value = serde_json::from_str(&merged).expect("valid json");
        let recent = value["recentWorkspaces"].as_array().expect("array");

        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0]["path"], "/new/b");
        assert_eq!(recent[0]["name"], "b");
        assert_eq!(recent[0]["pinned"], false);
        assert_eq!(recent[1]["path"], "/old/a");
        // 其他字段原样保留
        assert_eq!(value["lang"], "zh-CN");
    }

    #[test]
    fn merge_recent_workspace_moves_existing_entry_to_front_and_keeps_pinned() {
        let input = Some(
            r#"{"recentWorkspaces":[
                {"path":"/first","name":"first","lastOpenedAt":100,"pinned":false},
                {"path":"/target","name":"target","lastOpenedAt":50,"pinned":true}
            ]}"#,
        );
        let merged = merge_recent_workspace(input, "/target").expect("merge should succeed");
        let value: serde_json::Value = serde_json::from_str(&merged).expect("valid json");
        let recent = value["recentWorkspaces"].as_array().expect("array");

        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0]["path"], "/target");
        assert_eq!(recent[0]["pinned"], true, "pinned 必须保留");
        assert!(recent[0]["lastOpenedAt"].as_i64().unwrap() > 100);
        assert_eq!(recent[1]["path"], "/first");
    }

    #[test]
    fn merge_recent_workspace_dedupes_case_insensitively_on_macos_windows() {
        if !recent_paths_equivalent("/Users/example/x", "/Users/example/x") {
            // Linux：大小写敏感，跳过大小写去重断言
            return;
        }
        let input = Some(
            r#"{"recentWorkspaces":[
                {"path":"/Users/example/x","name":"x","lastOpenedAt":10,"pinned":false}
            ]}"#,
        );
        let merged = merge_recent_workspace(input, "/Users/example/x").expect("merge should succeed");
        let value: serde_json::Value = serde_json::from_str(&merged).expect("valid json");
        let recent = value["recentWorkspaces"].as_array().expect("array");

        assert_eq!(recent.len(), 1, "大小写不同的同一目录应去重");
        assert_eq!(recent[0]["path"], "/Users/example/x");
    }

    #[test]
    fn merge_recent_workspace_truncates_to_ten_entries() {
        let mut entries = Vec::new();
        for i in 0..12 {
            entries.push(format!(
                r#"{{"path":"/p{i}","name":"p{i}","lastOpenedAt":{i},"pinned":false}}"#
            ));
        }
        let input = Some(format!(r#"{{"recentWorkspaces":[{}]}}"#, entries.join(",")));
        let merged = merge_recent_workspace(input.as_deref(), "/new").expect("merge should succeed");
        let value: serde_json::Value = serde_json::from_str(&merged).expect("valid json");
        let recent = value["recentWorkspaces"].as_array().expect("array");

        assert_eq!(recent.len(), 10);
        assert_eq!(recent[0]["path"], "/new");
        assert_eq!(recent[9]["path"], "/p8");
    }

    #[test]
    fn merge_recent_workspace_handles_missing_or_corrupt_settings() {
        // 完全无 settings 行：从空对象起步
        let merged = merge_recent_workspace(None, "/fresh").expect("merge should succeed");
        let value: serde_json::Value = serde_json::from_str(&merged).expect("valid json");
        assert_eq!(value["recentWorkspaces"][0]["path"], "/fresh");

        // 非对象 JSON：报错而不是静默覆盖
        assert!(merge_recent_workspace(Some("42"), "/fresh").is_err());
        // 非 JSON：报错
        assert!(merge_recent_workspace(Some("{{{"), "/fresh").is_err());
    }

    #[test]
    fn note_recent_workspace_impl_persists_entry_immediately() {
        let workspace = TestWorkspace::new("recent-workspace-note");
        let db_path = workspace.file_path("codepapr-test.sqlite");

        note_recent_workspace_impl(&db_path, "/project/alpha")
            .expect("first note should succeed");
        note_recent_workspace_impl(&db_path, "/project/beta")
            .expect("second note should succeed");

        let conn = Connection::open(&db_path).expect("should open temp app db");
        let stored: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![APP_SETTINGS_KEY],
                |row| row.get(0),
            )
            .expect("should persist settings row");
        let value: serde_json::Value = serde_json::from_str(&stored).expect("valid json");
        let recent = value["recentWorkspaces"].as_array().expect("array");

        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0]["path"], "/project/beta", "最新打开的应排在最前");
        assert_eq!(recent[0]["name"], "beta");
        assert_eq!(recent[1]["path"], "/project/alpha");
    }

    #[test]
    fn note_recent_workspace_impl_rejects_empty_path() {
        let workspace = TestWorkspace::new("recent-workspace-empty");
        let db_path = workspace.file_path("codepapr-test.sqlite");
        assert!(note_recent_workspace_impl(&db_path, "   ").is_err());
    }

    #[test]
    fn set_recent_workspaces_replaces_list_and_preserves_other_fields() {
        let workspace = TestWorkspace::new("set-recent-workspaces");
        let db_path = workspace.file_path("codepapr-test.sqlite");

        // 先写入一条 settings 行（含其他字段），再整体替换 recentWorkspaces
        let base = r#"{"lang":"zh-CN","recentWorkspaces":[
            {"path":"/old","name":"old","lastOpenedAt":1,"pinned":false}
        ]}"#;
        note_recent_workspace_impl(&db_path, "/seed").expect("seed note should succeed");
        // 重新构造已知基线
        let conn0 = Connection::open(&db_path).expect("open temp db");
        conn0.execute(
            "INSERT INTO settings (key, value, data_type, updated_at)
             VALUES (?1, ?2, 'json', ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value,
               data_type = excluded.data_type, updated_at = excluded.updated_at",
            params![APP_SETTINGS_KEY, base, unix_millis().unwrap()],
        )
        .expect("seed settings");

        let list = r#"[
            {"path":"/b","name":"b","lastOpenedAt":200,"pinned":true},
            {"path":"/a","name":"a","lastOpenedAt":100,"pinned":false}
        ]"#;
        set_recent_workspaces_impl(&db_path, list).expect("set should succeed");

        let conn = Connection::open(&db_path).expect("open temp db");
        let stored: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![APP_SETTINGS_KEY],
                |row| row.get(0),
            )
            .expect("read settings");
        let value: serde_json::Value = serde_json::from_str(&stored).expect("valid json");
        let recent = value["recentWorkspaces"].as_array().expect("array");
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0]["path"], "/b");
        assert_eq!(recent[0]["pinned"], true);
        assert_eq!(recent[0]["lastOpenedAt"], 200);
        assert_eq!(recent[1]["path"], "/a");
        // 其他字段原样保留
        assert_eq!(value["lang"], "zh-CN");
    }

    #[test]
    fn set_recent_workspaces_normalizes_and_caps_list() {
        let workspace = TestWorkspace::new("set-recent-workspaces-cap");
        let db_path = workspace.file_path("codepapr-test.sqlite");
        note_recent_workspace_impl(&db_path, "/seed").expect("seed");

        // 12 条 + 1 条畸形（无 path）+ 1 条空 path
        let mut entries = Vec::new();
        for i in 0..12 {
            entries.push(format!(
                r#"{{"path":"/p{i}","name":"","lastOpenedAt":{i},"pinned":false}}"#
            ));
        }
        entries.push(r#"{"lastOpenedAt":1,"pinned":false}"#.to_string());
        entries.push(r#"{"path":"   ","lastOpenedAt":1,"pinned":false}"#.to_string());
        let list = format!("[{}]", entries.join(","));

        set_recent_workspaces_impl(&db_path, &list).expect("set should succeed");

        let conn = Connection::open(&db_path).expect("open temp db");
        let stored: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![APP_SETTINGS_KEY],
                |row| row.get(0),
            )
            .expect("read settings");
        let value: serde_json::Value = serde_json::from_str(&stored).expect("valid json");
        let recent = value["recentWorkspaces"].as_array().expect("array");
        assert_eq!(recent.len(), 10, "上限 10 条");
        assert_eq!(recent[0]["path"], "/p0");
        // 空 name 回退为路径末段
        assert_eq!(recent[0]["name"], "p0");
    }

    #[test]
    fn set_recent_workspaces_rejects_invalid_input() {
        let workspace = TestWorkspace::new("set-recent-workspaces-invalid");
        let db_path = workspace.file_path("codepapr-test.sqlite");

        assert!(set_recent_workspaces_impl(&db_path, "{}").is_err(), "非数组应报错");
        assert!(set_recent_workspaces_impl(&db_path, "{{{").is_err(), "非法 JSON 应报错");
    }

    #[test]
    fn extract_and_store_secrets_reports_change_only_when_keys_actually_move() {
        let workspace = TestWorkspace::new("extract-secrets-changed");
        let secrets = AppSecrets::init(&workspace.path).expect("init vault should succeed");

        // 新 key：应报告变更并剥离明文
        let mut value: serde_json::Value =
            serde_json::from_str(r#"{"apiKey":"sk-new","mentorApiKey":""}"#).unwrap();
        assert!(extract_and_store_secrets(&secrets, &mut value));
        assert_eq!(value["apiKey"], "");
        assert_eq!(secrets.get_secret(crate::secrets::PRIMARY_KEY_ACCOUNT).as_deref(), Some("sk-new"));

        // 前端每次保存都会带回已注入的同一 key：值与 vault 一致，不应报告变更
        let mut value2: serde_json::Value =
            serde_json::from_str(r#"{"apiKey":"sk-new","mentorApiKey":""}"#).unwrap();
        assert!(!extract_and_store_secrets(&secrets, &mut value2));
        assert_eq!(value2["apiKey"], "", "明文仍应被剥离");
        assert_eq!(secrets.get_secret(crate::secrets::PRIMARY_KEY_ACCOUNT).as_deref(), Some("sk-new"));

        // 显式清空已存在的 key：应报告变更并删除 vault 密钥
        let mut value3: serde_json::Value =
            serde_json::from_str(r#"{"apiKey":"","mentorApiKey":""}"#).unwrap();
        assert!(extract_and_store_secrets(&secrets, &mut value3));
        assert!(secrets.get_secret(crate::secrets::PRIMARY_KEY_ACCOUNT).is_none());

        // 空 key 且 vault 已无密钥：不是变更，无需写快照
        let mut value4: serde_json::Value =
            serde_json::from_str(r#"{"apiKey":"","mentorApiKey":""}"#).unwrap();
        assert!(!extract_and_store_secrets(&secrets, &mut value4));
    }

    #[test]
    fn wait_for_epoch_returns_when_epoch_advances() {
        let epoch = std::sync::Arc::new(AtomicU64::new(7));
        let epoch_for_thread = epoch.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(60));
            epoch_for_thread.fetch_add(1, Ordering::SeqCst);
        });
        assert!(wait_for_epoch(&epoch, 7, std::time::Duration::from_secs(2)));
    }

    #[test]
    fn wait_for_epoch_times_out_when_epoch_stays_put() {
        let epoch = AtomicU64::new(7);
        assert!(!wait_for_epoch(&epoch, 7, std::time::Duration::from_millis(40)));
    }

    /// PR5：memory recall 检索（stable-memory 语料）+ 审计记录 round-trip。
    #[test]
    fn memory_recall_search_and_audit_roundtrip() {
        let workspace = TestWorkspace::new("memory-recall-search");
        fs::create_dir_all(workspace.file_path(".CodePapr")).expect("create project dir");
        let ws = workspace.workspace_arg();

        // 准入一条 verified entry（候选 → entry）
        let candidate = serde_json::json!({
            "id": "cand-1",
            "category": "verification",
            "content": "[bash] ✓ pnpm test auth",
            "contentHash": "h1",
            "confidence": "confirmed",
            "trust": "workspace",
            "sourceSessionId": "s1",
            "sourceMessageIds": "[\"m1\"]",
            "evidence": "{\"origin\":\"bash:pnpm test auth\"}",
            "riskFlags": null,
            "createdAt": 1i64,
        });
        save_memory_candidate(ws.clone(), candidate.to_string()).expect("save candidate");
        admit_memory_candidate(ws.clone(), "cand-1".to_string(), "entry-1".to_string())
            .expect("admit");

        // 相关检索命中 stable-memory 且得分 > 0
        let query = serde_json::json!({ "tokens": ["pnpm", "test", "auth"], "limit": 8 });
        let items =
            search_memory_for_recall(ws.clone(), query.to_string()).expect("search");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].source, "stable-memory");
        assert_eq!(items[0].confidence, "confirmed");
        assert!(items[0].score > 0);

        // 不相关查询返回空
        let query2 = serde_json::json!({ "tokens": ["zzzz", "qqqq"], "limit": 8 });
        let items2 =
            search_memory_for_recall(ws.clone(), query2.to_string()).expect("search2");
        assert!(items2.is_empty());

        // 审计记录 round-trip：保存 → 归档 → 最新状态
        let recall = serde_json::json!({
            "id": "recall-1",
            "workspaceId": ws,
            "sessionId": "s1",
            "anchorMessageId": "u1",
            "queryText": "pnpm test auth",
            "renderedContent": "- [verified] pnpm test auth",
            "itemsJson": serde_json::to_string(&items).unwrap(),
            "estimatedTokens": 120i64,
            "retrievalStrategy": "like-token-v1",
            "retrievalVersion": 1i64,
            "createdAt": 2i64,
        });
        save_memory_recall(ws.clone(), recall.to_string()).expect("save recall");
        archive_memory_recall(ws.clone(), "recall-1".to_string()).expect("archive recall");
        let latest = load_latest_memory_recall(ws.clone(), "s1".to_string()).expect("load");
        assert_eq!(latest.as_ref().map(|r| r.status.as_str()), Some("archived"));
        assert_eq!(latest.as_ref().map(|r| r.anchor_message_id.as_str()), Some("u1"));
    }

    /// 回归：代码标识符（含 `_`/`-`）必须可召回——token 清洗不得剥离
    /// 下划线/连字符，LIKE 通配符须转义（与 TS buildRecallQuery 对齐）。
    #[test]
    fn memory_recall_matches_underscore_and_hyphen_identifiers() {
        let workspace = TestWorkspace::new("memory-recall-identifiers");
        fs::create_dir_all(workspace.file_path(".CodePapr")).expect("create project dir");
        let ws = workspace.workspace_arg();

        let candidate = serde_json::json!({
            "id": "cand-id",
            "category": "verification",
            "content": "[bash] ✓ TEST_COMMAND_PATTERN 与 oauth-callback 需在配置中注册",
            "contentHash": "h-id",
            "confidence": "confirmed",
            "trust": "workspace",
            "sourceSessionId": "s1",
            "sourceMessageIds": "[]",
            "evidence": null,
            "riskFlags": null,
            "createdAt": 1i64,
        });
        save_memory_candidate(ws.clone(), candidate.to_string()).expect("save");
        admit_memory_candidate(ws.clone(), "cand-id".to_string(), "entry-id".to_string())
            .expect("admit");

        // 下划线标识符（原实现剥离 `_` 后永不匹配）
        let q1 = serde_json::json!({ "tokens": ["test_command_pattern"], "limit": 8 });
        let items1 = search_memory_for_recall(ws.clone(), q1.to_string()).expect("search _");
        assert_eq!(items1.len(), 1);
        assert_eq!(items1[0].id, "entry-id");

        // 连字符标识符
        let q2 = serde_json::json!({ "tokens": ["oauth-callback"], "limit": 8 });
        let items2 = search_memory_for_recall(ws.clone(), q2.to_string()).expect("search -");
        assert_eq!(items2.len(), 1);
        assert_eq!(items2[0].id, "entry-id");
    }

    /// 检索升级（ADR-009 第8条 runtime probe）：FTS5 trigram 候选预筛 +
    /// 短 token LIKE 补齐；确定性 scoring 语义与全量扫描一致。
    #[test]
    fn memory_recall_fts_candidates_cjk_and_short_tokens() {
        let workspace = TestWorkspace::new("memory-recall-fts");
        fs::create_dir_all(workspace.file_path(".CodePapr")).expect("create project dir");
        let ws = workspace.workspace_arg();

        let c_cjk = serde_json::json!({
            "id": "c-cjk", "category": "decision",
            "content": "身份认证模块已迁移到新网关",
            "contentHash": "hcjk", "confidence": "confirmed", "trust": "workspace",
            "sourceSessionId": "s1", "sourceMessageIds": "[]",
            "evidence": null, "riskFlags": null, "createdAt": 1i64,
        });
        save_memory_candidate(ws.clone(), c_cjk.to_string()).expect("save cjk");
        admit_memory_candidate(ws.clone(), "c-cjk".to_string(), "e-cjk".to_string())
            .expect("admit cjk");

        let c_ui = serde_json::json!({
            "id": "c-ui", "category": "general",
            "content": "UI 组件库统一用 shadcn",
            "contentHash": "hcui", "confidence": "reported", "trust": "derived",
            "sourceSessionId": "s1", "sourceMessageIds": "[]",
            "evidence": null, "riskFlags": null, "createdAt": 2i64,
        });
        save_memory_candidate(ws.clone(), c_ui.to_string()).expect("save ui");
        admit_memory_candidate(ws.clone(), "c-ui".to_string(), "e-ui".to_string())
            .expect("admit ui");

        // 1. CJK 短语子串（trigram 预筛路径）
        let q1 = serde_json::json!({ "tokens": ["认证模块"], "limit": 8 });
        let items1 = search_memory_for_recall(ws.clone(), q1.to_string()).expect("search cjk");
        assert_eq!(items1.len(), 1);
        assert_eq!(items1[0].id, "e-cjk");

        // 2. 长 token + 短 token 混合：短 token 补齐不丢候选
        let q2 = serde_json::json!({ "tokens": ["shadcn", "ui"], "limit": 8 });
        let items2 = search_memory_for_recall(ws.clone(), q2.to_string()).expect("search mixed");
        assert_eq!(items2.len(), 1);
        assert_eq!(items2[0].id, "e-ui");
    }

    /// ADR-008：memory_forget 软删除——active → forgotten，退出投影与召回。
    #[test]
    fn forget_memory_entry_soft_deletes_active_entry() {
        let workspace = TestWorkspace::new("memory-forget");
        fs::create_dir_all(workspace.file_path(".CodePapr")).expect("create project dir");
        let ws = workspace.workspace_arg();

        let candidate = serde_json::json!({
            "id": "cand-f1",
            "category": "general",
            "content": "过时的项目事实",
            "contentHash": "hf",
            "confidence": "reported",
            "trust": "derived",
            "sourceSessionId": "s1",
            "sourceMessageIds": "[]",
            "evidence": null,
            "riskFlags": null,
            "createdAt": 1i64,
        });
        save_memory_candidate(ws.clone(), candidate.to_string()).expect("save candidate");
        admit_memory_candidate(ws.clone(), "cand-f1".to_string(), "entry-f1".to_string())
            .expect("admit");

        // 遗忘：active → forgotten，理由落 forgotten_reason
        forget_memory_entry(ws.clone(), "entry-f1".to_string(), Some("过时".to_string()))
            .expect("forget");
        let entries = load_memory_entries(ws.clone(), Some(false)).expect("load all");
        let entry = entries.iter().find(|e| e.id == "entry-f1").expect("entry exists");
        assert_eq!(entry.status, "forgotten");

        // 不再参与 active 投影 / 召回
        let active = load_memory_entries(ws.clone(), Some(true)).expect("load active");
        assert!(!active.iter().any(|e| e.id == "entry-f1"));

        // 二次遗忘（非 active）报错，不静默成功
        assert!(forget_memory_entry(ws.clone(), "entry-f1".to_string(), None).is_err());
    }

    /// ADR-008 第4点：user zone 读入 ledger——trusted/user-edit/confirmed，
    /// 哈希幂等；清空则 forgotten。
    #[test]
    fn sync_user_zone_to_ledger_roundtrip() {
        let workspace = TestWorkspace::new("memory-user-zone-sync");
        fs::create_dir_all(workspace.file_path(".CodePapr")).expect("create project dir");
        let ws = workspace.workspace_arg();
        let memory_path = workspace.file_path(".CodePapr/memory.md");

        // 1. 旧文件无标记：整体视为 user zone
        fs::write(&memory_path, "# Project Memory\n\n用户手写的偏好：使用 pnpm").unwrap();
        sync_user_zone_to_ledger(ws.clone()).expect("sync legacy");
        let entries = load_memory_entries(ws.clone(), Some(true)).expect("load");
        let entry = entries.iter().find(|e| e.id == "user-zone").expect("entry");
        assert_eq!(entry.category, "user-note");
        assert_eq!(entry.confidence, "confirmed");
        assert_eq!(entry.trust, "trusted");
        assert!(entry.content.contains("用户手写的偏好"));

        // 2. 未变化：同步幂等（content_hash 不变，不报错）
        sync_user_zone_to_ledger(ws.clone()).expect("sync unchanged");

        // 3. 变化：内容更新
        fs::write(&memory_path, "# Project Memory\n\n用户手写的偏好：改用 bun").unwrap();
        sync_user_zone_to_ledger(ws.clone()).expect("sync changed");
        let entries2 = load_memory_entries(ws.clone(), Some(true)).expect("load2");
        let entry2 = entries2.iter().find(|e| e.id == "user-zone").expect("entry2");
        assert!(entry2.content.contains("bun"));

        // 4. 投影后的标记文件：只提取 user zone（managed zone 内容不混入）；
        //    历史 bug 遗留在标记内的 "## User Notes" 标题行必须被剥离，
        //    不得作为用户内容进入 ledger。
        let marked = "# Project Memory\n\n## User Notes\n\n<!-- CodePapr:user-memory:start -->\n## User Notes\n\n## User Notes\n\n用户手写的偏好：只用中文注释\n<!-- CodePapr:user-memory:end -->\n\n## Verified Project Knowledge\n\n<!-- CodePapr:managed-memory:start -->\n- [verified] pnpm test 通过\n<!-- CodePapr:managed-memory:end -->\n";
        fs::write(&memory_path, marked).unwrap();
        sync_user_zone_to_ledger(ws.clone()).expect("sync marked");
        let entries3 = load_memory_entries(ws.clone(), Some(true)).expect("load3");
        let entry3 = entries3.iter().find(|e| e.id == "user-zone").expect("entry3");
        assert!(entry3.content.contains("中文注释"));
        assert!(!entry3.content.contains("pnpm test 通过"));
        assert!(!entry3.content.contains("## User Notes"));

        // 5. user zone 清空 → forgotten
        fs::write(
            &memory_path,
            "<!-- CodePapr:user-memory:start -->\n<!-- CodePapr:user-memory:end -->\n",
        )
        .unwrap();
        sync_user_zone_to_ledger(ws.clone()).expect("sync cleared");
        let active = load_memory_entries(ws.clone(), Some(true)).expect("load active");
        assert!(!active.iter().any(|e| e.id == "user-zone"));
    }

    /// 手写笔记（含遗留 user-zone id）可由面板遗忘；清空后恢复相同内容仍可重新激活。
    #[test]
    fn user_zone_entry_forgettable_from_panel_and_restorable() {
        let workspace = TestWorkspace::new("memory-user-zone-protect");
        fs::create_dir_all(workspace.file_path(".CodePapr")).expect("create project dir");
        let ws = workspace.workspace_arg();
        let memory_path = workspace.file_path(".CodePapr/memory.md");

        fs::write(&memory_path, "用户的手写记忆").unwrap();
        sync_user_zone_to_ledger(ws.clone()).expect("sync");
        forget_memory_entry(ws.clone(), "user-zone".to_string(), None)
            .expect("panel may forget handwritten notes");

        fs::write(
            &memory_path,
            "<!-- CodePapr:user-memory:start -->\n<!-- CodePapr:user-memory:end -->\n",
        )
        .unwrap();
        sync_user_zone_to_ledger(ws.clone()).expect("clear");
        let active = load_memory_entries(ws.clone(), Some(true)).expect("load active");
        assert!(!active.iter().any(|e| e.id == "user-zone"));

        fs::write(&memory_path, "用户的手写记忆").unwrap();
        sync_user_zone_to_ledger(ws.clone()).expect("restore same content");
        let active2 = load_memory_entries(ws.clone(), Some(true)).expect("load active 2");
        let entry = active2.iter().find(|e| e.id == "user-zone").expect("restored");
        assert_eq!(entry.status, "active");
        assert!(entry.content.contains("用户的手写记忆"));
    }

    /// 遗留 memory.md：User Zone 收成 user-note，然后删除文件；无文件时幂等。
    #[test]
    fn ingest_legacy_memory_md_imports_user_zone_and_deletes_file() {
        let workspace = TestWorkspace::new("memory-ingest-legacy");
        fs::create_dir_all(workspace.file_path(".CodePapr")).expect("create project dir");
        let ws = workspace.workspace_arg();
        let memory_path = workspace.file_path(".CodePapr/memory.md");
        fs::write(
            &memory_path,
            "# Project Memory\n\n<!-- CodePapr:user-memory:start -->\n用户手写的偏好必须用 pnpm\n<!-- CodePapr:user-memory:end -->\n\n<!-- CodePapr:managed-memory:start -->\n- [verified] fact A\n<!-- CodePapr:managed-memory:end -->\n",
        )
        .unwrap();

        let result = ingest_legacy_memory_md(ws.clone()).expect("ingest");
        assert_eq!(result.ingested, 1);
        assert!(result.deleted_file);
        assert!(!memory_path.exists());

        let entries = load_memory_entries(ws.clone(), Some(true)).expect("load");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].category, "user-note");
        assert!(entries[0].content.contains("pnpm"));

        let again = ingest_legacy_memory_md(ws.clone()).expect("ingest again");
        assert_eq!(again.ingested, 0);
        assert!(!again.deleted_file);
    }

    /// 回归：投影不得在 user zone 累积 "## User Notes" 标题（标题渲染在
    /// 标记外；遗留在标记内的旧标题提取时剥离）。
    #[test]
    fn project_memory_file_keeps_user_zone_and_single_header() {
        let workspace = TestWorkspace::new("memory-project-header");
        fs::create_dir_all(workspace.file_path(".CodePapr")).expect("create project dir");
        let ws = workspace.workspace_arg();
        let memory_path = workspace.file_path(".CodePapr/memory.md");

        // 1. 首次投影（空 user zone）：恰好一个标题
        project_memory_file(ws.clone(), "- [verified] fact A".to_string())
            .expect("project 1");
        let first = fs::read_to_string(&memory_path).unwrap();
        assert_eq!(first.matches("## User Notes").count(), 1);
        assert!(first.contains("- [verified] fact A"));

        // 2. 用户手编 user zone 后再次投影：内容保留、标题不累积
        let with_note = first.replace(
            "<!-- CodePapr:user-memory:start -->\n\n<!-- CodePapr:user-memory:end -->",
            "<!-- CodePapr:user-memory:start -->\nmy note\n<!-- CodePapr:user-memory:end -->",
        );
        assert_ne!(with_note, first, "user zone marker replacement must apply");
        fs::write(&memory_path, with_note).unwrap();
        project_memory_file(ws.clone(), "- [verified] fact B".to_string())
            .expect("project 2");
        let second = fs::read_to_string(&memory_path).unwrap();
        assert_eq!(second.matches("## User Notes").count(), 1);
        assert!(second.contains("my note"));
        assert!(second.contains("- [verified] fact B"));

        // 3. 历史 bug 文件（标记内已累积多行标题）：一次投影即清理干净
        let legacy = "# Project Memory\n\n<!-- CodePapr:user-memory:start -->\n## User Notes\n\n## User Notes\n\nreal content\n<!-- CodePapr:user-memory:end -->\n\n<!-- CodePapr:managed-memory:start -->\nold\n<!-- CodePapr:managed-memory:end -->\n";
        fs::write(&memory_path, legacy).unwrap();
        project_memory_file(ws.clone(), "- [verified] fact C".to_string())
            .expect("project 3");
        let third = fs::read_to_string(&memory_path).unwrap();
        assert_eq!(third.matches("## User Notes").count(), 1);
        assert!(third.contains("real content"));
    }

    /// 回归：候选按 content_hash 去重——同内容候选已存在（无论状态）时
    /// 静默跳过，回合后全量重扫不得重复入队。
    #[test]
    fn save_memory_candidate_dedups_by_content_hash() {
        let workspace = TestWorkspace::new("memory-candidate-dedup");
        fs::create_dir_all(workspace.file_path(".CodePapr")).expect("create project dir");
        let ws = workspace.workspace_arg();

        let candidate = |id: &str| {
            serde_json::json!({
                "id": id,
                "category": "verification",
                "content": "[bash] ✓ pnpm test",
                "contentHash": "h-dedup",
                "confidence": "confirmed",
                "trust": "workspace",
                "sourceSessionId": "s1",
                "sourceMessageIds": "[]",
                "evidence": null,
                "riskFlags": null,
                "createdAt": 1i64,
            })
        };

        assert_eq!(
            save_memory_candidate(ws.clone(), candidate("c1").to_string()).expect("save 1"),
            true
        );
        // 同 hash 第二次保存（新 id）→ 跳过
        assert_eq!(
            save_memory_candidate(ws.clone(), candidate("c2").to_string()).expect("save 2"),
            false
        );

        // 准入后同 hash 依然去重（不再重复入队/准入）
        admit_memory_candidate(ws.clone(), "c1".to_string(), "e1".to_string()).expect("admit");
        assert_eq!(
            save_memory_candidate(ws.clone(), candidate("c3").to_string()).expect("save 3"),
            false
        );

        // 被拒绝后同 hash 同样去重（不得每回合重新提议）
        let rejected = serde_json::json!({
            "id": "c4",
            "category": "general",
            "content": "被拒绝的内容",
            "contentHash": "h-rejected",
            "confidence": "reported",
            "trust": "derived",
            "sourceSessionId": "s1",
            "sourceMessageIds": "[]",
            "evidence": null,
            "riskFlags": null,
            "createdAt": 2i64,
        });
        assert_eq!(
            save_memory_candidate(ws.clone(), rejected.to_string()).expect("save 4"),
            true
        );
        reject_memory_candidate(ws.clone(), "c4".to_string(), Some("no".to_string()))
            .expect("reject");
        let mut repost = rejected.clone();
        repost["id"] = serde_json::json!("c5");
        assert_eq!(
            save_memory_candidate(ws.clone(), repost.to_string()).expect("save 5"),
            false
        );

        // 候选表只有一条 h-dedup 记录（无重复行）
        let candidates = load_memory_candidates(ws.clone(), None).expect("load candidates");
        assert_eq!(
            candidates.iter().filter(|c| c.content_hash == "h-dedup").count(),
            1
        );
    }

    /// 回归：forgotten 条目不得随重新准入复活；同 hash active 条目幂等准入。
    #[test]
    fn admit_memory_candidate_respects_forgotten_and_idempotent_active() {
        let workspace = TestWorkspace::new("memory-admit-guard");
        fs::create_dir_all(workspace.file_path(".CodePapr")).expect("create project dir");
        let ws = workspace.workspace_arg();
        let memory_path = workspace.file_path(".CodePapr/memory.md");

        let candidate = |id: &str, hash: &str, content: &str| {
            serde_json::json!({
                "id": id,
                "category": "verification",
                "content": content,
                "contentHash": hash,
                "confidence": "confirmed",
                "trust": "workspace",
                "sourceSessionId": "s1",
                "sourceMessageIds": "[]",
                "evidence": null,
                "riskFlags": null,
                "createdAt": 1i64,
            })
        };

        // 1. 准入 → 遗忘后，同 hash 候选在 save 层即被去重（第一道防线：
        //    遗忘内容不再重新入队提议）。
        save_memory_candidate(ws.clone(), candidate("c1", "h-f", "过时事实").to_string())
            .expect("save c1");
        admit_memory_candidate(ws.clone(), "c1".to_string(), "e1".to_string()).expect("admit c1");
        forget_memory_entry(ws.clone(), "e1".to_string(), None).expect("forget");
        assert_eq!(
            save_memory_candidate(ws.clone(), candidate("c2", "h-f", "过时事实").to_string())
                .expect("save c2"),
            false
        );
        let active = load_memory_entries(ws.clone(), Some(true)).expect("load active");
        assert!(!active.iter().any(|e| e.content_hash == "h-f"));

        // 2. admit 层的遗忘守卫（无候选行的遗留条目，如 user-zone）：
        //    user zone 内容 → entry → 清空 zone（用户管理路径）→ 同内容候选
        //    准入必须被拒绝，候选标记 rejected。
        fs::write(&memory_path, "用户写过后又作废的内容").unwrap();
        sync_user_zone_to_ledger(ws.clone()).expect("sync user zone");
        fs::write(
            &memory_path,
            "<!-- CodePapr:user-memory:start -->\n<!-- CodePapr:user-memory:end -->\n",
        )
        .unwrap();
        sync_user_zone_to_ledger(ws.clone()).expect("clear user zone");
        use sha2::{Digest, Sha256};
        let zone_hash = {
            let mut hasher = Sha256::new();
            hasher.update("用户写过后又作废的内容".as_bytes());
            format!("{:x}", hasher.finalize())
        };
        save_memory_candidate(
            ws.clone(),
            candidate("c3", &zone_hash, "用户写过后又作废的内容").to_string(),
        )
        .expect("save c3");
        let err = admit_memory_candidate(ws.clone(), "c3".to_string(), "e3".to_string())
            .expect_err("admit forgotten content must fail");
        assert!(err.contains("遗忘"));
        let rejected = load_memory_candidates(ws.clone(), Some("rejected".to_string()))
            .expect("load rejected");
        assert!(rejected.iter().any(|c| c.id == "c3"));

        // 3. 同 hash active 条目：幂等准入——返回既有 entry id，不新建条目。
        //    （无候选行的遗留条目场景：user zone 已生成 active entry，
        //    agent 又对同内容建候选。）
        fs::write(&memory_path, "稳定的项目事实").unwrap();
        sync_user_zone_to_ledger(ws.clone()).expect("sync user zone 2");
        let zone_hash2 = {
            let mut hasher = Sha256::new();
            hasher.update("稳定的项目事实".as_bytes());
            format!("{:x}", hasher.finalize())
        };
        save_memory_candidate(ws.clone(), candidate("c4", &zone_hash2, "稳定的项目事实").to_string())
            .expect("save c4");
        let existing = admit_memory_candidate(ws.clone(), "c4".to_string(), "e4".to_string())
            .expect("idempotent admit");
        assert_eq!(existing, "user-zone");
        let entries = load_memory_entries(ws.clone(), Some(false)).expect("load all");
        assert_eq!(
            entries.iter().filter(|e| e.content_hash == zone_hash2).count(),
            1
        );
        // 候选被标记 admitted（审计闭环）
        let admitted = load_memory_candidates(ws.clone(), Some("admitted".to_string()))
            .expect("load admitted");
        assert!(admitted.iter().any(|c| c.id == "c4"));
    }

    /// 回归：候选溯源字段（sourceMessageIds/evidence/riskFlags）按 Rust serde
    /// 契约落库并随准入进入 entry（字段名不匹配曾被静默丢弃）。
    #[test]
    fn memory_candidate_provenance_roundtrip() {
        let workspace = TestWorkspace::new("memory-provenance");
        fs::create_dir_all(workspace.file_path(".CodePapr")).expect("create project dir");
        let ws = workspace.workspace_arg();

        let candidate = serde_json::json!({
            "id": "cand-p",
            "category": "verification",
            "content": "[bash] ✓ pnpm test auth",
            "contentHash": "h-prov",
            "confidence": "confirmed",
            "trust": "workspace",
            "sourceSessionId": "s1",
            "sourceMessageIds": "[\"m1\",\"m2\"]",
            "evidence": "{\"origin\":\"bash:pnpm test auth\"}",
            "riskFlags": "[]",
            "createdAt": 1i64,
        });
        save_memory_candidate(ws.clone(), candidate.to_string()).expect("save");

        let candidates = load_memory_candidates(ws.clone(), Some("pending".to_string()))
            .expect("load candidates");
        let loaded = candidates.iter().find(|c| c.id == "cand-p").expect("candidate");
        assert_eq!(loaded.source_message_ids.as_deref(), Some("[\"m1\",\"m2\"]"));
        assert_eq!(loaded.risk_flags.as_deref(), Some("[]"));

        admit_memory_candidate(ws.clone(), "cand-p".to_string(), "entry-p".to_string())
            .expect("admit");
        let entries = load_memory_entries(ws.clone(), Some(true)).expect("load entries");
        let entry = entries.iter().find(|e| e.id == "entry-p").expect("entry");
        assert_eq!(entry.source_message_ids.as_deref(), Some("[\"m1\",\"m2\"]"));
        assert_eq!(
            entry.evidence.as_deref(),
            Some("{\"origin\":\"bash:pnpm test auth\"}")
        );
    }

    #[test]
    fn search_memory_for_recall_skips_untrusted_even_with_high_overlap() {
        let workspace = TestWorkspace::new("memory-recall-untrusted");
        fs::create_dir_all(workspace.file_path(".CodePapr")).expect("create project dir");
        let ws = workspace.workspace_arg();

        {
            let (conn, ..) = open_project_db(&ws).unwrap();
            conn.execute(
                "INSERT INTO memory_entries
                   (id, category, content, content_hash, confidence, trust, status,
                    created_at, verified_at)
                 VALUES ('untrusted-1', 'verification', 'pnpm test auth oauth callback',
                         'h-u', 'confirmed', 'untrusted', 'active', 1, 1)",
                [],
            )
            .unwrap();
        }

        let query = serde_json::json!({ "tokens": ["pnpm", "test", "auth", "oauth", "callback"], "limit": 8 });
        let items = search_memory_for_recall(ws, query.to_string()).expect("search");
        assert!(
            items.iter().all(|item| item.trust != "untrusted"),
            "untrusted entries must not be recalled"
        );
        assert!(items.is_empty());
    }

    #[test]
    fn reject_memory_candidate_errors_when_missing_or_already_decided() {
        let workspace = TestWorkspace::new("memory-reject-missing");
        fs::create_dir_all(workspace.file_path(".CodePapr")).expect("create project dir");
        let ws = workspace.workspace_arg();

        let candidate = serde_json::json!({
            "id": "c-rej",
            "category": "general",
            "content": "待拒绝",
            "contentHash": "h-rej",
            "confidence": "reported",
            "trust": "derived",
            "sourceSessionId": "s1",
            "sourceMessageIds": "[]",
            "evidence": null,
            "riskFlags": null,
            "createdAt": 1i64,
        });
        save_memory_candidate(ws.clone(), candidate.to_string()).expect("save");
        reject_memory_candidate(ws.clone(), "c-rej".to_string(), Some("no".to_string()))
            .expect("first reject");
        let err = reject_memory_candidate(ws.clone(), "c-rej".to_string(), None)
            .expect_err("already rejected");
        assert!(err.contains("不存在或已处理"), "got: {err}");
        let missing = reject_memory_candidate(ws, "no-such".to_string(), None)
            .expect_err("missing id");
        assert!(missing.contains("不存在或已处理"), "got: {missing}");
    }

    #[test]
    fn save_memory_candidate_id_conflict_resets_decision_fields() {
        let workspace = TestWorkspace::new("memory-id-conflict");
        fs::create_dir_all(workspace.file_path(".CodePapr")).expect("create project dir");
        let ws = workspace.workspace_arg();

        let first = serde_json::json!({
            "id": "same-id",
            "category": "general",
            "content": "旧内容",
            "contentHash": "h-old",
            "confidence": "reported",
            "trust": "derived",
            "sourceSessionId": "s1",
            "sourceMessageIds": "[]",
            "evidence": null,
            "riskFlags": null,
            "createdAt": 1i64,
        });
        save_memory_candidate(ws.clone(), first.to_string()).expect("save first");
        reject_memory_candidate(ws.clone(), "same-id".to_string(), Some("stale".to_string()))
            .expect("reject");

        let second = serde_json::json!({
            "id": "same-id",
            "category": "fact",
            "content": "新内容不同哈希",
            "contentHash": "h-new",
            "confidence": "reported",
            "trust": "derived",
            "sourceSessionId": "s1",
            "sourceMessageIds": "[]",
            "evidence": null,
            "riskFlags": null,
            "createdAt": 2i64,
        });
        assert!(
            save_memory_candidate(ws.clone(), second.to_string()).expect("save collision"),
            "id collision with different hash must insert/update"
        );
        let candidates = load_memory_candidates(ws, Some("pending".to_string())).expect("load");
        let loaded = candidates.iter().find(|c| c.id == "same-id").expect("row");
        assert_eq!(loaded.status, "pending");
        assert_eq!(loaded.content, "新内容不同哈希");
        assert!(loaded.decided_at.is_none());
        assert!(loaded.rejection_reason.is_none());
    }

    fn compaction_commit_json(id: &str, session_id: &str, source: i64, target: i64) -> String {
        serde_json::json!({
            "id": id,
            "sessionId": session_id,
            "trigger": "token-limit",
            "sourceGeneration": source,
            "targetGeneration": target,
            "checkpointMessageId": "cp-1",
            "parentCheckpointMessageId": null,
            "sourceStartMessageId": "u1",
            "sourceEndMessageId": "a1",
            "retainedTailStartMessageId": "u2",
            "sourceMessageCount": 2,
            "retainedMessageCount": 1,
            "estimatedTokensBefore": 100,
            "estimatedTokensAfter": 40,
            "sourceTokens": 80,
            "checkpointTokens": 20,
            "summaryMode": "local-fallback",
            "summaryProvider": null,
            "summaryModel": "local-checkpoint",
            "createdAt": 1i64,
            "nodes": [{ "position": 0, "messageId": "cp-1", "nodeKind": "checkpoint" }],
            "renderParamsJson": "{\"pruneParams\":{\"enabled\":false,\"protectRecentRounds\":0,\"minPrunableChars\":0,\"protectedTools\":[],\"placeholder\":\"\"},\"renderVersion\":1}",
        })
        .to_string()
    }

    #[test]
    fn commit_context_compaction_rejects_stale_source_generation() {
        let workspace = TestWorkspace::new("compaction-occ");
        fs::create_dir_all(workspace.file_path(".CodePapr")).expect("create project dir");
        let ws = workspace.workspace_arg();

        commit_context_compaction(ws.clone(), compaction_commit_json("c1", "s1", 0, 1))
            .expect("first commit");

        let err = commit_context_compaction(ws.clone(), compaction_commit_json("c2", "s1", 0, 1))
            .expect_err("stale source must be rejected");
        assert!(
            err.contains("source_generation"),
            "error should mention source_generation, got: {err}"
        );

        let surface = load_context_surface(ws.clone(), "s1".to_string(), None)
            .expect("load")
            .expect("surface");
        assert_eq!(surface.generation, 1);
        assert_eq!(surface.compaction_id.as_deref(), Some("c1"));
    }

    #[test]
    fn commit_context_compaction_is_idempotent_for_completed_id() {
        let workspace = TestWorkspace::new("compaction-idempotent");
        fs::create_dir_all(workspace.file_path(".CodePapr")).expect("create project dir");
        let ws = workspace.workspace_arg();

        commit_context_compaction(ws.clone(), compaction_commit_json("c1", "s1", 0, 1))
            .expect("first commit");
        let again = commit_context_compaction(ws.clone(), compaction_commit_json("c1", "s1", 0, 1))
            .expect("retry of completed id");
        assert_eq!(again["compactionId"], "c1");
        assert_eq!(again["generation"], 1);
    }

    #[test]
    fn mark_context_compaction_failed_does_not_flip_completed() {
        let workspace = TestWorkspace::new("compaction-fail-guard");
        fs::create_dir_all(workspace.file_path(".CodePapr")).expect("create project dir");
        let ws = workspace.workspace_arg();

        commit_context_compaction(ws.clone(), compaction_commit_json("c1", "s1", 0, 1))
            .expect("commit");

        let failure = serde_json::json!({
            "id": "c1",
            "sessionId": "s1",
            "trigger": "token-limit",
            "sourceGeneration": 0,
            "summaryMode": "local-fallback",
            "createdAt": 1i64,
            "failureCode": "commit_failed",
            "failureMessage": "ipc lost",
        })
        .to_string();
        mark_context_compaction_failed(ws.clone(), failure).expect("mark failed is a no-op");

        let rows = load_context_compactions(ws, "s1".to_string(), None).expect("load rows");
        let row = rows.iter().find(|r| r.id == "c1").expect("row");
        assert_eq!(row.status, "completed");
        assert!(row.failure_code.is_none());
    }

    #[test]
    fn delete_session_is_transactional_and_clears_memory_recalls() {
        let workspace = TestWorkspace::new("delete-session-recalls");
        fs::create_dir_all(workspace.file_path(".CodePapr")).expect("create project dir");
        let ws = workspace.workspace_arg();

        save_session(
            ws.clone(),
            r#"{"id":"s-del","name":"待删","provider":"deepseek","model":"m","createdAt":1}"#
                .to_string(),
        )
        .expect("save session");
        save_message_batch(
            ws.clone(),
            "s-del".to_string(),
            r#"[{"id":"m1","role":"user","content":"hi","timestamp":1}]"#.to_string(),
        )
        .expect("save messages");
        let recall = serde_json::json!({
            "id": "recall-del",
            "workspaceId": ws,
            "sessionId": "s-del",
            "anchorMessageId": "m1",
            "queryText": "hi",
            "renderedContent": "- hi",
            "itemsJson": "[]",
            "estimatedTokens": 1i64,
            "retrievalStrategy": "like-token-v1",
            "retrievalVersion": 1i64,
            "createdAt": 2i64,
        });
        save_memory_recall(ws.clone(), recall.to_string()).expect("save recall");

        delete_session(ws.clone(), "s-del".to_string()).expect("delete");

        let latest = load_latest_memory_recall(ws.clone(), "s-del".to_string()).expect("load");
        assert!(latest.is_none(), "memory_recalls must be cleared with the session");
        let messages = load_session_messages(ws, "s-del".to_string()).expect("load messages");
        let parsed: Vec<serde_json::Value> =
            serde_json::from_str(&messages.messages_json).expect("parse");
        assert!(parsed.is_empty());
    }

    #[test]
    fn archive_session_hides_from_active_list_and_keeps_messages() {
        let workspace = TestWorkspace::new("archive-session");
        fs::create_dir_all(workspace.file_path(".CodePapr")).expect("create project dir");
        let ws = workspace.workspace_arg();

        save_session(
            ws.clone(),
            r#"{"id":"s-live","name":"活跃","provider":"deepseek","model":"m","createdAt":1}"#
                .to_string(),
        )
        .expect("save live");
        save_session(
            ws.clone(),
            r#"{"id":"s-arch","name":"待归档","provider":"deepseek","model":"m","createdAt":2}"#
                .to_string(),
        )
        .expect("save arch");
        save_message_batch(
            ws.clone(),
            "s-arch".to_string(),
            r#"[{"id":"m-keep","role":"user","content":"keep me","timestamp":1}]"#.to_string(),
        )
        .expect("save messages");

        archive_session(ws.clone(), "s-arch".to_string()).expect("archive");

        let active = load_sessions(ws.clone()).expect("load active");
        let active_parsed: Vec<serde_json::Value> =
            serde_json::from_str(&active.sessions_json).expect("parse active");
        assert_eq!(active_parsed.len(), 1);
        assert_eq!(active_parsed[0]["id"], "s-live");

        let archived = load_archived_sessions(ws.clone()).expect("load archived");
        let archived_parsed: Vec<serde_json::Value> =
            serde_json::from_str(&archived.sessions_json).expect("parse archived");
        assert_eq!(archived_parsed.len(), 1);
        assert_eq!(archived_parsed[0]["id"], "s-arch");
        assert!(archived_parsed[0]["archivedAt"].as_i64().unwrap() > 0);

        save_session(
            ws.clone(),
            r#"{"id":"s-arch","name":"待归档","provider":"deepseek","model":"m","createdAt":2,"updatedAt":9}"#
                .to_string(),
        )
        .expect("resave archived must not clear archived_at");
        let still_archived = load_archived_sessions(ws.clone()).expect("reload archived");
        let still_parsed: Vec<serde_json::Value> =
            serde_json::from_str(&still_archived.sessions_json).expect("parse still");
        assert_eq!(still_parsed.len(), 1);
        assert_eq!(still_parsed[0]["id"], "s-arch");
        let active_after_save = load_sessions(ws.clone()).expect("active after save");
        let active_after_save_parsed: Vec<serde_json::Value> =
            serde_json::from_str(&active_after_save.sessions_json).expect("parse active after save");
        assert_eq!(active_after_save_parsed.len(), 1);

        let messages = load_session_messages(ws.clone(), "s-arch".to_string()).expect("messages");
        let msg_parsed: Vec<serde_json::Value> =
            serde_json::from_str(&messages.messages_json).expect("parse messages");
        assert_eq!(msg_parsed.len(), 1);
        assert_eq!(msg_parsed[0]["content"], "keep me");

        restore_session(ws.clone(), "s-arch".to_string()).expect("restore");
        let restored = load_sessions(ws.clone()).expect("load restored");
        let restored_parsed: Vec<serde_json::Value> =
            serde_json::from_str(&restored.sessions_json).expect("parse restored");
        assert_eq!(restored_parsed.len(), 2);
        let empty_archived = load_archived_sessions(ws.clone()).expect("archived after restore");
        let empty_parsed: Vec<serde_json::Value> =
            serde_json::from_str(&empty_archived.sessions_json).expect("parse empty");
        assert!(empty_parsed.is_empty());

        archive_session(ws.clone(), "s-arch".to_string()).expect("re-archive");
        delete_session(ws.clone(), "s-arch".to_string()).expect("purge archived");
        let after_delete = load_archived_sessions(ws.clone()).expect("archived after delete");
        let after_delete_parsed: Vec<serde_json::Value> =
            serde_json::from_str(&after_delete.sessions_json).expect("parse after delete");
        assert!(after_delete_parsed.is_empty());
        let gone = load_session_messages(ws, "s-arch".to_string()).expect("purged messages");
        let gone_parsed: Vec<serde_json::Value> =
            serde_json::from_str(&gone.messages_json).expect("parse gone");
        assert!(gone_parsed.is_empty());
    }

    #[test]
    fn save_message_batch_rejects_duplicate_id_from_another_session() {
        let workspace = TestWorkspace::new("save-message-dup-id");
        let ws = workspace.workspace_arg();
        save_session(
            ws.clone(),
            r#"{"id":"s-a","name":"A","provider":"deepseek","model":"m","createdAt":1}"#
                .to_string(),
        )
        .expect("s-a");
        save_session(
            ws.clone(),
            r#"{"id":"s-b","name":"B","provider":"deepseek","model":"m","createdAt":2}"#
                .to_string(),
        )
        .expect("s-b");
        save_message_batch(
            ws.clone(),
            "s-a".to_string(),
            r#"[{"id":"shared-id","role":"user","content":"a","timestamp":1}]"#.to_string(),
        )
        .expect("s-a messages");
        let err = save_message_batch(
            ws,
            "s-b".to_string(),
            r#"[{"id":"shared-id","role":"user","content":"b","timestamp":1}]"#.to_string(),
        )
        .expect_err("duplicate id must fail");
        assert!(err.contains("主键冲突"), "got: {err}");
    }

    #[test]
    fn save_message_batch_persists_display_metadata_in_extras() {
        let workspace = TestWorkspace::new("save-message-model-meta");
        let ws = workspace.workspace_arg();
        save_session(
            ws.clone(),
            r#"{"id":"s-meta","name":"M","provider":"deepseek","model":"m","createdAt":1}"#
                .to_string(),
        )
        .expect("session");
        save_message_batch(
            ws.clone(),
            "s-meta".to_string(),
            r#"[{"id":"a1","role":"assistant","content":"ok","timestamp":1,"modelTier":"primary","modelName":"deepseek-v4-pro"}]"#
                .to_string(),
        )
        .expect("save");
        let loaded = load_session_messages(ws, "s-meta".to_string()).expect("load");
        let parsed: Vec<serde_json::Value> =
            serde_json::from_str(&loaded.messages_json).expect("parse");
        assert_eq!(parsed[0]["modelTier"], "primary");
        assert_eq!(parsed[0]["modelName"], "deepseek-v4-pro");
    }

    #[test]
    fn save_message_batch_persists_attached_files_in_extras() {
        let workspace = TestWorkspace::new("save-message-attached-files");
        let ws = workspace.workspace_arg();
        save_session(
            ws.clone(),
            r#"{"id":"s-files","name":"F","provider":"deepseek","model":"m","createdAt":1}"#
                .to_string(),
        )
        .expect("session");
        save_message_batch(
            ws.clone(),
            "s-files".to_string(),
            r#"[{"id":"u1","role":"user","content":"see this","timestamp":1,"attachedFiles":[{"name":"a.ts","size":12}]}]"#
                .to_string(),
        )
        .expect("save");
        let loaded = load_session_messages(ws, "s-files".to_string()).expect("load");
        let parsed: Vec<serde_json::Value> =
            serde_json::from_str(&loaded.messages_json).expect("parse");
        assert_eq!(parsed[0]["attachedFiles"][0]["name"], "a.ts");
        assert_eq!(parsed[0]["attachedFiles"][0]["size"], 12);
    }

    #[test]
    fn archive_memory_recall_errors_when_id_missing() {
        let workspace = TestWorkspace::new("archive-recall-missing");
        fs::create_dir_all(workspace.file_path(".CodePapr")).expect("create project dir");
        let ws = workspace.workspace_arg();
        let err = archive_memory_recall(ws, "no-such-recall".to_string())
            .expect_err("unknown id must fail");
        assert!(err.contains("未找到"), "got: {err}");
    }

    #[test]
    fn load_latest_memory_recall_breaks_created_at_ties_by_id() {
        let workspace = TestWorkspace::new("recall-tie-break");
        fs::create_dir_all(workspace.file_path(".CodePapr")).expect("create project dir");
        let ws = workspace.workspace_arg();
        for id in ["recall-a", "recall-b"] {
            let recall = serde_json::json!({
                "id": id,
                "workspaceId": ws,
                "sessionId": "s1",
                "anchorMessageId": "u1",
                "queryText": id,
                "renderedContent": id,
                "itemsJson": "[]",
                "estimatedTokens": 1i64,
                "retrievalStrategy": "like-token-v1",
                "retrievalVersion": 1i64,
                "createdAt": 100i64,
            });
            save_memory_recall(ws.clone(), recall.to_string()).expect("save");
        }
        let latest = load_latest_memory_recall(ws, "s1".to_string())
            .expect("load")
            .expect("row");
        assert_eq!(latest.id, "recall-b");
    }

    #[test]
    fn memory_recall_unicode_casefold_matches_accented_letters() {
        let workspace = TestWorkspace::new("memory-recall-unicode-case");
        fs::create_dir_all(workspace.file_path(".CodePapr")).expect("create project dir");
        let ws = workspace.workspace_arg();
        let candidate = serde_json::json!({
            "id": "c-ecole",
            "category": "decision",
            "content": "École auth gateway 已切换",
            "contentHash": "hecole",
            "confidence": "confirmed",
            "trust": "workspace",
            "sourceSessionId": "s1",
            "sourceMessageIds": "[]",
            "evidence": null,
            "riskFlags": null,
            "createdAt": 1i64,
        });
        save_memory_candidate(ws.clone(), candidate.to_string()).expect("save");
        admit_memory_candidate(ws.clone(), "c-ecole".to_string(), "e-ecole".to_string())
            .expect("admit");
        let query = serde_json::json!({ "tokens": ["école"], "limit": 8 });
        let items = search_memory_for_recall(ws, query.to_string()).expect("search");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "e-ecole");
    }

    #[test]
    fn v6_migration_drops_fts_probe_leftover_table() {
        let workspace = TestWorkspace::new("fts-probe-leftover");
        fs::create_dir_all(workspace.file_path(".CodePapr")).expect("create project dir");
        let ws = workspace.workspace_arg();
        {
            let (conn, ..) = open_project_db(&ws).unwrap();
            let _ = conn.execute_batch(
                "CREATE VIRTUAL TABLE IF NOT EXISTS _codepapr_fts_probe USING fts5(x);",
            );
            conn.pragma_update(None, "user_version", 5_i64).unwrap();
        }
        let (conn, ..) = open_project_db(&ws).unwrap();
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 7);
        let leftover: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name = '_codepapr_fts_probe')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!leftover, "v6 must drop leftover FTS probe table");
    }

    #[test]
    fn orphan_checkpoint_cleanup_removes_failed_compaction_messages() {
        let workspace = TestWorkspace::new("orphan-checkpoint");
        fs::create_dir_all(workspace.file_path(".CodePapr")).expect("create project dir");
        let ws = workspace.workspace_arg();
        save_session(
            ws.clone(),
            r#"{"id":"s-orphan","name":"O","provider":"deepseek","model":"m","createdAt":1}"#
                .to_string(),
        )
        .expect("session");
        save_message_batch(
            ws.clone(),
            "s-orphan".to_string(),
            r#"[{"id":"cp-orphan","role":"assistant","content":"摘要","timestamp":1,"contextCheckpoint":{"summary":"x"}}]"#
                .to_string(),
        )
        .expect("checkpoint message");
        {
            let (conn, ..) = open_project_db(&ws).unwrap();
            conn.execute(
                "INSERT INTO context_compactions
                   (id, session_id, status, trigger, source_generation, checkpoint_message_id,
                    source_message_count, retained_message_count, summary_mode, created_at)
                 VALUES ('c-fail', 's-orphan', 'failed', 'token-limit', 0, 'cp-orphan',
                         1, 0, 'local-fallback', 1)",
                [],
            )
            .unwrap();
            cleanup_orphan_checkpoint_messages(&conn).expect("cleanup");
        }
        let loaded = load_session_messages(ws, "s-orphan".to_string()).expect("load");
        let parsed: Vec<serde_json::Value> =
            serde_json::from_str(&loaded.messages_json).expect("parse");
        assert!(
            parsed.iter().all(|m| m["id"] != "cp-orphan"),
            "orphan checkpoint message must be removed"
        );
    }
}
