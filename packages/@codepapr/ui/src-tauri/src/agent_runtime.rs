//! Node sidecar for the Agent chat loop.
//!
//! App-level singleton Node process. Session switch reuses the live process
//! (`init` from the new agent). Crash recovery calls `agent_runtime_stop`
//! then start. UI talks NDJSON over stdin/stdout.
//! P2: `tool-request` for fs/bash/git/lsp/images/web/skill/shell is executed here instead of WebView JS.

use crate::agent_runtime_tools::{self, RuntimeSearxngSettings, RuntimeSkillEntry, RuntimeToolContext};
use crate::lsp_managed_tools;
use crate::shell::process_tree::{kill_process_tree, prepare_new_process_group};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use tauri::{AppHandle, Emitter, Manager};

pub(crate) const FRAME_EVENT: &str = "agent-runtime://frame";
const EXIT_EVENT: &str = "agent-runtime://exit";

struct RuntimeProcess {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Clone, Default)]
struct RuntimeMeta {
    workspace_path: Option<String>,
    mode: String,
    searxng: RuntimeSearxngSettings,
    skill_catalog: Vec<RuntimeSkillEntry>,
}

static RUNTIME_META: OnceLock<Mutex<HashMap<String, RuntimeMeta>>> = OnceLock::new();

fn runtime_meta() -> &'static Mutex<HashMap<String, RuntimeMeta>> {
    RUNTIME_META.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FrameEvent {
    runtime_id: String,
    message: serde_json::Value,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitEvent {
    runtime_id: String,
    code: Option<i32>,
    signal: Option<String>,
    error: Option<String>,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static RUNTIMES: OnceLock<Mutex<HashMap<String, RuntimeProcess>>> = OnceLock::new();
static START_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn runtimes() -> &'static Mutex<HashMap<String, RuntimeProcess>> {
    RUNTIMES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn start_lock() -> &'static Mutex<()> {
    START_LOCK.get_or_init(|| Mutex::new(()))
}

fn lock_runtimes() -> Result<std::sync::MutexGuard<'static, HashMap<String, RuntimeProcess>>, String> {
    runtimes()
        .lock()
        .map_err(|_| "agent runtime lock poisoned".to_string())
}

fn find_path_node() -> Option<PathBuf> {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn resolve_node() -> Result<PathBuf, String> {
    if let Ok(custom) = std::env::var("CODEPAPR_AGENT_NODE") {
        let path = PathBuf::from(custom);
        if path.is_file() {
            return Ok(path);
        }
        return Err(format!(
            "CODEPAPR_AGENT_NODE is not a file: {}",
            path.display()
        ));
    }
    lsp_managed_tools::find_managed_node_command()
        .or_else(find_path_node)
        .ok_or_else(|| {
            "找不到 Node.js 运行时（打包 node-runtime 或 PATH 上的 node）".to_string()
        })
}

fn sidecar_script_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(custom) = std::env::var("CODEPAPR_AGENT_SIDECAR_SCRIPT") {
        candidates.push(PathBuf::from(custom));
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("agent-runtime.mjs"));
        candidates.push(resource_dir.join("dist-sidecar").join("agent-runtime.mjs"));
        candidates.push(
            resource_dir
                .join("_up_")
                .join("dist-sidecar")
                .join("agent-runtime.mjs"),
        );
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(ui_dir) = manifest.parent() {
        candidates.push(ui_dir.join("dist-sidecar").join("agent-runtime.mjs"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("agent-runtime.mjs"));
            candidates.push(dir.join("resources").join("agent-runtime.mjs"));
            candidates.push(dir.join("..").join("Resources").join("agent-runtime.mjs"));
        }
    }
    candidates
}

fn resolve_sidecar_script(app: &AppHandle) -> Result<PathBuf, String> {
    sidecar_script_candidates(app)
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            "找不到 agent sidecar 脚本 dist-sidecar/agent-runtime.mjs（先跑 npm run build:sidecar）"
                .to_string()
        })
}

fn pipe_stderr(stderr: std::process::ChildStderr) {
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            if !line.is_empty() {
                eprintln!("[agent-sidecar] {line}");
            }
        }
    });
}

