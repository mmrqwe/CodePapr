//! Thin Tauri command wrappers. Engine I/O is hosted by `codepapr-server`.
//! Invoke names and Rust parameter names stay identical to the previous in-process
//! commands so the frontend does not need to change.

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::host;
use crate::secrets::{MENTOR_KEY_ACCOUNT, PRIMARY_KEY_ACCOUNT};
use crate::vault::AppSecrets;

async fn rpc(app: &AppHandle, method: &str, params: Value) -> Result<Value, String> {
    host::call(app, method, params).await
}

async fn rpc_ok(app: &AppHandle, method: &str, params: Value) -> Result<(), String> {
    let _ = rpc(app, method, params).await?;
    Ok(())
}

fn persist_vault_from_settings(app: &AppHandle, settings_json: &str) {
    let Ok(value) = serde_json::from_str::<Value>(settings_json) else {
        return;
    };
    let Some(obj) = value.as_object() else {
        return;
    };
    let secrets = app.state::<AppSecrets>();
    let mut changed = false;
    for (field, account) in [("apiKey", PRIMARY_KEY_ACCOUNT), ("mentorApiKey", MENTOR_KEY_ACCOUNT)] {
        if let Some(secret) = obj.get(field).and_then(|v| v.as_str()) {
            if secrets.set_secret(account, secret).is_ok() {
                changed = true;
            }
        }
    }
    if changed {
        let _ = secrets.save();
    }
}

// ── DB ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn load_app_settings(app: AppHandle) -> Result<Value, String> {
    rpc(&app, "db/loadSettings", json!({})).await
}

#[tauri::command]
pub async fn save_app_settings(app: AppHandle, settings_json: String) -> Result<Value, String> {
    persist_vault_from_settings(&app, &settings_json);
    rpc(&app, "db/saveSettings", json!({ "settingsJson": settings_json })).await
}

#[tauri::command]
pub async fn note_recent_workspace(app: AppHandle, path: String) -> Result<Value, String> {
    rpc(&app, "db/noteRecentWorkspace", json!({ "path": path })).await
}

#[tauri::command]
pub async fn set_recent_workspaces(app: AppHandle, workspaces_json: String) -> Result<Value, String> {
    rpc(&app, "db/setRecentWorkspaces", json!({ "workspacesJson": workspaces_json })).await
}

#[tauri::command]
pub async fn load_app_characters(app: AppHandle) -> Result<Value, String> {
    rpc(&app, "db/loadCharacters", json!({})).await
}

#[tauri::command]
pub async fn save_app_characters(app: AppHandle, characters_json: String) -> Result<Value, String> {
    rpc(&app, "db/saveCharacters", json!({ "charactersJson": characters_json })).await
}

#[tauri::command]
pub async fn load_project_state(app: AppHandle, workspace_path: String) -> Result<Value, String> {
    rpc(&app, "db/loadProjectState", json!({ "workspacePath": workspace_path })).await
}

#[tauri::command]
pub async fn save_project_state(
    app: AppHandle,
    workspace_path: String,
    state_json: String,
    purge_deleted_content: Option<bool>,
) -> Result<Value, String> {
    rpc(&app, "db/saveProjectState", json!({
        "workspacePath": workspace_path,
        "stateJson": state_json,
        "purgeDeletedContent": purge_deleted_content,
    })).await
}

#[tauri::command]
pub async fn save_session(app: AppHandle, workspace_path: String, session_json: String) -> Result<(), String> {
    rpc_ok(&app, "db/saveSession", json!({ "workspacePath": workspace_path, "sessionJson": session_json })).await
}

#[tauri::command]
pub async fn load_sessions(app: AppHandle, workspace_path: String) -> Result<Value, String> {
    rpc(&app, "db/loadSessions", json!({ "workspacePath": workspace_path })).await
}

#[tauri::command]
pub async fn load_archived_sessions(app: AppHandle, workspace_path: String) -> Result<Value, String> {
    rpc(&app, "db/loadArchivedSessions", json!({ "workspacePath": workspace_path })).await
}

#[tauri::command]
pub async fn archive_session(app: AppHandle, workspace_path: String, session_id: String) -> Result<(), String> {
    rpc_ok(&app, "db/archiveSession", json!({ "workspacePath": workspace_path, "sessionId": session_id })).await
}

#[tauri::command]
pub async fn restore_session(app: AppHandle, workspace_path: String, session_id: String) -> Result<(), String> {
    rpc_ok(&app, "db/restoreSession", json!({ "workspacePath": workspace_path, "sessionId": session_id })).await
}

#[tauri::command]
pub async fn delete_session(app: AppHandle, workspace_path: String, session_id: String) -> Result<(), String> {
    rpc_ok(&app, "db/deleteSession", json!({ "workspacePath": workspace_path, "sessionId": session_id })).await
}

#[tauri::command]
pub async fn save_message_batch(
    app: AppHandle,
    workspace_path: String,
    session_id: String,
    messages_json: String,
) -> Result<(), String> {
    rpc_ok(&app, "db/saveMessageBatch", json!({
        "workspacePath": workspace_path,
        "sessionId": session_id,
        "messagesJson": messages_json,
    })).await
}

#[tauri::command]
pub async fn load_session_messages(
    app: AppHandle,
    workspace_path: String,
    session_id: String,
) -> Result<Value, String> {
    rpc(&app, "db/loadSessionMessages", json!({ "workspacePath": workspace_path, "sessionId": session_id })).await
}

#[tauri::command]
pub async fn load_all_session_messages(app: AppHandle, workspace_path: String) -> Result<Value, String> {
    rpc(&app, "db/loadAllSessionMessages", json!({ "workspacePath": workspace_path })).await
}

