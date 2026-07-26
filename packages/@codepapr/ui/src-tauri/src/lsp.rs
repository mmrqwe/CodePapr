use serde::Serialize;
use serde_json::{json, Value};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Component, Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        mpsc::{self, RecvTimeoutError},
        Arc, Mutex, OnceLock, RwLock,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::Emitter;

use crate::lsp_fallback;
use crate::lsp_managed_tools::{
    dotnet_binary, ensure_managed_language_server, managed_lsp_commands, ManagedLspCommand,
    ManagedLspProgress,
};
use crate::shared::run_blocking_workspace_task;

const LSP_STARTUP_TIMEOUT: Duration = Duration::from_secs(8);
// 常规语义请求（hover/definition/references/rename/...）单独用更长的超时：大型项目里
// rust-analyzer/clangd/JDTLS 首次索引期间响应经常超过 8 秒，复用启动超时会把"健康但繁忙"
// 的 server 误判为无响应。
const LSP_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_LSP_REQUEST_BYTES: usize = 1_000_000;
const MAX_LSP_RESPONSE_BYTES: usize = 2_000_000;
const MAX_LSP_QUEUED_MESSAGES: usize = 256;
const MAX_LSP_STDERR_LINES: usize = 80;
const MANAGED_LSP_STATUS_EVENT: &str = "codepapr://lsp-managed-status";

#[derive(Clone, Copy)]
struct LspCommandCandidate {
    command: &'static str,
    args: &'static [&'static str],
}

#[derive(Clone)]
struct ResolvedLspConfig {
    family_key: &'static str,
    candidates: &'static [LspCommandCandidate],
    initialization_options: Option<serde_json::Value>,
}

#[derive(Clone)]
struct ResolvedLspCommandCandidate {
    command: String,
    args: Vec<String>,
    tool_origin: String,
    tool_source: String,
    tool_label: String,
    managed_cache_path: Option<String>,
}

const TYPESCRIPT_LANGUAGE_SERVER: &[LspCommandCandidate] = &[LspCommandCandidate {
    command: "typescript-language-server",
    args: &["--stdio"],
}];

const HTML_LANGUAGE_SERVER: &[LspCommandCandidate] = &[LspCommandCandidate {
    command: "vscode-html-language-server",
    args: &["--stdio"],
}];

const CSS_LANGUAGE_SERVER: &[LspCommandCandidate] = &[LspCommandCandidate {
    command: "vscode-css-language-server",
    args: &["--stdio"],
}];

const JSON_LANGUAGE_SERVER: &[LspCommandCandidate] = &[LspCommandCandidate {
    command: "vscode-json-language-server",
    args: &["--stdio"],
}];

const YAML_LANGUAGE_SERVER: &[LspCommandCandidate] = &[LspCommandCandidate {
    command: "yaml-language-server",
    args: &["--stdio"],
}];

const PYTHON_LANGUAGE_SERVER: &[LspCommandCandidate] = &[LspCommandCandidate {
    command: "pyright-langserver",
    args: &["--stdio"],
}];

const CSHARP_LANGUAGE_SERVER: &[LspCommandCandidate] = &[
    LspCommandCandidate {
        command: "csharp-ls",
        args: &[],
    },
    LspCommandCandidate {
        command: "omnisharp",
        args: &["-lsp"],
    },
    LspCommandCandidate {
        command: "OmniSharp",
        args: &["-lsp"],
    },
];

const SWIFT_LANGUAGE_SERVER: &[LspCommandCandidate] = &[LspCommandCandidate {
    command: "sourcekit-lsp",
    args: &[],
}];

const SQL_LANGUAGE_SERVER: &[LspCommandCandidate] = &[LspCommandCandidate {
    command: "sqls",
    args: &[],
}];

const MARKDOWN_LANGUAGE_SERVER: &[LspCommandCandidate] = &[LspCommandCandidate {
    command: "marksman",
    args: &["server"],
}];

const JAVA_LANGUAGE_SERVER: &[LspCommandCandidate] = &[LspCommandCandidate {
    command: "jdtls",
    args: &[],
}];

const CPP_LANGUAGE_SERVER: &[LspCommandCandidate] = &[LspCommandCandidate {
    command: "clangd",
    args: &[],
}];

const SHELL_LANGUAGE_SERVER: &[LspCommandCandidate] = &[LspCommandCandidate {
    command: "bash-language-server",
    args: &["start"],
}];

const RUST_LANGUAGE_SERVER: &[LspCommandCandidate] = &[LspCommandCandidate {
    command: "rust-analyzer",
    args: &[],
}];

const GO_LANGUAGE_SERVER: &[LspCommandCandidate] = &[LspCommandCandidate {
    command: "gopls",
    args: &[],
}];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerStatus {
    pub language_id: String,
    pub server_family: String,
    pub running: bool,
    pub command: String,
    pub tool_origin: String,
    pub tool_source: String,
    pub tool_label: String,
    pub managed_cache_path: Option<String>,
    pub pid: Option<u32>,
    pub open_documents: usize,
    pub stderr_tail: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedLspStatusEvent {
    pub workspace_path: String,
    pub language_id: String,
    pub phase: String,
    pub tool_label: String,
    pub detail: String,
    pub cache_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspResponse {
    pub message: Value,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDiagnosticsResponse {
    pub diagnostics: HashMap<String, Value>,
}

struct ManagedLspServer {
    server_family: String,
    command: String,
    args: Vec<String>,
    tool_origin: String,
    tool_source: String,
    tool_label: String,
    managed_cache_path: Option<String>,
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    messages: Arc<Mutex<VecDeque<Value>>>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    open_documents: HashMap<String, i32>,
    diagnostics_by_uri: HashMap<String, Value>,
    next_id: u64,
    pending_responses: Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>>,
}

#[allow(dead_code)]
struct CollectedDiagnostics {
    current: Vec<Value>,
    workspace: Vec<Value>,
}

type SharedLspServer = Arc<Mutex<ManagedLspServer>>;

static LSP_SERVERS: OnceLock<RwLock<HashMap<String, SharedLspServer>>> = OnceLock::new();

fn lsp_servers() -> &'static RwLock<HashMap<String, SharedLspServer>> {
    LSP_SERVERS.get_or_init(|| RwLock::new(HashMap::new()))
}

fn lock_server<'a>(
    server: &'a SharedLspServer,
) -> Result<std::sync::MutexGuard<'a, ManagedLspServer>, String> {
    server
        .lock()
        .map_err(|_| "LSP server 实例锁定失败".to_string())
}

fn lookup_server_handle(workspace_path: &str, language_id: &str) -> Option<SharedLspServer> {
    lsp_servers().read().ok().and_then(|servers| {
        servers
            .get(&server_key(workspace_path, language_id))
            .cloned()
    })
}

fn remove_server_handle(workspace_path: &str, language_id: &str) -> Option<SharedLspServer> {
    lsp_servers()
        .write()
        .ok()
        .and_then(|mut servers| servers.remove(&server_key(workspace_path, language_id)))
}

fn insert_server_handle(
    workspace_path: &str,
    language_id: &str,
    server: SharedLspServer,
) -> Result<(), String> {
    let mut servers = lsp_servers()
        .write()
        .map_err(|_| "LSP server registry 已不可用".to_string())?;
    servers.insert(server_key(workspace_path, language_id), server);
    Ok(())
}

fn canonical_workspace(workspace_path: &str) -> Result<PathBuf, String> {
    let trimmed = workspace_path.trim();
    if trimmed.is_empty() {
        return Err("workspace_path 不能为空".to_string());
    }
    if trimmed.contains("..") {
        return Err("workspace_path 包含非法路径遍历".to_string());
    }
    let path = PathBuf::from(trimmed);
    if !path.exists() {
        return Err("工作区不存在".to_string());
    }
    let canonical = path
        .canonicalize()
        .map_err(|err| format!("无法访问工作区: {err}"))?;
    if !canonical.is_dir() {
        return Err("工作区路径不是文件夹".to_string());
    }
    Ok(canonical)
}

pub(crate) fn normalize_relative_path(relative_path: &str) -> Result<PathBuf, String> {
    let raw = relative_path.trim();
    if raw.is_empty() {
        return Err("文件路径不能为空".to_string());
    }

    let mut normalized = PathBuf::new();
    for component in Path::new(raw).components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("拒绝访问项目文件夹之外的路径".to_string());
            }
        }
    }

    if normalized.as_os_str().is_empty() {
        return Err("文件路径不能为空".to_string());
    }
    Ok(normalized)
}

fn percent_encode_path(path: &str) -> String {
    let mut result = String::with_capacity(path.len());
    for byte in path.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' | b':' => {
                result.push(byte as char)
            }
            _ => {
                result.push('%');
                result.push_str(&format!("{byte:02X}"));
            }
        }
    }
    result
}

fn strip_windows_unc_prefix(path: &str) -> &str {
    if path.starts_with("//?/") || path.starts_with("\\\\?\\") {
        let rest = &path[4..];
        if rest.len() >= 2 && rest.as_bytes()[1] == b':' {
            return rest;
        }
    }
    path
}

fn strip_leading_slash(path: &str) -> &str {
    path.strip_prefix('/').unwrap_or(path)
}

