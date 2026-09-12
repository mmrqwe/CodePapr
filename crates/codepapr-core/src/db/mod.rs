//! SQLite persistence for app settings and project state.
//!
//! Three database locations:
//! - **App DB** (`~/.codepapr/codepapr.sqlite`): global UI settings
//! - **Project DB** (`<workspace>/.CodePapr/project.sqlite`): per-workspace state + ProjectGraph cache
//! - **Papr App DB** (`<appDir>/db.sqlite`): per-app key-value storage backing
//!   `papr.db`. Lives next to the app's `manifest.json` — workspace install at
//!   `<workspace>/.CodePapr/apps/<appId>/`, global install at `~/.codepapr/apps/<appId>/`.
//!   A leftover workspace folder without `manifest.json` must not steal a global plugin.
//!
//! This module is pure Rust (rusqlite); no FFI, so unsafe is forbidden.

#![forbid(unsafe_code)]

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use rusqlite::functions::FunctionFlags;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::shared::{canonical_workspace, home_dir, unix_millis};

pub trait SecretStorage: Send + Sync {
    fn get_secret(&self, account: &str) -> Option<String>;
    fn set_secret(&self, account: &str, value: &str) -> Result<(), String>;
    fn save(&self) -> Result<(), String>;
}

#[derive(Default, Debug)]
pub struct InMemorySecretStorage {
    secrets: Mutex<std::collections::HashMap<String, String>>,
}

impl InMemorySecretStorage {
    pub fn new() -> Self {
        Self::default()
    }
}