#[tauri::command]
pub async fn aggregate_tool_usage(app: AppHandle, workspace_path: String) -> Result<Value, String> {
    rpc(&app, "db/aggregateToolUsage", json!({ "workspacePath": workspace_path })).await
}

#[tauri::command]
pub async fn aggregate_session_runtime(app: AppHandle, workspace_path: String) -> Result<Value, String> {
    rpc(&app, "db/aggregateSessionRuntime", json!({ "workspacePath": workspace_path })).await
}

#[tauri::command]
pub async fn save_project_meta(app: AppHandle, workspace_path: String, key: String, value: String) -> Result<(), String> {
    rpc_ok(&app, "db/saveProjectMeta", json!({ "workspacePath": workspace_path, "key": key, "value": value })).await
}

#[tauri::command]
pub async fn load_project_meta(app: AppHandle, workspace_path: String, key: String) -> Result<Value, String> {
    rpc(&app, "db/loadProjectMeta", json!({ "workspacePath": workspace_path, "key": key })).await
}

#[tauri::command]
pub async fn load_all_project_meta(app: AppHandle, workspace_path: String) -> Result<Value, String> {
    rpc(&app, "db/loadAllProjectMeta", json!({ "workspacePath": workspace_path })).await
}

#[tauri::command]
pub async fn load_context_surface(
    app: AppHandle,
    workspace_path: String,
    session_id: String,
    generation: Option<i64>,
) -> Result<Value, String> {
    rpc(&app, "db/loadContextSurface", json!({
        "workspacePath": workspace_path, "sessionId": session_id, "generation": generation,
    })).await
}

#[tauri::command]
pub async fn save_context_surface(
    app: AppHandle,
    workspace_path: String,
    session_id: String,
    generation: i64,
    parent_generation: Option<i64>,
    compaction_id: Option<String>,
    render_params_json: String,
    nodes_json: String,
) -> Result<(), String> {
    rpc_ok(&app, "db/saveContextSurface", json!({
        "workspacePath": workspace_path,
        "sessionId": session_id,
        "generation": generation,
        "parentGeneration": parent_generation,
        "compactionId": compaction_id,
        "renderParamsJson": render_params_json,
        "nodesJson": nodes_json,
    })).await
}

#[tauri::command]
pub async fn discard_context_surfaces_from_generation(
    app: AppHandle,
    workspace_path: String,
    session_id: String,
    from_generation: i64,
) -> Result<(), String> {
    rpc_ok(&app, "db/discardContextSurfacesFromGeneration", json!({
        "workspacePath": workspace_path, "sessionId": session_id, "fromGeneration": from_generation,
    })).await
}

#[tauri::command]
pub async fn commit_context_compaction(app: AppHandle, workspace_path: String, request_json: String) -> Result<Value, String> {
    rpc(&app, "db/commitContextCompaction", json!({ "workspacePath": workspace_path, "requestJson": request_json })).await
}

#[tauri::command]
pub async fn mark_context_compaction_failed(app: AppHandle, workspace_path: String, failure_json: String) -> Result<(), String> {
    rpc_ok(&app, "db/markContextCompactionFailed", json!({ "workspacePath": workspace_path, "failureJson": failure_json })).await
}

#[tauri::command]
pub async fn load_context_compactions(
    app: AppHandle,
    workspace_path: String,
    session_id: String,
    limit: Option<i64>,
) -> Result<Value, String> {
    rpc(&app, "db/loadContextCompactions", json!({
        "workspacePath": workspace_path, "sessionId": session_id, "limit": limit,
    })).await
}

#[tauri::command]
pub async fn save_checkpoint_record(
    app: AppHandle,
    workspace_path: String,
    session_id: String,
    message_id: String,
    sha: String,
    label: String,
    file_count: i64,
) -> Result<(), String> {
    rpc_ok(&app, "db/saveCheckpointRecord", json!({
        "workspacePath": workspace_path,
        "sessionId": session_id,
        "messageId": message_id,
        "sha": sha,
        "label": label,
        "fileCount": file_count,
    })).await
}

#[tauri::command]
pub async fn load_checkpoint_records(app: AppHandle, workspace_path: String, session_id: Option<String>) -> Result<Value, String> {
    rpc(&app, "db/loadCheckpointRecords", json!({ "workspacePath": workspace_path, "sessionId": session_id })).await
}

#[tauri::command]
pub async fn delete_checkpoint_by_message(app: AppHandle, workspace_path: String, message_id: String) -> Result<(), String> {
    rpc_ok(&app, "db/deleteCheckpointByMessage", json!({ "workspacePath": workspace_path, "messageId": message_id })).await
}

#[tauri::command]
pub async fn delete_checkpoints_for_session(app: AppHandle, workspace_path: String, session_id: String) -> Result<(), String> {
    rpc_ok(&app, "db/deleteCheckpointsForSession", json!({ "workspacePath": workspace_path, "sessionId": session_id })).await
}

#[tauri::command]
pub async fn save_projectgraph_cache(app: AppHandle, workspace_path: String, cache_data: String) -> Result<(), String> {
    rpc_ok(&app, "db/saveProjectgraphCache", json!({ "workspacePath": workspace_path, "cacheData": cache_data })).await
}

#[tauri::command]
pub async fn load_projectgraph_cache(app: AppHandle, workspace_path: String) -> Result<Value, String> {
    rpc(&app, "db/loadProjectgraphCache", json!({ "workspacePath": workspace_path })).await
}

#[tauri::command]
pub async fn cache_get(app: AppHandle, key: String) -> Result<Value, String> {
    rpc(&app, "db/cacheGet", json!({ "key": key })).await
}