pub(crate) fn file_uri_for(workspace: &Path, relative_path: &str) -> Result<String, String> {
    let relative = normalize_relative_path(relative_path)?;
    let target = workspace.join(relative);
    let path_str = target.to_string_lossy().replace('\\', "/");
    let path_str = strip_windows_unc_prefix(&path_str);
    let normalized = strip_leading_slash(path_str);
    Ok(format!("file:///{}", percent_encode_path(normalized)))
}

fn detect_python_path() -> Option<String> {
    #[cfg(target_os = "windows")]
    let primary_candidates: &[&str] = &["python", "py", "python3"];
    #[cfg(not(target_os = "windows"))]
    let primary_candidates: &[&str] = &["python3", "python"];

    for candidate in primary_candidates {
        if let Ok(output) = std::process::Command::new(candidate)
            .arg("-c")
            .arg("import sys; print(sys.executable)")
            .output()
        {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    return Some(path);
                }
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    for base in &[
        "/usr/local/bin/python3",
        "/opt/homebrew/bin/python3",
        "/usr/bin/python3",
    ] {
        let path = std::path::Path::new(base);
        if path.is_file() {
            return Some(base.to_string());
        }
    }

    #[cfg(target_os = "windows")]
    {
        for base in &[
            "C:\\Python311\\python.exe",
            "C:\\Python312\\python.exe",
            "C:\\Python313\\python.exe",
        ] {
            let path = std::path::Path::new(base);
            if path.is_file() {
                return Some(base.to_string());
            }
        }
        if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
            for name in &[
                "Programs\\Python\\Python311\\python.exe",
                "Programs\\Python\\Python312\\python.exe",
                "Programs\\Python\\Python313\\python.exe",
                "Microsoft\\WindowsApps\\python.exe",
                "Microsoft\\WindowsApps\\python3.exe",
            ] {
                let path = std::path::Path::new(&localappdata).join(name);
                if path.is_file() {
                    return Some(path.to_string_lossy().to_string());
                }
            }
        }
    }

    None
}

fn python_initialization_options() -> Option<serde_json::Value> {
    let python_path = detect_python_path()?;
    Some(json!({
        "settings": {
            "python": {
                "pythonPath": python_path,
                "analysis": {
                    "typeCheckingMode": "basic"
                }
            }
        }
    }))
}

fn load_pyright_project_config(workspace: &Path) -> Option<serde_json::Value> {
    let pyrightconfig = workspace.join("pyrightconfig.json");
    if let Ok(content) = fs::read_to_string(&pyrightconfig) {
        if let Ok(config) = serde_json::from_str::<serde_json::Value>(&content) {
            return Some(config);
        }
    }
    let pyproject = workspace.join("pyproject.toml");
    if let Ok(content) = fs::read_to_string(&pyproject) {
        if let Ok(toml_val) = content.parse::<toml::Value>() {
            if let Some(pyright) = toml_val.get("tool").and_then(|t| t.get("pyright")) {
                if let Ok(config) = serde_json::to_value(pyright) {
                    return Some(config);
                }
            }
        }
    }
    None
}

fn rust_initialization_options() -> Option<serde_json::Value> {
    Some(json!({
        "checkOnSave": true,
        "diagnostics": { "enable": true },
    }))
}

fn find_solution_in_workspace(workspace: &Path) -> Option<String> {
    let entries = std::fs::read_dir(workspace).ok()?;
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext == "sln") {
            return path.to_str().map(|s| s.to_string());
        }
    }
    None
}

fn workspace_initialization_options(
    language_id: &str,
    workspace: &Path,
    config: &ResolvedLspConfig,
) -> Option<serde_json::Value> {
    match language_id {
        "csharp" => {
            let solution = find_solution_in_workspace(workspace)?;
            let mut opts = json!({ "solutionPath": solution });
            if let Some(Value::Object(base)) = &config.initialization_options {
                if let Value::Object(ref mut map) = opts {
                    for (key, value) in base {
                        map.insert(key.clone(), value.clone());
                    }
                }
            }
            Some(opts)
        }
        "python" => {
            let mut opts = config.initialization_options.clone().unwrap_or_default();
            if let Some(project_config) = load_pyright_project_config(workspace) {
                if let Some(analysis) = opts.pointer_mut("/settings/python/analysis") {
                    if let Value::Object(ref mut base_analysis) = *analysis {
                        if let Value::Object(proj) = &project_config {
                            for (key, value) in proj {
                                base_analysis.insert(key.clone(), value.clone());
                            }
                        }
                    }
                }
            }
            Some(opts)
        }
        _ => config.initialization_options.clone(),
    }
}

fn lsp_server_config(language_id: &str) -> Option<ResolvedLspConfig> {
    match language_id {
        "typescript" | "typescriptreact" | "javascript" | "javascriptreact" => {
            Some(ResolvedLspConfig {
                family_key: "typescript",
                candidates: TYPESCRIPT_LANGUAGE_SERVER,
                initialization_options: None,
            })
        }
        "html" => Some(ResolvedLspConfig {
            family_key: "html",
            candidates: HTML_LANGUAGE_SERVER,
            initialization_options: None,
        }),
        "css" | "scss" | "less" => Some(ResolvedLspConfig {
            family_key: "css",
            candidates: CSS_LANGUAGE_SERVER,
            initialization_options: None,
        }),
        "json" | "jsonc" => Some(ResolvedLspConfig {
            family_key: "json",
            candidates: JSON_LANGUAGE_SERVER,
            initialization_options: None,
        }),
        "yaml" => Some(ResolvedLspConfig {
            family_key: "yaml",
            candidates: YAML_LANGUAGE_SERVER,
            initialization_options: None,
        }),
        "python" => Some(ResolvedLspConfig {
            family_key: "python",
            candidates: PYTHON_LANGUAGE_SERVER,
            initialization_options: python_initialization_options(),
        }),
        "csharp" => Some(ResolvedLspConfig {
            family_key: "csharp",
            candidates: CSHARP_LANGUAGE_SERVER,
            initialization_options: None,
        }),
        "java" => Some(ResolvedLspConfig {
            family_key: "java",
            candidates: JAVA_LANGUAGE_SERVER,
            initialization_options: None,
        }),
        "c" | "cpp" => Some(ResolvedLspConfig {
            family_key: "cpp",
            candidates: CPP_LANGUAGE_SERVER,
            initialization_options: None,
        }),
        "shellscript" => Some(ResolvedLspConfig {
            family_key: "shellscript",
            candidates: SHELL_LANGUAGE_SERVER,
            initialization_options: None,
        }),
        "rust" => Some(ResolvedLspConfig {
            family_key: "rust",
            candidates: RUST_LANGUAGE_SERVER,
            initialization_options: rust_initialization_options(),
        }),
        "go" => Some(ResolvedLspConfig {
            family_key: "go",
            candidates: GO_LANGUAGE_SERVER,
            initialization_options: None,
        }),
        "swift" => Some(ResolvedLspConfig {
            family_key: "swift",
            candidates: SWIFT_LANGUAGE_SERVER,
            initialization_options: None,
        }),
        "sql" => Some(ResolvedLspConfig {
            family_key: "sql",
            candidates: SQL_LANGUAGE_SERVER,
            initialization_options: None,
        }),
        "markdown" => Some(ResolvedLspConfig {
            family_key: "markdown",
            candidates: MARKDOWN_LANGUAGE_SERVER,
            initialization_options: None,
        }),
        _ => None,
    }
}

fn lsp_server_family(language_id: &str) -> Option<&'static str> {
    lsp_server_config(language_id).map(|config| config.family_key)
}

fn content_length(header: &str) -> Result<usize, String> {
    for line in header.lines() {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("content-length") {
            return value
                .trim()
                .parse::<usize>()
                .map_err(|err| format!("无法解析 LSP Content-Length: {err}"));
        }
    }
    Err("LSP 响应缺少 Content-Length".to_string())
}

fn read_lsp_message(reader: &mut dyn Read) -> Result<Value, String> {
    let mut header = Vec::new();
    let mut byte = [0_u8; 1];
    loop {
        reader
            .read_exact(&mut byte)
            .map_err(|err| format!("读取 LSP 响应头失败: {err}"))?;
        header.push(byte[0]);
        if header.ends_with(b"\r\n\r\n") {
            break;
        }
        if header.len() > 8192 {
            return Err("LSP 响应头过长".to_string());
        }
    }

    let header_text = String::from_utf8_lossy(&header);
    let len = content_length(&header_text)?;
    if len > MAX_LSP_RESPONSE_BYTES {
        return Err(format!("LSP 响应超过上限 {MAX_LSP_RESPONSE_BYTES} bytes"));
    }

    let mut body = vec![0_u8; len];
    reader
        .read_exact(&mut body)
        .map_err(|err| format!("读取 LSP 响应正文失败: {err}"))?;
    serde_json::from_slice::<Value>(&body).map_err(|err| format!("解析 LSP JSON 失败: {err}"))
}

fn push_lsp_message(queue: &Arc<Mutex<VecDeque<Value>>>, message: Value) {
    let Ok(mut messages) = queue.lock() else {
        return;
    };
    if messages.len() >= MAX_LSP_QUEUED_MESSAGES {
        messages.pop_front();
    }
    messages.push_back(message);
}

