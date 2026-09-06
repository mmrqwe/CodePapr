//! P1/P2: execute sidecar `tool-request`s in Rust so tools do not wait on WebView JS.
//!
//! UI-bound tools (todo, memory admission, MCP confirm, browser overlay, graph,
//! question, apps) still go to the page. Permission prompts wait on the UI.

use crate::git_operations;
use crate::shell::background;
use crate::shell::sandbox::SandboxAccessArgs;
use crate::shell::session;
use crate::web::fetch as web_fetch;
use crate::web::search as web_search;
use crate::workspace_fs::{self, access::check_external_path};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use crate::events::SharedEventSink;

pub const PERMISSION_EVENT: &str = "agent-runtime://permission-request";
pub const PERMISSION_CANCEL_EVENT: &str = "agent-runtime://permission-cancel";
pub const WORKSPACE_MUTATED_EVENT: &str = "agent-runtime://workspace-mutated";

const RUST_HOSTED_TOOLS: &[&str] = &[
    "read",
    "write",
    "edit",
    "patch",
    "grep",
    "glob",
    "list",
    "bash",
    "git",
    "workspace_read_file",
    "workspace_write_file",
    "workspace_apply_patch",
    "workspace_apply_diff",
    "workspace_search_text",
    "workspace_search_files",
    "workspace_list_files",
    "workspace_run_shell_command",
    "workspace_run_command",
    "workspace_start_shell_background_command",
    "workspace_start_background_command",
    "workspace_list_background_processes",
    "workspace_stop_background_process",
    "workspace_stop_all_background_processes",
    "workspace_git_status",
    "workspace_git_diff",
    "workspace_git_history",
    "workspace_git_branch_checkout",
    "workspace_git_stage",
    "workspace_git_commit",
    "workspace_git_restore",
    "workspace_git_reset",
    "workspace_restore_undo",
    "read_image",
    "workspace_read_image",
    "local_time_now",
    "lsp",
    "lsp_edit",
    "diagnostics",
    "workspace_lsp_diagnostics",
    "workspace_symbol_definition",
    "workspace_symbol_references",
    "workspace_symbol_hover",
    "workspace_document_symbol",
    "workspace_workspace_symbol",
    "workspace_implementation",
    "workspace_prepare_call_hierarchy",
    "workspace_incoming_calls",
    "workspace_outgoing_calls",
    "workspace_rename_symbol",
    "workspace_apply_code_action",
    "workspace_organize_imports",
    "workspace_fix_diagnostics",
    "workspace_format_files",
    "webfetch",
    "web_fetch_url",
    "web_download_file",
    "websearch",
    "skill",
    "skill_load",
    "shell_open_session",
    "shell_list_sessions",
    "shell_read_output",
    "shell_send_input",
    "shell_close_session",
    "workspace_start_preview_session",
];

#[derive(Clone)]
pub struct RuntimeSearxngSettings {
    pub enabled: bool,
    pub base_url: String,
    pub categories: String,
    pub time_range: String,
    pub language: String,
    pub safe_search: u8,
    pub engines: String,
}

impl Default for RuntimeSearxngSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            base_url: String::new(),
            categories: String::new(),
            time_range: String::new(),
            language: String::new(),
            safe_search: 1,
            engines: String::new(),
        }
    }
}

#[derive(Clone)]
pub struct RuntimeSkillEntry {
    pub name: String,
    pub id: String,
    pub display_name: String,
    pub source_path: String,
    pub enabled: bool,
}

impl Default for RuntimeSkillEntry {
    fn default() -> Self {
        Self {
            name: String::new(),
            id: String::new(),
            display_name: String::new(),
            source_path: String::new(),
            enabled: true,
        }
    }
}

