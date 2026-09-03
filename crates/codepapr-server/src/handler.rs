use std::sync::Arc;
use serde_json::{json, Value};
use codepapr_core::events::SharedEventSink;
use codepapr_core::db::InMemorySecretStorage;

pub struct ServerContext {
    pub default_workspace: Option<String>,
    pub event_sink: SharedEventSink,
    pub secrets: Arc<InMemorySecretStorage>,
}

impl ServerContext {
    pub fn new(default_workspace: Option<String>, event_sink: SharedEventSink) -> Self {
        Self {
            default_workspace,
            event_sink,
            secrets: Arc::new(InMemorySecretStorage::new()),
        }
    }
}

pub async fn handle_request(ctx: &Arc<ServerContext>, method: &str, params: Value) -> Result<Value, String> {
    match method {
        "initialize" => {
            Ok(json!({
                "serverInfo": {
                    "name": "codepapr-server",
                    "version": codepapr_core::version(),
                },
                "capabilities": {
                    "fs": true,
                    "git": true,
                    "shell": true,
                    "lsp": true,
                    "agent": true,
                    "db": true,
                },
                "workspace": ctx.default_workspace,
            }))
        }
        "ping" => Ok(json!("pong")),

        // ── FS ────────────────────────────────────────────────────────────
        "fs/readTextFile" => {
            let ws = require_workspace(ctx, &params)?;
            let path = require_str(&params, "path")?;
            let max_bytes = params.get("maxBytes").and_then(|v| v.as_u64()).map(|v| v as usize);
            let start_line = params.get("startLine").and_then(|v| v.as_u64()).map(|v| v as usize);
            let end_line = params.get("endLine").and_then(|v| v.as_u64()).map(|v| v as usize);
            let around_line = params.get("aroundLine").and_then(|v| v.as_u64()).map(|v| v as usize);
            let context_lines = params.get("contextLines").and_then(|v| v.as_u64()).map(|v| v as usize);
            let res = codepapr_core::workspace_fs::read::read_text_file(
                ws,
                path.to_string(),
                max_bytes,
                start_line,
                end_line,
                around_line,
                context_lines,
            ).await?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "fs/writeTextFile" => {
            let ws = require_workspace(ctx, &params)?;
            let path = require_str(&params, "path")?;
            let content = require_str(&params, "content")?;
            let res = codepapr_core::workspace_fs::write::write_text_file(
                ws,
                path.to_string(),
                content.to_string(),
            ).await?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "fs/deleteFile" => {
            let ws = require_workspace(ctx, &params)?;
            let path = require_str(&params, "path")?;
            let res = codepapr_core::workspace_fs::write::delete_workspace_file(
                ws,
                path.to_string(),
            ).await?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "fs/listFiles" => {
            let ws = require_workspace(ctx, &params)?;
            let max_depth = params.get("maxDepth").and_then(|v| v.as_u64()).map(|v| v as usize);
            let sub_path = params.get("subPath").and_then(|v| v.as_str()).map(|s| s.to_string());
            let include_codepapr_apps = params.get("includeCodepaprApps").and_then(|v| v.as_bool());
            let res = codepapr_core::workspace_fs::list::list_workspace_files(
                ws,
                sub_path,
                max_depth,
                include_codepapr_apps,
            ).await?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "fs/search" => {
            let ws = require_workspace(ctx, &params)?;
            let query = require_str(&params, "query")?;
            let case_sensitive = params.get("caseSensitive").and_then(|v| v.as_bool());
            let is_regexp = params.get("isRegexp").and_then(|v| v.as_bool());
            let context_lines = params.get("contextLines").and_then(|v| v.as_u64()).map(|v| v as usize);
            let max_results = params.get("maxResults").and_then(|v| v.as_u64()).map(|v| v as usize);
            let max_matches_per_file = params.get("maxMatchesPerFile").and_then(|v| v.as_u64()).map(|v| v as usize);
            let max_bytes_per_file = params.get("maxBytesPerFile").and_then(|v| v.as_u64()).map(|v| v as usize);
            let include_codepapr_apps = params.get("includeCodepaprApps").and_then(|v| v.as_bool());
            let include_ignored_dirs = params.get("includeIgnoredDirs").and_then(|v| v.as_bool());
            let res = codepapr_core::workspace_fs::search::search_workspace_text(
                ws,
                query.to_string(),
                case_sensitive,
                is_regexp,
                context_lines,
                max_results,
                max_matches_per_file,
                max_bytes_per_file,
                include_codepapr_apps,
                include_ignored_dirs,
            ).await?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }

        // ── Git ───────────────────────────────────────────────────────────
        "git/status" => {
            let ws = require_workspace(ctx, &params)?;
            let res = codepapr_core::git_operations::status::git_status(ws).await;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "git/diff" => {
            let ws = require_workspace(ctx, &params)?;
            let staged = params.get("staged").and_then(|v| v.as_bool());
            let pathspecs = parse_string_vec(&params, "pathspecs");
            let res = codepapr_core::git_operations::diff::git_diff(ws, staged, pathspecs).await;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "git/stage" => {
            let ws = require_workspace(ctx, &params)?;
            let all = params.get("all").and_then(|v| v.as_bool());
            let pathspecs = parse_string_vec(&params, "pathspecs");
            let res = codepapr_core::git_operations::stage::git_stage(ws, all, pathspecs).await;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "git/commit" => {
            let ws = require_workspace(ctx, &params)?;
            let message = require_str(&params, "message")?;
            let stage_all = params.get("stageAll").and_then(|v| v.as_bool());
            let pathspecs = parse_string_vec(&params, "pathspecs");
            let allow_empty = params.get("allowEmpty").and_then(|v| v.as_bool());
            let res = codepapr_core::git_operations::commit::git_commit(
                ws,
                message.to_string(),
                stage_all,
                pathspecs,
                allow_empty,
            ).await;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "git/branchList" => {
            let ws = require_workspace(ctx, &params)?;
            let res = codepapr_core::git_operations::branch::git_branch_list(ws).await;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "git/branchCheckout" => {
            let ws = require_workspace(ctx, &params)?;
            let branch = require_str(&params, "branchName")?;
            let create = params.get("create").and_then(|v| v.as_bool());
            let abort = params.get("abort").and_then(|v| v.as_bool());
            let res = codepapr_core::git_operations::branch::git_branch_checkout(
                ws,
                branch.to_string(),
                create,
                abort,
                None,
            ).await;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }

        // ── Shell ─────────────────────────────────────────────────────────
        "shell/execute" => {
            let ws = require_workspace(ctx, &params)?;
            let command = require_str(&params, "command")?;
            let args = parse_string_vec(&params, "args");
            let timeout = params.get("timeoutSeconds").and_then(|v| v.as_u64());
            let res = codepapr_core::shell::run_workspace_command(
                ws,
                command.to_string(),
                args,
                timeout,
                None,
                None,
            ).await?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "shell/openSession" => {
            let ws = require_workspace(ctx, &params)?;
            let shell = params.get("shell").and_then(|v| v.as_str()).map(String::from);
            let res = codepapr_core::shell::session::open_shell_session(ws, shell)?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "shell/sendCommand" => {
            let session_id = require_str(&params, "sessionId")?;
            let command = require_str(&params, "command")?;
            let args = parse_string_vec(&params, "args");
            let res = codepapr_core::shell::session::send_shell_command(
                session_id.to_string(),
                command.to_string(),
                args,
            )?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "shell/readOutput" => {
            let session_id = require_str(&params, "sessionId")?;
            let res = codepapr_core::shell::session::read_shell_output(
                session_id.to_string(),
            )?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "shell/closeSession" => {
            let session_id = require_str(&params, "sessionId")?;
            let res = codepapr_core::shell::session::close_shell_session(session_id.to_string())?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }

        // ── Agent Sidecar ─────────────────────────────────────────────────
        "agent/start" => {
            let resource_dir = params.get("resourceDir").and_then(|v| v.as_str()).map(std::path::PathBuf::from);
            let runtime_id = codepapr_core::agent_runtime::agent_runtime_start(
                Arc::clone(&ctx.event_sink),
                resource_dir,
            )?;
            Ok(json!({ "runtimeId": runtime_id }))
        }
        "agent/send" => {
            let runtime_id = require_str(&params, "runtimeId")?;
            let line = require_str(&params, "line")?;
            codepapr_core::agent_runtime::agent_runtime_send(runtime_id.to_string(), line.to_string())?;
            Ok(json!({ "success": true }))
        }
        "agent/stop" => {
            let runtime_id = require_str(&params, "runtimeId")?;
            codepapr_core::agent_runtime::agent_runtime_stop(runtime_id.to_string())?;
            Ok(json!({ "success": true }))
        }
        "agent/respondPermission" => {
            let request_id = require_str(&params, "requestId")?;
            let approved = params.get("approved").and_then(|v| v.as_bool()).unwrap_or(false);
            let scope = params.get("scope").and_then(|v| v.as_str()).unwrap_or("session").to_string();
            codepapr_core::agent_runtime_tools::agent_runtime_permission_respond(
                request_id.to_string(),
                approved,
                scope,
            )?;
            Ok(json!({ "success": true }))
        }

        // ── DB / Project State ────────────────────────────────────────────
        "db/loadSettings" => {
            let res = codepapr_core::db::load_app_settings(Some(&*ctx.secrets))?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "db/saveSettings" => {
            let settings_json = require_str(&params, "settingsJson")?;
            let res = codepapr_core::db::save_app_settings(
                Some(Arc::clone(&ctx.secrets) as Arc<dyn codepapr_core::db::SecretStorage>),
                settings_json.to_string(),
            ).await?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "db/loadProjectState" => {
            let ws = require_workspace(ctx, &params)?;
            let res = codepapr_core::db::load_project_state(ws)?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "db/saveProjectState" => {
            let ws = require_workspace(ctx, &params)?;
            let state_json = require_str(&params, "stateJson")?;
            let purge = params.get("purgeDeletedContent").and_then(|v| v.as_bool());
            let res = codepapr_core::db::save_project_state(ws, state_json.to_string(), purge)?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }

        // ── LSP ───────────────────────────────────────────────────────────
        "lsp/queryAvailability" => {
            let ws = require_workspace(ctx, &params)?;
            let lang = require_str(&params, "languageId")?;
            let res = codepapr_core::lsp::lsp_query_availability(ws, lang.to_string()).await?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "lsp/diagnostics" => {
            let ws = require_workspace(ctx, &params)?;
            let lang = require_str(&params, "languageId")?;
            let rel = params.get("relativePath").and_then(|v| v.as_str()).map(String::from);
            let res = codepapr_core::lsp::lsp_get_diagnostics(ws, lang.to_string(), rel).await?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }

        unknown => Err(format!("Unknown JSON-RPC method: {unknown}")),
    }
}

fn require_workspace(ctx: &Arc<ServerContext>, params: &Value) -> Result<String, String> {
    if let Some(ws) = params.get("workspacePath").and_then(|v| v.as_str()) {
        if !ws.trim().is_empty() {
            return Ok(ws.to_string());
        }
    }
    if let Some(ref default) = ctx.default_workspace {
        return Ok(default.clone());
    }
    Err("workspacePath is required in params or via --workspace flag".to_string())
}

fn require_str<'a>(params: &'a Value, key: &str) -> Result<&'a str, String> {
    params.get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("Missing required string parameter: {key}"))
}

fn parse_string_vec(params: &Value, key: &str) -> Option<Vec<String>> {
    params.get(key)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
}