fn push_stderr_line(queue: &Arc<Mutex<VecDeque<String>>>, line: String) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }

    let Ok(mut stderr_tail) = queue.lock() else {
        return;
    };
    if stderr_tail.len() >= MAX_LSP_STDERR_LINES {
        stderr_tail.pop_front();
    }
    stderr_tail.push_back(trimmed.to_string());
}

fn spawn_lsp_reader(
    mut stdout: impl Read + Send + 'static,
    queue: Arc<Mutex<VecDeque<Value>>>,
    pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>>,
) {
    thread::spawn(move || {
        while let Ok(message) = read_lsp_message(&mut stdout) {
            if let Some(id) = message.get("id").and_then(Value::as_u64) {
                if let Ok(mut map) = pending.lock() {
                    if let Some(tx) = map.remove(&id) {
                        let _ = tx.send(message);
                    }
                }
            } else {
                push_lsp_message(&queue, message);
            }
        }
    });
}

fn spawn_lsp_stderr_reader(
    stderr: impl Read + Send + 'static,
    queue: Arc<Mutex<VecDeque<String>>>,
) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => push_stderr_line(&queue, line.clone()),
                Err(_) => break,
            }
        }
    });
}

fn stderr_tail_snapshot(queue: &Arc<Mutex<VecDeque<String>>>) -> Vec<String> {
    queue
        .lock()
        .map(|stderr_tail| stderr_tail.iter().cloned().collect())
        .unwrap_or_default()
}

fn format_stderr_tail(queue: &Arc<Mutex<VecDeque<String>>>) -> String {
    let stderr_tail = stderr_tail_snapshot(queue);
    if stderr_tail.is_empty() {
        String::new()
    } else {
        format!("\n最近 stderr:\n{}", stderr_tail.join("\n"))
    }
}

fn write_lsp_message(writer: &mut ChildStdin, message: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(message).map_err(|err| format!("序列化 LSP JSON 失败: {err}"))?;
    if body.len() > MAX_LSP_REQUEST_BYTES {
        return Err(format!("LSP 请求超过上限 {MAX_LSP_REQUEST_BYTES} bytes"));
    }
    write!(writer, "Content-Length: {}\r\n\r\n", body.len())
        .map_err(|err| format!("写入 LSP 请求头失败: {err}"))?;
    writer
        .write_all(&body)
        .map_err(|err| format!("写入 LSP 请求正文失败: {err}"))?;
    writer
        .flush()
        .map_err(|err| format!("刷新 LSP stdin 失败: {err}"))
}

fn describe_lsp_error(response: &Value) -> Option<String> {
    let error = response.get("error")?;
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("未知错误");
    let code = error.get("code").and_then(Value::as_i64);
    let data = error.get("data");
    let mut description = match code {
        Some(code) => format!("{message} (code {code})"),
        None => message.to_string(),
    };
    if let Some(data) = data {
        let rendered = if let Some(text) = data.as_str() {
            text.to_string()
        } else {
            data.to_string()
        };
        if !rendered.trim().is_empty() {
            description.push_str(&format!("\n{rendered}"));
        }
    }
    Some(description)
}

fn command_display(command: &str, args: &[String]) -> String {
    format!("{} {}", command, args.join(" ")).trim().to_string()
}

fn resolved_command_display(candidate: &ResolvedLspCommandCandidate) -> String {
    command_display(&candidate.command, &candidate.args)
}

fn emit_managed_lsp_status(
    app: &tauri::AppHandle,
    workspace_path: &str,
    language_id: &str,
    progress: ManagedLspProgress,
) {
    let _ = app.emit(
        MANAGED_LSP_STATUS_EVENT,
        ManagedLspStatusEvent {
            workspace_path: workspace_path.to_string(),
            language_id: language_id.to_string(),
            phase: progress.phase,
            tool_label: progress.tool_label,
            detail: progress.detail,
            cache_path: progress.cache_path,
        },
    );
}

fn server_status(language_id: &str, server: &ManagedLspServer) -> LspServerStatus {
    LspServerStatus {
        language_id: language_id.to_string(),
        server_family: server.server_family.clone(),
        running: true,
        command: command_display(&server.command, &server.args),
        tool_origin: server.tool_origin.clone(),
        tool_source: server.tool_source.clone(),
        tool_label: server.tool_label.clone(),
        managed_cache_path: server.managed_cache_path.clone(),
        pid: Some(server.child.id()),
        open_documents: server.open_documents.len(),
        stderr_tail: stderr_tail_snapshot(&server.stderr_tail),
    }
}

fn fallback_server_status(
    language_id: &str,
    workspace_path: &str,
) -> Result<LspServerStatus, String> {
    let snapshot = lsp_fallback::ensure_server(workspace_path, language_id)
        .ok_or_else(|| format!("内建 fallback 不支持该语言: {language_id}"))?;
    Ok(LspServerStatus {
        language_id: language_id.to_string(),
        server_family: snapshot.server_family,
        running: true,
        command: snapshot.command,
        tool_origin: "builtin".to_string(),
        tool_source: "builtin-fallback".to_string(),
        tool_label: "CodePapr builtin symbols".to_string(),
        managed_cache_path: None,
        pid: None,
        open_documents: snapshot.open_documents,
        stderr_tail: snapshot.stderr_tail,
    })
}

fn force_stop_server_process(server: &mut ManagedLspServer) {
    let _ = server.child.kill();
    let _ = server.child.wait();
}

fn resolve_lsp_command_candidates(
    workspace: &Path,
    language_id: &str,
) -> Vec<ResolvedLspCommandCandidate> {
    let mut candidates = managed_lsp_commands(workspace, language_id)
        .into_iter()
        .map(|candidate: ManagedLspCommand| ResolvedLspCommandCandidate {
            command: candidate.command,
            args: candidate.args,
            tool_origin: candidate.tool_origin,
            tool_source: candidate.tool_source,
            tool_label: candidate.tool_label,
            managed_cache_path: candidate.managed_cache_path,
        })
        .collect::<Vec<_>>();

    if let Some(config) = lsp_server_config(language_id) {
        candidates.extend(config.candidates.iter().map(|candidate| {
            ResolvedLspCommandCandidate {
                command: candidate.command.to_string(),
                args: candidate
                    .args
                    .iter()
                    .map(|arg| (*arg).to_string())
                    .collect(),
                tool_origin: "external".to_string(),
                tool_source: "path".to_string(),
                tool_label: candidate.command.to_string(),
                managed_cache_path: None,
            }
        }));
    }

    let mut seen = std::collections::HashSet::new();
    candidates.retain(|candidate| {
        let key = format!("{}::{}", candidate.command, candidate.args.join("\u{1f}"));
        seen.insert(key)
    });
    candidates
}

fn send_request(
    server: &mut ManagedLspServer,
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<Value, String> {
    let id = server.next_id;
    server.next_id += 1;
    let message = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });

    let (tx, rx) = mpsc::channel();

    server
        .pending_responses
        .lock()
        .map_err(|_| "LSP pending 表已不可用".to_string())?
        .insert(id, tx);

    {
        let mut stdin = server
            .stdin
            .lock()
            .map_err(|_| "LSP stdin 已不可用".to_string())?;
        write_lsp_message(&mut stdin, &message)?;
    }

    let response = match rx.recv_timeout(timeout) {
        Ok(response) => response,
        Err(RecvTimeoutError::Timeout) => {
            let _ = server
                .pending_responses
                .lock()
                .map_err(|_| "LSP pending 表已不可用".to_string())?
                .remove(&id);
            if let Some(exit_status) = server
                .child
                .try_wait()
                .map_err(|err| format!("检查 LSP 进程状态失败: {err}"))?
            {
                return Err(format!(
                    "LSP 进程已退出 ({exit_status})，请求失败: {method}{}",
                    format_stderr_tail(&server.stderr_tail)
                ));
            }
            return Err(format!("等待 LSP 响应超时: {method}"));
        }
        Err(RecvTimeoutError::Disconnected) => {
            let _ = server
                .pending_responses
                .lock()
                .map_err(|_| "LSP pending 表已不可用".to_string())?
                .remove(&id);
            return Err(format!(
                "LSP reader 已断开，请求失败: {method}{}",
                format_stderr_tail(&server.stderr_tail)
            ));
        }
    };

    let _ = server
        .pending_responses
        .lock()
        .map_err(|_| "LSP pending 表已不可用".to_string())?
        .remove(&id);

    if let Some(description) = describe_lsp_error(&response) {
        return Err(format!("LSP 请求失败: {method}: {description}"));
    }
    Ok(response)
}

fn downgrade_pyright_diagnostics(mut params: Value) -> Value {
    let diagnostics = match params.get_mut("diagnostics") {
        Some(Value::Array(arr)) => arr,
        _ => return params,
    };
    for diag in diagnostics.iter_mut() {
        let code = diag.get("code").and_then(Value::as_str).unwrap_or("");
        let severity = diag.get("severity").and_then(|v| v.as_i64()).unwrap_or(1);
        let new_severity = match code {
            "reportMissingImports" | "reportMissingModuleSource" if severity <= 2 => 2,
            "reportUnknownMemberType"
            | "reportUnknownVariableType"
            | "reportUnknownArgumentType"
                if severity <= 2 =>
            {
                3
            }
            "reportGeneralTypeIssues" if severity <= 2 => 2,
            _ => severity,
        };
        if new_severity != severity {
            diag["severity"] =
                Value::Number(serde_json::Number::from(new_severity));
        }
    }
    params
}