#[derive(Clone)]
pub struct RuntimeToolContext {
    pub workspace_path: String,
    pub mode: String,
    pub searxng: RuntimeSearxngSettings,
    pub skill_catalog: Vec<RuntimeSkillEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppAccess {
    network: Option<bool>,
    workspace_write: Option<bool>,
    allow_codepapr_apps: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolRequest {
    request_id: String,
    tool_request_id: String,
    tool_name: String,
    #[serde(default)]
    arguments: Value,
    app_access: Option<AppAccess>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PermissionRequestEvent {
    runtime_id: String,
    request_id: String,
    path: String,
    operation: String,
    tool_name: String,
    workspace_path: String,
    exists: bool,
    allow_file: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceMutatedEvent {
    runtime_id: String,
    paths: Vec<String>,
}

struct PermissionDecision {
    approved: bool,
    scope: String,
}

struct HostedOutcome {
    result: Result<Value, String>,
    mutated: Vec<String>,
}

static NEXT_PERMISSION_ID: AtomicU64 = AtomicU64::new(1);
static PERMISSION_WAITERS: OnceLock<Mutex<HashMap<String, Sender<Result<PermissionDecision, String>>>>> =
    OnceLock::new();
static TOOL_CANCELS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
static TOOL_PERMISSION: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn permission_waiters() -> &'static Mutex<HashMap<String, Sender<Result<PermissionDecision, String>>>> {
    PERMISSION_WAITERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn tool_cancels() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    TOOL_CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn tool_permission() -> &'static Mutex<HashMap<String, String>> {
    TOOL_PERMISSION.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn should_host_in_rust(message: &Value) -> bool {
    let Some(name) = message.get("toolName").and_then(Value::as_str) else {
        return false;
    };
    if !RUST_HOSTED_TOOLS.contains(&name) {
        return false;
    }
    if name == "diagnostics" && message.pointer("/arguments/project") == Some(&Value::Bool(true)) {
        return false;
    }
    let args = message.get("arguments").cloned().unwrap_or(Value::Null);
    !touches_memory_file(name, &args)
}

pub fn cancel_hosted_tool(message: &Value) {
    let Some(tool_request_id) = message
        .get("toolRequestId")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return;
    };
    if let Some(flag) = tool_cancels()
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .get(&tool_request_id)
        .cloned()
    {
        flag.store(true, Ordering::SeqCst);
    }
    let _ = background::cancel_running_command(tool_request_id.clone());
    if let Some(permission_id) = tool_permission()
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .remove(&tool_request_id)
    {
        reject_permission(&permission_id, "已取消".to_string());
    }
}

pub fn agent_runtime_permission_respond(
    request_id: String,
    approved: bool,
    scope: String,
) -> Result<(), String> {
    let sender = permission_waiters()
        .lock()
        .map_err(|_| "permission lock poisoned".to_string())?
        .remove(&request_id);
    if let Some(sender) = sender {
        let _ = sender.send(Ok(PermissionDecision { approved, scope }));
    }
    Ok(())
}

pub fn handle_hosted_tool_request(sink: SharedEventSink, runtime_id: String, message: Value) {
    let parsed: ToolRequest = match serde_json::from_value(message) {
        Ok(value) => value,
        Err(err) => {
            eprintln!("[agent-sidecar] tool-request parse failed: {err}");
            return;
        }
    };
    let cancel_flag = Arc::new(AtomicBool::new(false));
    tool_cancels()
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .insert(parsed.tool_request_id.clone(), cancel_flag.clone());

    let activity_start = json!({
        "type": "tool-host-activity",
        "requestId": parsed.request_id,
        "toolRequestId": parsed.tool_request_id,
        "phase": "start",
    });
    sink.emit(
        crate::agent_runtime::FRAME_EVENT,
        json!({
            "runtimeId": runtime_id,
            "message": activity_start,
        }),
    );

    let ctx = match crate::agent_runtime::runtime_tool_context(&runtime_id) {
        Some(ctx) if !ctx.workspace_path.is_empty() => ctx,
        _ => {
            finish_hosted_tool(
                &sink,
                &runtime_id,
                &parsed,
                Err("agent sidecar 尚未收到 workspacePath（等 init）".to_string()),
                Vec::new(),
            );
            return;
        }
    };

    let outcome = dispatch_tool(&sink, &runtime_id, &ctx, &parsed, &cancel_flag);
    finish_hosted_tool(
        &sink,
        &runtime_id,
        &parsed,
        outcome.result,
        outcome.mutated,
    );
}

fn finish_hosted_tool(
    sink: &SharedEventSink,
    runtime_id: &str,
    parsed: &ToolRequest,
    result: Result<Value, String>,
    mutated: Vec<String>,
) {
    tool_cancels()
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .remove(&parsed.tool_request_id);
    tool_permission()
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .remove(&parsed.tool_request_id);

    let response = match result {
        Ok(value) => json!({
            "type": "tool-response",
            "payload": {
                "requestId": parsed.request_id,
                "toolRequestId": parsed.tool_request_id,
                "success": true,
                "result": value,
            }
        }),
        Err(error) => json!({
            "type": "tool-response",
            "payload": {
                "requestId": parsed.request_id,
                "toolRequestId": parsed.tool_request_id,
                "success": false,
                "error": error,
            }
        }),
    };
    if let Err(err) = crate::agent_runtime::write_sidecar_stdin(runtime_id, &format!("{response}\n")) {
        eprintln!("[agent-sidecar] write tool-response failed: {err}");
    }

    if !mutated.is_empty() {
        sink.emit(
            WORKSPACE_MUTATED_EVENT,
            serde_json::to_value(WorkspaceMutatedEvent {
                runtime_id: runtime_id.to_string(),
                paths: mutated,
            })
            .unwrap_or_default(),
        );
    }

    let activity_end = json!({
        "type": "tool-host-activity",
        "requestId": parsed.request_id,
        "toolRequestId": parsed.tool_request_id,
        "phase": "end",
    });
    sink.emit(
        crate::agent_runtime::FRAME_EVENT,
        json!({
            "runtimeId": runtime_id,
            "message": activity_end,
        }),
    );
}

fn dispatch_tool(
    sink: &SharedEventSink,
    runtime_id: &str,
    ctx: &RuntimeToolContext,
    req: &ToolRequest,
    cancel: &Arc<AtomicBool>,
) -> HostedOutcome {
    match dispatch_tool_inner(sink, runtime_id, ctx, req, cancel) {
        Ok(outcome) => outcome,
        Err(error) => HostedOutcome {
            result: Err(error),
            mutated: Vec::new(),
        },
    }
}

fn dispatch_tool_inner(
    sink: &SharedEventSink,
    runtime_id: &str,
    ctx: &RuntimeToolContext,
    req: &ToolRequest,
    cancel: &Arc<AtomicBool>,
) -> Result<HostedOutcome, String> {
    let name = req.tool_name.as_str();
    let args = &req.arguments;
    let include_apps = allow_codepapr_apps(ctx, req);

    if cancel.load(Ordering::SeqCst) {
        return Err("已取消".to_string());
    }

    match name {
        "read" | "workspace_read_file" => {
            let path = require_path(args)?;
            ensure_codepapr_access(&path, "read", &ctx.mode, include_apps)?;
            ensure_external_allowed(sink, runtime_id, ctx, req, &path, "read", cancel)?;
            let result = workspace_fs::read::read_text_file_impl(
                ctx.workspace_path.clone(),
                path,
                arg_usize(args, "maxBytes"),
                arg_usize(args, "startLine"),
                arg_usize(args, "endLine"),
                arg_usize(args, "aroundLine"),
                arg_usize(args, "contextLines"),
            )?;
            Ok(ok_result(result, Vec::new()))
        }
        "list" | "workspace_list_files" => {
            let path = extract_path(args, false)?;
            if let Some(path) = path.as_ref() {
                ensure_codepapr_access(path, "list", &ctx.mode, include_apps)?;
                ensure_external_allowed(sink, runtime_id, ctx, req, path, "list", cancel)?;
            }
            let result = workspace_fs::list::list_workspace_files_impl(
                ctx.workspace_path.clone(),
                path,
                arg_usize(args, "maxDepth"),
                Some(include_apps),
            )?;
            Ok(ok_result(result, Vec::new()))
        }
        "write" | "workspace_write_file" => {
            let path = require_path(args)?;
            let content = arg_string_req(args, &["content"])?;
            ensure_codepapr_access(&path, "write", &ctx.mode, include_apps)?;
            ensure_external_allowed(sink, runtime_id, ctx, req, &path, "write", cancel)?;
            let result = workspace_fs::write::write_text_file_impl(
                ctx.workspace_path.clone(),
                path.clone(),
                content,
            )?;
            let mutated = vec![result.path.clone()];
            Ok(ok_result(result, mutated))
        }
        "edit" | "workspace_apply_patch" => {
            let path = require_path(args)?;
            ensure_codepapr_access(&path, "write", &ctx.mode, include_apps)?;
            ensure_external_allowed(sink, runtime_id, ctx, req, &path, "write", cancel)?;
            let current = workspace_fs::read::read_text_file_impl(
                ctx.workspace_path.clone(),
                path.clone(),
                Some(20_000_000),
                None,
                None,
                None,
                None,
            )?;
            if current.truncated_by_bytes {
                return Err(format!(
                    "文件 {path} 超过 20MB 上限，请改用 workspace_write_file 重写整个文件"
                ));
            }
            let patched = apply_search_replace(
                &current.content,
                &arg_string_req(args, &["search"])?,
                &arg_string_req(args, &["replace"])?,
                arg_bool(args, "replaceAll"),
                arg_usize(args, "expectedOccurrences"),
            )?;
            let result = workspace_fs::write::write_text_file_impl(
                ctx.workspace_path.clone(),
                path.clone(),
                patched.content,
            )?;
            let mutated = vec![result.path.clone()];
            Ok(HostedOutcome {
                result: Ok(json!({
                    "path": result.path,
                    "replacements": patched.replacements,
                    "bytes": result.bytes,
                    "change": result.change,
                })),
                mutated,
            })
        }
        "patch" | "workspace_apply_diff" => {
            apply_multi_patch(sink, runtime_id, ctx, req, cancel)
        }
        "grep" | "workspace_search_text" => {
            let query = if name == "grep" {
                arg_string_req(args, &["query"])?
            } else {
                arg_string_req(args, &["query", "pattern"])?
            };
            let is_regexp = arg_bool(args, "isRegexp") == Some(true);
            let result = workspace_fs::search::search_workspace_text_impl_full(
                ctx.workspace_path.clone(),
                query,
                arg_bool(args, "caseSensitive"),
                Some(is_regexp),
                arg_usize(args, "contextLines"),
                arg_usize(args, "maxResults"),
                arg_usize(args, "maxMatchesPerFile"),
                arg_usize(args, "maxBytesPerFile"),
                Some(include_apps),
                arg_bool(args, "includeIgnoredDirs"),
                arg_string_vec(args, "includeGlobs"),
                arg_string_vec(args, "excludeGlobs"),
            )?;
            let mut value = serde_json::to_value(result).unwrap_or(Value::Null);
            if args.get("semantic") == Some(&Value::Bool(true)) {
                if let Some(obj) = value.as_object_mut() {
                    obj.insert("degraded".to_string(), json!(true));
                    let note = if is_regexp {
                        "语义搜索在 sidecar 宿主中降级为正则搜索。"
                    } else {
                        "语义搜索在 sidecar 宿主中降级为字面量搜索。"
                    };
                    match obj.get("note").and_then(Value::as_str) {
                        Some(existing) if !existing.is_empty() => {
                            obj.insert("note".to_string(), json!(format!("{note} {existing}")));
                        }
                        _ => {
                            obj.insert("note".to_string(), json!(note));
                        }
                    }
                }
            }
            Ok(HostedOutcome {
                result: Ok(value),
                mutated: Vec::new(),
            })
        }
        "glob" | "workspace_search_files" => {
            let raw_query = arg_string_req(args, &["query"])?;
            let query = if name == "glob" {
                glob_to_regex(&raw_query)
            } else if arg_bool(args, "isRegexp") == Some(true) {
                raw_query
            } else {
                glob_to_regex(&raw_query)
            };
            let result = workspace_fs::search::search_workspace_paths_impl_full(
                ctx.workspace_path.clone(),
                query,
                arg_bool(args, "caseSensitive"),
                Some(true),
                arg_usize(args, "maxResults"),
                Some(include_apps),
                arg_bool(args, "includeIgnoredDirs"),
                arg_string_vec(args, "includeGlobs"),
                arg_string_vec(args, "excludeGlobs"),
            )?;
            Ok(ok_result(result, Vec::new()))
        }
        "bash"
        | "workspace_run_shell_command"
        | "workspace_run_command"
        | "workspace_start_shell_background_command"
        | "workspace_start_background_command"
        | "workspace_start_preview_session"
        | "workspace_list_background_processes"
        | "workspace_stop_background_process"
        | "workspace_stop_all_background_processes" => {
            dispatch_bash(sink, runtime_id, ctx, req, cancel)
        }
        "git"
        | "workspace_git_status"
        | "workspace_git_diff"
        | "workspace_git_history"
        | "workspace_git_branch_checkout"
        | "workspace_git_stage"
        | "workspace_git_commit"
        | "workspace_git_restore"
        | "workspace_git_reset"
        | "workspace_restore_undo" => dispatch_git(ctx, name, args),
        "read_image" | "workspace_read_image" => dispatch_read_image(sink, runtime_id, ctx, req, cancel),
        "local_time_now" => Ok(ok_result(local_time_now(), Vec::new())),
        "lsp"
        | "lsp_edit"
        | "diagnostics"
        | "workspace_lsp_diagnostics"
        | "workspace_symbol_definition"
        | "workspace_symbol_references"
        | "workspace_symbol_hover"
        | "workspace_document_symbol"
        | "workspace_workspace_symbol"
        | "workspace_implementation"
        | "workspace_prepare_call_hierarchy"
        | "workspace_incoming_calls"
        | "workspace_outgoing_calls"
        | "workspace_rename_symbol"
        | "workspace_apply_code_action"
        | "workspace_organize_imports"
        | "workspace_fix_diagnostics"
        | "workspace_format_files" => {
            if let Some(path) = extract_path(args, false)? {
                ensure_codepapr_access(&path, "read", &ctx.mode, include_apps)?;
                ensure_external_allowed(sink, runtime_id, ctx, req, &path, "read", cancel)?;
            }
            let (value, mutated) =
                crate::agent_runtime_lsp::dispatch(Some(&**sink), &ctx.workspace_path, name, args)?;
            Ok(HostedOutcome {
                result: Ok(value),
                mutated,
            })
        }
        "webfetch" | "web_fetch_url" | "web_download_file" => {
            dispatch_webfetch(name, ctx, args)
        }
        "websearch" => dispatch_websearch(ctx, args),
        "skill" | "skill_load" => dispatch_skill(ctx, args),
        "shell_open_session"
        | "shell_list_sessions"
        | "shell_read_output"
        | "shell_send_input"
        | "shell_close_session" => dispatch_shell(sink, runtime_id, ctx, req, cancel),
        other => Err(format!("sidecar 宿主未实现工具: {other}")),
    }
}

fn apply_multi_patch(
    sink: &SharedEventSink,
    runtime_id: &str,
    ctx: &RuntimeToolContext,
    req: &ToolRequest,
    cancel: &Arc<AtomicBool>,
) -> Result<HostedOutcome, String> {
    let patches = req
        .arguments
        .get("patches")
        .and_then(Value::as_array)
        .ok_or_else(|| "patches 必须是数组".to_string())?;
    let mut planned: Vec<(String, String)> = Vec::new();
    for patch in patches {
        let path = require_path(patch)?;
        ensure_codepapr_access(&path, "write", &ctx.mode, allow_codepapr_apps(ctx, req))?;
        ensure_external_allowed(sink, runtime_id, ctx, req, &path, "write", cancel)?;
        let current = workspace_fs::read::read_text_file_impl(
            ctx.workspace_path.clone(),
            path.clone(),
            Some(20_000_000),
            None,
            None,
            None,
            None,
        )?;
        if current.truncated_by_bytes {
            return Err(format!("文件 {path} 超过 20MB 上限，无法打补丁"));
        }
        let content = match planned.iter().find(|(p, _)| p == &path) {
            Some((_, existing)) => existing.clone(),
            None => current.content,
        };
        let patched = apply_search_replace(
            &content,
            &arg_string_req(patch, &["search"])?,
            &arg_string_req(patch, &["replace"])?,
            arg_bool(patch, "replaceAll"),
            arg_usize(patch, "expectedOccurrences"),
        )?;
        if let Some((_, existing)) = planned.iter_mut().find(|(p, _)| p == &path) {
            *existing = patched.content;
        } else {
            planned.push((path, patched.content));
        }
    }
    let mut files = Vec::new();
    let mut mutated = Vec::new();
    for (path, content) in planned {
        let result = workspace_fs::write::write_text_file_impl(
            ctx.workspace_path.clone(),
            path.clone(),
            content,
        )?;
        mutated.push(result.path.clone());
        files.push(json!({
            "path": result.path,
            "bytes": result.bytes,
            "change": result.change,
        }));
    }
    Ok(HostedOutcome {
        result: Ok(json!({
            "files": files,
            "totalFiles": files.len(),
            "totalPatches": patches.len(),
        })),
        mutated,
    })
}

fn dispatch_bash(
    sink: &SharedEventSink,
    runtime_id: &str,
    ctx: &RuntimeToolContext,
    req: &ToolRequest,
    cancel: &Arc<AtomicBool>,
) -> Result<HostedOutcome, String> {
    let args = &req.arguments;
    let action = arg_string(args, &["action"]).unwrap_or_else(|| "run".to_string());
    if req.tool_name == "workspace_list_background_processes" || action == "list" {
        let result = background::list_background_processes(Some(ctx.workspace_path.clone()))?;
        return Ok(ok_result(result, Vec::new()));
    }
    if req.tool_name == "workspace_stop_background_process" || action == "stop" {
        let pid = arg_u32(args, "pid").ok_or_else(|| "pid 必须是数字".to_string())?;
        let result = background::stop_background_process(pid, Some("sidecar-tool".to_string()))?;
        return Ok(ok_result(result, Vec::new()));
    }
    if req.tool_name == "workspace_stop_all_background_processes" || action == "stop_all" {
        let result = background::stop_all_background_processes(
            Some(ctx.workspace_path.clone()),
            Some("sidecar-tool".to_string()),
        )?;
        return Ok(ok_result(result, Vec::new()));
    }

    let command = arg_string_req(args, &["command"])?;
    let workdir = arg_string(args, &["workdir"]);
    if let Some(dir) = workdir.as_deref() {
        ensure_codepapr_access(dir, "execute", &ctx.mode, allow_codepapr_apps(ctx, req))?;
        ensure_external_allowed(sink, runtime_id, ctx, req, dir, "execute", cancel)?;
    }
    ensure_shell_codepapr(&command, workdir.as_deref(), &ctx.mode, allow_codepapr_apps(ctx, req))?;
    for candidate in extract_absolute_command_paths(&command) {
        ensure_external_allowed(sink, runtime_id, ctx, req, &candidate, "execute", cancel)?;
    }

    let sandbox = sandbox_from_access(&ctx.mode, req.app_access.as_ref());
    let timeout = arg_u64(args, "timeoutSeconds").or_else(|| arg_u64(args, "timeout"));
    let background_run = arg_bool(args, "background") == Some(true)
        || req.tool_name == "workspace_start_shell_background_command"
        || req.tool_name == "workspace_start_background_command"
        || req.tool_name == "workspace_start_preview_session";

    if background_run {
        let result = if req.tool_name == "workspace_start_background_command"
            || req.tool_name == "workspace_start_preview_session"
        {
            background::start_workspace_background_command(
                ctx.workspace_path.clone(),
                command,
                arg_string_vec(args, "args"),
                workdir,
                arg_string(args, &["previewUrl"]),
                Some(sandbox),
                None,
            )?
        } else {
            background::start_workspace_shell_background_command(
                ctx.workspace_path.clone(),
                command,
                workdir,
                arg_string(args, &["previewUrl"]),
                Some(sandbox),
            )?
        };
        return Ok(ok_result(result, Vec::new()));
    }

    if req.tool_name == "workspace_run_command" {
        let result = background::run_workspace_command_impl(
            ctx.workspace_path.clone(),
            command,
            arg_string_vec(args, "args"),
            timeout,
            workdir,
            Some(req.tool_request_id.clone()),
        )?;
        return Ok(ok_result(result, Vec::new()));
    }

    let result = background::run_workspace_shell_command_impl(
        ctx.workspace_path.clone(),
        command,
        workdir,
        timeout,
        Some(sandbox),
        Some(req.tool_request_id.clone()),
    )?;
    Ok(ok_result(result, Vec::new()))
}

fn dispatch_git(ctx: &RuntimeToolContext, name: &str, args: &Value) -> Result<HostedOutcome, String> {
    let workspace = Path::new(&ctx.workspace_path);
    let action = if name == "git" {
        arg_string_req(args, &["action"])?
    } else {
        name.trim_start_matches("workspace_git_").to_string()
    };
    let mapped = match action.as_str() {
        "status" | "workspace_git_status" => {
            let status = crate::shared::with_workspace_git_read_lock(workspace, || {
                git_operations::status::git_status_impl(workspace)
            });
            json!({
                "available": status.available,
                "isRepo": status.is_repo,
                "files": status.entries.iter().map(|entry| json!({
                    "path": entry.path,
                    "originalPath": entry.old_path,
                    "indexStatus": entry.index_status,
                    "worktreeStatus": entry.worktree_status,
                    "isUntracked": entry.is_untracked,
                })).collect::<Vec<_>>(),
                "raw": "",
                "branch": status.branch,
                "headShort": status.head_short,
                "message": status.message,
            })
        }
        "diff" | "workspace_git_diff" => {
            let staged = arg_bool(args, "staged").unwrap_or(false);
            let pathspecs = arg_string_vec(args, "pathspecs").unwrap_or_default();
            let diff = crate::shared::with_workspace_git_read_lock(workspace, || {
                git_operations::diff::git_diff_impl(workspace, staged, &pathspecs)
            });
            json!({
                "available": diff.available,
                "isRepo": true,
                "staged": staged,
                "pathspecs": pathspecs,
                "stat": diff.stat,
                "diff": diff.diff,
                "truncated": diff.truncated,
                "message": diff.message,
            })
        }
        "log" | "history" | "workspace_git_history" => {
            let limit = arg_usize(args, "limit").unwrap_or(20).min(100);
            let entries = crate::shared::with_workspace_git_read_lock(workspace, || {
                git_operations::log::git_log_impl(workspace, limit)
            });
            json!({
                "available": true,
                "isRepo": true,
                "entries": entries.iter().map(|entry| json!({
                    "hash": entry.sha,
                    "shortHash": entry.short_hash,
                    "committedAt": chrono_like_iso(entry.timestamp),
                    "authorName": entry.author,
                    "refNames": entry.refs,
                    "subject": entry.message,
                    "isHead": entry.is_head,
                })).collect::<Vec<_>>(),
                "raw": "",
            })
        }
        "branch" | "workspace_git_branch_checkout" => {
            let branch_name = arg_string_req(args, &["branchName"])?;
            git_operations::validate_git_ref(&branch_name, "branchName")?;
            if let Some(start) = arg_string(args, &["startPoint"]) {
                git_operations::validate_git_ref(&start, "startPoint")?;
            }
            let result = crate::shared::with_workspace_git_write_lock(workspace, || {
                git_operations::branch::git_branch_checkout_impl(
                    workspace,
                    &branch_name,
                    arg_bool(args, "create").unwrap_or(false),
                    arg_bool(args, "createIfMissing").unwrap_or(true),
                    arg_string(args, &["startPoint"]).as_deref(),
                )
            });
            git_op_json("branch_checkout", result)
        }
        "stage" | "workspace_git_stage" => {
            let pathspecs = arg_string_vec(args, "pathspecs").unwrap_or_default();
            let stage_all = arg_bool(args, "all").unwrap_or(pathspecs.is_empty());
            let result = crate::shared::with_workspace_git_write_lock(workspace, || {
                git_operations::stage::git_stage_impl(workspace, stage_all, &pathspecs)
            });
            git_op_json("stage", result)
        }
        "commit" | "workspace_git_commit" => {
            let message = arg_string_req(args, &["message"])?;
            let pathspecs = arg_string_vec(args, "pathspecs").unwrap_or_default();
            let result = crate::shared::with_workspace_git_write_lock(workspace, || {
                git_operations::commit::git_commit_impl(
                    workspace,
                    &message,
                    arg_bool(args, "stageAll").unwrap_or(false),
                    &pathspecs,
                    arg_bool(args, "allowEmpty").unwrap_or(false),
                )
            });
            git_op_json("commit", result)
        }
        "restore" | "workspace_git_restore" => {
            if let Some(source) = arg_string(args, &["source"]) {
                git_operations::validate_git_ref(&source, "source")?;
            }
            let pathspecs = arg_string_vec(args, "pathspecs").unwrap_or_default();
            let result = crate::shared::with_workspace_git_write_lock(workspace, || {
                git_operations::restore_files::git_restore_files_impl(
                    workspace,
                    &pathspecs,
                    arg_string(args, &["source"]).as_deref(),
                    arg_bool(args, "includeUntracked"),
                )
            });
            git_op_json("restore", result)
        }
        "reset" | "workspace_git_reset" => {
            let target = arg_string_req(args, &["target"])?;
            git_operations::validate_git_ref(&target, "target")?;
            let result = crate::shared::with_workspace_git_write_lock(workspace, || {
                crate::snapshot::RestoreEngine::new(workspace).execute(&target)
            })?;
            let message = if result.ok {
                format!(
                    "已回退到 {target}，备份引用 {}，恢复 {} 个文件。",
                    result.backup_ref.as_deref().unwrap_or("N/A"),
                    result.files_restored
                )
            } else {
                result.error.clone().unwrap_or_else(|| "回退失败。".to_string())
            };
            return Ok(HostedOutcome {
                result: Ok(json!({
                    "available": true,
                    "isRepo": true,
                    "ok": result.ok,
                    "raw": "",
                    "action": "reset",
                    "message": message,
                    "backupBranch": result.backup_ref,
                    "target": target,
                })),
                mutated: vec![".".to_string()],
            });
        }
        "undo" | "workspace_restore_undo" => {
            crate::shared::with_workspace_git_write_lock(workspace, || {
                crate::snapshot::RestoreEngine::new(workspace).undo(None)
            })?;
            return Ok(HostedOutcome {
                result: Ok(json!({
                    "available": true,
                    "isRepo": true,
                    "ok": true,
                    "raw": "",
                    "action": "undo",
                    "message": "已撤销上一次恢复操作。",
                })),
                mutated: vec![".".to_string()],
            });
        }
        other => return Err(format!("未知的 git action: {other}")),
    };
    Ok(HostedOutcome {
        result: Ok(mapped),
        mutated: Vec::new(),
    })
}

fn dispatch_read_image(
    sink: &SharedEventSink,
    runtime_id: &str,
    ctx: &RuntimeToolContext,
    req: &ToolRequest,
    cancel: &Arc<AtomicBool>,
) -> Result<HostedOutcome, String> {
    let path = require_path(&req.arguments)?;
    ensure_codepapr_access(&path, "read", &ctx.mode, allow_codepapr_apps(ctx, req))?;
    ensure_external_allowed(sink, runtime_id, ctx, req, &path, "read", cancel)?;
    let result = workspace_fs::read::read_image_file_impl(
        ctx.workspace_path.clone(),
        path,
        arg_usize(&req.arguments, "maxBytes"),
    )?;
    Ok(HostedOutcome {
        result: Ok(json!({
            "path": result.path,
            "mediaType": result.media_type,
            "bytes": result.bytes,
            "__images": [{
                "mediaType": result.media_type,
                "data": result.data,
            }],
        })),
        mutated: Vec::new(),
    })
}

fn local_time_now() -> Value {
    let unix_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let (year, month, day, hour, min, sec, wday, offset_minutes, zone) = local_civil_clock();
    let sign = if offset_minutes >= 0 { '+' } else { '-' };
    let abs = offset_minutes.abs();
    let offset_hours = abs / 60;
    let offset_remain = abs % 60;
    let weekday = [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
    ]
    .get(wday as usize)
    .copied()
    .unwrap_or("Sunday");
    json!({
        "iso": format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}{sign}{offset_hours:02}:{offset_remain:02}"),
        "local": format!("{year:04}-{month:02}-{day:02} {hour:02}:{min:02}:{sec:02}"),
        "date": format!("{year:04}-{month:02}-{day:02}"),
        "time": format!("{hour:02}:{min:02}:{sec:02}"),
        "weekday": weekday,
        "timeZone": zone,
        "offsetMinutes": offset_minutes,
        "unixMs": unix_ms,
    })
}

fn local_civil_clock() -> (i32, i32, i32, i32, i32, i32, i32, i32, String) {
    #[cfg(unix)]
    {
        unsafe {
            let mut t: libc::time_t = 0;
            if libc::time(&mut t) == -1 {
                return (1970, 1, 1, 0, 0, 0, 4, 0, "UTC".to_string());
            }
            let mut tm = std::mem::zeroed::<libc::tm>();
            if libc::localtime_r(&t, &mut tm).is_null() {
                return (1970, 1, 1, 0, 0, 0, 4, 0, "UTC".to_string());
            }
            let offset_minutes = (tm.tm_gmtoff / 60) as i32;
            let zone = if tm.tm_zone.is_null() {
                "local".to_string()
            } else {
                std::ffi::CStr::from_ptr(tm.tm_zone)
                    .to_string_lossy()
                    .into_owned()
            };
            (
                tm.tm_year + 1900,
                tm.tm_mon + 1,
                tm.tm_mday,
                tm.tm_hour,
                tm.tm_min,
                tm.tm_sec,
                tm.tm_wday,
                offset_minutes,
                zone,
            )
        }
    }
    #[cfg(not(unix))]
    {
        (1970, 1, 1, 0, 0, 0, 4, 0, "UTC".to_string())
    }
}

fn dispatch_webfetch(
    name: &str,
    ctx: &RuntimeToolContext,
    args: &Value,
) -> Result<HostedOutcome, String> {
    let url = arg_string_req(args, &["url"])?;
    let save = name == "web_download_file" || arg_bool(args, "save") == Some(true);
    if save {
        let result = web_fetch::download_web_file_impl(
            ctx.workspace_path.clone(),
            url,
            arg_string(args, &["relativePath"]),
        )?;
        let mutated = vec![result.path.clone()];
        return Ok(ok_result(result, mutated));
    }
    let max_bytes = arg_usize(args, "maxBytes")
        .unwrap_or(20_000)
        .clamp(1_000, 100_000);
    let result = web_fetch::fetch_web_url_impl(url, Some(max_bytes))?;
    Ok(ok_result(result, Vec::new()))
}

fn dispatch_websearch(ctx: &RuntimeToolContext, args: &Value) -> Result<HostedOutcome, String> {
    let query = arg_string_req(args, &["query"])?;
    let max_results = arg_usize(args, "maxResults").unwrap_or(5).clamp(1, 10);
    // 设置里的分类/时间/语言只在 SearXNG 启用时作为默认值注入；
    // 未启用时若还从 settings 兜底，会让每次内置搜索都误报「参数被忽略」。
    let settings_default = |value: &str| {
        if ctx.searxng.enabled {
            value.to_string()
        } else {
            String::new()
        }
    };
    let categories = arg_string(args, &["searxngCategory", "searxngCategories"])
        .unwrap_or_else(|| settings_default(&ctx.searxng.categories));
    let time_range = arg_string(args, &["searxngTimeRange"])
        .unwrap_or_else(|| settings_default(&ctx.searxng.time_range));
    let language = arg_string(args, &["searxngLanguage"])
        .unwrap_or_else(|| settings_default(&ctx.searxng.language));
    let safe_search = arg_u8(args, "searxngSafeSearch")
        .or_else(|| ctx.searxng.enabled.then_some(ctx.searxng.safe_search))
        .unwrap_or(1);
    let result = web_search::search_web_impl(
        query,
        Some(max_results),
        Some(ctx.searxng.enabled),
        Some(ctx.searxng.base_url.clone()),
        Some(categories),
        Some(time_range),
        Some(language),
        Some(safe_search),
        Some(ctx.searxng.engines.clone()),
    )?;
    Ok(ok_result(result, Vec::new()))
}

fn dispatch_skill(ctx: &RuntimeToolContext, args: &Value) -> Result<HostedOutcome, String> {
    let name = arg_string_req(args, &["name"])?;
    if !is_safe_skill_id(&name) {
        return Err("name 只能包含安全的 skill 路径片段".to_string());
    }
    let relative_path = resolve_skill_file_path(&ctx.workspace_path, &name)
        .ok_or_else(|| format!("Skill 不存在: {name}"))?;
    // 停用的 Skill 对 Agent 完全不可见：报「不存在」而非「已停用」，
    // 避免把停用状态（即文件的存在性）泄漏给模型。
    if !skill_available_to_load(&name, &ctx.skill_catalog)
        || !skill_available_to_load(&relative_path, &ctx.skill_catalog)
    {
        return Err(format!("Skill 不存在: {name}"));
    }
    let result = workspace_fs::read::read_text_file_impl(
        ctx.workspace_path.clone(),
        relative_path.clone(),
        Some(500_000),
        None,
        None,
        None,
        None,
    )?;
    let skill_root = skill_root_from_path(&relative_path);
    Ok(HostedOutcome {
        result: Ok(json!({
            "path": result.path,
            "content": result.content,
            "bytes": result.bytes,
            "startLine": result.start_line,
            "endLine": result.end_line,
            "totalLines": result.total_lines,
            "truncatedByRange": result.truncated_by_range,
            "truncatedByBytes": result.truncated_by_bytes,
            "locationLine": result.location_line,
            "locationColumn": result.location_column,
            "skillPath": relative_path,
            "skillRoot": skill_root,
        })),
        mutated: Vec::new(),
    })
}

fn dispatch_shell(
    sink: &SharedEventSink,
    runtime_id: &str,
    ctx: &RuntimeToolContext,
    req: &ToolRequest,
    cancel: &Arc<AtomicBool>,
) -> Result<HostedOutcome, String> {
    let args = &req.arguments;
    match req.tool_name.as_str() {
        "shell_open_session" => {
            let result = session::open_shell_session(
                ctx.workspace_path.clone(),
                arg_string(args, &["shell"]),
            )?;
            Ok(ok_result(result, Vec::new()))
        }
        "shell_list_sessions" => {
            let result = session::list_shell_sessions(Some(ctx.workspace_path.clone()))?;
            Ok(ok_result(result, Vec::new()))
        }
        "shell_read_output" => {
            let session_id = arg_string_req(args, &["sessionId"])?;
            let result = session::read_shell_output(session_id)?;
            Ok(ok_result(result, Vec::new()))
        }
        "shell_close_session" => {
            let session_id = arg_string_req(args, &["sessionId"])?;
            let result = session::close_shell_session(session_id)?;
            Ok(ok_result(result, Vec::new()))
        }
        "shell_send_input" => {
            let session_id = arg_string_req(args, &["sessionId"])?;
            let input = arg_string(args, &["input"]);
            let command = arg_string(args, &["command"]);
            if command.is_some() && input.is_some() {
                return Err("shell_send_input 不能同时传 input 和 command".to_string());
            }
            if let Some(command) = command {
                let command_args = arg_string_vec(args, "args").unwrap_or_default();
                let joined = std::iter::once(command.clone())
                    .chain(command_args.iter().cloned())
                    .collect::<Vec<_>>()
                    .join(" ");
                ensure_shell_codepapr(&joined, None, &ctx.mode, allow_codepapr_apps(ctx, req))?;
                for candidate in extract_absolute_command_paths(&joined) {
                    ensure_external_allowed(sink, runtime_id, ctx, req, &candidate, "execute", cancel)?;
                }
                let result = session::send_shell_command(session_id, command, Some(command_args))?;
                return Ok(ok_result(result, Vec::new()));
            }
            let input = input.ok_or_else(|| "shell_send_input 必须提供 input 或 command".to_string())?;
            ensure_shell_codepapr(&input, None, &ctx.mode, allow_codepapr_apps(ctx, req))?;
            for candidate in extract_absolute_command_paths(&input) {
                ensure_external_allowed(sink, runtime_id, ctx, req, &candidate, "execute", cancel)?;
            }
            let result = session::send_shell_input(session_id, input)?;
            Ok(ok_result(result, Vec::new()))
        }
        other => Err(format!("sidecar 宿主未实现工具: {other}")),
    }
}

fn is_safe_skill_id(name: &str) -> bool {
    !name.is_empty()
        && !name.contains("..")
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '/' | '-'))
}

