//! SQLite persistence for app settings and project state.
//!
//! Two databases:
//! - **App DB** (`~/.codepapr/codepapr.sqlite`): global UI settings
//! - **Project DB** (`<workspace>/.CodePapr/project.sqlite`): per-workspace state + ProjectGraph cache

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

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
const PROJECT_STORAGE_DIR: &str = ".CodePapr";
const PROJECT_DB_FILE: &str = "project.sqlite";
const PROJECT_STATE_KEY: &str = "project.state";
const LEGACY_PROJECT_FILE: &str = ".CodePapr/project.json";
const LEGACY_STATE_FILE: &str = ".CodePapr/state.json";
const MAX_SETTINGS_JSON_BYTES: usize = 200_000;
const MAX_CHARACTERS_JSON_BYTES: usize = 50_000_000;
const MAX_PROJECT_STATE_JSON_BYTES: usize = 20_000_000;

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

// ── App DB helpers ───────────────────────────────────────────────────

fn app_db_path() -> Result<PathBuf, String> {
    let data_dir = home_dir()?.join(APP_DATA_DIR);
    fs::create_dir_all(&data_dir).map_err(|err| format!("创建数据目录失败: {err}"))?;
    Ok(data_dir.join(APP_DB_FILE))
}

fn open_app_db() -> Result<(Connection, PathBuf), String> {
    let db_path = app_db_path()?;
    let conn = Connection::open(&db_path)
        .map_err(|err| format!("打开配置数据库 {} 失败: {err}", db_path.display()))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
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
         PRAGMA secure_delete = ON;
         PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS project_state (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS app_storage (
           app_id TEXT NOT NULL,
           key TEXT NOT NULL,
           value TEXT NOT NULL,
           updated_at INTEGER NOT NULL,
           PRIMARY KEY (app_id, key)
         );
         CREATE INDEX IF NOT EXISTS idx_app_storage_app
           ON app_storage(app_id);
         CREATE TABLE IF NOT EXISTS sessions (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           provider TEXT NOT NULL,
           model TEXT NOT NULL,
           created_at INTEGER NOT NULL
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
            ON checkpoint_timeline(session_id);",
    )
    .map_err(|err| format!("初始化项目状态表失败: {err}"))?;

    migrate_project_db(&conn, &workspace)?;

    Ok((conn, workspace, db_path))
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

    Ok(())
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
    let tx = conn.unchecked_transaction()
        .map_err(|err| format!("开启迁移事务失败: {err}"))?;

    for session in &sessions {
        let id = session.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if id.is_empty() {
            continue;
        }
        let name = session.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let provider = session.get("provider").and_then(|v| v.as_str()).unwrap_or("");
        let model = session.get("model").and_then(|v| v.as_str()).unwrap_or("");
        let created_at = session.get("createdAt").and_then(|v| v.as_i64()).unwrap_or(0);

        tx.execute(
            "INSERT OR IGNORE INTO sessions (id, name, provider, model, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, name, provider, model, created_at],
        )
        .map_err(|err| format!("迁移会话 {id} 失败: {err}"))?;
    }

    let session_messages = parsed
        .get("sessionMessages")
        .and_then(|v| v.as_object());

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

    tx.commit().map_err(|err| format!("提交迁移事务失败: {err}"))?;

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
fn extract_and_store_secrets(app_secrets: &AppSecrets, value: &mut serde_json::Value) {
    let Some(obj) = value.as_object_mut() else {
        return;
    };

    for (field, account) in SECRET_FIELDS {
        let raw = obj.get(field).and_then(|v| v.as_str()).unwrap_or("");
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            // User cleared the key — remove from vault.
            let _ = secrets::delete_secret(app_secrets, account);
            continue;
        }
        if secrets::set_secret(app_secrets, account, trimmed).is_ok() {
            obj.insert((*field).to_string(), serde_json::Value::String(String::new()));
        }
    }
}

/// Performs one-time migration of legacy plaintext keys (from older versions
/// that stored them directly in SQLite) into the Stronghold vault, then injects
/// the vault values back into the JSON for the frontend to consume.
///
/// Returns `Some(stripped_json)` when migration occurred and the stripped JSON
/// should be re-persisted to SQLite to remove the plaintext. Returns `None`
/// otherwise.
fn migrate_and_inject_secrets(app_secrets: &AppSecrets, value: &mut serde_json::Value) -> Option<String> {
    // Migration phase: move any non-empty plaintext keys to vault.
    let mut migrated = false;
    {
        let obj = value.as_object_mut()?;
        for (field, account) in SECRET_FIELDS {
            let raw = obj.get(field).and_then(|v| v.as_str()).unwrap_or("");
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                if secrets::set_secret(app_secrets, account, trimmed).is_ok() {
                    obj.insert((*field).to_string(), serde_json::Value::String(String::new()));
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
            // migrated secrets survive a restart.
            if let Some(stripped) = stripped_for_persistence {
                let _ = conn.execute(
                    "INSERT INTO settings (key, value, data_type, updated_at)
                     VALUES (?1, ?2, 'json', ?3)
                     ON CONFLICT(key) DO UPDATE SET
                       value = excluded.value,
                       data_type = excluded.data_type,
                       updated_at = excluded.updated_at",
                    params![APP_SETTINGS_KEY, stripped, unix_millis()?],
                );
                let _ = app_secrets.save();
            }

            Some(
                serde_json::to_string(&value)
                    .map_err(|err| format!("序列化配置失败: {err}"))?,
            )
        }
        None => None,
    };

    Ok(AppSettingsResult {
        settings_json: final_json,
        db_path: db_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub(crate) fn save_app_settings(app: tauri::AppHandle, settings_json: String) -> Result<AppSettingsResult, String> {
    if settings_json.len() > MAX_SETTINGS_JSON_BYTES {
        return Err(format!("配置内容超过上限 {MAX_SETTINGS_JSON_BYTES} bytes"));
    }

    let mut value: serde_json::Value =
        serde_json::from_str(&settings_json).map_err(|err| format!("配置不是合法 JSON: {err}"))?;
    if !value.is_object() {
        return Err("配置 JSON 必须是对象".to_string());
    }

    // Divert API keys to the Stronghold vault before anything hits SQLite.
    let app_secrets = app.state::<AppSecrets>();
    extract_and_store_secrets(&app_secrets, &mut value);
    let persisted_json = serde_json::to_string(&value)
        .map_err(|err| format!("序列化配置失败: {err}"))?;

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

    // Persist the vault after writing secrets.
    app_secrets.save().map_err(|e| format!("保存密钥库失败: {e}"))?;

    Ok(AppSettingsResult {
        settings_json: Some(persisted_json),
        db_path: db_path.to_string_lossy().to_string(),
    })
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
        return Err(format!("角色卡内容超过上限 {MAX_CHARACTERS_JSON_BYTES} bytes"));
    }

    let value: serde_json::Value =
        serde_json::from_str(&characters_json).map_err(|err| format!("角色卡不是合法 JSON: {err}"))?;
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
    let parsed: serde_json::Value = serde_json::from_str(&session_json)
        .map_err(|err| format!("会话 JSON 不合法: {err}"))?;

    let id = parsed.get("id").and_then(|v| v.as_str()).unwrap_or("");
    if id.is_empty() {
        return Err("会话 ID 不能为空".to_string());
    }
    let name = parsed.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let provider = parsed.get("provider").and_then(|v| v.as_str()).unwrap_or("");
    let model = parsed.get("model").and_then(|v| v.as_str()).unwrap_or("");
    let created_at = parsed.get("createdAt").and_then(|v| v.as_i64()).unwrap_or(0);

    let (conn, ..) = open_project_db(&workspace_path)?;
    conn.execute(
        "INSERT INTO sessions (id, name, provider, model, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           provider = excluded.provider,
           model = excluded.model,
           created_at = excluded.created_at",
        params![id, name, provider, model, created_at],
    )
    .map_err(|err| format!("保存会话失败: {err}"))?;

    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionListResult {
    pub(crate) sessions_json: String,
}

#[tauri::command]
pub(crate) fn load_sessions(workspace_path: String) -> Result<SessionListResult, String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    let mut stmt = conn
        .prepare("SELECT id, name, provider, model, created_at FROM sessions ORDER BY created_at DESC, id ASC")
        .map_err(|err| format!("查询会话失败: {err}"))?;

    let sessions: Vec<serde_json::Value> = stmt
        .query_map([], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "provider": row.get::<_, String>(2)?,
                "model": row.get::<_, String>(3)?,
                "createdAt": row.get::<_, i64>(4)?,
            }))
        })
        .map_err(|err| format!("读取会话列表失败: {err}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(SessionListResult {
        sessions_json: serde_json::to_string(&sessions)
            .map_err(|err| format!("序列化会话列表失败: {err}"))?,
    })
}