fn collect_publish_diagnostics(
    server: &mut ManagedLspServer,
    uri: &str,
    wait: Duration,
) -> Result<CollectedDiagnostics, String> {
    let started = Instant::now();
    let mut saw_current_diagnostics = false;
    loop {
        let mut drained = Vec::new();
        {
            let mut messages = server
                .messages
                .lock()
                .map_err(|_| "LSP 消息队列已不可用".to_string())?;
            let mut index = 0;
            while index < messages.len() {
                let is_match = messages.get(index).and_then(|message| {
                    if message.get("method").and_then(Value::as_str)
                        != Some("textDocument/publishDiagnostics")
                    {
                        return None;
                    }
                    let params = message.get("params")?;
                    let message_uri = params.get("uri")?.as_str()?;
                    Some((message_uri.to_string(), params.clone()))
                });
                if let Some((message_uri, params)) = is_match {
                    messages.remove(index);
                    drained.push((message_uri, params));
                    continue;
                }
                index += 1;
            }
        }

        for (message_uri, params) in drained {
            if message_uri == uri {
                saw_current_diagnostics = true;
            }
            let params = if server.server_family == "python" {
                downgrade_pyright_diagnostics(params)
            } else {
                params
            };
            server.diagnostics_by_uri.insert(message_uri, params);
        }

        if saw_current_diagnostics || started.elapsed() >= wait {
            let current = server
                .diagnostics_by_uri
                .get(uri)
                .cloned()
                .map(|params| vec![params])
                .unwrap_or_default();
            let workspace = server.diagnostics_by_uri.values().cloned().collect();
            return Ok(CollectedDiagnostics { current, workspace });
        }

        if let Some(exit_status) = server
            .child
            .try_wait()
            .map_err(|err| format!("检查 LSP 进程状态失败: {err}"))?
        {
            return Err(format!(
                "LSP 进程已退出 ({exit_status})，未能返回诊断{}",
                format_stderr_tail(&server.stderr_tail)
            ));
        }
        thread::sleep(Duration::from_millis(25));
    }
}

fn send_notification(server: &ManagedLspServer, method: &str, params: Value) -> Result<(), String> {
    let message = json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
    });
    let mut stdin = server
        .stdin
        .lock()
        .map_err(|_| "LSP stdin 已不可用".to_string())?;
    write_lsp_message(&mut stdin, &message)
}

static EXPANDED_PATH_CACHE: std::sync::RwLock<Option<String>> = std::sync::RwLock::new(None);

fn expanded_path() -> String {
    fn compute() -> String {
        #[cfg(target_os = "macos")]
        {
            if let Ok(output) = std::process::Command::new("/usr/libexec/path_helper")
                .arg("-s")
                .output()
            {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if let Some(line) = stdout.lines().find(|l| l.starts_with("PATH=")) {
                    let shell_path = line
                        .strip_prefix("PATH=")
                        .unwrap_or("")
                        .trim_matches('"')
                        .trim_matches('\'');
                    if !shell_path.is_empty() {
                        let home = std::env::var("HOME").unwrap_or_default();
                        let expanded: Vec<String> = std::env::split_paths(shell_path)
                            .map(|p| {
                                let s = p.to_string_lossy().to_string();
                                if s.starts_with("~") {
                                    s.replacen("~", &home, 1)
                                } else {
                                    s
                                }
                            })
                            .collect();
                        let mut result = expanded.join(":");
                        if let Ok(current) = std::env::var("PATH") {
                            if !current.is_empty() {
                                result.push(':');
                                result.push_str(&current);
                            }
                        }
                        return result;
                    }
                }
            }
        }

        let current = std::env::var("PATH").unwrap_or_default();
        let mut paths: Vec<String> = std::env::split_paths(&current)
            .map(|p| p.to_string_lossy().to_string())
            .collect();

        if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
            let home_path = std::path::Path::new(&home);
            let extras = [
                home_path.join(".cargo/bin"),
                home_path.join(".dotnet/tools"),
                home_path.join("go/bin"),
                home_path.join(".local/bin"),
                home_path.join("miniconda3/bin"),
                home_path.join("anaconda3/bin"),
            ];
            for extra in &extras {
                let s = extra.to_string_lossy().to_string();
                if extra.is_dir() && !paths.contains(&s) && s != home {
                    paths.push(s);
                }
            }
            #[cfg(target_os = "macos")]
            {
                for prefix in &["/opt/homebrew/bin", "/usr/local/bin"] {
                    let s = prefix.to_string();
                    if std::path::Path::new(&s).is_dir() && !paths.contains(&s) {
                        paths.push(s);
                    }
                }
            }
        }

        std::env::join_paths(&paths)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| current)
    }

    if let Some(cached) = EXPANDED_PATH_CACHE.read().unwrap().as_ref() {
        return cached.clone();
    }
    let path = compute();
    *EXPANDED_PATH_CACHE.write().unwrap() = Some(path.clone());
    path
}

pub fn refresh_expanded_path() {
    EXPANDED_PATH_CACHE.write().unwrap().take();
}