fn is_resource_nested_skill_id(skill_id: &str) -> bool {
    let segments: Vec<&str> = skill_id.split('/').filter(|part| !part.is_empty()).collect();
    if segments.is_empty() {
        return true;
    }
    for (index, segment) in segments.iter().enumerate() {
        let lower = segment.to_ascii_lowercase();
        if !matches!(
            lower.as_str(),
            "agents" | "references" | "templates" | "commands" | "scripts"
        ) {
            continue;
        }
        if index == 0 && segments.len() == 1 {
            continue;
        }
        return true;
    }
    false
}

fn collect_skill_entry_refs(entries: &[workspace_fs::types::FileEntry]) -> Vec<(String, String, String)> {
    let mut refs: HashMap<String, (String, String)> = HashMap::new();
    for entry in entries {
        if entry.is_dir {
            continue;
        }
        let normalized = entry.path.replace('\\', "/");
        let Some(rest) = normalized.strip_prefix(".CodePapr/skills/") else {
            continue;
        };
        if rest.is_empty() || rest.ends_with('/') {
            continue;
        }
        let rest_lower = rest.to_ascii_lowercase();
        if let Some(prefix) = rest_lower.strip_suffix("/skill.md") {
            let skill_id = rest[..prefix.len()].to_string();
            if is_resource_nested_skill_id(&skill_id) {
                continue;
            }
            let display = skill_id
                .split('/')
                .filter(|part| !part.is_empty())
                .next_back()
                .unwrap_or(&skill_id)
                .to_string();
            refs.insert(skill_id, (display, normalized));
            continue;
        }
        if !rest.contains('/') && rest_lower.ends_with(".md") {
            let skill_id = rest[..rest.len() - 3].to_string();
            refs.entry(skill_id.clone()).or_insert_with(|| (skill_id, normalized));
        }
    }
    refs.into_iter()
        .map(|(id, (display, path))| (id, display, path))
        .collect()
}