impl SecretStorage for InMemorySecretStorage {
    fn get_secret(&self, account: &str) -> Option<String> {
        self.secrets.lock().ok()?.get(account).cloned()
    }
    fn set_secret(&self, account: &str, value: &str) -> Result<(), String> {
        let mut map = self.secrets.lock().map_err(|e| e.to_string())?;
        if value.is_empty() {
            map.remove(account);
        } else {
            map.insert(account.to_string(), value.to_string());
        }
        Ok(())
    }
    fn save(&self) -> Result<(), String> {
        Ok(())
    }
}

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
const PROJECT_SCHEMA_VERSION: i64 = 9;
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
pub struct AppSettingsResult {
    pub(crate) settings_json: Option<String>,
    pub(crate) db_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppCharactersResult {
    pub(crate) characters_json: Option<String>,
    pub(crate) db_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStateResult {
    pub(crate) state_json: Option<String>,
    pub(crate) db_path: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAccessPolicy {
    pub yolo: bool,
    pub allowed_dirs: Vec<String>,
    pub allowed_files: Vec<String>,
}

fn external_access_policy_cache() -> &'static Mutex<Option<(i64, ExternalAccessPolicy)>> {
    EXTERNAL_ACCESS_POLICY_CACHE.get_or_init(|| Mutex::new(None))
}

pub fn load_external_access_policy() -> Result<ExternalAccessPolicy, String> {
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
            ON context_compactions(checkpoint_message_id);",
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
        // v5（历史）：memory_entries 曾新增 forgotten_reason 列。账本已随 v9
        // 整体退役，此处只保留版本推进。
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

    if version < 8 {
        // v8（历史）：收敛重复入账的派生记忆。账本已随 v9 整体退役，此处
        // 只保留版本推进（v9 的种子导出按内容去重）。
        conn.pragma_update(None, "user_version", 8_i64)
            .map_err(|err| format!("设置数据库版本失败: {err}"))?;
    }

    if version < 9 {
        // v9: 账本退役——confirmed+active 条目导出为 MEMORY.md 种子（文件
        // 已存在时跳过），随后 DROP 全部记忆表。记忆此后由记忆管家与面板
        // 维护的 .CodePapr/MEMORY.md 承载。
        migrate_project_db_v9(conn, workspace)?;
        conn.pragma_update(None, "user_version", 9_i64)
            .map_err(|err| format!("设置数据库版本失败: {err}"))?;
    }

    Ok(())
}

/// v9：导出 confirmed 条目为 MEMORY.md 种子（零 LLM、按内容去重），然后
/// 删除全部账本表。文件已存在或账本为空时只删表。
fn migrate_project_db_v9(conn: &Connection, workspace: &Path) -> Result<(), String> {
    let memory_md = workspace.join(PROJECT_STORAGE_DIR).join("MEMORY.md");
    let table_exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_entries')",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);

    if table_exists && !memory_md.exists() {
        let mut stmt = conn
            .prepare(
                "SELECT category, content FROM memory_entries
                  WHERE status = 'active' AND confidence = 'confirmed'
                  ORDER BY created_at ASC",
            )
            .map_err(|err| format!("读取记忆条目失败: {err}"))?;
        let rows: Vec<(String, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|err| format!("查询记忆条目失败: {err}"))?
            .filter_map(|r| r.ok())
            .collect();
        drop(stmt);

        if !rows.is_empty() {
            let seed = render_memory_md_seed(&rows);
            fs::write(&memory_md, seed)
                .map_err(|err| format!("写入 MEMORY.md 种子失败: {err}"))?;
        }
    }

    conn.execute_batch(
        "DROP TABLE IF EXISTS memory_entries_fts;
         DROP TABLE IF EXISTS memory_entries;
         DROP TABLE IF EXISTS memory_candidates;
         DROP TABLE IF EXISTS memory_recalls;",
    )
    .map_err(|err| format!("删除记忆账本表失败: {err}"))?;
    Ok(())
}

/// 账本条目 → 三节种子 Markdown。按内容去重；上限 60 行。
fn render_memory_md_seed(entries: &[(String, String)]) -> String {
    let section_of = |category: &str| -> usize {
        match category {
            "preference" | "constraint" => 0,
            "verification" | "convention" | "decision" | "api" => 1,
            _ => 2,
        }
    };
    let headings = [
        "## 用户偏好与约束",
        "## 技术栈与环境约束",
        "## 架构与业务已知事实",
    ];
    let mut groups: [Vec<String>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    for (category, content) in entries {
        let text = content.split_whitespace().collect::<Vec<_>>().join(" ");
        if text.is_empty() {
            continue;
        }
        let idx = section_of(category);
        if !groups[idx].contains(&text) {
            groups[idx].push(text);
        }
    }
    let mut lines = vec!["# 项目与用户长期记忆".to_string()];
    let mut line_count = 1usize;
    for (idx, heading) in headings.iter().enumerate() {
        if line_count + 1 >= 60 {
            break;
        }
        if groups[idx].is_empty() {
            continue;
        }
        lines.push(heading.to_string());
        line_count += 1;
        for item in &groups[idx] {
            if line_count + 1 >= 60 {
                break;
            }
            lines.push(format!("- {item}"));
            line_count += 1;
        }
    }
    format!("{}\n", lines.join("\n"))
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
    .map_err(|err| format!("创建 messages 检索索引失败: {err}"))
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

pub fn global_apps_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(APP_DATA_DIR).join("apps"))
}

fn is_real_workspace(workspace_path: &str) -> bool {
    !workspace_path.is_empty() && workspace_path != "__global__"
}

fn workspace_apps_dir(workspace: &Path, app_id: &str) -> PathBuf {
    workspace.join(PROJECT_STORAGE_DIR).join("apps").join(app_id)
}

fn app_dir_has_manifest(dir: &Path) -> bool {
    dir.join("manifest.json").is_file()
}

fn is_valid_papr_app_id(app_id: &str) -> bool {
    !app_id.is_empty() && !app_id.contains("..") && !app_id.contains('/') && !app_id.contains('\\')
}

/// Resolve the on-disk app directory.
///
/// Workspace install wins only when it has `manifest.json`. A leftover folder
/// that only contains `db.sqlite` (created by a previous bug) must not shadow
/// `~/.codepapr/apps/<id>/`. If neither side has a manifest yet, new data
/// falls back to the workspace app dir.
pub fn resolve_app_dir(workspace_path: &str, app_id: &str) -> Result<PathBuf, String> {
    if !is_valid_papr_app_id(app_id) {
        return Err(format!("非法的 appId: {app_id}"));
    }
    if is_real_workspace(workspace_path) {
        if let Ok(workspace) = canonical_workspace(workspace_path) {
            let ws_app_dir = workspace_apps_dir(&workspace, app_id);
            if app_dir_has_manifest(&ws_app_dir) {
                return Ok(ws_app_dir);
            }
        }
    }
    if let Ok(global_dir) = global_apps_dir() {
        let global_app_dir = global_dir.join(app_id);
        if app_dir_has_manifest(&global_app_dir) {
            return Ok(global_app_dir);
        }
    }
    if is_real_workspace(workspace_path) {
        let workspace = canonical_workspace(workspace_path)?;
        Ok(workspace_apps_dir(&workspace, app_id))
    } else {
        Ok(global_apps_dir()?.join(app_id))
    }
}

/// Opens (and initializes) the per-app papr database next to the resolved app.
fn open_papr_app_db(workspace_path: &str, app_id: &str) -> Result<(Connection, PathBuf), String> {
    let app_dir = resolve_app_dir(workspace_path, app_id)?;
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

pub const PRIMARY_KEY_ACCOUNT: &str = "api_key";
pub const MENTOR_KEY_ACCOUNT: &str = "mentor_api_key";
pub const FAST_KEY_ACCOUNT: &str = "fast_api_key";

/// Names of settings JSON fields that hold API keys and must be diverted to
/// the Stronghold vault instead of being persisted as plaintext in SQLite.
const SECRET_FIELDS: [(&str, &str); 3] = [
    ("apiKey", PRIMARY_KEY_ACCOUNT),
    ("mentorApiKey", MENTOR_KEY_ACCOUNT),
    ("fastApiKey", FAST_KEY_ACCOUNT),
];

/// Moves API key values from the settings JSON into the Stronghold vault,
/// replacing them with empty strings in the JSON so nothing sensitive lands
/// in SQLite.  If vault storage fails for a field, the plaintext is left
/// untouched (graceful degradation).
///
/// Returns `true` if any secret was actually stored or removed — 只有发生
/// 真实变更时才值得执行一次 Stronghold 快照落盘（保存代价高且阻塞）。
fn extract_and_store_secrets(secrets: &dyn SecretStorage, value: &mut serde_json::Value) -> bool {
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
            if secrets.get_secret(account).is_some() {
                let _ = secrets.set_secret(account, "");
                changed = true;
            }
            continue;
        }
        // 前端每次保存都会带回已注入的 key：值与 vault 一致时只做明文剥离，
        // 不重复写库（Stronghold 快照全量落盘代价高），避免每次保存都写 vault。
        if secrets.get_secret(account).as_deref() == Some(trimmed) {
            obj.insert(
                (*field).to_string(),
                serde_json::Value::String(String::new()),
            );
            continue;
        }
        if secrets.set_secret(account, trimmed).is_ok() {
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
    secrets: &dyn SecretStorage,
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
                if secrets.set_secret(account, trimmed).is_ok() {
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
            let secret = secrets.get_secret(account).unwrap_or_default();
            obj.insert((*field).to_string(), serde_json::Value::String(secret));
        }
    }

    stripped_json
}

// ── Tauri commands ───────────────────────────────────────────────────

pub fn load_app_settings(secrets: Option<&dyn SecretStorage>) -> Result<AppSettingsResult, String> {
    let _guard = app_settings_db_lock()
        .lock()
        .unwrap_or_else(|err| err.into_inner());
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

            if let Some(s) = secrets {
                let stripped_for_persistence = migrate_and_inject_secrets(s, &mut value);

                // If migration happened, persist the stripped JSON so plaintext keys
                // are removed from SQLite going forward, and flush the vault so the
                // migrated secrets survive a restart.
                if let Some(stripped) = stripped_for_persistence {
                    if s.save().is_ok() {
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

pub async fn save_app_settings(
    secrets: Option<Arc<dyn SecretStorage>>,
    settings_json: String,
) -> Result<AppSettingsResult, String> {
    if settings_json.len() > MAX_SETTINGS_JSON_BYTES {
        return Err(format!("配置内容超过上限 {MAX_SETTINGS_JSON_BYTES} bytes"));
    }
    // 入口处先记账「收到一次保存请求」：退出流程据此探测前端是否已发起保存，
    // 没有保存请求时跳过完成等待直接退出。
    SETTINGS_SAVE_REQUESTS.fetch_add(1, Ordering::SeqCst);

    let result = tokio::task::spawn_blocking(move || {
        let mut value: serde_json::Value =
            serde_json::from_str(&settings_json).map_err(|err| format!("配置不是合法 JSON: {err}"))?;
        if !value.is_object() {
            return Err("配置 JSON 必须是对象".to_string());
        }

        if let Some(ref s) = secrets {
            let secrets_changed = extract_and_store_secrets(s.as_ref(), &mut value);
            if secrets_changed {
                s.save().map_err(|e| format!("保存密钥库失败: {e}"))?;
            }
        }

        let persisted_json =
            serde_json::to_string(&value).map_err(|err| format!("序列化配置失败: {err}"))?;

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

// 设置保存请求计数：每次 save_app_settings 被调用（入口）+1。退出流程先用它
// 探测「前端 flush 是否真的发起了保存」——没有保存请求时无需等待完成纪元，
// 直接退出（旧实现对每次退出都无条件忙等满 2 秒）。
static SETTINGS_SAVE_REQUESTS: AtomicU64 = AtomicU64::new(0);

pub fn settings_save_epoch() -> u64 {
    SETTINGS_SAVE_EPOCH.load(Ordering::SeqCst)
}

pub fn settings_save_requests() -> u64 {
    SETTINGS_SAVE_REQUESTS.load(Ordering::SeqCst)
}

/// 有界等待设置保存纪元推进（退出前 flush 用）。返回 true 表示 epoch 已推进
/// （一次保存已处理完毕），false 表示超时（前端不可用/无保存发生）。
pub fn wait_for_settings_save_epoch(epoch_before: u64, timeout: Duration) -> bool {
    wait_for_epoch(&SETTINGS_SAVE_EPOCH, epoch_before, timeout)
}

/// 有界等待「出现新的保存请求」（退出前探测用）。返回 true 表示前端已发起
/// 保存调用，随后才值得等待其完成；false 表示探测窗口内无保存，可立即退出。
pub fn wait_for_settings_save_requests(requests_before: u64, timeout: Duration) -> bool {
    wait_for_epoch(&SETTINGS_SAVE_REQUESTS, requests_before, timeout)
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

pub fn note_recent_workspace(path: String) -> Result<AppSettingsResult, String> {
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

pub fn set_recent_workspaces(workspaces_json: String) -> Result<AppSettingsResult, String> {
    let db_path = app_db_path()?;
    set_recent_workspaces_impl(&db_path, &workspaces_json)
}

pub fn load_app_characters() -> Result<AppCharactersResult, String> {
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

pub fn save_app_characters(characters_json: String) -> Result<AppCharactersResult, String> {
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

pub fn load_project_state(workspace_path: String) -> Result<ProjectStateResult, String> {
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

pub fn save_project_state(
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

pub fn save_session(workspace_path: String, session_json: String) -> Result<(), String> {
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
pub struct SessionListResult {
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

pub fn load_sessions(workspace_path: String) -> Result<SessionListResult, String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    let sessions = query_sessions(&conn, false)?;
    Ok(SessionListResult {
        sessions_json: serde_json::to_string(&sessions)
            .map_err(|err| format!("序列化会话列表失败: {err}"))?,
    })
}

pub fn load_archived_sessions(workspace_path: String) -> Result<SessionListResult, String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    let sessions = query_sessions(&conn, true)?;
    Ok(SessionListResult {
        sessions_json: serde_json::to_string(&sessions)
            .map_err(|err| format!("序列化归档会话列表失败: {err}"))?,
    })
}

pub fn archive_session(workspace_path: String, session_id: String) -> Result<(), String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    conn.execute(
        "UPDATE sessions SET archived_at = ?1 WHERE id = ?2 AND archived_at IS NULL",
        params![unix_millis()?, session_id],
    )
    .map_err(|err| format!("归档会话失败: {err}"))?;
    Ok(())
}

pub fn restore_session(workspace_path: String, session_id: String) -> Result<(), String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    conn.execute(
        "UPDATE sessions SET archived_at = NULL, updated_at = ?1 WHERE id = ?2",
        params![unix_millis()?, session_id],
    )
    .map_err(|err| format!("恢复会话失败: {err}"))?;
    Ok(())
}

pub fn delete_session(workspace_path: String, session_id: String) -> Result<(), String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|err| format!("开启事务失败: {err}"))?;
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

pub fn save_message_batch(
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
        // images 存的是落盘引用（{mediaType, data:"", path}，base64 在
        // .CodePapr/chat-images/ 文件中），前端加载后按 path 回填。
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
            "images",
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
pub struct MessageListResult {
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
    // modelTier / modelName / relatedFilePaths / attachedFiles / images）。
    if let Some(s) = extras_raw {
        if let Ok(serde_json::Value::Object(map)) = serde_json::from_str(&s) {
            for (key, value) in map {
                obj[key] = value;
            }
        }
    }

    Ok(obj)
}

pub fn load_session_messages(
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
pub struct AllMessagesResult {
    pub(crate) messages_by_session_json: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUsageEntry {
    pub(crate) name: String,
    pub(crate) count: i64,
    pub(crate) success: i64,
    pub(crate) error: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUsageResult {
    pub(crate) usage_json: String,
}

/// Load every session's messages in a single query (one connection open), grouped
/// by session id. Replaces the previous N+1 per-session loads at workspace open.
pub fn load_all_session_messages(
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
pub fn aggregate_tool_usage(workspace_path: String) -> Result<ToolUsageResult, String> {
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
pub struct SessionRuntimeResult {
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
pub fn aggregate_session_runtime(
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

pub fn save_project_meta(
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

pub fn load_project_meta(
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
pub struct ProjectMetaResult {
    pub(crate) meta_json: String,
}

pub fn load_all_project_meta(workspace_path: String) -> Result<ProjectMetaResult, String> {
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
pub struct CheckpointRecord {
    pub id: i64,
    pub session_id: String,
    pub message_id: String,
    pub sha: String,
    pub label: String,
    pub file_count: i64,
    pub created_at: i64,
}

pub fn save_checkpoint_record(
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

pub fn load_checkpoint_records(
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

pub fn delete_checkpoint_by_message(
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

pub fn delete_checkpoints_for_session(
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

pub fn save_projectgraph_cache(
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

pub fn load_projectgraph_cache(workspace_path: String) -> Result<Option<String>, String> {
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

pub fn cache_get(key: String) -> Result<Option<String>, String> {
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

pub fn cache_set(key: String, value: String, ttl_ms: Option<i64>) -> Result<(), String> {
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

pub fn cache_remove(key: String) -> Result<(), String> {
    let (conn, _db_path) = open_app_db()?;
    conn.execute("DELETE FROM cache WHERE key = ?1", params![key])
        .map_err(|err| format!("删除缓存失败: {err}"))?;
    Ok(())
}

// ── Papr App Storage ─────────────────────────────────────────────────

pub fn papr_storage_get(
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

pub fn papr_storage_set(
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

pub fn papr_storage_delete(
    workspace_path: &str,
    app_id: &str,
    key: &str,
) -> Result<(), String> {
    let (conn, ..) = open_papr_app_db(workspace_path, app_id)?;
    conn.execute("DELETE FROM app_storage WHERE key = ?1", params![key])
        .map_err(|err| format!("删除 app_storage 失败: {err}"))?;
    Ok(())
}

pub fn papr_storage_keys(workspace_path: &str, app_id: &str) -> Result<Vec<String>, String> {
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

fn inbox_workspace_id(workspace_path: &str) -> String {
    // 与前端 normalizeWorkspaceId / papr.app.info().workspaceId 同一规则：
    // 用打开的工作区路径作身份，不去 canonicalize（避免 /tmp vs /private/tmp 对不上）。
    workspace_path
        .trim()
        .trim_end_matches(['/', '\\'])
        .to_string()
}

/// 向 app 的 inbox 频道原子追加一条事件，key = `inbox:<channel>`。
///
/// 存储为 JSON 数组 `[{seq, ts, payload, workspaceId}, ...]`，只保留最近 `cap` 条；
/// seq 在锁内取「现有最大 seq + 1」分配，单调无冲突。返回 (seq, ts)。
/// `workspaceId` 标记事件所属项目，供看板等按记录过滤（数据仍与插件同目录）。
///
/// 原子性：进程内 Mutex + 跨进程 `BEGIN IMMEDIATE`（WAL 下全局单 writer，
/// busy_timeout=5000 使竞争方等待而非失败）。
pub fn papr_inbox_append(
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
    let workspace_id = inbox_workspace_id(workspace_path);
    events.push(serde_json::json!({
        "seq": seq,
        "ts": ts,
        "payload": payload,
        "workspaceId": workspace_id,
    }));
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

pub fn papr_load_permission_settings() -> Result<Option<String>, String> {
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
pub fn papr_save_permission_settings(settings_json: &str) -> Result<(), String> {
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
pub struct ContextSurfaceNodeResult {
    pub(crate) position: i64,
    pub(crate) message_id: String,
    pub(crate) node_kind: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSurfaceResult {
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
pub struct ContextSurfaceNodeInput {
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

pub fn load_context_surface(
    workspace_path: String,
    session_id: String,
    generation: Option<i64>,
) -> Result<Option<ContextSurfaceResult>, String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    read_context_surface(&conn, &session_id, generation)
}

/// ADR-002：degraded generation 回退 parent / 重建 gen 0 时丢弃
/// `generation >= from_generation` 的 surface 行与节点。
pub fn discard_context_surfaces_from_generation(
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
pub fn save_context_surface(
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
pub struct CompactionCommitInput {
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
    /// 压缩**成功提交**但摘要走了降级路径时的原因（写入 failure_code 供审计）：
    /// compactor_unavailable / empty_output / parse_failed /
    /// pinned_validation_failed / merge_failed / unspecified。None = 摘要质量正常。
    #[serde(default)]
    pub(crate) degraded_reason: Option<String>,
    pub(crate) created_at: i64,
    pub(crate) nodes: Vec<ContextSurfaceNodeInput>,
    pub(crate) render_params_json: String,
}

/// 压缩提交（ADR-005）：单事务内 started 行 → surface generation + nodes →
/// completed 行一步提交。任何一步失败整个事务回滚，之前 completed 的
/// generation 保持 active。
pub fn commit_context_compaction(
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
            summary_mode, summary_provider, summary_model, created_at, failure_code)
         VALUES (?1, ?2, 'started', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                 ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
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
            input.degraded_reason,
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
pub struct CompactionFailureInput {
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
pub fn mark_context_compaction_failed(
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
pub struct ContextCompactionResult {
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

pub fn load_context_compactions(
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

    struct RestoreTestHome;
    impl Drop for RestoreTestHome {
        fn drop(&mut self) {
            std::env::remove_var("CODEPAPR_TEST_HOME");
        }
    }

    #[test]
    fn papr_storage_global_plugin_ignores_workspace_stub_without_manifest() {
        let _guard = crate::shared::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let fake_home = TestWorkspace::new("papr-global-home");
        std::env::set_var("CODEPAPR_TEST_HOME", fake_home.workspace_arg());
        let _restore = RestoreTestHome;

        let global_app = fake_home.path.join(".codepapr/apps/cursor-canvas");
        fs::create_dir_all(&global_app).unwrap();
        fs::write(
            global_app.join("manifest.json"),
            r#"{"spec":"papr/0.1","name":"看板","kind":"plugin"}"#,
        )
        .unwrap();
        fs::write(global_app.join("index.html"), "<html></html>").unwrap();

        let workspace = TestWorkspace::new("papr-kanban-stub");
        let ws = workspace.workspace_arg();
        let stub = workspace.file_path(".CodePapr/apps/cursor-canvas");
        fs::create_dir_all(&stub).unwrap();
        fs::write(stub.join("db.sqlite"), b"").unwrap();

        let resolved = resolve_app_dir(&ws, "cursor-canvas").unwrap();
        assert_eq!(
            resolved.canonicalize().unwrap(),
            global_app.canonicalize().unwrap()
        );

        papr_storage_set(&ws, "cursor-canvas", "board:history", r#"[{"title":"ok"}]"#).unwrap();
        assert!(global_app.join("db.sqlite").exists());
        assert_eq!(
            papr_storage_get(&ws, "cursor-canvas", "board:history")
                .unwrap()
                .as_deref(),
            Some(r#"[{"title":"ok"}]"#)
        );
        // leftover stub must not receive the write
        let stub_len = fs::metadata(stub.join("db.sqlite")).unwrap().len();
        assert_eq!(stub_len, 0);
    }

    #[test]
    fn papr_storage_workspace_manifest_wins_over_global() {
        let _guard = crate::shared::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let fake_home = TestWorkspace::new("papr-ws-wins-home");
        std::env::set_var("CODEPAPR_TEST_HOME", fake_home.workspace_arg());
        let _restore = RestoreTestHome;

        let global_app = fake_home.path.join(".codepapr/apps/local-tool");
        fs::create_dir_all(&global_app).unwrap();
        fs::write(
            global_app.join("manifest.json"),
            r#"{"spec":"papr/0.1","name":"Global"}"#,
        )
        .unwrap();

        let workspace = TestWorkspace::new("papr-ws-install");
        let ws = workspace.workspace_arg();
        let app_dir = workspace.file_path(".CodePapr/apps/local-tool");
        fs::create_dir_all(&app_dir).unwrap();
        fs::write(
            app_dir.join("manifest.json"),
            r#"{"spec":"papr/0.1","name":"Local"}"#,
        )
        .unwrap();

        papr_storage_set(&ws, "local-tool", "k", "workspace").unwrap();
        assert!(workspace.file_path(".CodePapr/apps/local-tool/db.sqlite").exists());
        assert!(!global_app.join("db.sqlite").exists());
        assert_eq!(
            papr_storage_get(&ws, "local-tool", "k").unwrap().as_deref(),
            Some("workspace")
        );
    }

    #[test]
    fn papr_inbox_global_plugin_stamps_distinct_workspace_ids() {
        let _guard = crate::shared::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let fake_home = TestWorkspace::new("papr-inbox-home");
        std::env::set_var("CODEPAPR_TEST_HOME", fake_home.workspace_arg());
        let _restore = RestoreTestHome;

        let global_app = fake_home.path.join(".codepapr/apps/cursor-canvas");
        fs::create_dir_all(&global_app).unwrap();
        fs::write(
            global_app.join("manifest.json"),
            r#"{"spec":"papr/0.1","name":"看板","kind":"plugin"}"#,
        )
        .unwrap();

        let ws_a = TestWorkspace::new("papr-inbox-a");
        let ws_b = TestWorkspace::new("papr-inbox-b");
        papr_inbox_append(&ws_a.workspace_arg(), "cursor-canvas", "board", r#"{"title":"A"}"#, None)
            .unwrap();
        papr_inbox_append(&ws_b.workspace_arg(), "cursor-canvas", "board", r#"{"title":"B"}"#, None)
            .unwrap();

        let raw = papr_storage_get(&ws_a.workspace_arg(), "cursor-canvas", "inbox:board")
            .unwrap()
            .expect("shared inbox");
        let events: Vec<serde_json::Value> = serde_json::from_str(&raw).unwrap();
        assert_eq!(events.len(), 2);
        let id_a = events[0]["workspaceId"].as_str().unwrap();
        let id_b = events[1]["workspaceId"].as_str().unwrap();
        assert_ne!(id_a, id_b);
        let expected_a = ws_a.workspace_arg();
        let expected_b = ws_b.workspace_arg();
        assert_eq!(id_a, expected_a.trim().trim_end_matches(['/', '\\']));
        assert_eq!(id_b, expected_b.trim().trim_end_matches(['/', '\\']));
        assert_eq!(events[0]["payload"]["title"], "A");
        assert_eq!(events[1]["payload"]["title"], "B");
        assert!(global_app.join("db.sqlite").exists());
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

        // 落库格式：inbox:<channel> → [{seq, ts, payload, workspaceId}]
        let raw = papr_storage_get(&ws, app_id, "inbox:cards")
            .unwrap()
            .expect("inbox key should exist");
        let events: Vec<serde_json::Value> = serde_json::from_str(&raw).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["seq"], 1);
        assert_eq!(events[0]["payload"]["op"], "add");
        assert_eq!(events[1]["seq"], 2);
        assert_eq!(events[1]["payload"]["op"], "move");
        let ws_id = events[0]["workspaceId"].as_str().unwrap_or("");
        let expected_id = ws.trim().trim_end_matches(['/', '\\']);
        assert_eq!(ws_id, expected_id, "inbox workspaceId must match the open workspace path");
        assert_eq!(events[1]["workspaceId"], ws_id);
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

        // 重新打开触发 v4 迁移（当前最新版本为 v9，v4 迁移后继续升级）
        {
            let (conn, ..) = open_project_db(&ws).unwrap();
            let version: i64 = conn
                .pragma_query_value(None, "user_version", |row| row.get(0))
                .unwrap();
            assert_eq!(version, 9);
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
        let _workspace = TestWorkspace::new("extract-secrets-changed");
        let secrets = InMemorySecretStorage::new();

        // 新 key：应报告变更并剥离明文
        let mut value: serde_json::Value =
            serde_json::from_str(r#"{"apiKey":"sk-new","mentorApiKey":""}"#).unwrap();
        assert!(extract_and_store_secrets(&secrets, &mut value));
        assert_eq!(value["apiKey"], "");
        assert_eq!(secrets.get_secret(PRIMARY_KEY_ACCOUNT).as_deref(), Some("sk-new"));

        // 前端每次保存都会带回已注入的同一 key：值与 vault 一致，不应报告变更
        let mut value2: serde_json::Value =
            serde_json::from_str(r#"{"apiKey":"sk-new","mentorApiKey":""}"#).unwrap();
        assert!(!extract_and_store_secrets(&secrets, &mut value2));
        assert_eq!(value2["apiKey"], "", "明文仍应被剥离");
        assert_eq!(secrets.get_secret(PRIMARY_KEY_ACCOUNT).as_deref(), Some("sk-new"));

        // 显式清空已存在的 key：应报告变更并删除 vault 密钥
        let mut value3: serde_json::Value =
            serde_json::from_str(r#"{"apiKey":"","mentorApiKey":""}"#).unwrap();
        assert!(extract_and_store_secrets(&secrets, &mut value3));
        assert!(secrets.get_secret(PRIMARY_KEY_ACCOUNT).is_none());

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
    fn commit_context_compaction_records_degraded_reason_as_failure_code() {
        // F：压缩成功提交但摘要走了降级路径时，failure_code 必须留下原因，
        // 否则审计端只能看到 summary_mode=local-fallback 而不知道为什么。
        let workspace = TestWorkspace::new("compaction-degraded");
        fs::create_dir_all(workspace.file_path(".CodePapr")).expect("create project dir");
        let ws = workspace.workspace_arg();

        let json = serde_json::Value::Object({
            let mut base: serde_json::Map<String, serde_json::Value> =
                serde_json::from_str(&compaction_commit_json("c1", "s1", 0, 1)).expect("base json");
            base.insert(
                "degradedReason".to_string(),
                serde_json::json!("pinned_validation_failed"),
            );
            base
        });
        commit_context_compaction(ws.clone(), json.to_string()).expect("commit degraded");

        let rows = load_context_compactions(ws.clone(), "s1".to_string(), None).expect("load rows");
        let row = rows.iter().find(|r| r.id == "c1").expect("row");
        assert_eq!(row.status, "completed");
        assert_eq!(row.failure_code.as_deref(), Some("pinned_validation_failed"));

        // 未降级时不写 failure_code
        commit_context_compaction(ws.clone(), compaction_commit_json("c2", "s2", 0, 1))
            .expect("commit clean");
        let rows = load_context_compactions(ws, "s2".to_string(), None).expect("load rows");
        let clean = rows.iter().find(|r| r.id == "c2").expect("row");
        assert_eq!(clean.status, "completed");
        assert!(clean.failure_code.is_none());
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
    fn save_message_batch_persists_image_disk_references_in_extras() {
        let workspace = TestWorkspace::new("save-message-image-refs");
        let ws = workspace.workspace_arg();
        save_session(
            ws.clone(),
            r#"{"id":"s-img","name":"I","provider":"deepseek","model":"m","createdAt":1}"#
                .to_string(),
        )
        .expect("session");
        // images 携带的是落盘引用（data 为空、path 指向 .CodePapr/chat-images/），
        // 必须经 extras 持久化，重启后前端才能按路径回填预览。
        save_message_batch(
            ws.clone(),
            "s-img".to_string(),
            r#"[{"id":"u1","role":"user","content":"with image","timestamp":1,"images":[{"mediaType":"image/png","data":"","path":".CodePapr/chat-images/abc.png"}]}]"#
                .to_string(),
        )
        .expect("save");
        let loaded = load_session_messages(ws, "s-img".to_string()).expect("load");
        let parsed: Vec<serde_json::Value> =
            serde_json::from_str(&loaded.messages_json).expect("parse");
        assert_eq!(parsed[0]["images"][0]["path"], ".CodePapr/chat-images/abc.png");
        assert_eq!(parsed[0]["images"][0]["mediaType"], "image/png");
        assert_eq!(parsed[0]["images"][0]["data"], "");
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
        assert_eq!(version, 9);
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
    fn v9_migration_exports_memory_seed_and_drops_ledger_tables() {
        let workspace = TestWorkspace::new("v9-memory-retire");
        fs::create_dir_all(workspace.file_path(".CodePapr")).expect("create project dir");
        let ws = workspace.workspace_arg();
        {
            let (conn, ..) = open_project_db(&ws).unwrap();
            conn.execute_batch(
                "CREATE TABLE memory_entries (
                   id TEXT PRIMARY KEY, category TEXT NOT NULL, content TEXT NOT NULL,
                   content_hash TEXT NOT NULL, confidence TEXT NOT NULL, trust TEXT NOT NULL,
                   status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL
                 );
                 INSERT INTO memory_entries (id, category, content, content_hash, confidence, trust, status, created_at)
                 VALUES
                   ('e1','preference','用户偏好中文回复','h1','confirmed','user-note','active',1),
                   ('e2','convention','验证命令是 npm test','h2','confirmed','tool-output','active',2),
                   ('e3','fact','未确认不入种子','h3','reported','derived','active',3),
                   ('e4','preference','已被忘记不入种子','h4','confirmed','derived','forgotten',4);",
            )
            .unwrap();
            conn.pragma_update(None, "user_version", 8_i64).unwrap();
        }
        let memory_md = workspace.file_path(".CodePapr/MEMORY.md");
        assert!(!std::path::Path::new(&memory_md).exists());
        let (conn, ..) = open_project_db(&ws).unwrap();
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 9);
        let seed = fs::read_to_string(&memory_md).expect("seed written");
        assert!(seed.starts_with("# 项目与用户长期记忆"));
        assert!(seed.contains("用户偏好中文回复"));
        assert!(seed.contains("验证命令是 npm test"));
        assert!(!seed.contains("未确认不入种子"));
        assert!(!seed.contains("已被忘记不入种子"));
        let table_gone: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_entries')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!table_gone, "v9 must drop memory_entries");
    }

    #[test]
    fn v9_migration_keeps_existing_memory_md() {
        let workspace = TestWorkspace::new("v9-memory-keep");
        fs::create_dir_all(workspace.file_path(".CodePapr")).expect("create project dir");
        let ws = workspace.workspace_arg();
        let memory_md = workspace.file_path(".CodePapr/MEMORY.md");
        fs::write(&memory_md, "# 手工维护内容\n").expect("pre-write MEMORY.md");
        {
            let (conn, ..) = open_project_db(&ws).unwrap();
            conn.execute_batch(
                "CREATE TABLE memory_entries (
                   id TEXT PRIMARY KEY, category TEXT NOT NULL, content TEXT NOT NULL,
                   content_hash TEXT NOT NULL, confidence TEXT NOT NULL, trust TEXT NOT NULL,
                   status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL
                 );
                 INSERT INTO memory_entries (id, category, content, content_hash, confidence, trust, status, created_at)
                 VALUES ('e1','preference','旧账本条目','h1','confirmed','user-note','active',1);",
            )
            .unwrap();
            conn.pragma_update(None, "user_version", 8_i64).unwrap();
        }
        let _ = open_project_db(&ws).unwrap();
        let content = fs::read_to_string(&memory_md).expect("read MEMORY.md");
        assert_eq!(content, "# 手工维护内容\n");
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
