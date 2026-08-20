use serde::Serialize;

use crate::papr_runtime::permission;
use crate::papr_runtime::permission::AppPermissionSettings;

#[tauri::command]
pub fn papr_storage_get(app_id: String, key: String) -> Result<Option<String>, String> {
    let ctx = crate::papr_runtime::app_context::get(&app_id)?;
    let manifest = crate::papr_runtime::manifest::get_manifest(&app_id)?;
    permission::check_permission(&manifest, &app_id, "storage:read")?;
    crate::db::papr_storage_get(&ctx.workspace_path, &app_id, &key)
}

#[tauri::command]
pub fn papr_storage_set(app_id: String, key: String, value: String) -> Result<(), String> {
    let ctx = crate::papr_runtime::app_context::get(&app_id)?;
    let manifest = crate::papr_runtime::manifest::get_manifest(&app_id)?;
    permission::check_permission(&manifest, &app_id, "storage:write")?;
    crate::db::papr_storage_set(&ctx.workspace_path, &app_id, &key, &value)
}

#[tauri::command]
pub fn papr_storage_delete(app_id: String, key: String) -> Result<(), String> {
    let ctx = crate::papr_runtime::app_context::get(&app_id)?;
    let manifest = crate::papr_runtime::manifest::get_manifest(&app_id)?;
    permission::check_permission(&manifest, &app_id, "storage:write")?;
    crate::db::papr_storage_delete(&ctx.workspace_path, &app_id, &key)
}

#[tauri::command]
pub fn papr_storage_keys(app_id: String) -> Result<Vec<String>, String> {
    let ctx = crate::papr_runtime::app_context::get(&app_id)?;
    let manifest = crate::papr_runtime::manifest::get_manifest(&app_id)?;
    permission::check_permission(&manifest, &app_id, "storage:read")?;
    crate::db::papr_storage_keys(&ctx.workspace_path, &app_id)
}

/// app_publish 追加结果：seq 供事件排序，ts 供 UI 展示。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaprInboxAppendResult {
    pub seq: u64,
    pub ts: i64,
}

/// 原子追加一条事件到 app 的 inbox 频道（agent 工具 app_publish 的数据面）。
/// 并发安全由 db::papr_inbox_append 的进程锁 + BEGIN IMMEDIATE 保证。
#[tauri::command]
pub fn papr_inbox_append(
    app_id: String,
    channel: String,
    payload: serde_json::Value,
    cap: Option<usize>,
) -> Result<PaprInboxAppendResult, String> {
    let ctx = crate::papr_runtime::app_context::get(&app_id)?;
    let manifest = crate::papr_runtime::manifest::get_manifest(&app_id)?;
    permission::check_permission(&manifest, &app_id, "storage:write")?;
    let (seq, ts) = crate::db::papr_inbox_append(
        &ctx.workspace_path,
        &app_id,
        &channel,
        &payload.to_string(),
        cap,
    )?;
    Ok(PaprInboxAppendResult { seq, ts })
}

#[tauri::command]
pub fn papr_get_manifest(app_id: String) -> Result<crate::papr_runtime::manifest::PaprManifest, String> {
    crate::papr_runtime::manifest::get_manifest(&app_id)
}

#[tauri::command]
pub fn papr_get_app_settings() -> Result<AppPermissionSettings, String> {
    Ok(permission::get_app_settings())
}

#[tauri::command]
pub fn papr_set_app_settings(settings: AppPermissionSettings) -> Result<(), String> {
    permission::set_app_settings(settings);
    Ok(())
}