fn resolve_skill_file_path(workspace_path: &str, name: &str) -> Option<String> {
    if !is_safe_skill_id(name) {
        return None;
    }
    let listed = workspace_fs::list::list_workspace_files_impl(
        workspace_path.to_string(),
        Some(".CodePapr/skills".to_string()),
        Some(10),
        Some(true),
    )
    .ok()?;
    let entries = collect_skill_entry_refs(&listed.entries);
    if let Some((_, _, path)) = entries.iter().find(|(id, _, _)| id == name) {
        return Some(path.clone());
    }
    let matches: Vec<_> = entries
        .iter()
        .filter(|(id, display, _)| {
            display == name
                || id.split('/').filter(|part| !part.is_empty()).next_back() == Some(name)
        })
        .collect();
    if matches.len() == 1 {
        Some(matches[0].2.clone())
    } else {
        None
    }
}

fn skill_root_from_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let lower = normalized.to_ascii_lowercase();
    if let Some(stripped) = lower.strip_suffix("/skill.md") {
        return normalized[..stripped.len()].to_string();
    }
    if let Some(stripped) = lower.strip_suffix(".md") {
        return normalized[..stripped.len()].to_string();
    }
    normalized
}

fn skill_available_to_load(needle: &str, catalog: &[RuntimeSkillEntry]) -> bool {
    let needle = needle.trim();
    if needle.is_empty() {
        return false;
    }
    let matched: Vec<&RuntimeSkillEntry> = catalog
        .iter()
        .filter(|skill| {
            skill_catalog_name(skill) == needle
                || skill_leaf_name(skill) == needle
                || skill.id == needle
                || skill.display_name == needle
                || skill.name == needle
                || skill.source_path == needle
        })
        .collect();
    // 多个 Skill 共享 name/leaf 时，任一匹配项被停用即拒绝：
    // 不能因为先匹配到同名且启用的条目，就把停用的那份读出来。
    matched.is_empty() || matched.iter().all(|skill| skill.enabled)
}