fn emit_frames(app: AppHandle, runtime_id: String, stdout: std::process::ChildStdout) {
    let reader = BufReader::new(stdout);
    for line in reader.lines().map_while(Result::ok) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let message = match serde_json::from_str::<serde_json::Value>(trimmed) {
            Ok(value) => value,
            Err(err) => serde_json::json!({
                "type": "worker-diagnostic",
                "message": format!("sidecar stdout is not JSON: {err}"),
                "detail": trimmed.chars().take(240).collect::<String>(),
            }),
        };
        dispatch_sidecar_frame(&app, &runtime_id, message);
    }

    let child = {
        let mut map = match lock_runtimes() {
            Ok(map) => map,
            Err(_) => return,
        };
        map.remove(&runtime_id)
    };
    clear_runtime_meta(&runtime_id);
    let event = if let Some(mut runtime) = child {
        drop(runtime.stdin);
        match runtime.child.wait() {
            Ok(status) => ExitEvent {
                runtime_id: runtime_id.clone(),
                code: status.code(),
                signal: None,
                error: None,
            },
            Err(err) => ExitEvent {
                runtime_id: runtime_id.clone(),
                code: None,
                signal: None,
                error: Some(err.to_string()),
            },
        }
    } else {
        return;
    };
    let _ = app.emit(EXIT_EVENT, event);
}

fn dispatch_sidecar_frame(app: &AppHandle, runtime_id: &str, message: serde_json::Value) {
    let ty = message.get("type").and_then(|value| value.as_str()).unwrap_or("");
    if ty == "tool-request" && agent_runtime_tools::should_host_in_rust(&message) {
        let app = app.clone();
        let runtime_id = runtime_id.to_string();
        std::thread::spawn(move || {
            agent_runtime_tools::handle_hosted_tool_request(app, runtime_id, message);
        });
        return;
    }
    if ty == "cancel-tool-request" {
        agent_runtime_tools::cancel_hosted_tool(&message);
    }
    let _ = app.emit(
        FRAME_EVENT,
        FrameEvent {
            runtime_id: runtime_id.to_string(),
            message,
        },
    );
}

pub(crate) fn runtime_tool_context(runtime_id: &str) -> Option<RuntimeToolContext> {
    let map = runtime_meta().lock().ok()?;
    let meta = map.get(runtime_id)?;
    Some(RuntimeToolContext {
        workspace_path: meta.workspace_path.clone().unwrap_or_default(),
        mode: if meta.mode.is_empty() {
            "agent".to_string()
        } else {
            meta.mode.clone()
        },
        searxng: meta.searxng.clone(),
        skill_catalog: meta.skill_catalog.clone(),
    })
}

pub(crate) fn write_sidecar_stdin(runtime_id: &str, line: &str) -> Result<(), String> {
    let mut map = lock_runtimes()?;
    let runtime = map
        .get_mut(runtime_id)
        .ok_or_else(|| format!("unknown agent runtime {runtime_id}"))?;
    runtime
        .stdin
        .write_all(line.as_bytes())
        .map_err(|err| format!("write sidecar stdin: {err}"))?;
    if !line.ends_with('\n') {
        runtime
            .stdin
            .write_all(b"\n")
            .map_err(|err| format!("write sidecar stdin newline: {err}"))?;
    }
    runtime
        .stdin
        .flush()
        .map_err(|err| format!("flush sidecar stdin: {err}"))
}