#[tauri::command]
pub async fn cache_set(app: AppHandle, key: String, value: String, ttl_ms: Option<i64>) -> Result<(), String> {
    rpc_ok(&app, "db/cacheSet", json!({ "key": key, "value": value, "ttlMs": ttl_ms })).await
}

#[tauri::command]
pub async fn cache_remove(app: AppHandle, key: String) -> Result<(), String> {
    rpc_ok(&app, "db/cacheRemove", json!({ "key": key })).await
}

// ── MCP ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn mcp_list_tools(
    app: AppHandle,
    settings: codepapr_core::mcp_host::McpSettings,
    refresh: Option<bool>,
) -> Result<Value, String> {
    rpc(&app, "mcp/listTools", json!({ "settings": settings, "refresh": refresh.unwrap_or(false) })).await
}

#[tauri::command]
pub async fn mcp_update_settings(app: AppHandle, settings: codepapr_core::mcp_host::McpSettings) -> Result<(), String> {
    rpc_ok(&app, "mcp/updateSettings", json!({ "settings": settings })).await
}

#[tauri::command]
pub async fn mcp_call_tool(
    app: AppHandle,
    settings: Option<codepapr_core::mcp_host::McpSettings>,
    server_id: String,
    tool_name: String,
    arguments: Value,
) -> Result<Value, String> {
    rpc(&app, "mcp/callTool", json!({
        "settings": settings, "serverId": server_id, "toolName": tool_name, "arguments": arguments,
    })).await
}

#[tauri::command]
pub async fn mcp_list_status(app: AppHandle, settings: codepapr_core::mcp_host::McpSettings) -> Result<Value, String> {
    rpc(&app, "mcp/listStatus", json!({ "settings": settings })).await
}

#[tauri::command]
pub async fn mcp_disconnect_all(app: AppHandle) -> Result<Value, String> {
    rpc(&app, "mcp/disconnectAll", json!({})).await
}

#[tauri::command]
pub async fn mcp_test_server(app: AppHandle, settings: codepapr_core::mcp_host::McpSettings, server_id: String) -> Result<Value, String> {
    rpc(&app, "mcp/testServer", json!({ "settings": settings, "serverId": server_id })).await
}

#[tauri::command]
pub async fn mcp_preview_server(
    app: AppHandle,
    url: String,
    transport: String,
    timeout_seconds: Option<u64>,
) -> Result<Value, String> {
    rpc(&app, "mcp/previewServer", json!({ "url": url, "transport": transport, "timeoutSeconds": timeout_seconds })).await
}

#[tauri::command]
pub async fn mcp_disconnect_server(app: AppHandle, settings: codepapr_core::mcp_host::McpSettings, server_id: String) -> Result<Value, String> {
    rpc(&app, "mcp/disconnectServer", json!({ "settings": settings, "serverId": server_id })).await
}

#[tauri::command]
pub async fn mcp_confirm_response(app: AppHandle, request_id: String, approved: bool) -> Result<(), String> {
    rpc_ok(&app, "mcp/confirmResponse", json!({ "requestId": request_id, "approved": approved })).await
}

#[tauri::command]
pub async fn mcp_health_check(app: AppHandle) -> Result<Value, String> {
    rpc(&app, "mcp/healthCheck", json!({})).await
}

// ── FS ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_workspace_files(
    app: AppHandle,
    workspace_path: String,
    relative_path: Option<String>,
    max_depth: Option<usize>,
    include_codepapr_apps: Option<bool>,
) -> Result<Value, String> {
    rpc(&app, "fs/listFiles", json!({
        "workspacePath": workspace_path,
        "relativePath": relative_path,
        "maxDepth": max_depth,
        "includeCodepaprApps": include_codepapr_apps,
    })).await
}

#[tauri::command]
pub async fn check_external_path(app: AppHandle, workspace_path: String, raw_path: String) -> Result<Value, String> {
    rpc(&app, "fs/checkExternalPath", json!({ "workspacePath": workspace_path, "rawPath": raw_path })).await
}

#[tauri::command]
pub async fn get_external_access_policy(app: AppHandle) -> Result<Value, String> {
    rpc(&app, "fs/getExternalAccessPolicy", json!({})).await
}

#[tauri::command]
pub async fn set_external_access_yolo(app: AppHandle, enabled: bool) -> Result<Value, String> {
    rpc(&app, "fs/setExternalAccessYolo", json!({ "enabled": enabled })).await
}

#[tauri::command]
pub async fn grant_external_access(app: AppHandle, workspace_path: String, raw_path: String, scope: String) -> Result<Value, String> {
    rpc(&app, "fs/grantExternalAccess", json!({ "workspacePath": workspace_path, "rawPath": raw_path, "scope": scope })).await
}

#[tauri::command]
pub async fn revoke_external_access(app: AppHandle, raw_path: String, scope: String) -> Result<Value, String> {
    rpc(&app, "fs/revokeExternalAccess", json!({ "rawPath": raw_path, "scope": scope })).await
}

#[tauri::command]
pub async fn clear_external_access_grants(app: AppHandle) -> Result<Value, String> {
    rpc(&app, "fs/clearExternalAccessGrants", json!({})).await
}

#[tauri::command]
pub async fn ensure_default_project(app: AppHandle) -> Result<Value, String> {
    let base = app.path().document_dir().ok().or_else(|| app.path().app_local_data_dir().ok());
    rpc(&app, "fs/ensureDefaultProject", json!({
        "baseOverride": base.map(|p| p.to_string_lossy().to_string()),
    })).await
}