fn skill_catalog_name(skill: &RuntimeSkillEntry) -> String {
    let id = skill.id.trim();
    if !id.is_empty() {
        return id.to_string();
    }
    let display = skill.display_name.trim();
    if !display.is_empty() {
        return display.to_string();
    }
    skill.name.trim().to_string()
}

fn skill_leaf_name(skill: &RuntimeSkillEntry) -> String {
    let catalog = if !skill.id.is_empty() {
        skill.id.as_str()
    } else if !skill.source_path.is_empty() {
        skill.source_path.as_str()
    } else {
        skill.name.as_str()
    };
    catalog
        .replace('\\', "/")
        .split('/')
        .filter(|part| !part.is_empty() && *part != "SKILL.md" && !part.eq_ignore_ascii_case("skill.md"))
        .next_back()
        .unwrap_or(catalog)
        .trim_end_matches(".md")
        .trim_end_matches(".MD")
        .to_string()
}

fn git_op_json(action: &str, result: crate::snapshot::types::GitOperationResult) -> Value {
    json!({
        "available": true,
        "isRepo": true,
        "ok": result.ok,
        "raw": result.message,
        "action": action,
        "message": result.message,
        "backupBranch": result.backup_ref,
    })
}

fn allow_apps_for(mode: &str, access: Option<&AppAccess>) -> bool {
    mode == "app" || access.and_then(|a| a.allow_codepapr_apps).unwrap_or(false)
}

