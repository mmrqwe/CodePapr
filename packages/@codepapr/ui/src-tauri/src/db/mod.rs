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
const PROJECT_STORAGE_DIR: &str = ".CodePapr";
const PROJECT_DB_FILE: &str = "project.sqlite";
const PROJECT_STATE_KEY: &str = "project.state";
const LEGACY_PROJECT_FILE: &str = ".CodePapr/project.json";
const LEGACY_STATE_FILE: &str = ".CodePapr/state.json";
const MAX_SETTINGS_JSON_BYTES: usize = 200_000;
const MAX_CHARACTERS_JSON_BYTES: usize = 50_000_000;
const MAX_PROJECT_STATE_JSON_BYTES: usize = 5_000_000;

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
         );",
    )
    .map_err(|err| format!("初始化项目状态表失败: {err}"))?;

    Ok((conn, workspace, db_path))
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
}