#[tauri::command]
pub async fn compute_project_stats(app: AppHandle, workspace_path: String) -> Result<Value, String> {
    rpc(&app, "fs/computeProjectStats", json!({ "workspacePath": workspace_path })).await
}

#[tauri::command]
pub async fn cancel_project_stats(app: AppHandle, workspace_path: String) -> Result<(), String> {
    rpc_ok(&app, "fs/cancelProjectStats", json!({ "workspacePath": workspace_path })).await
}

#[tauri::command]
pub async fn read_text_file(
    app: AppHandle,
    workspace_path: String,
    relative_path: String,
    max_bytes: Option<usize>,
    start_line: Option<usize>,
    end_line: Option<usize>,
    around_line: Option<usize>,
    context_lines: Option<usize>,
) -> Result<Value, String> {
    rpc(&app, "fs/readTextFile", json!({
        "workspacePath": workspace_path,
        "relativePath": relative_path,
        "maxBytes": max_bytes,
        "startLine": start_line,
        "endLine": end_line,
        "aroundLine": around_line,
        "contextLines": context_lines,
    })).await
}

#[tauri::command]
pub async fn read_text_files_batch(
    app: AppHandle,
    workspace_path: String,
    relative_paths: Vec<String>,
    max_bytes: Option<usize>,
) -> Result<Value, String> {
    rpc(&app, "fs/readTextFilesBatch", json!({
        "workspacePath": workspace_path, "relativePaths": relative_paths, "maxBytes": max_bytes,
    })).await
}

#[tauri::command]
pub async fn read_image_file(
    app: AppHandle,
    workspace_path: String,
    relative_path: String,
    max_bytes: Option<usize>,
) -> Result<Value, String> {
    rpc(&app, "fs/readImageFile", json!({
        "workspacePath": workspace_path, "relativePath": relative_path, "maxBytes": max_bytes,
    })).await
}

#[tauri::command]
pub async fn read_artifact(
    app: AppHandle,
    workspace_path: String,
    artifact_id: String,
    offset_chars: Option<usize>,
    limit_chars: Option<usize>,
) -> Result<Value, String> {
    rpc(&app, "fs/readArtifact", json!({
        "workspacePath": workspace_path,
        "artifactId": artifact_id,
        "offsetChars": offset_chars,
        "limitChars": limit_chars,
    })).await
}

#[tauri::command]
pub async fn write_text_file(
    app: AppHandle,
    workspace_path: String,
    relative_path: String,
    content: String,
) -> Result<Value, String> {
    rpc(&app, "fs/writeTextFile", json!({
        "workspacePath": workspace_path, "relativePath": relative_path, "content": content,
    })).await
}

#[tauri::command]
pub async fn delete_workspace_file(app: AppHandle, workspace_path: String, relative_path: String) -> Result<Value, String> {
    rpc(&app, "fs/deleteFile", json!({ "workspacePath": workspace_path, "relativePath": relative_path })).await
}

#[tauri::command]
pub async fn delete_workspace_dir(app: AppHandle, workspace_path: String, relative_path: String) -> Result<Value, String> {
    rpc(&app, "fs/deleteDir", json!({ "workspacePath": workspace_path, "relativePath": relative_path })).await
}

#[tauri::command]
pub async fn save_chat_image(
    app: AppHandle,
    workspace_path: String,
    media_type: String,
    data_base64: String,
) -> Result<Value, String> {
    rpc(&app, "fs/saveChatImage", json!({
        "workspacePath": workspace_path, "mediaType": media_type, "dataBase64": data_base64,
    })).await
}

#[tauri::command]
pub async fn load_chat_images(app: AppHandle, workspace_path: String, paths: Vec<String>) -> Result<Value, String> {
    rpc(&app, "fs/loadChatImages", json!({ "workspacePath": workspace_path, "paths": paths })).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn search_workspace_text(
    app: AppHandle,
    workspace_path: String,
    query: String,
    case_sensitive: Option<bool>,
    is_regexp: Option<bool>,
    context_lines: Option<usize>,
    max_results: Option<usize>,
    max_matches_per_file: Option<usize>,
    max_bytes_per_file: Option<usize>,
    include_codepapr_apps: Option<bool>,
    include_ignored_dirs: Option<bool>,
    include_globs: Option<Vec<String>>,
    exclude_globs: Option<Vec<String>>,
) -> Result<Value, String> {
    rpc(&app, "fs/search", json!({
        "workspacePath": workspace_path,
        "query": query,
        "caseSensitive": case_sensitive,
        "isRegexp": is_regexp,
        "contextLines": context_lines,
        "maxResults": max_results,
        "maxMatchesPerFile": max_matches_per_file,
        "maxBytesPerFile": max_bytes_per_file,
        "includeCodepaprApps": include_codepapr_apps,
        "includeIgnoredDirs": include_ignored_dirs,
        "includeGlobs": include_globs,
        "excludeGlobs": exclude_globs,
    })).await
}

#[tauri::command]
pub async fn search_workspace_paths(
    app: AppHandle,
    workspace_path: String,
    query: String,
    case_sensitive: Option<bool>,
    is_regexp: Option<bool>,
    max_results: Option<usize>,
    include_codepapr_apps: Option<bool>,
    include_ignored_dirs: Option<bool>,
    include_globs: Option<Vec<String>>,
    exclude_globs: Option<Vec<String>>,
) -> Result<Value, String> {
    rpc(&app, "fs/searchPaths", json!({
        "workspacePath": workspace_path,
        "query": query,
        "caseSensitive": case_sensitive,
        "isRegexp": is_regexp,
        "maxResults": max_results,
        "includeCodepaprApps": include_codepapr_apps,
        "includeIgnoredDirs": include_ignored_dirs,
        "includeGlobs": include_globs,
        "excludeGlobs": exclude_globs,
    })).await
}

#[tauri::command]
pub async fn start_workspace_watcher(app: AppHandle, workspace_path: String) -> Result<(), String> {
    rpc_ok(&app, "fs/startWatcher", json!({ "workspacePath": workspace_path })).await
}

#[tauri::command]
pub async fn stop_workspace_watcher(app: AppHandle) -> Result<(), String> {
    rpc_ok(&app, "fs/stopWatcher", json!({})).await
}

// ── Shell ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn run_workspace_command(
    app: AppHandle,
    workspace_path: String,
    command: String,
    args: Option<Vec<String>>,
    timeout_seconds: Option<u64>,
    workdir: Option<String>,
    cancel_token: Option<String>,
) -> Result<Value, String> {
    rpc(&app, "shell/execute", json!({
        "workspacePath": workspace_path,
        "command": command,
        "args": args,
        "timeoutSeconds": timeout_seconds,
        "workdir": workdir,
        "cancelToken": cancel_token,
    })).await
}