fn spawn_server_candidate(
    workspace: &Path,
    language_id: &str,
    server_family: &str,
    candidate: &ResolvedLspCommandCandidate,
    initialization_options: Option<&serde_json::Value>,
) -> Result<ManagedLspServer, String> {
    let command = candidate.command.clone();
    let args = candidate.args.clone();

    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let mut cmd = Command::new(&command);
    cmd.args(&args)
        .current_dir(workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    {
        let dotnet_root = std::env::var("DOTNET_ROOT")
            .ok()
            .or_else(|| std::env::var("DOTNET_INSTALL_DIR").ok())
            .or_else(|| {
                let dotnet_bin = dotnet_binary();
                let output = std::process::Command::new(dotnet_bin)
                    .args(["--list-runtimes"])
                    .output()
                    .ok()?;
                let stdout = String::from_utf8_lossy(&output.stdout);
                stdout
                    .lines()
                    .filter(|line| line.starts_with("Microsoft.NETCore.App"))
                    .filter_map(|line| {
                        let parts: Vec<&str> = line.split_whitespace().collect();
                        let version = parts.get(1)?.to_string();
                        let path = line.rsplit('[').next()?.trim_end_matches(']');
                        let root = std::path::Path::new(path)
                            .parent()?
                            .parent()?
                            .to_string_lossy()
                            .to_string();
                        Some((version, root))
                    })
                    .max_by(|(va, _), (vb, _)| va.cmp(vb))
                    .map(|(_, root)| root)
            });
        if let Some(root) = dotnet_root {
            cmd.env("DOTNET_ROOT", root);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            for prefix in &[
                exe_dir
                    .join("_up_")
                    .join("generated")
                    .join("lsp-tools")
                    .join("dotnet-sdk"),
                exe_dir
                    .join("..")
                    .join("Resources")
                    .join("_up_")
                    .join("generated")
                    .join("lsp-tools")
                    .join("dotnet-sdk"),
                exe_dir
                    .join("..")
                    .join("resources")
                    .join("_up_")
                    .join("generated")
                    .join("lsp-tools")
                    .join("dotnet-sdk"),
            ] {
                if prefix.join("dotnet").is_file() {
                    cmd.env("DOTNET_ROOT", prefix);
                    break;
                }
            }
        }
    }
    cmd.env("PATH", expanded_path());
    let mut child = cmd.spawn().map_err(|err| {
        format!(
            "无法启动 LSP server `{}`: {err}",
            command_display(&command, &args)
        )
    })?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法打开 LSP stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法打开 LSP stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法打开 LSP stderr".to_string())?;
    let messages = Arc::new(Mutex::new(VecDeque::new()));
    let stderr_tail = Arc::new(Mutex::new(VecDeque::new()));
    let pending_responses = Arc::new(Mutex::new(HashMap::new()));
    spawn_lsp_reader(stdout, Arc::clone(&messages), Arc::clone(&pending_responses));
    spawn_lsp_stderr_reader(stderr, Arc::clone(&stderr_tail));

    let mut server = ManagedLspServer {
        server_family: server_family.to_string(),
        command,
        args,
        tool_origin: candidate.tool_origin.clone(),
        tool_source: candidate.tool_source.clone(),
        tool_label: candidate.tool_label.clone(),
        managed_cache_path: candidate.managed_cache_path.clone(),
        child,
        stdin: Arc::new(Mutex::new(stdin)),
        messages,
        stderr_tail,
        open_documents: HashMap::new(),
        diagnostics_by_uri: HashMap::new(),
        next_id: 1,
        pending_responses,
    };

    let workspace_path_str = workspace.to_string_lossy().replace('\\', "/");
    let workspace_path_str = strip_windows_unc_prefix(&workspace_path_str);
    let normalized = strip_leading_slash(workspace_path_str);
    let root_uri = format!("file:///{}", percent_encode_path(normalized));
    let mut init_params = json!({
        "processId": std::process::id(),
        "rootUri": root_uri,
        "capabilities": {
            // 注意：这里【没有】声明 general.positionEncodings，因此按 LSP 规范服务器一律使用默认的
            // UTF-16 位置编码。前端（core/src/tool/workspace/languageTools.ts 的 positionToOffset）
            // 正是按 UTF-16（JS 字符串下标）换算偏移的。若在此处加入 positionEncodings（如 utf-8/utf-32），
            // 必须同步修改前端偏移换算，否则含非 ASCII 字符的文件编辑会错位。
            "textDocument": {
                "synchronization": { "didSave": true, "didClose": true },
                "hover": { "contentFormat": ["markdown", "plaintext"] },
                "definition": { "linkSupport": true },
                "references": {},
                "documentSymbol": { "hierarchicalDocumentSymbolSupport": true },
                "completion": { "completionItem": { "snippetSupport": false } },
                "publishDiagnostics": { "relatedInformation": true }
            },
            "workspace": { "workspaceFolders": true }
        },
        "workspaceFolders": [{ "uri": root_uri, "name": "workspace" }]
    });
    if let Some(opts) = initialization_options {
        init_params["initializationOptions"] = opts.clone();
    }
    send_request(&mut server, "initialize", init_params, LSP_STARTUP_TIMEOUT)?;
    send_notification(&server, "initialized", json!({}))?;
    if let Some(opts) = initialization_options {
        // workspace/didChangeConfiguration 的 params 必须是 { settings: ... } 形式，
        // 否则严格的服务器（如 rust-analyzer）会因 "missing field `settings`" 直接 panic 退出。
        let payload = json!({ "settings": opts });
        let _ = send_notification(&server, "workspace/didChangeConfiguration", payload);
    }
    push_stderr_line(
        &server.stderr_tail,
        format!(
            "connected {} via {}",
            language_id,
            command_display(&server.command, &server.args)
        ),
    );

    Ok(server)
}

fn start_server(
    app: Option<&tauri::AppHandle>,
    workspace_path: &str,
    language_id: &str,
) -> Result<ManagedLspServer, String> {
    let workspace = canonical_workspace(workspace_path)?;
    let Some(config) = lsp_server_config(language_id) else {
        return Err(format!("暂不支持该语言的 LSP: {language_id}"));
    };

    let mut managed_install_error = None;
    let reporter = app.map(|app| {
        move |progress: ManagedLspProgress| {
            emit_managed_lsp_status(app, workspace_path, language_id, progress)
        }
    });
    if let Err(err) = ensure_managed_language_server(
        &workspace,
        language_id,
        reporter
            .as_ref()
            .map(|value| value as &dyn Fn(ManagedLspProgress)),
    ) {
        managed_install_error = Some(err);
    }

    let init_opts = workspace_initialization_options(language_id, &workspace, &config);

    let mut failures = Vec::new();
    for candidate in resolve_lsp_command_candidates(&workspace, language_id) {
        match spawn_server_candidate(
            &workspace,
            language_id,
            config.family_key,
            &candidate,
            init_opts.as_ref(),
        ) {
            Ok(server) => return Ok(server),
            Err(err) => failures.push(format!("{}: {err}", resolved_command_display(&candidate))),
        }
    }

    if let Some(err) = managed_install_error {
        failures.insert(0, format!("托管安装失败: {err}"));
    }

    Err(format!(
        "无法为 `{language_id}` 启动 LSP。已尝试:\n{}",
        failures.join("\n")
    ))
}

fn server_key(workspace_path: &str, language_id: &str) -> String {
    format!(
        "{}::{}",
        workspace_path,
        lsp_server_family(language_id).unwrap_or(language_id)
    )
}

fn server_is_running(server: &mut ManagedLspServer) -> Result<bool, String> {
    Ok(server
        .child
        .try_wait()
        .map_err(|err| format!("检查 LSP 状态失败: {err}"))?
        .is_none())
}

fn ensure_running_server_handle(
    app: Option<&tauri::AppHandle>,
    workspace_path: &str,
    language_id: &str,
) -> Result<SharedLspServer, String> {
    if let Some(server) = lookup_server_handle(workspace_path, language_id) {
        let mut guard = lock_server(&server)?;
        if server_is_running(&mut guard)? {
            drop(guard);
            return Ok(server);
        }
        drop(guard);
        let _ = remove_server_handle(workspace_path, language_id);
    }

    let server = Arc::new(Mutex::new(start_server(app, workspace_path, language_id)?));
    insert_server_handle(workspace_path, language_id, Arc::clone(&server))?;
    Ok(server)
}

pub fn stop_all_servers() {
    if let Ok(mut servers) = lsp_servers().write() {
        for (_, server) in servers.drain() {
            if let Ok(mut server) = server.lock() {
                force_stop_server_process(&mut server);
            }
        }
    }
}

#[tauri::command]
pub async fn lsp_start_server(
    workspace_path: String,
    language_id: String,
) -> Result<LspServerStatus, String> {
    run_blocking_workspace_task(move || {
        let sanitized_language_id = language_id.trim().to_lowercase();
        if sanitized_language_id.is_empty() {
            return Err("language_id 不能为空".to_string());
        }
        if sanitized_language_id
            .contains(|c: char| c.is_control() || c == '`' || c == '$' || c == '|' || c == ';')
        {
            return Err(format!("language_id 包含非法字符: {language_id}"));
        }
        let sanitized_workspace = workspace_path.trim().to_string();
        if sanitized_workspace.is_empty() {
            return Err("workspace_path 不能为空".to_string());
        }

        match ensure_running_server_handle(None, &sanitized_workspace, &sanitized_language_id).and_then(
            |server| {
                let server = lock_server(&server)?;
                Ok(server_status(&sanitized_language_id, &server))
            },
        ) {
            Ok(status) => Ok(status),
            Err(err) if lsp_fallback::supports_language(&sanitized_language_id) => {
                fallback_server_status(&sanitized_language_id, &sanitized_workspace).map_err(|_| err)
            }
            Err(err) => Err(err),
        }
    }).await
}

pub(crate) fn lsp_open_document_with_app(
    app: Option<&tauri::AppHandle>,
    workspace_path: String,
    language_id: String,
    relative_path: String,
    content: String,
    version: i32,
) -> Result<LspResponse, String> {
    let workspace = canonical_workspace(&workspace_path)?;
    let uri = file_uri_for(&workspace, &relative_path)?;
    match ensure_running_server_handle(app, &workspace_path, &language_id).and_then(|server| {
        let mut server = lock_server(&server)?;
        let already_open = server.open_documents.get(&uri).copied();
        if let Some(previous_version) = already_open {
            let next_version = version.max(previous_version + 1);
            send_notification(
                &server,
                "textDocument/didChange",
                json!({
                    "textDocument": {
                        "uri": uri,
                        "version": next_version,
                    },
                    "contentChanges": [{ "text": content }]
                }),
            )?;
            server.open_documents.insert(uri.clone(), next_version);
        } else {
            send_notification(
                &server,
                "textDocument/didOpen",
                json!({
                    "textDocument": {
                        "uri": uri,
                        "languageId": language_id,
                        "version": version,
                        "text": content,
                    }
                }),
            )?;
            server.open_documents.insert(uri.clone(), version);
        }
        if already_open.is_none() {
            // Duration::ZERO 等价于"看一眼当前已到的消息就返回"，诊断通常是异步、
            // 有延迟发布的，首次打开文档时几乎总是拿到空诊断。给一个短暂的真实等待窗口。
            let _ = collect_publish_diagnostics(&mut server, &uri, Duration::from_millis(300));
        }
        let current = server
            .diagnostics_by_uri
            .get(&uri)
            .cloned()
            .map(|p| vec![p])
            .unwrap_or_default();
        let workspace: Vec<_> = server.diagnostics_by_uri.values().cloned().collect();
        Ok(LspResponse {
            message: json!({
                "opened": true,
                "diagnostics": current,
                "workspaceDiagnostics": workspace,
                "server": server_status(&language_id, &server),
            }),
        })
    }) {
        Ok(response) => Ok(response),
        Err(err) if lsp_fallback::supports_language(&language_id) => {
            let snapshot =
                lsp_fallback::open_document(&workspace_path, &language_id, &uri, &content, version)
                    .ok_or_else(|| err.clone())?;
            Ok(LspResponse {
                message: json!({
                    "opened": true,
                    "diagnostics": [],
                    "workspaceDiagnostics": [],
                    "server": {
                        "languageId": language_id,
                        "serverFamily": snapshot.server_family,
                        "running": true,
                        "command": snapshot.command,
                        "toolOrigin": "builtin",
                        "toolSource": "builtin-fallback",
                        "toolLabel": "CodePapr builtin symbols",
                        "managedCachePath": Value::Null,
                        "pid": Value::Null,
                        "openDocuments": snapshot.open_documents,
                        "stderrTail": snapshot.stderr_tail,
                    },
                }),
            })
        }
        Err(err) => Err(err),
    }
}

#[tauri::command]
pub fn lsp_open_document(
    app: tauri::AppHandle,
    workspace_path: String,
    language_id: String,
    relative_path: String,
    content: String,
    version: i32,
) -> Result<LspResponse, String> {
    lsp_open_document_with_app(
        Some(&app),
        workspace_path,
        language_id,
        relative_path,
        content,
        version,
    )
}

#[tauri::command]
pub fn lsp_close_document(
    workspace_path: String,
    language_id: String,
    relative_path: String,
) -> Result<bool, String> {
    let workspace = canonical_workspace(&workspace_path)?;
    let uri = file_uri_for(&workspace, &relative_path)?;
    match lookup_server_handle(&workspace_path, &language_id)
        .ok_or_else(|| "LSP server 未启动".to_string())
        .and_then(|server| {
            let mut server = lock_server(&server)?;
            if server
                .child
                .try_wait()
                .map_err(|err| format!("检查 LSP 状态失败: {err}"))?
                .is_some()
            {
                let _ = remove_server_handle(&workspace_path, &language_id);
                return Ok(false);
            }

            if !server.open_documents.contains_key(&uri) {
                return Ok(false);
            }

            send_notification(
                &server,
                "textDocument/didClose",
                json!({
                    "textDocument": { "uri": uri }
                }),
            )?;
            server.open_documents.remove(&uri);
            server.diagnostics_by_uri.remove(&uri);
            Ok(true)
        }) {
        Ok(result) => Ok(result),
        Err(err) if lsp_fallback::supports_language(&language_id) => {
            lsp_fallback::close_document(&workspace_path, &language_id, &uri).ok_or(err)
        }
        Err(err) => Err(err),
    }
}

#[tauri::command]
pub async fn lsp_request(
    workspace_path: String,
    language_id: String,
    method: String,
    params: Value,
) -> Result<LspResponse, String> {
    run_blocking_workspace_task(move || {
        lsp_request_impl(&workspace_path, &language_id, &method, &params)
    }).await
}

pub(crate) fn lsp_request_impl(
    workspace_path: &str,
    language_id: &str,
    method: &str,
    params: &Value,
) -> Result<LspResponse, String> {
    let server_handle = match ensure_running_server_handle(None, workspace_path, language_id) {
        Ok(h) => Some(h),
        Err(_) => None,
    };

    let request_result = if let Some(server_handle) = server_handle {
        let (rx, pending, request_id) = {
            let mut server = lock_server(&server_handle)?;
            let id = server.next_id;
            server.next_id += 1;
            let message = json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": method,
                "params": params,
            });

            let (tx, rx) = mpsc::channel();
            server
                .pending_responses
                .lock()
                .map_err(|_| "LSP pending 表已不可用".to_string())?
                .insert(id, tx);

            {
                let mut stdin = server
                    .stdin
                    .lock()
                    .map_err(|_| "LSP stdin 已不可用".to_string())?;
                write_lsp_message(&mut stdin, &message)?;
            }

            (rx, Arc::clone(&server.pending_responses), id)
        };

        let response = match rx.recv_timeout(LSP_REQUEST_TIMEOUT) {
            Ok(response) => {
                let _ = pending
                    .lock()
                    .map(|mut p| p.remove(&request_id));
                response
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err(format!(
                    "LSP server 已断开，请求失败: {method}"
                ));
            }
            Err(RecvTimeoutError::Timeout) => {
                let _ = pending
                    .lock()
                    .map(|mut p| p.remove(&request_id));
                return Err(format!("等待 LSP 响应超时: {method}"));
            }
        };

        if let Some(description) = describe_lsp_error(&response) {
            Err(format!("LSP 请求失败: {method}: {description}"))
        } else {
            Ok(LspResponse { message: response })
        }
    } else {
        Err("LSP server 未启动".to_string())
    };

    match request_result {
        Ok(response) => Ok(response),
        Err(err) if lsp_fallback::supports_language(language_id) => {
            let result = lsp_fallback::request(workspace_path, language_id, method, params)
                .ok_or(err.clone())??;
            Ok(LspResponse {
                message: json!({ "result": result }),
            })
        }
        Err(err) => Err(err),
    }
}