#[tauri::command]
pub(crate) fn delete_session(workspace_path: String, session_id: String) -> Result<(), String> {
    let (conn, ..) = open_project_db(&workspace_path)?;
    conn.execute("DELETE FROM sessions WHERE id = ?1", params![session_id])
        .map_err(|err| format!("删除会话失败: {err}"))?;
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
    let tx = conn.unchecked_transaction()
        .map_err(|err| format!("开启事务失败: {err}"))?;

    // 全量替换语义：先删除该 session 的所有旧消息，再插入新消息。
    // 这样 clearMessages(空数组) 和 resetToMessage(截断数组) 才能正确清理旧数据。
    tx.execute("DELETE FROM messages WHERE session_id = ?1", params![session_id])
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

        // 使用 INSERT OR IGNORE：DELETE 已清空当前 session 的消息，
        // 如果 id 冲突（来自其他 session 的消息），跳过而非覆盖，避免跨 session 数据破坏
        tx.execute(
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
    }

    tx.commit().map_err(|err| format!("提交消息事务失败: {err}"))?;

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
    // contextCheckpoint / question），供 buildEffectiveContextMessages 重建压缩
    // 历史与上下文成员资格。
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
             FROM checkpoint_timeline WHERE session_id = ?1 ORDER BY id".into(),
            vec![sid.clone().into()],
        )
    } else {
        (
            "SELECT id, session_id, message_id, sha, label, file_count, created_at
             FROM checkpoint_timeline ORDER BY id".into(),
            vec![],
        )
    };

    let mut stmt = conn.prepare(&sql)
        .map_err(|err| format!("查询 checkpoint 记录失败: {err}"))?;

    let records = stmt.query_map(
        rusqlite::params_from_iter(params.iter()),
        |row| {
            Ok(CheckpointRecord {
                id: row.get(0)?,
                session_id: row.get(1)?,
                message_id: row.get(2)?,
                sha: row.get(3)?,
                label: row.get(4)?,
                file_count: row.get(5)?,
                created_at: row.get(6)?,
            })
        },
    )
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
    let (conn, ..) = open_project_db(workspace_path)?;
    conn.query_row(
        "SELECT value FROM app_storage WHERE app_id = ?1 AND key = ?2",
        params![app_id, key],
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
    let (conn, ..) = open_project_db(workspace_path)?;
    conn.execute(
        "INSERT INTO app_storage (app_id, key, value, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(app_id, key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at",
        params![app_id, key, value, unix_millis()?],
    )
    .map_err(|err| format!("保存 app_storage 失败: {err}"))?;
    Ok(())
}