#[tauri::command]
pub async fn run_workspace_shell_command(
    app: AppHandle,
    workspace_path: String,
    command: String,
    workdir: Option<String>,
    timeout_seconds: Option<u64>,
    sandbox: Option<Value>,
    cancel_token: Option<String>,
) -> Result<Value, String> {
    rpc(&app, "shell/executeShell", json!({
        "workspacePath": workspace_path,
        "command": command,
        "workdir": workdir,
        "timeoutSeconds": timeout_seconds,
        "sandbox": sandbox,
        "cancelToken": cancel_token,
    })).await
}

#[tauri::command]
pub async fn cancel_running_command(app: AppHandle, token: String) -> Result<Value, String> {
    rpc(&app, "shell/cancel", json!({ "token": token })).await
}

/// 高危命令三值裁决（纯字符串分析，无副作用）：UI exec handler 在调用执行
/// 命令前询问 verdict，Confirm 级走用户确认 + 检查点，与 Rust 宿主入口层同一套规则。
#[tauri::command]
pub fn classify_dangerous_command(command_line: String) -> Result<Value, String> {
    Ok(match codepapr_core::shell::dangerous::classify_dangerous_command(&command_line) {
        codepapr_core::shell::dangerous::DangerVerdict::Block(reason) => {
            json!({ "verdict": "block", "reason": reason })
        }
        codepapr_core::shell::dangerous::DangerVerdict::Confirm(reason) => {
            json!({ "verdict": "confirm", "reason": reason })
        }
        codepapr_core::shell::dangerous::DangerVerdict::Allow => json!({ "verdict": "allow" }),
    })
}