#[tauri::command]
pub fn lsp_get_diagnostics(
    workspace_path: String,
    language_id: String,
) -> Result<LspDiagnosticsResponse, String> {
    match ensure_running_server_handle(None, &workspace_path, &language_id).and_then(|server| {
        let mut server = lock_server(&server)?;
        // 同上：给一个短暂的真实等待窗口，而不是一県就返回已有结果。
        let _ = collect_publish_diagnostics(&mut server, "", Duration::from_millis(300));
        Ok(server.diagnostics_by_uri.clone())
    }) {
        Ok(diagnostics) => Ok(LspDiagnosticsResponse { diagnostics }),
        Err(_err) if lsp_fallback::supports_language(&language_id) => Ok(LspDiagnosticsResponse {
            diagnostics: HashMap::new(),
        }),
        Err(err) => Err(err),
    }
}

#[tauri::command]
pub fn lsp_stop_server(workspace_path: String, language_id: String) -> Result<bool, String> {
    match remove_server_handle(&workspace_path, &language_id)
        .ok_or_else(|| "LSP server 未启动".to_string())
        .and_then(|server| {
            let mut server = lock_server(&server)?;
            if server
                .child
                .try_wait()
                .map_err(|err| format!("检查 LSP 状态失败: {err}"))?
                .is_some()
            {
                return Ok(false);
            }
            let _ = send_request(&mut server, "shutdown", json!(null), LSP_STARTUP_TIMEOUT);
            let _ = send_notification(&server, "exit", json!(null));
            thread::sleep(Duration::from_millis(50));
            if server
                .child
                .try_wait()
                .map_err(|err| format!("检查 LSP 状态失败: {err}"))?
                .is_none()
            {
                force_stop_server_process(&mut server);
                return Ok(true);
            }
            let _ = server.child.wait();
            Ok(true)
        }) {
        Ok(result) => Ok(result),
        Err(err) if lsp_fallback::supports_language(&language_id) => {
            lsp_fallback::stop_server(&workspace_path, &language_id).ok_or(err)
        }
        Err(err) => Err(err),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_running_server_handle, file_uri_for, lock_server, lsp_close_document,
        lsp_open_document_with_app, lsp_request, lsp_server_config, lsp_stop_server,
        normalize_relative_path, resolve_lsp_command_candidates, resolved_command_display,
        send_request, server_key, LSP_REQUEST_TIMEOUT,
    };
    use serde_json::{json, Value};
    use std::{
        env, fs,
        path::{Path, PathBuf},
        process,
        sync::{Mutex, OnceLock},
        thread,
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };

    static LSP_SMOKE_MUTEX: OnceLock<Mutex<()>> = OnceLock::new();

    fn lsp_smoke_lock() -> std::sync::MutexGuard<'static, ()> {
        LSP_SMOKE_MUTEX
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn make_temp_workspace(prefix: &str) -> PathBuf {
        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        let workspace = env::temp_dir().join(format!(
            "codepapr-{prefix}-{}-{unique_suffix}",
            process::id()
        ));
        fs::create_dir_all(&workspace).expect("create temp workspace");
        workspace
    }

    fn write_workspace_file(workspace: &Path, relative_path: &str, content: &str) {
        let target = workspace.join(relative_path);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).expect("create parent directory");
        }
        fs::write(target, content).expect("write workspace file");
    }

    fn value_contains_text(value: &Value, needle: &str) -> bool {
        match value {
            Value::String(text) => text.contains(needle),
            Value::Array(items) => items.iter().any(|item| value_contains_text(item, needle)),
            Value::Object(map) => map.values().any(|item| value_contains_text(item, needle)),
            _ => false,
        }
    }

    fn value_has_line(value: &Value, expected_line: u64) -> bool {
        match value {
            Value::Object(map) => {
                if map.get("line").and_then(Value::as_u64) == Some(expected_line) {
                    return true;
                }
                map.values().any(|item| value_has_line(item, expected_line))
            }
            Value::Array(items) => items.iter().any(|item| value_has_line(item, expected_line)),
            _ => false,
        }
    }

    fn value_has_uri_fragment(value: &Value, fragment: &str) -> bool {
        match value {
            Value::String(text) => text.contains(fragment),
            Value::Object(map) => map
                .values()
                .any(|item| value_has_uri_fragment(item, fragment)),
            Value::Array(items) => items
                .iter()
                .any(|item| value_has_uri_fragment(item, fragment)),
            _ => false,
        }
    }

    fn request_until<F>(
        workspace_path: &str,
        language_id: &str,
        method: &str,
        params: Value,
        description: &str,
        predicate: F,
    ) -> Value
    where
        F: Fn(&Value) -> bool,
    {
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut last_result: Option<Value> = None;
        let mut last_error = String::new();
        let rt = tokio::runtime::Runtime::new().expect("failed to create tokio runtime");

        loop {
            match rt.block_on(lsp_request(
                workspace_path.to_string(),
                language_id.to_string(),
                method.to_string(),
                params.clone(),
            )) {
                Ok(response) => {
                    let result = response
                        .message
                        .get("result")
                        .cloned()
                        .unwrap_or(Value::Null);
                    if predicate(&result) {
                        return result;
                    }
                    last_result = Some(result);
                    last_error.clear();
                }
                Err(err) => {
                    last_error = err;
                }
            }

            if Instant::now() >= deadline {
                let last_result_text = last_result
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "null".to_string());
                panic!("timed out waiting for {language_id} {description}. last result: {last_result_text}. last error: {last_error}");
            }
            thread::sleep(Duration::from_millis(200));
        }
    }

    fn request_server_until<F>(
        workspace_path: &str,
        language_id: &str,
        method: &str,
        params: Value,
        description: &str,
        predicate: F,
    ) -> Value
    where
        F: Fn(&Value) -> bool,
    {
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut last_result: Option<Value> = None;
        let mut last_error = String::new();

        loop {
            match ensure_running_server_handle(None, workspace_path, language_id).and_then(
                |server| {
                    let mut server = lock_server(&server)?;
                    send_request(&mut server, method, params.clone(), LSP_REQUEST_TIMEOUT)
                },
            ) {
                Ok(response) => {
                    let result = response.get("result").cloned().unwrap_or(Value::Null);
                    if predicate(&result) {
                        return result;
                    }
                    last_result = Some(result);
                    last_error.clear();
                }
                Err(err) => {
                    last_error = err;
                }
            }

            if Instant::now() >= deadline {
                let last_result_text = last_result
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "null".to_string());
                panic!("timed out waiting for {language_id} direct {description}. last result: {last_result_text}. last error: {last_error}");
            }
            thread::sleep(Duration::from_millis(200));
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn run_lsp_smoke_case(
        workspace: &Path,
        language_id: &str,
        relative_path: &str,
        content: &str,
        hover_position: (u64, u64),
        hover_needle: &str,
        definition_position: (u64, u64),
        expected_definition_line: u64,
        expected_symbols: &[&str],
    ) {
        let workspace_path = workspace.to_string_lossy().into_owned();
        let open_result = lsp_open_document_with_app(
            None,
            workspace_path.clone(),
            language_id.to_string(),
            relative_path.to_string(),
            content.to_string(),
            1,
        )
        .unwrap_or_else(|err| panic!("{language_id} open document failed: {err}"));

        assert_eq!(
            open_result.message.get("opened").and_then(Value::as_bool),
            Some(true),
            "{language_id} smoke should open the document"
        );

        let canonical_workspace = workspace.canonicalize().expect("canonical workspace path");
        let uri = file_uri_for(&canonical_workspace, relative_path).expect("file uri");
        let hover = request_until(
            &workspace_path,
            language_id,
            "textDocument/hover",
            json!({
                "textDocument": { "uri": uri },
                "position": { "line": hover_position.0, "character": hover_position.1 },
            }),
            "hover",
            |result| !result.is_null(),
        );
        assert!(
            value_contains_text(&hover, hover_needle),
            "{language_id} hover should mention `{hover_needle}`, got {hover}"
        );

        let definition = request_until(
            &workspace_path,
            language_id,
            "textDocument/definition",
            json!({
                "textDocument": { "uri": uri },
                "position": { "line": definition_position.0, "character": definition_position.1 },
            }),
            "definition",
            |result| match result {
                Value::Null => false,
                Value::Array(items) => !items.is_empty(),
                _ => true,
            },
        );
        assert!(
            value_has_line(&definition, expected_definition_line),
            "{language_id} definition should point to line {expected_definition_line}, got {definition}"
        );

        let symbols = request_until(
            &workspace_path,
            language_id,
            "textDocument/documentSymbol",
            json!({
                "textDocument": { "uri": uri }
            }),
            "documentSymbol",
            |result| matches!(result, Value::Array(items) if !items.is_empty()),
        );
        for expected_symbol in expected_symbols {
            assert!(
                value_contains_text(&symbols, expected_symbol),
                "{language_id} outline should contain `{expected_symbol}`, got {symbols}"
            );
        }

        let _ = lsp_close_document(
            workspace_path.clone(),
            language_id.to_string(),
            relative_path.to_string(),
        );
        let _ = lsp_stop_server(workspace_path, language_id.to_string());
    }

    #[test]
    fn rejects_escaping_relative_paths() {
        assert!(normalize_relative_path("../x.ts").is_err());
        assert!(normalize_relative_path("/x.ts").is_err());
    }

    #[test]
    fn builds_family_scoped_server_keys() {
        assert_eq!(server_key("/tmp/ws", "typescript"), "/tmp/ws::typescript");
        assert_eq!(
            server_key("/tmp/ws", "javascriptreact"),
            "/tmp/ws::typescript"
        );
        assert_eq!(server_key("/tmp/ws", "scss"), "/tmp/ws::css");
    }

    #[test]
    fn resolves_supported_multilanguage_lsp_configs() {
        assert_eq!(
            lsp_server_config("typescript").map(|config| config.family_key),
            Some("typescript")
        );
        assert_eq!(
            lsp_server_config("html").map(|config| config.family_key),
            Some("html")
        );
        assert_eq!(
            lsp_server_config("scss").map(|config| config.family_key),
            Some("css")
        );
        assert_eq!(
            lsp_server_config("jsonc").map(|config| config.family_key),
            Some("json")
        );
        assert_eq!(
            lsp_server_config("yaml").map(|config| config.family_key),
            Some("yaml")
        );
        assert_eq!(
            lsp_server_config("python").map(|config| config.family_key),
            Some("python")
        );
        assert_eq!(
            lsp_server_config("csharp").map(|config| config.family_key),
            Some("csharp")
        );
        assert_eq!(
            lsp_server_config("java").map(|config| config.family_key),
            Some("java")
        );
        assert_eq!(
            lsp_server_config("cpp").map(|config| config.family_key),
            Some("cpp")
        );
        assert_eq!(
            lsp_server_config("c").map(|config| config.family_key),
            Some("cpp")
        );
        assert_eq!(
            lsp_server_config("shellscript").map(|config| config.family_key),
            Some("shellscript")
        );
        assert_eq!(
            lsp_server_config("rust").map(|config| config.family_key),
            Some("rust")
        );
        assert_eq!(
            lsp_server_config("go").map(|config| config.family_key),
            Some("go")
        );
        assert_eq!(
            lsp_server_config("markdown").map(|config| config.family_key),
            Some("markdown")
        );
    }

    #[test]
    fn csharp_prefers_managed_analyzer_candidate() {
        let candidates = resolve_lsp_command_candidates(Path::new("/tmp"), "csharp");
        assert!(!candidates.is_empty());
        let first = &candidates[0];
        // 首选要么是自管的 Roslyn sidecar（CodePapr.CSharp.Analyzer / dotnet），
        // 要么是系统 PATH / dotnet tools 里的 csharp-ls——后者在 managed_csharp_commands
        // 中显式优先，因此都视为合法的 managed 候选。
        let command_lower = first.command.to_lowercase();
        assert!(
            first.command.contains("CodePapr.CSharp.Analyzer")
                || first.command == "dotnet"
                || command_lower.contains("csharp-ls"),
            "expected managed C# analyzer to be first candidate, got {}",
            resolved_command_display(first)
        );
    }

    #[test]
    fn lsp_smoke_cpp_hover_definition_outline() {
        let _guard = lsp_smoke_lock();

        let workspace = make_temp_workspace("cpp-lsp-smoke");
        let source = "int add(int left, int right) { return left + right; }\n\nint main() {\n    return add(1, 2);\n}\n";
        let compile_commands = format!(
            "[{{\"directory\":\"{}\",\"command\":\"clang++ -std=c++20 -c main.cpp\",\"file\":\"main.cpp\"}}]",
            workspace.display()
        );
        write_workspace_file(&workspace, "main.cpp", source);
        write_workspace_file(&workspace, "compile_commands.json", &compile_commands);

        run_lsp_smoke_case(
            &workspace,
            "cpp",
            "main.cpp",
            source,
            (3, 12),
            "add",
            (3, 12),
            0,
            &["add", "main"],
        );

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn lsp_smoke_typescript_hover_definition_outline() {
        let _guard = lsp_smoke_lock();

        let workspace = make_temp_workspace("typescript-lsp-smoke");
        let source = "export function add(left: number, right: number): number {\n    return left + right;\n}\n\nconst value = add(1, 2);\nconsole.log(value);\n";
        let tsconfig =
            "{\"compilerOptions\":{\"target\":\"ES2022\",\"module\":\"ESNext\",\"strict\":true}}";
        write_workspace_file(&workspace, "tsconfig.json", tsconfig);
        write_workspace_file(&workspace, "src/main.ts", source);

        run_lsp_smoke_case(
            &workspace,
            "typescript",
            "src/main.ts",
            source,
            (4, 15),
            "add",
            (4, 15),
            0,
            &["add", "value"],
        );

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn lsp_smoke_python_hover_definition_outline() {
        let _guard = lsp_smoke_lock();

        let workspace = make_temp_workspace("python-lsp-smoke");
        let source = "def add(left: int, right: int) -> int:\n    return left + right\n\nresult = add(1, 2)\n";
        write_workspace_file(&workspace, "main.py", source);

        run_lsp_smoke_case(
            &workspace,
            "python",
            "main.py",
            source,
            (3, 10),
            "add",
            (3, 10),
            0,
            &["add", "result"],
        );

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn lsp_smoke_rust_hover_definition_outline() {
        let _guard = lsp_smoke_lock();

        let workspace = make_temp_workspace("rust-lsp-smoke");
        let manifest =
            "[package]\nname = \"codepapr_rust_smoke\"\nversion = \"0.1.0\"\nedition = \"2021\"\n";
        let source = "fn add(left: i32, right: i32) -> i32 {\n    left + right\n}\n\nfn main() {\n    let value = add(1, 2);\n    println!(\"{value}\");\n}\n";
        write_workspace_file(&workspace, "Cargo.toml", manifest);
        write_workspace_file(&workspace, "src/main.rs", source);

        run_lsp_smoke_case(
            &workspace,
            "rust",
            "src/main.rs",
            source,
            (5, 16),
            "add",
            (5, 16),
            0,
            &["add", "main"],
        );

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn lsp_smoke_csharp_hover_definition_outline() {
        let _guard = lsp_smoke_lock();

        let workspace = make_temp_workspace("csharp-lsp-smoke");
        let source = "using System;\n\ninternal static class Program\n{\n    private static int Add(int left, int right) => left + right;\n\n    private static void Main()\n    {\n        Console.WriteLine(Add(1, 2));\n    }\n}\n";
        let project = "<Project Sdk=\"Microsoft.NET.Sdk\">\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n    <TargetFramework>net8.0</TargetFramework>\n    <ImplicitUsings>enable</ImplicitUsings>\n    <Nullable>enable</Nullable>\n  </PropertyGroup>\n</Project>\n";
        write_workspace_file(&workspace, "CodePaprSmoke.csproj", project);
        write_workspace_file(&workspace, "Program.cs", source);

        let open_result = lsp_open_document_with_app(
            None,
            workspace.to_string_lossy().into_owned(),
            "csharp".to_string(),
            "Program.cs".to_string(),
            source.to_string(),
            1,
        )
        .unwrap_or_else(|err| panic!("csharp open document failed: {err}"));

        let server_command = open_result
            .message
            .get("server")
            .and_then(|server| server.get("command"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        assert!(
            server_command.contains("CodePapr.CSharp.Analyzer")
                || server_command.contains("dotnet"),
            "expected Roslyn analyzer sidecar, got {server_command}"
        );

        let _ = lsp_close_document(
            workspace.to_string_lossy().into_owned(),
            "csharp".to_string(),
            "Program.cs".to_string(),
        );
        let _ = lsp_stop_server(
            workspace.to_string_lossy().into_owned(),
            "csharp".to_string(),
        );

        run_lsp_smoke_case(
            &workspace,
            "csharp",
            "Program.cs",
            source,
            (8, 26),
            "Add",
            (8, 26),
            4,
            &["Program", "Add", "Main"],
        );

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn lsp_smoke_csharp_cross_file_definition() {
        let _guard = lsp_smoke_lock();

        let workspace = make_temp_workspace("csharp-cross-file-smoke");
        let project = "<Project Sdk=\"Microsoft.NET.Sdk\">\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n    <TargetFramework>net8.0</TargetFramework>\n    <ImplicitUsings>enable</ImplicitUsings>\n    <Nullable>enable</Nullable>\n  </PropertyGroup>\n</Project>\n";
        let program = "using System;\n\ninternal static class Program\n{\n    private static void Main()\n    {\n        Console.WriteLine(Calculator.Add(1, 2));\n    }\n}\n";
        let calculator = "internal static class Calculator\n{\n    public static int Add(int left, int right) => left + right;\n}\n";
        write_workspace_file(&workspace, "CodePaprSmoke.csproj", project);
        write_workspace_file(&workspace, "Program.cs", program);
        write_workspace_file(&workspace, "Calculator.cs", calculator);

        let workspace_path = workspace.to_string_lossy().into_owned();
        let open_result = lsp_open_document_with_app(
            None,
            workspace_path.clone(),
            "csharp".to_string(),
            "Program.cs".to_string(),
            program.to_string(),
            1,
        )
        .unwrap_or_else(|err| panic!("csharp cross-file open failed: {err}"));
        assert_eq!(
            open_result.message.get("opened").and_then(Value::as_bool),
            Some(true)
        );
        let server_command = open_result
            .message
            .get("server")
            .and_then(|server| server.get("command"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        assert!(
            server_command.contains("CodePapr.CSharp.Analyzer")
                || server_command.contains("dotnet"),
            "expected Roslyn analyzer sidecar for cross-file smoke, got {server_command}"
        );

        let canonical_workspace = workspace.canonicalize().expect("canonical workspace path");
        let uri = file_uri_for(&canonical_workspace, "Program.cs").expect("file uri");
        let definition = request_server_until(
            &workspace_path,
            "csharp",
            "textDocument/definition",
            json!({
                "textDocument": { "uri": uri },
                "position": { "line": 6_u64, "character": 37_u64 },
            }),
            "cross-file definition",
            |result| matches!(result, Value::Array(items) if !items.is_empty()),
        );
        assert!(
            value_has_line(&definition, 2),
            "expected cross-file definition line, got {definition}"
        );
        assert!(
            value_has_uri_fragment(&definition, "Calculator.cs"),
            "expected cross-file definition to point at Calculator.cs, got {definition}"
        );

        let _ = lsp_close_document(
            workspace_path.clone(),
            "csharp".to_string(),
            "Program.cs".to_string(),
        );
        let _ = lsp_stop_server(workspace_path, "csharp".to_string());
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn lsp_smoke_csharp_project_reference_definition() {
        let _guard = lsp_smoke_lock();

        let workspace = make_temp_workspace("csharp-project-ref-smoke");
        let app_project = "<Project Sdk=\"Microsoft.NET.Sdk\">\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n    <TargetFramework>net8.0</TargetFramework>\n    <ImplicitUsings>enable</ImplicitUsings>\n    <Nullable>enable</Nullable>\n  </PropertyGroup>\n  <ItemGroup>\n    <ProjectReference Include=\"../Library/Library.csproj\" />\n  </ItemGroup>\n</Project>\n";
        let library_project = "<Project Sdk=\"Microsoft.NET.Sdk\">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n    <ImplicitUsings>enable</ImplicitUsings>\n    <Nullable>enable</Nullable>\n  </PropertyGroup>\n</Project>\n";
        let program = "using System;\nusing Library;\n\ninternal static class Program\n{\n    private static void Main()\n    {\n        Console.WriteLine(MathHelpers.Add(1, 2));\n    }\n}\n";
        let helper = "namespace Library;\n\npublic static class MathHelpers\n{\n    public static int Add(int left, int right) => left + right;\n}\n";
        write_workspace_file(&workspace, "App/App.csproj", app_project);
        write_workspace_file(&workspace, "App/Program.cs", program);
        write_workspace_file(&workspace, "Library/Library.csproj", library_project);
        write_workspace_file(&workspace, "Library/MathHelpers.cs", helper);

        let workspace_path = workspace.to_string_lossy().into_owned();
        let open_result = lsp_open_document_with_app(
            None,
            workspace_path.clone(),
            "csharp".to_string(),
            "App/Program.cs".to_string(),
            program.to_string(),
            1,
        )
        .unwrap_or_else(|err| panic!("csharp project-ref open failed: {err}"));
        assert_eq!(
            open_result.message.get("opened").and_then(Value::as_bool),
            Some(true)
        );
        let server_command = open_result
            .message
            .get("server")
            .and_then(|server| server.get("command"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        assert!(
            server_command.contains("CodePapr.CSharp.Analyzer")
                || server_command.contains("dotnet"),
            "expected Roslyn analyzer sidecar for project-ref smoke, got {server_command}"
        );

        let canonical_workspace = workspace.canonicalize().expect("canonical workspace path");
        let uri = file_uri_for(&canonical_workspace, "App/Program.cs").expect("file uri");
        let definition = request_server_until(
            &workspace_path,
            "csharp",
            "textDocument/definition",
            json!({
                "textDocument": { "uri": uri },
                "position": { "line": 7_u64, "character": 38_u64 },
            }),
            "project reference definition",
            |result| matches!(result, Value::Array(items) if !items.is_empty()),
        );
        assert!(
            value_has_line(&definition, 4),
            "expected project reference definition line, got {definition}"
        );
        assert!(
            value_has_uri_fragment(&definition, "Library/MathHelpers.cs"),
            "expected project reference definition to point at Library/MathHelpers.cs, got {definition}"
        );

        let _ = lsp_close_document(
            workspace_path.clone(),
            "csharp".to_string(),
            "App/Program.cs".to_string(),
        );
        let _ = lsp_stop_server(workspace_path, "csharp".to_string());
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn lsp_smoke_java_hover_definition_outline() {
        let _guard = lsp_smoke_lock();

        let workspace = make_temp_workspace("java-lsp-smoke");
        let source = "package com.example;\n\npublic class Main {\n    private static int add(int left, int right) {\n        return left + right;\n    }\n\n    public static void main(String[] args) {\n        System.out.println(add(1, 2));\n    }\n}\n";
        let pom = "<project xmlns=\"http://maven.apache.org/POM/4.0.0\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xsi:schemaLocation=\"http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd\">\n  <modelVersion>4.0.0</modelVersion>\n  <groupId>com.example</groupId>\n  <artifactId>codepapr-smoke</artifactId>\n  <version>1.0.0</version>\n  <properties>\n    <maven.compiler.source>17</maven.compiler.source>\n    <maven.compiler.target>17</maven.compiler.target>\n  </properties>\n</project>\n";
        write_workspace_file(&workspace, "pom.xml", pom);
        write_workspace_file(&workspace, "src/main/java/com/example/Main.java", source);

        run_lsp_smoke_case(
            &workspace,
            "java",
            "src/main/java/com/example/Main.java",
            source,
            (8, 27),
            "add",
            (8, 27),
            3,
            &["Main", "add", "main"],
        );

        let _ = fs::remove_dir_all(workspace);
    }
}