fn note_outbound_message(runtime_id: &str, line: &str) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
        return;
    };
    let ty = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let workspace = match ty {
        "init" | "chat" => value
            .pointer("/payload/workspacePath")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        "run-app-agent" => value
            .pointer("/payload/workspacePath")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        _ => None,
    };
    let mode = match ty {
        "init" | "chat" => value
            .pointer("/payload/runtime/mode")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        "run-app-agent" => value
            .pointer("/payload/mode")
            .or_else(|| value.pointer("/payload/runtime/mode"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
        _ => None,
    };
    let searxng = match ty {
        "init" | "chat" | "run-app-agent" => value
            .pointer("/payload/settings")
            .map(parse_searxng_settings),
        _ => None,
    };
    let skill_catalog = match ty {
        "init" | "chat" | "run-app-agent" => value
            .pointer("/payload/runtime/skillDefinitions")
            .and_then(parse_skill_catalog),
        _ => None,
    };
    if workspace.is_none() && mode.is_none() && searxng.is_none() && skill_catalog.is_none() {
        return;
    }
    if let Ok(mut map) = runtime_meta().lock() {
        let meta = map.entry(runtime_id.to_string()).or_default();
        if let Some(workspace) = workspace {
            meta.workspace_path = Some(workspace);
        }
        if let Some(mode) = mode {
            meta.mode = mode;
        }
        if let Some(searxng) = searxng {
            meta.searxng = searxng;
        }
        if let Some(skill_catalog) = skill_catalog {
            meta.skill_catalog = skill_catalog;
        }
    }
}

fn parse_searxng_settings(settings: &serde_json::Value) -> RuntimeSearxngSettings {
    RuntimeSearxngSettings {
        enabled: settings
            .get("searxngEnabled")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        base_url: settings
            .get("searxngBaseUrl")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string(),
        categories: settings
            .get("searxngCategories")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string(),
        time_range: settings
            .get("searxngTimeRange")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string(),
        language: settings
            .get("searxngLanguage")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string(),
        safe_search: settings
            .get("searxngSafeSearch")
            .and_then(serde_json::Value::as_u64)
            .or_else(|| {
                settings
                    .get("searxngSafeSearch")
                    .and_then(serde_json::Value::as_f64)
                    .map(|n| n as u64)
            })
            .unwrap_or(1)
            .min(2) as u8,
        engines: settings
            .get("searxngEngines")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string(),
    }
}

fn parse_skill_catalog(value: &serde_json::Value) -> Option<Vec<RuntimeSkillEntry>> {
    let items = value.as_array()?;
    Some(
        items
            .iter()
            .filter_map(|item| {
                if !item.is_object() {
                    return None;
                }
                Some(RuntimeSkillEntry {
                    name: item
                        .get("name")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    id: item
                        .get("id")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    display_name: item
                        .get("displayName")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    source_path: item
                        .get("sourcePath")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    enabled: item
                        .get("enabled")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(true),
                })
            })
            .collect(),
    )
}

fn clear_runtime_meta(runtime_id: &str) {
    if let Ok(mut map) = runtime_meta().lock() {
        map.remove(runtime_id);
    }
}

fn live_runtime_id() -> Result<Option<String>, String> {
    let mut map = lock_runtimes()?;
    let mut dead = Vec::new();
    let mut live = None;
    for (id, runtime) in map.iter_mut() {
        match runtime.child.try_wait() {
            Ok(None) => {
                live = Some(id.clone());
                break;
            }
            _ => dead.push(id.clone()),
        }
    }
    for id in dead {
        if let Some(mut runtime) = map.remove(&id) {
            drop(runtime.stdin);
            let _ = kill_process_tree(&mut runtime.child);
        }
        clear_runtime_meta(&id);
    }
    Ok(live)
}

#[tauri::command]
pub fn agent_runtime_start(app: AppHandle) -> Result<String, String> {
    let _guard = start_lock()
        .lock()
        .map_err(|_| "agent runtime start lock poisoned".to_string())?;
    if let Some(existing) = live_runtime_id()? {
        return Ok(existing);
    }
    let node = resolve_node()?;
    let script = resolve_sidecar_script(&app)?;
    let mut command = Command::new(&node);
    command
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("NODE_NO_WARNINGS", "1");
    prepare_new_process_group(&mut command);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().map_err(|err| {
        format!(
            "启动 agent sidecar 失败 ({} {}): {err}",
            node.display(),
            script.display()
        )
    })?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "agent sidecar stdin missing".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "agent sidecar stdout missing".to_string())?;
    if let Some(stderr) = child.stderr.take() {
        pipe_stderr(stderr);
    }
    let runtime_id = format!("rt-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
    {
        let mut map = lock_runtimes()?;
        map.insert(runtime_id.clone(), RuntimeProcess { child, stdin });
    }
    if let Ok(mut map) = runtime_meta().lock() {
        map.insert(runtime_id.clone(), RuntimeMeta::default());
    }
    let app_frames = app.clone();
    let id_frames = runtime_id.clone();
    thread::spawn(move || emit_frames(app_frames, id_frames, stdout));
    Ok(runtime_id)
}

#[tauri::command]
pub fn agent_runtime_send(runtime_id: String, line: String) -> Result<(), String> {
    note_outbound_message(&runtime_id, &line);
    write_sidecar_stdin(&runtime_id, &line)
}

#[tauri::command]
pub fn agent_runtime_stop(runtime_id: String) -> Result<(), String> {
    let _guard = start_lock()
        .lock()
        .map_err(|_| "agent runtime start lock poisoned".to_string())?;
    let runtime = {
        let mut map = lock_runtimes()?;
        map.remove(&runtime_id)
    };
    let Some(mut runtime) = runtime else {
        return Ok(());
    };
    drop(runtime.stdin);
    let _ = kill_process_tree(&mut runtime.child);
    clear_runtime_meta(&runtime_id);
    Ok(())
}

pub fn stop_all() {
    let ids: Vec<String> = match lock_runtimes() {
        Ok(map) => map.keys().cloned().collect(),
        Err(_) => return,
    };
    for id in ids {
        let _ = agent_runtime_stop(id);
    }
}

#[cfg(test)]
mod tests {
    use super::find_path_node;

    #[test]
    fn path_node_search_does_not_panic() {
        let _ = find_path_node();
    }
}