pub(crate) fn papr_storage_delete(
    workspace_path: &str,
    app_id: &str,
    key: &str,
) -> Result<(), String> {
    let (conn, ..) = open_project_db(workspace_path)?;
    conn.execute(
        "DELETE FROM app_storage WHERE app_id = ?1 AND key = ?2",
        params![app_id, key],
    )
    .map_err(|err| format!("删除 app_storage 失败: {err}"))?;
    Ok(())
}

pub(crate) fn papr_storage_keys(
    workspace_path: &str,
    app_id: &str,
) -> Result<Vec<String>, String> {
    let (conn, ..) = open_project_db(workspace_path)?;
    let mut stmt = conn
        .prepare("SELECT key FROM app_storage WHERE app_id = ?1 ORDER BY key")
        .map_err(|err| format!("查询 app_storage keys 失败: {err}"))?;
    let keys: Vec<String> = stmt
        .query_map(params![app_id], |row| row.get::<_, String>(0))
        .map_err(|err| format!("读取 app_storage keys 失败: {err}"))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(keys)
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

pub(crate) fn papr_save_permission_settings(settings_json: &str) -> Result<(), String> {
    let (conn, _) = open_app_db()?;
    conn.execute(
        "INSERT INTO settings (key, value, data_type, updated_at)
         VALUES (?1, ?2, 'json', ?3)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           data_type = excluded.data_type,
           updated_at = excluded.updated_at",
        params![PAPR_APP_PERMISSION_SETTINGS_KEY, settings_json, unix_millis()?],
    )
    .map_err(|err| format!("保存 Papr 权限设置失败: {err}"))?;
    Ok(())
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
    }
}