#[tauri::command]
pub async fn start_workspace_background_command(
    app: AppHandle,
    workspace_path: String,
    command: String,
    args: Option<Vec<String>>,
    workdir: Option<String>,
    preview_url: Option<String>,
    sandbox: Option<Value>,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<Value, String> {
    rpc(&app, "shell/startBackground", json!({
        "workspacePath": workspace_path,
        "command": command,
        "args": args,
        "workdir": workdir,
        "previewUrl": preview_url,
        "sandbox": sandbox,
        "env": env,
    })).await
}

#[tauri::command]
pub async fn start_workspace_shell_background_command(
    app: AppHandle,
    workspace_path: String,
    command: String,
    workdir: Option<String>,
    preview_url: Option<String>,
    sandbox: Option<Value>,
) -> Result<Value, String> {
    rpc(&app, "shell/startShellBackground", json!({
        "workspacePath": workspace_path,
        "command": command,
        "workdir": workdir,
        "previewUrl": preview_url,
        "sandbox": sandbox,
    })).await
}

#[tauri::command]
pub async fn start_app_background_command(
    app: AppHandle,
    workspace_path: String,
    app_id: String,
    command: String,
    args: Option<Vec<String>>,
    preview_url: Option<String>,
    sandbox: Option<Value>,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<Value, String> {
    rpc(&app, "shell/startAppBackground", json!({
        "workspacePath": workspace_path,
        "appId": app_id,
        "command": command,
        "args": args,
        "previewUrl": preview_url,
        "sandbox": sandbox,
        "env": env,
    })).await
}

#[tauri::command]
pub async fn list_background_processes(app: AppHandle, workspace_path: Option<String>) -> Result<Value, String> {
    rpc(&app, "shell/listBackground", json!({ "workspacePath": workspace_path })).await
}

#[tauri::command]
pub async fn log_ui_event(app: AppHandle, workspace_path: String, message: String) -> Result<(), String> {
    rpc_ok(&app, "shell/logUiEvent", json!({ "workspacePath": workspace_path, "message": message })).await
}

#[tauri::command]
pub async fn background_process_alive(app: AppHandle, pid: u32) -> Result<bool, String> {
    let value = rpc(&app, "shell/backgroundAlive", json!({ "pid": pid })).await?;
    Ok(value.as_bool().unwrap_or(false))
}

#[tauri::command]
pub async fn background_process_exit_info(app: AppHandle, pid: u32) -> Result<Value, String> {
    rpc(&app, "shell/backgroundExitInfo", json!({ "pid": pid })).await
}

#[tauri::command]
pub async fn stop_background_process(app: AppHandle, pid: u32, source: Option<String>) -> Result<Value, String> {
    rpc(&app, "shell/stopBackground", json!({ "pid": pid, "source": source })).await
}

#[tauri::command]
pub async fn stop_all_background_processes(
    app: AppHandle,
    workspace_path: Option<String>,
    source: Option<String>,
) -> Result<Value, String> {
    rpc(&app, "shell/stopAllBackground", json!({ "workspacePath": workspace_path, "source": source })).await
}

#[tauri::command]
pub async fn open_shell_session(app: AppHandle, workspace_path: String, shell: Option<String>) -> Result<Value, String> {
    rpc(&app, "shell/openSession", json!({ "workspacePath": workspace_path, "shell": shell })).await
}

#[tauri::command]
pub async fn list_shell_sessions(app: AppHandle, workspace_path: Option<String>) -> Result<Value, String> {
    rpc(&app, "shell/listSessions", json!({ "workspacePath": workspace_path })).await
}

#[tauri::command]
pub async fn read_shell_output(app: AppHandle, session_id: String) -> Result<Value, String> {
    rpc(&app, "shell/readOutput", json!({ "sessionId": session_id })).await
}

#[tauri::command]
pub async fn send_shell_input(app: AppHandle, session_id: String, input: String) -> Result<Value, String> {
    rpc(&app, "shell/sendInput", json!({ "sessionId": session_id, "input": input })).await
}

#[tauri::command]
pub async fn send_shell_command(
    app: AppHandle,
    session_id: String,
    command: String,
    args: Option<Vec<String>>,
) -> Result<Value, String> {
    rpc(&app, "shell/sendCommand", json!({ "sessionId": session_id, "command": command, "args": args })).await
}

#[tauri::command]
pub async fn close_shell_session(app: AppHandle, session_id: String) -> Result<Value, String> {
    rpc(&app, "shell/closeSession", json!({ "sessionId": session_id })).await
}

// ── Git / snapshot / web / task ───────────────────────────────────────

#[tauri::command]
pub async fn git_status(app: AppHandle, workspace_path: String) -> Result<Value, String> {
    rpc(&app, "git/status", json!({ "workspacePath": workspace_path })).await
}

#[tauri::command]
pub async fn git_diff(app: AppHandle, workspace_path: String, staged: Option<bool>, pathspecs: Option<Vec<String>>) -> Result<Value, String> {
    rpc(&app, "git/diff", json!({ "workspacePath": workspace_path, "staged": staged, "pathspecs": pathspecs })).await
}

#[tauri::command]
pub async fn git_log(app: AppHandle, workspace_path: String, limit: Option<usize>) -> Result<Value, String> {
    rpc(&app, "git/log", json!({ "workspacePath": workspace_path, "limit": limit })).await
}

#[tauri::command]
pub async fn git_stage(app: AppHandle, workspace_path: String, all: Option<bool>, pathspecs: Option<Vec<String>>) -> Result<Value, String> {
    rpc(&app, "git/stage", json!({ "workspacePath": workspace_path, "all": all, "pathspecs": pathspecs })).await
}

#[tauri::command]
pub async fn git_commit(
    app: AppHandle,
    workspace_path: String,
    message: String,
    stage_all: Option<bool>,
    pathspecs: Option<Vec<String>>,
    allow_empty: Option<bool>,
) -> Result<Value, String> {
    rpc(&app, "git/commit", json!({
        "workspacePath": workspace_path,
        "message": message,
        "stageAll": stage_all,
        "pathspecs": pathspecs,
        "allowEmpty": allow_empty,
    })).await
}

#[tauri::command]
pub async fn git_branch_list(app: AppHandle, workspace_path: String) -> Result<Value, String> {
    rpc(&app, "git/branchList", json!({ "workspacePath": workspace_path })).await
}

#[tauri::command]
pub async fn git_branch_checkout(
    app: AppHandle,
    workspace_path: String,
    branch_name: String,
    create: Option<bool>,
    create_if_missing: Option<bool>,
    start_point: Option<String>,
) -> Result<Value, String> {
    rpc(&app, "git/branchCheckout", json!({
        "workspacePath": workspace_path,
        "branchName": branch_name,
        "create": create,
        "createIfMissing": create_if_missing,
        "startPoint": start_point,
    })).await
}

#[tauri::command]
pub async fn git_restore_files(
    app: AppHandle,
    workspace_path: String,
    pathspecs: Option<Vec<String>>,
    source: Option<String>,
    include_untracked: Option<bool>,
) -> Result<Value, String> {
    rpc(&app, "git/restoreFiles", json!({
        "workspacePath": workspace_path,
        "pathspecs": pathspecs,
        "source": source,
        "includeUntracked": include_untracked,
    })).await
}

#[tauri::command]
pub async fn snapshot_ensure(app: AppHandle, workspace_path: String) -> Result<Value, String> {
    rpc(&app, "snapshot/ensure", json!({ "workspacePath": workspace_path })).await
}

#[tauri::command]
pub async fn snapshot_create(app: AppHandle, workspace_path: String, label: String) -> Result<Value, String> {
    rpc(&app, "snapshot/create", json!({ "workspacePath": workspace_path, "label": label })).await
}

#[tauri::command]
pub async fn snapshot_list(app: AppHandle, workspace_path: String, limit: Option<usize>) -> Result<Value, String> {
    rpc(&app, "snapshot/list", json!({ "workspacePath": workspace_path, "limit": limit })).await
}

#[tauri::command]
pub async fn snapshot_head_sha(app: AppHandle, workspace_path: String) -> Result<Option<String>, String> {
    let value = rpc(&app, "snapshot/headSha", json!({ "workspacePath": workspace_path })).await?;
    if value.is_null() {
        Ok(None)
    } else {
        Ok(value.as_str().map(|s| s.to_string()))
    }
}

#[tauri::command]
pub async fn restore_plan(app: AppHandle, workspace_path: String, target_sha: String) -> Result<Value, String> {
    rpc(&app, "snapshot/restorePlan", json!({ "workspacePath": workspace_path, "targetSha": target_sha })).await
}

#[tauri::command]
pub async fn restore_execute(app: AppHandle, workspace_path: String, target_sha: String) -> Result<Value, String> {
    rpc(&app, "snapshot/restoreExecute", json!({ "workspacePath": workspace_path, "targetSha": target_sha })).await
}

#[tauri::command]
pub async fn restore_undo(app: AppHandle, workspace_path: String, expected_backup_sha: Option<String>) -> Result<(), String> {
    rpc_ok(&app, "snapshot/restoreUndo", json!({
        "workspacePath": workspace_path, "expectedBackupSha": expected_backup_sha,
    })).await
}

#[tauri::command]
pub async fn snapshot_changed_files(app: AppHandle, workspace_path: String, sha: String) -> Result<Value, String> {
    rpc(&app, "snapshot/changedFiles", json!({ "workspacePath": workspace_path, "sha": sha })).await
}

#[tauri::command]
pub async fn diff_snapshots(app: AppHandle, workspace_path: String, from_sha: String, to_sha: String) -> Result<Value, String> {
    rpc(&app, "snapshot/diff", json!({ "workspacePath": workspace_path, "fromSha": from_sha, "toSha": to_sha })).await
}

#[tauri::command]
pub async fn snapshot_file_content(app: AppHandle, workspace_path: String, sha: String, path: String) -> Result<Value, String> {
    rpc(&app, "snapshot/fileContent", json!({ "workspacePath": workspace_path, "sha": sha, "path": path })).await
}

#[tauri::command]
pub async fn snapshot_index_file_content(app: AppHandle, workspace_path: String, path: String) -> Result<Value, String> {
    rpc(&app, "snapshot/indexFileContent", json!({ "workspacePath": workspace_path, "path": path })).await
}

#[tauri::command]
pub async fn enqueue_workspace_task(
    app: AppHandle,
    task_type: String,
    workspace_path: String,
    relative_path: Option<String>,
    max_depth: Option<usize>,
    max_bytes: Option<usize>,
    command: Option<String>,
    args: Option<Vec<String>>,
    timeout_seconds: Option<u64>,
) -> Result<u64, String> {
    let value = rpc(&app, "task/enqueue", json!({
        "taskType": task_type,
        "workspacePath": workspace_path,
        "relativePath": relative_path,
        "maxDepth": max_depth,
        "maxBytes": max_bytes,
        "command": command,
        "args": args,
        "timeoutSeconds": timeout_seconds,
    })).await?;
    value.as_u64().ok_or_else(|| "invalid task id".to_string())
}

#[tauri::command]
pub async fn poll_workspace_task(app: AppHandle, task_id: u64) -> Result<Value, String> {
    rpc(&app, "task/poll", json!({ "taskId": task_id })).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn search_web(
    app: AppHandle,
    query: String,
    max_results: Option<usize>,
    searxng_enabled: Option<bool>,
    searxng_base_url: Option<String>,
    searxng_categories: Option<String>,
    searxng_time_range: Option<String>,
    searxng_language: Option<String>,
    searxng_safe_search: Option<u8>,
    searxng_engines: Option<String>,
) -> Result<Value, String> {
    rpc(&app, "web/search", json!({
        "query": query,
        "maxResults": max_results,
        "searxngEnabled": searxng_enabled,
        "searxngBaseUrl": searxng_base_url,
        "searxngCategories": searxng_categories,
        "searxngTimeRange": searxng_time_range,
        "searxngLanguage": searxng_language,
        "searxngSafeSearch": searxng_safe_search,
        "searxngEngines": searxng_engines,
    })).await
}

#[tauri::command]
pub async fn fetch_web_url(app: AppHandle, url: String, max_bytes: Option<usize>) -> Result<Value, String> {
    rpc(&app, "web/fetchUrl", json!({ "url": url, "maxBytes": max_bytes })).await
}

#[tauri::command]
pub async fn test_searxng_connection(app: AppHandle, base_url: String) -> Result<Value, String> {
    rpc(&app, "web/testSearxng", json!({ "baseUrl": base_url })).await
}

#[tauri::command]
pub async fn download_web_file(
    app: AppHandle,
    workspace_path: String,
    url: String,
    relative_path: Option<String>,
) -> Result<Value, String> {
    rpc(&app, "web/downloadFile", json!({
        "workspacePath": workspace_path, "url": url, "relativePath": relative_path,
    })).await
}

// ── LSP / symbols / agent ─────────────────────────────────────────────

#[tauri::command]
pub async fn lsp_start_server(app: AppHandle, workspace_path: String, language_id: String) -> Result<Value, String> {
    rpc(&app, "lsp/startServer", json!({ "workspacePath": workspace_path, "languageId": language_id })).await
}

#[tauri::command]
pub async fn lsp_query_availability(app: AppHandle, workspace_path: String, language_id: String) -> Result<Value, String> {
    rpc(&app, "lsp/queryAvailability", json!({ "workspacePath": workspace_path, "languageId": language_id })).await
}

#[tauri::command]
pub async fn lsp_list_components(app: AppHandle) -> Result<Value, String> {
    rpc(&app, "lsp/listComponents", json!({})).await
}

#[tauri::command]
pub async fn lsp_set_disabled_families(app: AppHandle, families: Vec<String>) -> Result<(), String> {
    rpc_ok(&app, "lsp/setDisabledFamilies", json!({ "families": families })).await
}

#[tauri::command]
pub async fn lsp_open_document(
    app: AppHandle,
    workspace_path: String,
    language_id: String,
    relative_path: String,
    content: String,
    version: i32,
    diag_wait_ms: Option<u64>,
) -> Result<Value, String> {
    rpc(&app, "lsp/openDocument", json!({
        "workspacePath": workspace_path,
        "languageId": language_id,
        "relativePath": relative_path,
        "content": content,
        "version": version,
        "diagWaitMs": diag_wait_ms,
    })).await
}

#[tauri::command]
pub async fn lsp_close_document(
    app: AppHandle,
    workspace_path: String,
    language_id: String,
    relative_path: String,
) -> Result<Value, String> {
    rpc(&app, "lsp/closeDocument", json!({
        "workspacePath": workspace_path, "languageId": language_id, "relativePath": relative_path,
    })).await
}

#[tauri::command]
pub async fn lsp_request(
    app: AppHandle,
    workspace_path: String,
    language_id: String,
    method: String,
    params: Value,
) -> Result<Value, String> {
    rpc(&app, "lsp/request", json!({
        "workspacePath": workspace_path,
        "languageId": language_id,
        "method": method,
        "params": params,
    })).await
}

#[tauri::command]
pub async fn lsp_get_diagnostics(
    app: AppHandle,
    workspace_path: String,
    language_id: String,
    relative_path: Option<String>,
) -> Result<Value, String> {
    rpc(&app, "lsp/diagnostics", json!({
        "workspacePath": workspace_path, "languageId": language_id, "relativePath": relative_path,
    })).await
}

#[tauri::command]
pub async fn lsp_stop_server(app: AppHandle, workspace_path: String, language_id: String) -> Result<Value, String> {
    rpc(&app, "lsp/stopServer", json!({ "workspacePath": workspace_path, "languageId": language_id })).await
}

#[tauri::command]
pub async fn lsp_batch_symbols(app: AppHandle, workspace_path: String, files: Value) -> Result<Value, String> {
    rpc(&app, "lsp/batchSymbols", json!({ "workspacePath": workspace_path, "files": files })).await
}

#[tauri::command]
pub async fn lsp_batch_enrich(app: AppHandle, workspace_path: String, files: Value) -> Result<Value, String> {
    rpc(&app, "lsp/batchEnrich", json!({ "workspacePath": workspace_path, "files": files })).await
}

#[tauri::command]
pub async fn resolve_symbol_provider(app: AppHandle, language_id: String) -> Result<Value, String> {
    rpc(&app, "symbols/resolveProvider", json!({ "languageId": language_id })).await
}

#[tauri::command]
pub async fn list_available_symbol_providers(app: AppHandle) -> Result<Value, String> {
    rpc(&app, "symbols/listProviders", json!({})).await
}

#[tauri::command]
pub async fn resolve_symbols(app: AppHandle, language_id: String, path: String, content: String) -> Result<Value, String> {
    rpc(&app, "symbols/resolve", json!({ "languageId": language_id, "path": path, "content": content })).await
}

#[tauri::command]
pub async fn resolve_symbol_hover(
    app: AppHandle,
    language_id: String,
    path: String,
    content: String,
    line: usize,
    character: usize,
) -> Result<Value, String> {
    rpc(&app, "symbols/hover", json!({
        "languageId": language_id, "path": path, "content": content, "line": line, "character": character,
    })).await
}

#[tauri::command]
pub async fn resolve_symbol_definition(
    app: AppHandle,
    language_id: String,
    path: String,
    content: String,
    line: usize,
    character: usize,
) -> Result<Value, String> {
    rpc(&app, "symbols/definition", json!({
        "languageId": language_id, "path": path, "content": content, "line": line, "character": character,
    })).await
}

#[tauri::command]
pub async fn resolve_symbol_references(
    app: AppHandle,
    language_id: String,
    path: String,
    content: String,
    line: usize,
    character: usize,
) -> Result<Value, String> {
    rpc(&app, "symbols/references", json!({
        "languageId": language_id, "path": path, "content": content, "line": line, "character": character,
    })).await
}

#[tauri::command]
pub async fn check_syntax(app: AppHandle, language_id: String, content: String) -> Result<Value, String> {
    rpc(&app, "symbols/checkSyntax", json!({ "languageId": language_id, "content": content })).await
}

#[tauri::command]
pub async fn extract_file_symbols(app: AppHandle, language_id: String, content: String) -> Result<Value, String> {
    rpc(&app, "symbols/extractFileSymbols", json!({ "languageId": language_id, "content": content })).await
}

#[tauri::command]
pub async fn agent_runtime_start(app: AppHandle) -> Result<String, String> {
    let resource_dir = app.path().resource_dir().ok().map(|p| p.to_string_lossy().to_string());
    let value = rpc(&app, "agent/start", json!({ "resourceDir": resource_dir })).await?;
    value
        .get("runtimeId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "agent/start did not return runtimeId".to_string())
}

#[tauri::command]
pub async fn agent_runtime_send(app: AppHandle, runtime_id: String, line: String) -> Result<(), String> {
    rpc_ok(&app, "agent/send", json!({ "runtimeId": runtime_id, "line": line })).await
}

#[tauri::command]
pub async fn agent_runtime_stop(app: AppHandle, runtime_id: String) -> Result<(), String> {
    rpc_ok(&app, "agent/stop", json!({ "runtimeId": runtime_id })).await
}

#[tauri::command]
pub async fn agent_runtime_permission_respond(
    app: AppHandle,
    request_id: String,
    approved: bool,
    scope: String,
) -> Result<(), String> {
    rpc_ok(&app, "agent/respondPermission", json!({
        "requestId": request_id, "approved": approved, "scope": scope,
    })).await
}