fn allow_codepapr_apps(ctx: &RuntimeToolContext, req: &ToolRequest) -> bool {
    allow_apps_for(&ctx.mode, req.app_access.as_ref())
}

fn sandbox_from_access(mode: &str, access: Option<&AppAccess>) -> SandboxAccessArgs {
    let allow_apps = allow_apps_for(mode, access);
    if let Some(access) = access {
        SandboxAccessArgs {
            network: access.network.unwrap_or(true),
            workspace_write: access.workspace_write.unwrap_or(true),
            allow_bind: false,
            allow_codepapr_apps: allow_apps,
        }
    } else {
        SandboxAccessArgs {
            network: true,
            workspace_write: true,
            allow_bind: false,
            allow_codepapr_apps: allow_apps,
        }
    }
}

fn ensure_external_allowed(
    sink: &SharedEventSink,
    runtime_id: &str,
    ctx: &RuntimeToolContext,
    req: &ToolRequest,
    path: &str,
    operation: &str,
    cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    if !is_absolute_path(path) {
        return Ok(());
    }
    let check = check_external_path(ctx.workspace_path.clone(), path.to_string())?;
    if check.in_workspace || check.allowed {
        return Ok(());
    }
    if check.protected {
        return Err(format!(
            "安全限制：禁止访问受保护的隐藏目录 {}",
            check.canonical_path
        ));
    }
    if cancel.load(Ordering::SeqCst) {
        return Err("已取消".to_string());
    }

    let permission_id = format!(
        "perm-{}",
        NEXT_PERMISSION_ID.fetch_add(1, Ordering::Relaxed)
    );
    let (tx, rx) = mpsc::channel();
    permission_waiters()
        .lock()
        .map_err(|_| "permission lock poisoned".to_string())?
        .insert(permission_id.clone(), tx);
    tool_permission()
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .insert(req.tool_request_id.clone(), permission_id.clone());

    let _ = crate::agent_runtime::write_sidecar_stdin(
        runtime_id,
        &format!("{}\n", json!({ "type": "permission-wait", "waiting": true })),
    );
    sink.emit(
        PERMISSION_EVENT,
        serde_json::to_value(PermissionRequestEvent {
            runtime_id: runtime_id.to_string(),
            request_id: permission_id.clone(),
            path: if check.exists {
                check.canonical_path.clone()
            } else {
                path.to_string()
            },
            operation: operation.to_string(),
            tool_name: req.tool_name.clone(),
            workspace_path: ctx.workspace_path.clone(),
            exists: check.exists,
            allow_file: check.exists,
        })
        .unwrap_or_default(),
    );

    loop {
        if cancel.load(Ordering::SeqCst) {
            sink.emit(
                PERMISSION_CANCEL_EVENT,
                json!({ "runtimeId": runtime_id, "requestId": permission_id }),
            );
            reject_permission(&permission_id, "已取消".to_string());
            let _ = crate::agent_runtime::write_sidecar_stdin(
                runtime_id,
                &format!("{}\n", json!({ "type": "permission-wait", "waiting": false })),
            );
            return Err("已取消".to_string());
        }
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(Ok(decision)) => {
                let _ = crate::agent_runtime::write_sidecar_stdin(
                    runtime_id,
                    &format!("{}\n", json!({ "type": "permission-wait", "waiting": false })),
                );
                if !decision.approved {
                    return Err(format!("用户拒绝访问外部路径：{}", check.canonical_path));
                }
                crate::workspace_fs::access::grant_external_access(
                    ctx.workspace_path.clone(),
                    check.canonical_path.clone(),
                    decision.scope,
                )?;
                return Ok(());
            }
            Ok(Err(err)) => {
                let _ = crate::agent_runtime::write_sidecar_stdin(
                    runtime_id,
                    &format!("{}\n", json!({ "type": "permission-wait", "waiting": false })),
                );
                return Err(err);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = crate::agent_runtime::write_sidecar_stdin(
                    runtime_id,
                    &format!("{}\n", json!({ "type": "permission-wait", "waiting": false })),
                );
                return Err("权限请求已取消".to_string());
            }
        }
    }
}

fn reject_permission(request_id: &str, error: String) {
    if let Some(sender) = permission_waiters()
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .remove(request_id)
    {
        let _ = sender.send(Err(error));
    }
}

fn ok_result<T: Serialize>(value: T, mutated: Vec<String>) -> HostedOutcome {
    HostedOutcome {
        result: serde_json::to_value(value).map_err(|err| err.to_string()),
        mutated,
    }
}

pub(crate) fn glob_to_regex(glob: &str) -> String {
    let mut pattern = String::from("^");
    let chars: Vec<char> = glob.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch == '*' {
            if chars.get(i + 1) == Some(&'*') {
                i += 1;
                if chars.get(i + 1) == Some(&'/') {
                    i += 1;
                    pattern.push_str("(.*/)?");
                } else {
                    pattern.push_str(".*");
                }
            } else {
                pattern.push_str("[^/]*");
            }
        } else if ch == '?' {
            pattern.push_str("[^/]");
        } else if ".+^${}()|[]\\".contains(ch) {
            pattern.push('\\');
            pattern.push(ch);
        } else {
            pattern.push(ch);
        }
        i += 1;
    }
    pattern.push('$');
    pattern
}

#[derive(Debug)]
pub(crate) struct PatchedContent {
    content: String,
    replacements: usize,
}

pub(crate) fn apply_search_replace(
    content: &str,
    search: &str,
    replace: &str,
    replace_all: Option<bool>,
    expected_occurrences: Option<usize>,
) -> Result<PatchedContent, String> {
    if search.is_empty() {
        return Err("search 不能为空".to_string());
    }
    let file_has_crlf = content.contains("\r\n");
    let search_lf = search.replace("\r\n", "\n");
    let replace_lf = replace.replace("\r\n", "\n");
    let content_lf = if file_has_crlf {
        content.replace("\r\n", "\n")
    } else {
        content.to_string()
    };
    let occurrences = content_lf.matches(&search_lf).count();
    if occurrences == 0 {
        let hint = if search.contains("\r\n") && !file_has_crlf {
            "（文件使用 LF 换行，但 search 使用了 CRLF）"
        } else if !search.contains("\r\n") && file_has_crlf {
            "（文件使用 CRLF 换行，但 search 使用了 LF）"
        } else {
            ""
        };
        return Err(format!("未找到要替换的文本块{hint}"));
    }
    if let Some(expected) = expected_occurrences {
        if expected != occurrences {
            return Err(format!(
                "预期匹配 {expected} 处，实际匹配 {occurrences} 处"
            ));
        }
    }
    if occurrences > 1 && replace_all != Some(true) {
        let extra = if expected_occurrences.is_some() {
            "（expectedOccurrences 只能校验数量，不能消歧；请加长 search 或设置 replaceAll=true）"
        } else {
            ""
        };
        return Err(format!(
            "匹配到 {occurrences} 处文本块，请改用更精确的 search 或设置 replaceAll=true{extra}"
        ));
    }
    let replacements = if replace_all == Some(true) {
        occurrences
    } else {
        1
    };
    let patched_lf = if replace_all == Some(true) {
        content_lf.replace(&search_lf, &replace_lf)
    } else {
        content_lf.replacen(&search_lf, &replace_lf, 1)
    };
    let content = if file_has_crlf {
        patched_lf.replace('\n', "\r\n")
    } else {
        patched_lf
    };
    Ok(PatchedContent {
        content,
        replacements,
    })
}

pub(crate) fn is_memory_file_path(relative_path: &str) -> bool {
    let normalized = relative_path
        .replace('\\', "/")
        .trim_start_matches("./")
        .replace("//", "/")
        .trim_end_matches('/')
        .to_ascii_lowercase();
    normalized == ".codepapr/memory.md"
}

fn touches_memory_file(name: &str, args: &Value) -> bool {
    if matches!(
        name,
        "write" | "edit" | "patch" | "workspace_write_file" | "workspace_apply_patch" | "workspace_apply_diff"
    ) {
        if let Ok(path) = extract_path(args, false) {
            if path.as_deref().is_some_and(is_memory_file_path) {
                return true;
            }
        }
        if let Some(patches) = args.get("patches").and_then(Value::as_array) {
            return patches.iter().any(|patch| {
                extract_path(patch, false)
                    .ok()
                    .flatten()
                    .is_some_and(|path| is_memory_file_path(&path))
            });
        }
    }
    false
}

fn ensure_codepapr_access(path: &str, op: &str, mode: &str, allow_apps: bool) -> Result<(), String> {
    let Some(suffix) = codepapr_suffix(path) else {
        return Ok(());
    };
    if is_allowed_codepapr_suffix(&suffix, op, mode, allow_apps) {
        return Ok(());
    }
    Err(format!(
        "无法访问「{path}」：.CodePapr 由 CodePapr 运行时管理。Agent 请使用 skill / 项目配置界面；草稿可用 .CodePapr/tmp、tool-output、downloads、screenshots、images、assets、fixtures。"
    ))
}

fn ensure_shell_codepapr(
    command: &str,
    workdir: Option<&str>,
    mode: &str,
    allow_apps: bool,
) -> Result<(), String> {
    if let Some(dir) = workdir {
        ensure_codepapr_access(dir, "execute", mode, allow_apps)?;
    }
    for token in command.split(|ch: char| " \t\"'`=<>|;&()".contains(ch)) {
        let token = token.trim_end_matches(|ch: char| ",.;".contains(ch));
        if token.is_empty() || codepapr_suffix(token).is_none() {
            continue;
        }
        ensure_codepapr_access(token, "execute", mode, allow_apps)?;
    }
    Ok(())
}

fn codepapr_suffix(path: &str) -> Option<String> {
    let normalized = path.replace('\\', "/");
    let parts: Vec<&str> = normalized
        .split('/')
        .map(str::trim)
        .filter(|part| !part.is_empty() && *part != ".")
        .collect();
    let index = parts
        .iter()
        .position(|part| part.eq_ignore_ascii_case(".codepapr"))?;
    Some(parts[index + 1..].join("/"))
}

fn is_allowed_codepapr_suffix(suffix: &str, op: &str, mode: &str, allow_apps: bool) -> bool {
    if suffix.is_empty() {
        return false;
    }
    let first = suffix.split('/').next().unwrap_or("").to_ascii_lowercase();
    matches!(
        first.as_str(),
        "tmp" | "tool-output" | "downloads" | "screenshots" | "images" | "assets" | "fixtures"
    ) || (first == "skills" && op != "write")
        || (first == "apps" && (mode == "app" || allow_apps))
}

fn is_absolute_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    normalized.starts_with('/') || {
        let bytes = normalized.as_bytes();
        bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/'
    }
}

fn extract_absolute_command_paths(command: &str) -> Vec<String> {
    let skip = sandbox_skip_prefixes();
    let mut out = Vec::new();
    for part in command.split(|ch: char| " \t\"'`=<>|;&()".contains(ch)) {
        let candidate = part
            .trim_matches(|ch: char| ",.;".contains(ch))
            .replace('\\', "/");
        if !(candidate.starts_with('/') || is_absolute_path(&candidate)) {
            continue;
        }
        if skip.iter().any(|prefix| candidate.starts_with(prefix)) {
            continue;
        }
        if !out.contains(&candidate) {
            out.push(candidate);
        }
    }
    out
}

fn sandbox_skip_prefixes() -> Vec<String> {
    let mut prefixes = vec![
        "/bin/".to_string(),
        "/sbin/".to_string(),
        "/usr/bin/".to_string(),
        "/usr/sbin/".to_string(),
        "/usr/local/bin/".to_string(),
        "/opt/homebrew/bin/".to_string(),
        "/opt/homebrew/".to_string(),
    ];
    if let Ok(path) = std::env::var("PATH") {
        for entry in path.split(':').filter(|entry| !entry.is_empty()) {
            prefixes.push(format!("{entry}/"));
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        for name in [".npm", ".cache", ".cargo", ".local/share", ".nvm", ".volta"] {
            prefixes.push(format!("{home}/{name}/"));
        }
    }
    prefixes
}

fn require_path(args: &Value) -> Result<String, String> {
    if let Some(path) = extract_path(args, false)? {
        return Ok(path);
    }
    // 区分「参数缺失」与「传了错误类型」：后者给出实际类型，便于模型自纠。
    const PATH_KEYS: [&str; 8] = [
        "relativePath",
        "path",
        "filePath",
        "file_path",
        "imagePath",
        "image_path",
        "file",
        "src",
    ];
    for key in PATH_KEYS {
        match args.get(key) {
            None | Some(Value::Null) | Some(Value::String(_)) => continue,
            Some(value) => {
                let type_name = match value {
                    Value::Bool(_) => "boolean",
                    Value::Number(_) => "number",
                    Value::Array(_) => "array",
                    Value::Object(_) => "object",
                    _ => "unknown",
                };
                return Err(format!(
                    "{key} 必须是非空字符串（实际类型: {type_name}），请传入文件的相对路径，如 \"src/main.ts\"",
                ));
            }
        }
    }
    Err("缺少路径参数：需要文件的相对路径（relativePath），如 \"src/main.ts\"".to_string())
}

fn extract_path(args: &Value, _required: bool) -> Result<Option<String>, String> {
    for key in [
        "relativePath",
        "path",
        "filePath",
        "file_path",
        "imagePath",
        "image_path",
        "file",
        "src",
    ] {
        if let Some(value) = arg_string(args, &[key]) {
            return Ok(Some(value));
        }
    }
    Ok(None)
}

fn arg_string(args: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = args.get(*key).and_then(Value::as_str) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn arg_string_req(args: &Value, keys: &[&str]) -> Result<String, String> {
    arg_string(args, keys).ok_or_else(|| format!("{} 必须是字符串", keys[0]))
}

fn arg_bool(args: &Value, key: &str) -> Option<bool> {
    args.get(key).and_then(Value::as_bool)
}

fn arg_usize(args: &Value, key: &str) -> Option<usize> {
    args.get(key).and_then(Value::as_u64).map(|n| n as usize)
}

fn arg_u64(args: &Value, key: &str) -> Option<u64> {
    args.get(key).and_then(Value::as_u64)
}

fn arg_u32(args: &Value, key: &str) -> Option<u32> {
    args.get(key).and_then(Value::as_u64).map(|n| n as u32)
}

fn arg_u8(args: &Value, key: &str) -> Option<u8> {
    args.get(key).and_then(|value| {
        value
            .as_u64()
            .or_else(|| value.as_f64().map(|n| n as u64))
            .map(|n| n.min(255) as u8)
    })
}

fn arg_string_vec(args: &Value, key: &str) -> Option<Vec<String>> {
    args.get(key).and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect()
    })
}

fn chrono_like_iso(timestamp: i64) -> String {
    // Keep a stable UTC-ish ISO without pulling chrono. JS used toISOString().
    let secs = timestamp.max(0) as u64;
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let hour = rem / 3600;
    let min = (rem % 3600) / 60;
    let sec = rem % 60;
    let mut y = 1970u64;
    let mut remain_days = days;
    loop {
        let len = if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) {
            366
        } else {
            365
        };
        if remain_days < len {
            break;
        }
        remain_days -= len;
        y += 1;
    }
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let mdays = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1u64;
    for dim in mdays {
        if remain_days < dim {
            break;
        }
        remain_days -= dim;
        month += 1;
    }
    let day = remain_days + 1;
    format!("{y:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}.000Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rust_hosted_allowlist_covers_hot_path() {
        let read = json!({ "toolName": "read", "arguments": { "relativePath": "src/a.ts" } });
        assert!(should_host_in_rust(&read));
        let todo = json!({ "toolName": "todo", "arguments": {} });
        assert!(!should_host_in_rust(&todo));
        let memory = json!({
            "toolName": "write",
            "arguments": { "relativePath": ".CodePapr/memory.md", "content": "x" }
        });
        assert!(!should_host_in_rust(&memory));
        let lsp = json!({ "toolName": "lsp", "arguments": { "action": "hover", "relativePath": "src/a.ts" } });
        assert!(should_host_in_rust(&lsp));
        let git_reset = json!({ "toolName": "git", "arguments": { "action": "reset", "target": "HEAD" } });
        assert!(should_host_in_rust(&git_reset));
        let image = json!({ "toolName": "read_image", "arguments": { "relativePath": "shot.png" } });
        assert!(should_host_in_rust(&image));
        let time = json!({ "toolName": "local_time_now", "arguments": {} });
        assert!(should_host_in_rust(&time));
        let project_diag = json!({ "toolName": "diagnostics", "arguments": { "project": true } });
        assert!(!should_host_in_rust(&project_diag));
        let file_diag = json!({ "toolName": "diagnostics", "arguments": { "relativePath": "src/a.ts" } });
        assert!(should_host_in_rust(&file_diag));
        let graph = json!({ "toolName": "graph", "arguments": { "action": "overview" } });
        assert!(!should_host_in_rust(&graph));
        let webfetch = json!({ "toolName": "webfetch", "arguments": { "url": "https://example.com" } });
        assert!(should_host_in_rust(&webfetch));
        let websearch = json!({ "toolName": "websearch", "arguments": { "query": "rust" } });
        assert!(should_host_in_rust(&websearch));
        let skill = json!({ "toolName": "skill", "arguments": { "name": "docs" } });
        assert!(should_host_in_rust(&skill));
        let shell = json!({ "toolName": "shell_open_session", "arguments": {} });
        assert!(should_host_in_rust(&shell));
        let preview = json!({
            "toolName": "workspace_start_preview_session",
            "arguments": { "command": "python", "previewUrl": "http://127.0.0.1:8000" }
        });
        assert!(should_host_in_rust(&preview));
        let question = json!({ "toolName": "question", "arguments": { "question": "ok?" } });
        assert!(!should_host_in_rust(&question));
        let browser = json!({ "toolName": "browser", "arguments": { "action": "open" } });
        assert!(!should_host_in_rust(&browser));
        let app_render = json!({ "toolName": "app_render", "arguments": { "appId": "demo" } });
        assert!(!should_host_in_rust(&app_render));
        let mcp = json!({ "toolName": "mcp__demo__search", "arguments": {} });
        assert!(!should_host_in_rust(&mcp));
    }

    fn test_tool_ctx(workspace: &str) -> RuntimeToolContext {
        RuntimeToolContext {
            workspace_path: workspace.to_string(),
            mode: "agent".to_string(),
            searxng: RuntimeSearxngSettings::default(),
            skill_catalog: Vec::new(),
        }
    }

    #[test]
    fn skill_load_reads_project_skill_file() {
        let ws = crate::test_helpers::TestWorkspace::new("sidecar-host-skill");
        let skill_dir = ws.file_path(".CodePapr/skills/docs");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(skill_dir.join("SKILL.md"), "# Docs\nhello skill\n").unwrap();
        let outcome = dispatch_skill(
            &test_tool_ctx(&ws.workspace_arg()),
            &json!({ "name": "docs" }),
        )
        .unwrap();
        let value = outcome.result.unwrap();
        assert_eq!(value["skillPath"], ".CodePapr/skills/docs/SKILL.md");
        assert!(value["content"].as_str().unwrap().contains("hello skill"));
    }

    #[test]
    fn skill_load_rejects_disabled_catalog_entry() {
        let ws = crate::test_helpers::TestWorkspace::new("sidecar-host-skill-off");
        let skill_dir = ws.file_path(".CodePapr/skills/search");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(skill_dir.join("SKILL.md"), "# Search\n").unwrap();
        let mut ctx = test_tool_ctx(&ws.workspace_arg());
        ctx.skill_catalog.push(RuntimeSkillEntry {
            name: "search".to_string(),
            id: "search".to_string(),
            display_name: "search".to_string(),
            source_path: ".CodePapr/skills/search/SKILL.md".to_string(),
            enabled: false,
        });
        let err = match dispatch_skill(&ctx, &json!({ "name": "search" })) {
            Ok(_) => panic!("disabled skill should not load"),
            Err(error) => error,
        };
        // 停用项必须伪装成「不存在」：错误信息不得泄漏停用状态。
        assert!(err.contains("不存在"), "{err}");
        assert!(!err.contains("已停用"), "{err}");
    }

    #[test]
    fn skill_available_to_load_rejects_when_any_name_match_disabled() {
        let catalog = vec![
            RuntimeSkillEntry {
                name: "shared".to_string(),
                id: "alpha".to_string(),
                ..Default::default()
            },
            RuntimeSkillEntry {
                name: "shared".to_string(),
                id: "beta".to_string(),
                enabled: false,
                ..Default::default()
            },
        ];
        // 同名两条、其中一条停用：按共享名查询必须被拒绝（不能只看先命中的启用项）。
        assert!(!skill_available_to_load("shared", &catalog));
        // 精确 id 只命中启用项：仍然允许。
        assert!(skill_available_to_load("alpha", &catalog));
        // 目录外的名字维持“不存在即放行”的既有语义。
        assert!(skill_available_to_load("gamma", &catalog));
        assert!(!skill_available_to_load("  ", &catalog));
    }

    #[test]
    fn glob_starstar_matches_ts() {
        assert_eq!(glob_to_regex("**/*.ts"), "^(.*/)?[^/]*\\.ts$");
        assert_eq!(glob_to_regex("src/*.rs"), "^src/[^/]*\\.rs$");
    }

    #[test]
    fn read_write_edit_roundtrip_on_disk() {
        let ws = crate::test_helpers::TestWorkspace::new("sidecar-host-tools");
        std::fs::write(ws.file_path("note.txt"), "alpha\n").unwrap();
        crate::workspace_fs::write::write_text_file_impl(
            ws.workspace_arg(),
            "note.txt".to_string(),
            "alpha\nbeta\n".to_string(),
        )
        .unwrap();
        let read = crate::workspace_fs::read::read_text_file_impl(
            ws.workspace_arg(),
            "note.txt".to_string(),
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        assert!(read.content.contains("beta"));
        let patched = apply_search_replace(&read.content, "beta", "gamma", None, None).unwrap();
        assert_eq!(patched.replacements, 1);
        assert!(patched.content.contains("gamma"));
        assert!(!patched.content.contains("beta"));
    }

    #[test]
    fn search_replace_single_and_all() {
        let one = apply_search_replace("hello world\n", "world", "there", None, None).unwrap();
        assert_eq!(one.content, "hello there\n");
        assert_eq!(one.replacements, 1);
        let all = apply_search_replace("a\na\n", "a", "b", Some(true), None).unwrap();
        assert_eq!(all.content, "b\nb\n");
        assert_eq!(all.replacements, 2);
        let err = apply_search_replace("hello", "missing", "x", None, None).unwrap_err();
        assert!(err.contains("未找到"));
    }

    #[test]
    fn codepapr_gate_blocks_config_and_allows_scratch() {
        assert!(ensure_codepapr_access(".CodePapr/AGENTS.md", "read", "agent", false).is_err());
        assert!(ensure_codepapr_access(".CodePapr/tmp/out.txt", "write", "agent", false).is_ok());
        assert!(ensure_codepapr_access(".CodePapr/apps/x/index.html", "read", "agent", false).is_err());
        assert!(ensure_codepapr_access(".CodePapr/apps/x/index.html", "read", "app", false).is_ok());
        assert!(ensure_codepapr_access(".CodePapr/apps/x/index.html", "read", "agent", true).is_ok());
        // browser 截图默认存 screenshots 前缀（Agent 可读）；运行时私有的 browser 目录仍封锁
        assert!(ensure_codepapr_access(".CodePapr/screenshots/shot.png", "read", "agent", false).is_ok());
        assert!(ensure_codepapr_access(".CodePapr/browser/shot.png", "read", "agent", false).is_err());
        assert!(ensure_shell_codepapr("node server.js", Some(".CodePapr/apps/x"), "agent", true).is_ok());
        assert!(ensure_shell_codepapr("node server.js", Some(".CodePapr/apps/x"), "agent", false).is_err());
    }

    #[test]
    fn allow_apps_requires_explicit_true_outside_app_mode() {
        let access = |allow: Option<bool>| AppAccess {
            network: Some(false),
            workspace_write: Some(true),
            allow_codepapr_apps: allow,
        };
        assert!(allow_apps_for("app", None));
        assert!(allow_apps_for("agent", Some(&access(Some(true)))));
        // 缺省/显式 false 的 appAccess 不再默认放行 .CodePapr/apps
        assert!(!allow_apps_for("agent", Some(&access(None))));
        assert!(!allow_apps_for("agent", Some(&access(Some(false)))));
        assert!(!allow_apps_for("agent", None));
        let denied = sandbox_from_access("agent", Some(&access(Some(false))));
        assert!(!denied.allow_codepapr_apps);
        assert!(!denied.network);
        assert!(denied.workspace_write);
    }

    #[test]
    fn local_time_now_has_iso_and_unix() {
        let value = local_time_now();
        assert!(value.get("iso").and_then(Value::as_str).unwrap_or("").contains('T'));
        assert!(value.get("unixMs").and_then(Value::as_u64).unwrap_or(0) > 0);
    }
}
