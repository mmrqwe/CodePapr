#![forbid(unsafe_code)]

use rmcp::{
    model::{CallToolRequestParams, ClientRequest, PingRequest},
    object,
    service::RunningService,
    transport::{
        streamable_http_client::StreamableHttpClientTransportConfig, ConfigureCommandExt,
        TokioChildProcess,
    },
    RoleClient, ServiceExt,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
    time::Duration,
};
use crate::events::SharedEventSink;
use tokio::{process::Command, sync::Mutex as AsyncMutex};
use futures_util::future::join_all;

#[path = "mcp_sse.rs"]
mod mcp_sse;

const DEFAULT_RESULT_MAX_BYTES: usize = 200_000;

pub(crate) type McpRunningClient = RunningService<RoleClient, ()>;
pub(crate) type SharedMcpClient = Arc<AsyncMutex<McpRunningClient>>;

static MCP_CLIENTS: OnceLock<AsyncMutex<HashMap<String, SharedMcpClient>>> = OnceLock::new();
static EXPANDED_PATH_CACHE: OnceLock<String> = OnceLock::new();
static PENDING_CONFIRMATIONS: OnceLock<AsyncMutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>> = OnceLock::new();
static STORED_SETTINGS: OnceLock<AsyncMutex<Option<McpSettings>>> = OnceLock::new();
static HEALTH_FAILS: OnceLock<AsyncMutex<HashMap<String, u8>>> = OnceLock::new();

fn stored_settings() -> &'static AsyncMutex<Option<McpSettings>> {
    STORED_SETTINGS.get_or_init(|| AsyncMutex::new(None))
}

pub async fn update_settings(settings: McpSettings) {
    *stored_settings().lock().await = Some(settings);
}

async fn resolve_settings(explicit: Option<McpSettings>) -> Result<McpSettings, String> {
    if let Some(s) = explicit {
        update_settings(s.clone()).await;
        return Ok(s);
    }
    stored_settings()
        .lock()
        .await
        .clone()
        .ok_or_else(|| "MCP settings not initialized. Call list_tools or update_settings first.".to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfirmRequest {
    pub request_id: String,
    pub server_id: String,
    pub server_name: String,
    pub tool_name: String,
    pub arguments: Value,
}

fn pending_confirmations() -> &'static AsyncMutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>> {
    PENDING_CONFIRMATIONS.get_or_init(|| AsyncMutex::new(HashMap::new()))
}

pub async fn resolve_confirmation(request_id: String, approved: bool) -> Result<(), String> {
    let sender = pending_confirmations()
        .lock()
        .await
        .remove(&request_id)
        .ok_or_else(|| format!("No pending confirmation with id: {request_id}"))?;
    let _ = sender.send(approved);
    Ok(())
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSettings {
    pub enabled: bool,
    pub expose_tools: bool,
    pub result_max_bytes: Option<usize>,
    pub servers: Vec<McpServerConfig>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub category: String,
    pub transport: String,
    pub command: String,
    pub args: Vec<String>,
    pub url: String,
    pub env: HashMap<String, String>,
    pub headers: HashMap<String, String>,
    pub allowed_tools: Vec<String>,
    pub denied_tools: Vec<String>,
    #[serde(default)]
    pub force_mutating: Vec<String>,
    #[serde(default)]
    pub force_readonly: Vec<String>,
    pub permission_mode: String,
    pub require_confirmation: bool,
    pub timeout_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub server_id: String,
    pub server_name: String,
    pub tool_name: String,
    pub display_name: String,
    pub description: String,
    pub input_schema: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerError {
    pub server_id: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpListToolsResult {
    pub tools: Vec<McpToolInfo>,
    pub errors: Vec<McpServerError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCallToolResult {
    pub server_id: String,
    pub tool_name: String,
    pub result: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTestServerResult {
    pub server_id: String,
    pub server_name: String,
    pub success: bool,
    pub tool_count: usize,
    pub filtered_count: usize,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolPreviewItem {
    pub name: String,
    pub description: String,
    pub input_schema: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPreviewResult {
    pub success: bool,
    pub url: String,
    pub server_name: String,
    pub tool_count: usize,
    pub tools: Vec<McpToolPreviewItem>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub server_id: String,
    pub server_name: String,
    pub enabled: bool,
    pub connected: bool,
    pub transport: String,
    pub permission_mode: String,
}

fn clients() -> &'static AsyncMutex<HashMap<String, SharedMcpClient>> {
    MCP_CLIENTS.get_or_init(|| AsyncMutex::new(HashMap::new()))
}

fn sanitize_name_part(value: &str) -> String {
    let mut out = String::new();
    for ch in value.trim().chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('_').to_string();
    if trimmed.is_empty() {
        "tool".to_string()
    } else {
        trimmed
    }
}

fn build_display_name(server_id: &str, tool_name: &str) -> String {
    format!(
        "mcp__{}__{}",
        sanitize_name_part(server_id),
        sanitize_name_part(tool_name)
    )
}

fn expanded_path() -> String {
    EXPANDED_PATH_CACHE
        .get_or_init(|| {
            #[cfg(target_os = "macos")]
            {
                if let Ok(output) = std::process::Command::new("/usr/libexec/path_helper")
                    .arg("-s")
                    .output()
                {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    if let Some(line) = stdout.lines().find(|line| line.starts_with("PATH=")) {
                        let shell_path = line
                            .strip_prefix("PATH=")
                            .unwrap_or("")
                            .trim_matches('"')
                            .trim_matches('\'');
                        if !shell_path.is_empty() {
                            let home = env::var("HOME").unwrap_or_default();
                            let mut paths: Vec<PathBuf> = env::split_paths(shell_path)
                                .map(|path| {
                                    let s = path.to_string_lossy().to_string();
                                    if s.starts_with('~') {
                                        PathBuf::from(s.replacen('~', &home, 1))
                                    } else {
                                        path
                                    }
                                })
                                .collect();
                            append_common_command_dirs(&mut paths);
                            return join_paths_or_current(paths);
                        }
                    }
                }
            }

            let mut paths: Vec<PathBuf> = env::var_os("PATH")
                .map(|value| env::split_paths(&value).collect())
                .unwrap_or_default();
            append_common_command_dirs(&mut paths);
            join_paths_or_current(paths)
        })
        .clone()
}

fn join_paths_or_current(paths: Vec<PathBuf>) -> String {
    env::join_paths(paths)
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|_| env::var("PATH").unwrap_or_default())
}

fn append_if_dir(paths: &mut Vec<PathBuf>, path: impl Into<PathBuf>) {
    let path = path.into();
    if path.is_dir() && !paths.iter().any(|existing| existing == &path) {
        paths.push(path);
    }
}

fn append_common_command_dirs(paths: &mut Vec<PathBuf>) {
    #[cfg(target_os = "macos")]
    {
        append_if_dir(paths, "/opt/homebrew/bin");
        append_if_dir(paths, "/usr/local/bin");
        append_if_dir(paths, "/usr/bin");
        append_if_dir(paths, "/bin");
    }
    if let Ok(home) = env::var("HOME").or_else(|_| env::var("USERPROFILE")) {
        let home = Path::new(&home);
        append_if_dir(paths, home.join(".volta/bin"));
        append_if_dir(paths, home.join(".fnm"));
        append_if_dir(paths, home.join(".local/bin"));
        append_if_dir(paths, home.join(".cargo/bin"));
        if let Ok(entries) = fs::read_dir(home.join(".nvm/versions/node")) {
            let mut node_bins: Vec<PathBuf> = entries
                .flatten()
                .map(|entry| entry.path().join("bin"))
                .filter(|path| path.is_dir())
                .collect();
            node_bins.sort();
            for path in node_bins.into_iter().rev() {
                append_if_dir(paths, path);
            }
        }
    }
}

fn resolve_command(command: &str) -> Result<String, String> {
    let trimmed = command.trim();
    if trimmed.contains('/') || trimmed.contains('\\') {
        let path = Path::new(trimmed);
        if path.is_file() {
            return Ok(trimmed.to_string());
        }
        return Err(format!("MCP command not found at path: {trimmed}"));
    }
    for dir in env::split_paths(&expanded_path()) {
        let candidate = dir.join(trimmed);
        if candidate.is_file() {
            return Ok(candidate.to_string_lossy().to_string());
        }
        #[cfg(windows)]
        {
            for ext in ["exe", "cmd", "bat"] {
                let candidate = dir.join(format!("{trimmed}.{ext}"));
                if candidate.is_file() {
                    return Ok(candidate.to_string_lossy().to_string());
                }
            }
        }
    }
    Err(format!(
        "MCP command not found: '{trimmed}' is not installed or not in PATH"
    ))
}

fn server_cache_key(server: &McpServerConfig) -> String {
    let mut env: Vec<_> = server.env.iter().collect();
    env.sort_by(|left, right| left.0.cmp(right.0));
    let env_key = env
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("\u{1f}");
    let mut headers: Vec<_> = server.headers.iter().collect();
    headers.sort_by(|left, right| left.0.cmp(right.0));
    let headers_key = headers
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("\u{1f}");
    format!(
        "{}\u{1e}{}\u{1e}{}\u{1e}{}\u{1e}{}\u{1e}{}\u{1e}{}",
        sanitize_name_part(&server.id),
        server.transport,
        server.command,
        server.args.join("\u{1f}"),
        server.url,
        env_key,
        headers_key,
    )
}

fn matches_pattern(pattern: &str, value: &str) -> bool {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return false;
    }
    if pattern == "*" {
        return true;
    }
    // *foo*：包含匹配。必须先于前缀/后缀分支判断（否则会被 strip_suffix
    // 当成前缀 "*foo" 处理，永远匹配不上）。
    if let Some(inner) = pattern.strip_prefix('*').and_then(|p| p.strip_suffix('*')) {
        return value.contains(inner);
    }
    if let Some(prefix) = pattern.strip_suffix('*') {
        return value.starts_with(prefix);
    }
    if let Some(suffix) = pattern.strip_prefix('*') {
        return value.ends_with(suffix);
    }
    pattern == value
}

fn is_tool_allowed(server: &McpServerConfig, tool_name: &str) -> bool {
    if server
        .denied_tools
        .iter()
        .any(|pattern| matches_pattern(pattern, tool_name))
    {
        return false;
    }
    if server.allowed_tools.is_empty() {
        return true;
    }
    server
        .allowed_tools
        .iter()
        .any(|pattern| matches_pattern(pattern, tool_name))
}

fn looks_mutating_tool(tool_name: &str) -> bool {
    let name = tool_name.to_ascii_lowercase();
    const MUTATING_PREFIXES: &[&str] = &[
        "create", "insert", "update", "upsert", "delete", "drop", "truncate", "alter", "write",
        "patch", "edit", "remove", "send", "publish", "execute", "run", "mutation",
    ];
    MUTATING_PREFIXES.iter().any(|prefix| {
        name == *prefix
            || name.starts_with(&format!("{prefix}_"))
            || name.starts_with(&format!("{prefix}-"))
            || name.starts_with(&format!("{prefix}."))
    })
}

fn is_mutating_with_overrides(server: &McpServerConfig, tool_name: &str) -> bool {
    // Dangerous 忽略 force_readonly：不能把写工具伪装成只读来跳过确认/重试限制。
    if server.permission_mode != "dangerous"
        && server
            .force_readonly
            .iter()
            .any(|p| matches_pattern(p, tool_name))
    {
        return false;
    }
    if server.force_mutating.iter().any(|p| matches_pattern(p, tool_name)) {
        return true;
    }
    looks_mutating_tool(tool_name)
}

fn confirmation_required(server: &McpServerConfig, tool_name: &str) -> bool {
    let confirm = server.require_confirmation || server.permission_mode == "dangerous";
    if !confirm {
        return false;
    }
    server.permission_mode != "read-only" || is_mutating_with_overrides(server, tool_name)
}

/// `*` / `**` 只表示「发现范围」，不能当作对变更工具的显式放行。
/// 否则商城默认 `allowedTools=*` 会把 read-only 整档掏空。
fn is_catch_all_allow_pattern(pattern: &str) -> bool {
    let pattern = pattern.trim();
    pattern == "*" || pattern == "**"
}

fn explicitly_allows_mutating_tool(server: &McpServerConfig, tool_name: &str) -> bool {
    server.allowed_tools.iter().any(|pattern| {
        !is_catch_all_allow_pattern(pattern) && matches_pattern(pattern, tool_name)
    })
}

fn validate_tool_policy(server: &McpServerConfig, tool_name: &str) -> Result<(), String> {
    if !is_tool_allowed(server, tool_name) {
        return Err(format!("MCP tool is not allowed by policy: {tool_name}"));
    }
    if server.permission_mode == "read-only" && is_mutating_with_overrides(server, tool_name) {
        if explicitly_allows_mutating_tool(server, tool_name) {
            return Ok(());
        }
        return Err(format!(
            "MCP tool '{tool_name}' looks mutating but server '{}' is read-only. Allow it explicitly by changing permission mode or tool policy.",
            server.name
        ));
    }
    Ok(())
}

fn find_server(settings: &McpSettings, server_id: &str) -> Option<McpServerConfig> {
    find_server_inner(settings, server_id, true)
}

fn find_server_any(settings: &McpSettings, server_id: &str) -> Option<McpServerConfig> {
    find_server_inner(settings, server_id, false)
}

fn find_server_inner(
    settings: &McpSettings,
    server_id: &str,
    require_enabled: bool,
) -> Option<McpServerConfig> {
    let sanitized = sanitize_name_part(server_id);
    settings
        .servers
        .iter()
        .find(|server| {
            if require_enabled && !server.enabled {
                return false;
            }
            server.id == server_id || sanitize_name_part(&server.id) == sanitized
        })
        .cloned()
}

fn is_retryable_transport_error(err: &str) -> bool {
    let e = err.to_ascii_lowercase();
    const NEEDLES: &[&str] = &[
        "connection reset",
        "connection closed",
        "connection refused",
        "broken pipe",
        "not connected",
        "transport",
        "session closed",
        "channel closed",
        "connection abort",
        "eof",
        "os error 32",
        "os error 54",
        "os error 104",
    ];
    NEEDLES.iter().any(|needle| e.contains(needle))
}

async fn connect_client(server: &McpServerConfig) -> Result<SharedMcpClient, String> {
    let timeout = Duration::from_secs(server.timeout_seconds.unwrap_or(60).clamp(5, 600));
    match server.transport.as_str() {
        "stdio" => connect_stdio(server, timeout).await,
        "sse" => mcp_sse::connect_sse(server, timeout).await,
        "streamable-http" => connect_http(server, timeout).await,
        other => Err(format!("Unsupported MCP transport: '{other}'")),
    }
}

async fn connect_stdio(
    server: &McpServerConfig,
    timeout: Duration,
) -> Result<SharedMcpClient, String> {
    if server.command.trim().is_empty() {
        return Err("MCP stdio command is required".to_string());
    }

    let command_name = resolve_command(&server.command)?;
    let args = server.args.clone();
    let env = server.env.clone();
    let path = expanded_path();
    let transport = TokioChildProcess::new(Command::new(command_name).configure(move |cmd| {
        cmd.args(args);
        cmd.env("PATH", path);
        for (key, value) in env {
            if !key.trim().is_empty() {
                cmd.env(key, value);
            }
        }
    }))
    .map_err(|err| format!("Failed to start MCP server '{}': {err}", server.name))?;

    let client = tokio::time::timeout(timeout, ().serve(transport))
        .await
        .map_err(|_| format!("Timed out connecting to MCP server '{}'", server.name))?
        .map_err(|err| format!("Failed to initialize MCP server '{}': {err}", server.name))?;

    Ok(Arc::new(AsyncMutex::new(client)))
}

async fn connect_http(
    server: &McpServerConfig,
    timeout: Duration,
) -> Result<SharedMcpClient, String> {
    if server.url.trim().is_empty() {
        return Err(format!("MCP {} url is required", server.transport));
    }

    let url: Arc<str> = Arc::from(server.url.trim());
    let mut config = StreamableHttpClientTransportConfig::with_uri(url);

    if !server.headers.is_empty() {
        let mut headers = std::collections::HashMap::new();
        for (key, value) in &server.headers {
            if key.trim().is_empty() {
                continue;
            }
            match (
                reqwest::header::HeaderName::from_bytes(key.as_bytes()),
                reqwest::header::HeaderValue::from_str(value),
            ) {
                (Ok(name), Ok(val)) => {
                    headers.insert(name, val);
                }
                _ => continue,
            }
        }
        if !headers.is_empty() {
            config = config.custom_headers(headers);
        }
    }

    let transport = rmcp::transport::StreamableHttpClientTransport::from_config(config);

    let client = tokio::time::timeout(timeout, ().serve(transport))
        .await
        .map_err(|_| {
            format!(
                "Timed out connecting to MCP {} server '{}'",
                server.transport, server.name
            )
        })?
        .map_err(|err| {
            format!(
                "Failed to initialize MCP {} server '{}': {err}",
                server.transport, server.name
            )
        })?;

    Ok(Arc::new(AsyncMutex::new(client)))
}

async fn get_or_connect_client(server: &McpServerConfig) -> Result<SharedMcpClient, String> {
    let key = server_cache_key(server);
    let server_id = sanitize_name_part(&server.id);
    // 全局 map 锁只用于查找/清理，clone 出 Arc 后立即释放，绝不跨 await 持有：
    // client 子锁可能被长时间的 call_tool/list_tools 占用，若在持有 map 锁时
    // await 它，会把所有其他服务器的访问一并阻塞。
    let existing = {
        let mut guard = clients().lock().await;
        let stale_keys: Vec<String> = guard
            .iter()
            .filter_map(|(existing_key, client)| {
                let same_server = existing_key.starts_with(&format!("{server_id}\u{1e}"));
                let closed = client
                    .try_lock()
                    .map(|locked| locked.is_closed())
                    .unwrap_or(false);
                if closed || (same_server && existing_key != &key) {
                    Some(existing_key.clone())
                } else {
                    None
                }
            })
            .collect();
        for stale_key in stale_keys {
            guard.remove(&stale_key);
        }
        guard.get(&key).cloned()
    };

    if let Some(client) = existing {
        let closed = client.lock().await.is_closed();
        if !closed {
            return Ok(client);
        }
        // 释放窗口期内可能已有并发重连插入了新 client，仅当仍是同一个 Arc 时才移除
        let mut guard = clients().lock().await;
        if let Some(current) = guard.get(&key) {
            if Arc::ptr_eq(current, &client) {
                guard.remove(&key);
            }
        }
    }

    const MAX_RETRIES: u32 = 2;
    let mut last_err = String::new();
    for attempt in 0..=MAX_RETRIES {
        if attempt > 0 {
            let backoff = Duration::from_millis(500 * 2u64.pow(attempt - 1));
            eprintln!(
                "[MCP] Retry {attempt}/{MAX_RETRIES} for server '{}' in {}ms",
                server.name,
                backoff.as_millis()
            );
            tokio::time::sleep(backoff).await;
        }
        match connect_client(server).await {
            Ok(client) => {
                let mut guard = clients().lock().await;
                guard.insert(key, client.clone());
                return Ok(client);
            }
            Err(err) => {
                last_err = err;
                if server.transport != "stdio" {
                    break;
                }
            }
        }
    }

    Err(last_err)
}

async fn invalidate_cached_client(server: &McpServerConfig) {
    let _ = take_cached_client(server).await;
}

async fn take_cached_client(server: &McpServerConfig) -> Option<SharedMcpClient> {
    let key = server_cache_key(server);
    let mut guard = clients().lock().await;
    guard.remove(&key)
}

async fn close_cached_client(server: &McpServerConfig) {
    if let Some(client) = take_cached_client(server).await {
        let mut locked = client.lock().await;
        let _ = locked.close_with_timeout(Duration::from_secs(2)).await;
    }
}

fn truncate_json(mut value: Value, max_bytes: usize) -> Value {
    let total_len = match serde_json::to_string(&value) {
        Ok(text) => text.len(),
        Err(_) => return value,
    };
    if total_len <= max_bytes {
        return value;
    }

    if let Value::Object(ref mut map) = value {
        if let Some(Value::Array(content)) = map.get_mut("content") {
            let mut current_size = total_len;
            for item in content.iter_mut() {
                if current_size <= max_bytes {
                    break;
                }
                if let Value::Object(ref mut item_map) = item {
                    if let Some(Value::String(ref mut text)) = item_map.get_mut("text") {
                        let text_bytes = text.len();
                        if text_bytes > 500 {
                            let excess = current_size.saturating_sub(max_bytes);
                            let allowed = text_bytes.saturating_sub(excess + 100);
                            let safe_len = allowed.clamp(100, text_bytes);
                            let end = text
                                .char_indices()
                                .map(|(idx, _)| idx)
                                .take_while(|idx| *idx <= safe_len)
                                .last()
                                .unwrap_or(0);
                            let new_text = format!(
                                "{}\n...[MCP content truncated: {} bytes > {} bytes]",
                                &text[..end],
                                text_bytes,
                                safe_len
                            );
                            let delta = text_bytes.saturating_sub(new_text.len());
                            *text = new_text;
                            current_size = current_size.saturating_sub(delta);
                        }
                    }
                }
            }

            while current_size > max_bytes && content.len() > 1 {
                if let Some(popped) = content.pop() {
                    let popped_size = serde_json::to_string(&popped).map(|s| s.len()).unwrap_or(0);
                    current_size = current_size.saturating_sub(popped_size);
                }
            }

            if current_size > max_bytes {
                if let Some(first) = content.get_mut(0) {
                    if let Value::Object(ref mut item_map) = first {
                        if let Some(Value::String(ref mut text)) = item_map.get_mut("text") {
                            let end = text
                                .char_indices()
                                .map(|(i, _)| i)
                                .take_while(|i| *i <= max_bytes.saturating_sub(200))
                                .last()
                                .unwrap_or(0);
                            *text = format!("{}\n...[MCP content truncated]", &text[..end]);
                        }
                    }
                }
            }
            map.insert("truncated".to_string(), Value::Bool(true));
            return value;
        }
    }

    let original_error = value.get("isError").cloned();
    let text = serde_json::to_string(&value).unwrap_or_default();
    let end = text
        .char_indices()
        .map(|(index, _)| index)
        .take_while(|index| *index <= max_bytes.saturating_sub(100))
        .last()
        .unwrap_or(0);
    let mut envelope = serde_json::json!({
        "content": [{
            "type": "text",
            "text": format!("{}\n...[MCP result truncated: {} bytes > {} bytes]", &text[..end], text.len(), max_bytes)
        }],
        "truncated": true
    });
    if let Some(flag) = original_error {
        if let Some(map) = envelope.as_object_mut() {
            map.insert("isError".to_string(), flag);
        }
    }
    envelope
}

pub async fn list_tools(
    settings: McpSettings,
    refresh: bool,
) -> Result<McpListToolsResult, String> {
    update_settings(settings.clone()).await;

    if !settings.enabled || !settings.expose_tools {
        let _ = disconnect_all().await;
        return Ok(McpListToolsResult {
            tools: vec![],
            errors: vec![],
        });
    }

    let enabled_servers: Vec<McpServerConfig> = settings
        .servers
        .iter()
        .filter(|server| server.enabled)
        .cloned()
        .collect();

    if refresh {
        for server in &enabled_servers {
            close_cached_client(server).await;
        }
    }

    let futures = enabled_servers.iter().map(|server| {
        let server = server.clone();
        async move {
            let server_id = sanitize_name_part(&server.id);
            // #18：list_all_tools 必须有时限。旧实现无超时——挂起的服务器会无限
            // 持有 client 的 AsyncMutex，该服务器后续所有 call_tool 永久排队。
            // 超时后 future 被取消，锁随 guard drop 释放。
            let timeout = Duration::from_secs(server.timeout_seconds.unwrap_or(60).clamp(5, 600));
            let result = match tokio::time::timeout(timeout, async {
                let client = get_or_connect_client(&server).await?;
                let client = client.lock().await;
                client
                    .list_all_tools()
                    .await
                    .map_err(|err| format!("Failed to list tools: {err}"))
            })
            .await
            {
                Ok(inner) => inner,
                Err(_) => Err(format!(
                    "Timed out listing tools for server '{}' after {}s",
                    server.name,
                    timeout.as_secs()
                )),
            };
            (server, server_id, result)
        }
    });

    let results = join_all(futures).await;

    let mut tools = Vec::new();
    let mut errors = Vec::new();

    for (server, server_id, result) in results {
        match result {
            Ok(list) => {
                let mut filtered = 0u32;
                for tool in list {
                    let tool_name = tool.name.to_string();
                    if let Err(reason) = validate_tool_policy(&server, &tool_name) {
                        eprintln!(
                            "[MCP] Tool '{tool_name}' on server '{}' filtered by policy: {reason}",
                            server.name
                        );
                        filtered += 1;
                        continue;
                    }
                    tools.push(McpToolInfo {
                        server_id: server_id.clone(),
                        server_name: server.name.clone(),
                        tool_name: tool_name.clone(),
                        display_name: build_display_name(&server_id, &tool_name),
                        description: tool
                            .description
                            .map(|value| value.to_string())
                            .unwrap_or_default(),
                        input_schema: (*tool.input_schema).clone(),
                    });
                }
                if filtered > 0 {
                    eprintln!(
                        "[MCP] Server '{}': {filtered} tool(s) filtered by policy",
                        server.name
                    );
                }
            }
            Err(message) => errors.push(McpServerError { server_id, message }),
        }
    }

    tools.sort_by(|left, right| left.display_name.cmp(&right.display_name));
    Ok(McpListToolsResult { tools, errors })
}

pub async fn call_tool(
    event_sink: Option<SharedEventSink>,
    settings: Option<McpSettings>,
    server_id: String,
    tool_name: String,
    arguments: Value,
) -> Result<McpCallToolResult, String> {
    let settings = resolve_settings(settings).await?;

    if !settings.enabled || !settings.expose_tools {
        let _ = disconnect_all().await;
        return Err("MCP is disabled".to_string());
    }
    let server = find_server(&settings, &server_id)
        .ok_or_else(|| format!("MCP server not found: {server_id}"))?;
    validate_tool_policy(&server, &tool_name)?;

    // #20：read-only 模式不再整体跳过确认。read-only 下变更工具默认被策略
    // 拦截（无需确认），但 allowed_tools 显式放行的变更工具仍会执行——此时
    // require_confirmation 必须生效，否则配合 allowed_tools 可无确认执行变更。
    // Dangerous 强制确认，且忽略 force_readonly。
    if confirmation_required(&server, &tool_name) {
        // Fail-closed：没有 UI 通道就无法向用户要确认。旧实现在 app 为 None
        // 时直接跳过确认执行，会把需要确认的工具放行。
        let Some(sink) = &event_sink else {
            return Err(format!(
                "MCP tool '{tool_name}' on server '{}' requires user confirmation, but no UI channel is available",
                server.name
            ));
        };
        let request_id = format!("mcp_{}_{}", sanitize_name_part(&server_id), uuid_v4());
        let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
        pending_confirmations().lock().await.insert(request_id.clone(), tx);

        sink.emit(
            "mcp-confirm-request",
            serde_json::to_value(McpConfirmRequest {
                request_id: request_id.clone(),
                server_id: sanitize_name_part(&server_id),
                server_name: server.name.clone(),
                tool_name: tool_name.clone(),
                arguments: arguments.clone(),
            })
            .unwrap_or_default(),
        );

        let approved = match tokio::time::timeout(Duration::from_secs(120), rx).await {
            Ok(Ok(approved)) => approved,
            Ok(Err(_)) => {
                pending_confirmations().lock().await.remove(&request_id);
                return Err("Confirmation channel closed".to_string());
            }
            Err(_) => {
                pending_confirmations().lock().await.remove(&request_id);
                return Err("Confirmation timed out".to_string());
            }
        };

        if !approved {
            return Err(format!(
                "MCP tool '{tool_name}' on server '{}' was denied by user",
                server.name
            ));
        }
    }

    let max_bytes = settings
        .result_max_bytes
        .unwrap_or(DEFAULT_RESULT_MAX_BYTES)
        .clamp(1_000, 5_000_000);
    let args_object = match arguments {
        Value::Object(map) => map,
        _ => object!({}),
    };

    let timeout = Duration::from_secs(server.timeout_seconds.unwrap_or(60).clamp(5, 600));
    let mut last_err = String::new();
    let mut result_value = None;

    for attempt in 0..2 {
        let client = match get_or_connect_client(&server).await {
            Ok(c) => c,
            Err(e) => {
                last_err = e;
                break;
            }
        };

        let call_res = {
            let client = client.lock().await;
            tokio::time::timeout(
                timeout,
                client.call_tool(CallToolRequestParams::new(tool_name.clone()).with_arguments(args_object.clone())),
            )
            .await
        };

        match call_res {
            Ok(Ok(result)) => {
                match serde_json::to_value(result) {
                    Ok(val) => {
                        result_value = Some(val);
                        break;
                    }
                    Err(err) => {
                        return Err(format!("Failed to encode MCP result: {err}"));
                    }
                }
            }
            Ok(Err(err)) => {
                last_err = format!("Failed to call MCP tool: {err}");
                invalidate_cached_client(&server).await;
                let mutating = is_mutating_with_overrides(&server, &tool_name);
                let retryable = is_retryable_transport_error(&err.to_string());
                if attempt == 0 && !mutating && retryable {
                    eprintln!(
                        "[MCP] Tool call failed on transport ({err}), invalidating client and retrying once..."
                    );
                    tokio::time::sleep(Duration::from_millis(200)).await;
                } else {
                    break;
                }
            }
            Err(_) => {
                last_err = format!("Timed out calling MCP tool '{tool_name}'");
                invalidate_cached_client(&server).await;
                break; // Do not retry if timed out
            }
        }
    }

    let value = match result_value {
        Some(v) => v,
        None => return Err(last_err),
    };

    Ok(McpCallToolResult {
        server_id: sanitize_name_part(&server_id),
        tool_name,
        result: truncate_json(value, max_bytes),
    })
}

fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    let counter = {
        use std::sync::atomic::{AtomicU32, Ordering};
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        COUNTER.fetch_add(1, Ordering::Relaxed)
    };
    format!("{nanos:08x}_{counter:08x}")
}

pub async fn list_status(settings: McpSettings) -> Vec<McpServerStatus> {
    let guard = clients().lock().await;
    let mut result = Vec::new();
    for server in settings.servers.iter() {
        let key = server_cache_key(server);
        let connected = match guard.get(&key) {
            Some(client) => match client.try_lock() {
                Ok(locked) => !locked.is_closed(),
                Err(_) => true, // locked by another operation → considered connected
            },
            None => false,
        };
        result.push(McpServerStatus {
            server_id: sanitize_name_part(&server.id),
            server_name: server.name.clone(),
            enabled: server.enabled,
            connected,
            transport: server.transport.clone(),
            permission_mode: server.permission_mode.clone(),
        });
    }
    result
}

/// Prune dead and hung connections. Closed sockets are dropped immediately;
/// idle clients that fail a short ping twice in a row are also removed.
pub async fn health_check() -> Vec<String> {
    let mut pruned = prune_closed_clients().await;

    let idle: Vec<(String, SharedMcpClient)> = {
        let guard = clients().lock().await;
        guard
            .iter()
            .filter_map(|(key, client)| match client.try_lock() {
                Ok(locked) if !locked.is_closed() => Some((key.clone(), client.clone())),
                _ => None,
            })
            .collect()
    };

    for (key, client) in idle {
        let ping_ok = {
            let Ok(locked) = client.try_lock() else {
                continue;
            };
            if locked.is_closed() {
                false
            } else {
                matches!(
                    tokio::time::timeout(
                        Duration::from_secs(3),
                        locked.send_request(ClientRequest::PingRequest(PingRequest::default())),
                    )
                    .await,
                    Ok(Ok(_))
                )
            }
        };
        if ping_ok {
            health_fails().lock().await.remove(&key);
            continue;
        }
        let fails = {
            let mut map = health_fails().lock().await;
            let entry = map.entry(key.clone()).or_insert(0);
            *entry = entry.saturating_add(1);
            *entry
        };
        if fails < 2 {
            continue;
        }
        {
            let mut guard = clients().lock().await;
            if let Some(stale) = guard.remove(&key) {
                drop(guard);
                if let Ok(mut locked) = stale.try_lock() {
                    let _ = locked.close_with_timeout(Duration::from_secs(2)).await;
                }
            }
        }
        health_fails().lock().await.remove(&key);
        let server_id = key.split('\u{1e}').next().unwrap_or(&key).to_string();
        if !pruned.contains(&server_id) {
            pruned.push(server_id);
        }
    }
    pruned
}

fn health_fails() -> &'static AsyncMutex<HashMap<String, u8>> {
    HEALTH_FAILS.get_or_init(|| AsyncMutex::new(HashMap::new()))
}

async fn prune_closed_clients() -> Vec<String> {
    let mut guard = clients().lock().await;
    let dead_keys: Vec<String> = guard
        .iter()
        .filter_map(|(key, client)| {
            let closed = client
                .try_lock()
                .map(|locked| locked.is_closed())
                .unwrap_or(false);
            if closed {
                Some(key.clone())
            } else {
                None
            }
        })
        .collect();

    let mut pruned = Vec::new();
    for key in &dead_keys {
        guard.remove(key);
        let server_id = key.split('\u{1e}').next().unwrap_or(key).to_string();
        if !pruned.contains(&server_id) {
            pruned.push(server_id);
        }
    }
    drop(guard);
    if !dead_keys.is_empty() {
        let mut fails = health_fails().lock().await;
        for key in dead_keys {
            fails.remove(&key);
        }
    }
    pruned
}

pub async fn disconnect_all() -> Result<usize, String> {
    disconnect_all_with_timeout(Duration::from_secs(2)).await
}

async fn disconnect_all_with_timeout(timeout: Duration) -> Result<usize, String> {
    let mut guard = clients().lock().await;
    let clients_to_close: Vec<_> = guard.drain().map(|(_, client)| client).collect();
    drop(guard);

    let mut closed = 0;
    for client in clients_to_close {
        let mut locked = client.lock().await;
        let _ = locked.close_with_timeout(timeout).await;
        closed += 1;
    }
    Ok(closed)
}

pub fn disconnect_all_blocking() {
    // 由退出路径调用，该线程不在 tokio runtime 上下文里：
    // 旧实现 Handle::try_current() 在此必然失败而静默 return，MCP stdio
    // 子进程退出时从不被关闭。改用一次性 current-thread runtime 阻塞执行——
    // 无论本线程是否已有 runtime 都安全（独立实例，不构成嵌套 block_on）。
    // 宿主退出时用短超时：stdio 子进程随后会被 SIGKILL，不必每人等 2s。
    let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return;
    };
    let timeout = crate::shared::child_reap_timeout();
    let _ = runtime.block_on(disconnect_all_with_timeout(timeout));
}

/** Test connection to a single server: connect, list tools, return summary.
 *  Used by the per-server "Test" button in the UI. */
pub async fn test_server(
    settings: McpSettings,
    server_id: String,
) -> Result<McpTestServerResult, String> {
    let server = find_server(&settings, &server_id)
        .ok_or_else(|| format!("MCP server not found: {server_id}"))?;
    let server_id_sanitized = sanitize_name_part(&server.id);

    if !server.enabled {
        return Ok(McpTestServerResult {
            server_id: server_id_sanitized,
            server_name: server.name.clone(),
            success: false,
            tool_count: 0,
            filtered_count: 0,
            message: "Server is disabled — enable it and configure the transport before testing.".to_string(),
        });
    }

    let result: Result<(usize, usize), String> = async {
        let client = get_or_connect_client(&server).await?;
        let client = client.lock().await;
        let tools = client
            .list_all_tools()
            .await
            .map_err(|err| format!("Failed to list tools: {err}"))?;
        let total = tools.len();
        let mut allowed = 0usize;
        for tool in &tools {
            if validate_tool_policy(&server, &tool.name).is_ok() {
                allowed += 1;
            }
        }
        Ok((total, total - allowed))
    }
    .await;

    match result {
        Ok((total, filtered)) => Ok(McpTestServerResult {
            server_id: server_id_sanitized,
            server_name: server.name.clone(),
            success: true,
            tool_count: total - filtered,
            filtered_count: filtered,
            message: format!(
                "Connected. {} tool(s) available{}",
                total - filtered,
                if filtered > 0 {
                    format!(", {filtered} filtered by policy")
                } else {
                    String::new()
                }
            ),
        }),
        Err(err) => Ok(McpTestServerResult {
            server_id: server_id_sanitized,
            server_name: server.name.clone(),
            success: false,
            tool_count: 0,
            filtered_count: 0,
            message: err,
        }),
    }
}

pub async fn preview_mcp_server(
    url: String,
    transport: String,
    timeout_seconds: Option<u64>,
) -> Result<McpPreviewResult, String> {
    let server = McpServerConfig {
        id: format!("preview_{}", url.len()),
        name: "Preview".to_string(),
        enabled: true,
        category: "custom".to_string(),
        transport,
        command: String::new(),
        args: vec![],
        url: url.clone(),
        env: HashMap::new(),
        headers: HashMap::new(),
        allowed_tools: vec![],
        denied_tools: vec![],
        force_mutating: vec![],
        force_readonly: vec![],
        permission_mode: "read-only".to_string(),
        require_confirmation: false,
        timeout_seconds,
    };

    let client = connect_client(&server).await?;
    let listed = {
        let locked = client.lock().await;
        locked
            .list_all_tools()
            .await
            .map_err(|e| format!("Failed to list tools: {e}"))
    };
    {
        let mut locked = client.lock().await;
        let _ = locked.close_with_timeout(Duration::from_secs(2)).await;
    }
    let tools = listed?;

    let previews: Vec<McpToolPreviewItem> = tools
        .iter()
        .map(|t| McpToolPreviewItem {
            name: t.name.to_string(),
            description: t
                .description
                .as_ref()
                .map(|v| v.to_string())
                .unwrap_or_default(),
            input_schema: (*t.input_schema).clone(),
        })
        .collect();

    let count = previews.len();
    Ok(McpPreviewResult {
        success: true,
        url: server.url.clone(),
        server_name: "Preview".to_string(),
        tool_count: count,
        tools: previews,
        message: format!("Found {} tools", count),
    })
}

/** Disconnect a single server by id. Returns the number of clients closed (0 or 1). */
pub async fn disconnect_server(settings: McpSettings, server_id: String) -> Result<usize, String> {
    let server = find_server_any(&settings, &server_id);
    let sanitized_id = sanitize_name_part(server.as_ref().map(|s| s.id.as_str()).unwrap_or(&server_id));
    let server_id_prefix = format!("{sanitized_id}\u{1e}");
    let exact_key = server.as_ref().map(server_cache_key);

    let mut guard = clients().lock().await;
    let keys_to_close: Vec<String> = if let Some(key) = exact_key.filter(|key| guard.contains_key(key)) {
        vec![key]
    } else {
        guard
            .keys()
            .filter(|k| k.starts_with(&server_id_prefix))
            .cloned()
            .collect()
    };
    let clients_to_close: Vec<_> = keys_to_close
        .iter()
        .filter_map(|k| guard.remove(k))
        .collect();
    drop(guard);

    let mut closed = 0;
    for client in clients_to_close {
        let mut locked = client.lock().await;
        let _ = locked.close_with_timeout(Duration::from_secs(2)).await;
        closed += 1;
    }

    Ok(closed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_server(transport: &str, url: &str, headers: &[(&str, &str)]) -> McpServerConfig {
        let mut env = HashMap::new();
        env.insert("PATH".to_string(), "/usr/bin".to_string());
        let mut hdrs = HashMap::new();
        for (k, v) in headers {
            hdrs.insert(k.to_string(), v.to_string());
        }
        McpServerConfig {
            id: "test".to_string(),
            name: "Test".to_string(),
            enabled: true,
            category: "custom".to_string(),
            transport: transport.to_string(),
            command: String::new(),
            args: vec![],
            url: url.to_string(),
            env,
            headers: hdrs,
            allowed_tools: vec![],
            denied_tools: vec![],
            force_mutating: vec![],
            force_readonly: vec![],
            permission_mode: "read-only".to_string(),
            require_confirmation: false,
            timeout_seconds: Some(60),
        }
    }

    #[test]
    fn cache_key_differs_by_transport() {
        let stdio = make_server("stdio", "", &[]);
        let sse = make_server("sse", "https://example.com/sse", &[]);
        let http = make_server("streamable-http", "https://example.com/mcp", &[]);
        let k1 = server_cache_key(&stdio);
        let k2 = server_cache_key(&sse);
        let k3 = server_cache_key(&http);
        assert_ne!(k1, k2, "stdio and sse keys must differ");
        assert_ne!(k1, k3, "stdio and http keys must differ");
        assert_ne!(k2, k3, "sse and http keys must differ");
    }

    #[test]
    fn cache_key_differs_by_url() {
        let a = make_server("sse", "https://a.com/sse", &[]);
        let b = make_server("sse", "https://b.com/sse", &[]);
        assert_ne!(server_cache_key(&a), server_cache_key(&b));
    }

    #[test]
    fn cache_key_differs_by_headers() {
        let no_headers = make_server("streamable-http", "https://example.com/mcp", &[]);
        let with_auth = make_server(
            "streamable-http",
            "https://example.com/mcp",
            &[("Authorization", "Bearer token")],
        );
        assert_ne!(server_cache_key(&no_headers), server_cache_key(&with_auth));
    }

    #[test]
    fn cache_key_same_for_identical_config() {
        let a = make_server("sse", "https://example.com/sse", &[("X-Key", "val")]);
        let b = make_server("sse", "https://example.com/sse", &[("X-Key", "val")]);
        assert_eq!(server_cache_key(&a), server_cache_key(&b));
    }

    #[test]
    fn matches_pattern_supports_prefix_suffix_exact_and_wildcard() {
        assert!(super::matches_pattern("get_*", "get_user"));
        assert!(super::matches_pattern("*_list", "user_list"));
        assert!(super::matches_pattern("get_user", "get_user"));
        assert!(super::matches_pattern("*", "anything"));
        assert!(!super::matches_pattern("get_*", "set_user"));
        assert!(!super::matches_pattern("", "anything"));
    }

    // P3：旧实现只支持前缀/后缀通配，*foo*（包含）永远匹配不上。
    #[test]
    fn matches_pattern_supports_contains_glob() {
        assert!(super::matches_pattern("*user*", "get_user_info"));
        assert!(super::matches_pattern("*user*", "user"));
        assert!(!super::matches_pattern("*user*", "get_account"));
        // ** 等价于全匹配
        assert!(super::matches_pattern("**", "anything"));
    }

    fn make_server_with(mut server: McpServerConfig, mode: &str, confirm: bool, allowed: &[&str]) -> McpServerConfig {
        server.permission_mode = mode.to_string();
        server.require_confirmation = confirm;
        server.allowed_tools = allowed.iter().map(|s| s.to_string()).collect();
        server
    }

    /// #20：read-only 模式不再整体跳过 require_confirmation——allowed_tools
    /// 显式放行的变更工具仍会执行，确认不能被跳过。
    #[tokio::test]
    async fn read_only_with_allowed_mutating_tool_still_requires_confirmation() {
        let server = make_server_with(make_server("sse", "", &[]), "read-only", true, &["write"]);
        // 变更工具（write 命中 allowed_tools 放行）+ require_confirmation +
        // 无 UI 通道 → 必须走到确认路径并报「无 UI 通道」，而不是静默放行。
        let err = call_tool(None, Some(settings_from(vec![server.clone()])), "test".into(), "write".into(), serde_json::json!({}))
            .await
            .expect_err("should require confirmation");
        assert!(
            err.contains("requires user confirmation"),
            "expected confirmation error, got: {err}"
        );
    }

    /// 对照：#20 修复后，read-only + 未放行变更工具（策略拦截）仍不需要确认。
    #[tokio::test]
    async fn read_only_with_blocked_mutating_tool_skips_confirmation() {
        let server = make_server_with(make_server("sse", "", &[]), "read-only", true, &[]);
        let err = call_tool(None, Some(settings_from(vec![server.clone()])), "test".into(), "write".into(), serde_json::json!({}))
            .await
            .expect_err("policy should block the tool");
        assert!(
            !err.contains("requires user confirmation"),
            "blocked tool must not reach confirmation: {err}"
        );
    }

    /// 对照：read-only + 只读工具不需要确认（策略本就不会拦截）。
    #[tokio::test]
    async fn read_only_with_readonly_tool_skips_confirmation() {
        let server = make_server_with(make_server("sse", "", &[]), "read-only", true, &[]);
        let err = call_tool(None, Some(settings_from(vec![server.clone()])), "test".into(), "read".into(), serde_json::json!({}))
            .await
            .expect_err("connection should fail, but not on confirmation");
        assert!(
            !err.contains("requires user confirmation"),
            "read-only tool must not require confirmation: {err}"
        );
    }

    #[test]
    fn read_only_wildcard_allow_does_not_bypass_mutating_block() {
        let star = make_server_with(make_server("sse", "", &[]), "read-only", false, &["*"]);
        let err = super::validate_tool_policy(&star, "delete_row")
            .expect_err("wildcard must not allow mutating tools in read-only");
        assert!(
            err.contains("read-only"),
            "expected read-only policy error, got: {err}"
        );
        super::validate_tool_policy(&star, "query")
            .expect("read-only tools must still be allowed under *");

        let globstar = make_server_with(make_server("sse", "", &[]), "read-only", false, &["**"]);
        super::validate_tool_policy(&globstar, "delete_row")
            .expect_err("** must not allow mutating tools in read-only");
    }

    #[test]
    fn read_only_explicit_pattern_still_allows_mutating() {
        let server = make_server_with(make_server("sse", "", &[]), "read-only", false, &["delete*"]);
        super::validate_tool_policy(&server, "delete_row")
            .expect("explicit non-catch-all pattern may allow a mutating tool");
        super::validate_tool_policy(&server, "write")
            .expect_err("unrelated mutating tools stay blocked");
    }

    #[test]
    fn truncate_json_preserves_envelope_and_truncates_text() {
        let large_text = "a".repeat(10_000);
        let input = serde_json::json!({
            "content": [{
                "type": "text",
                "text": large_text
            }],
            "isError": false
        });
        let truncated = super::truncate_json(input, 1_000);
        assert!(truncated.is_object());
        let content = truncated.get("content").and_then(|v| v.as_array()).expect("content array must exist");
        assert_eq!(content.len(), 1);
        let first = content[0].as_object().expect("first item must be object");
        assert_eq!(first.get("type").and_then(|v| v.as_str()), Some("text"));
        let text = first.get("text").and_then(|v| v.as_str()).expect("text must exist");
        assert!(text.contains("...[MCP content truncated: 10000 bytes >"));
        assert!(text.len() < 1_500);
        assert_eq!(truncated.get("truncated").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(truncated.get("isError").and_then(|v| v.as_bool()), Some(false));
    }

    #[test]
    fn truncate_json_formats_raw_value_as_envelope() {
        let raw = serde_json::json!({ "foo": "bar".repeat(5000) });
        let truncated = super::truncate_json(raw, 200);
        assert!(truncated.is_object());
        assert!(truncated.get("content").is_some());
        assert_eq!(truncated.get("truncated").and_then(|v| v.as_bool()), Some(true));
        assert!(truncated.get("isError").is_none());
    }

    #[test]
    fn truncate_json_preserves_original_is_error() {
        let raw = serde_json::json!({ "isError": true, "foo": "bar".repeat(5000) });
        let truncated = super::truncate_json(raw, 200);
        assert_eq!(truncated.get("isError").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(truncated.get("truncated").and_then(|v| v.as_bool()), Some(true));
    }

    #[test]
    fn dangerous_forces_confirmation_and_ignores_readonly_override() {
        let mut server = make_server_with(make_server("sse", "", &[]), "dangerous", false, &[]);
        assert!(super::confirmation_required(&server, "read"));
        assert!(super::confirmation_required(&server, "write"));
        server.force_readonly = vec!["write".to_string()];
        assert!(super::is_mutating_with_overrides(&server, "write"));

        let rw = make_server_with(make_server("sse", "", &[]), "read-write", false, &[]);
        assert!(!super::confirmation_required(&rw, "write"));
    }

    #[test]
    fn retryable_transport_errors_are_detected() {
        assert!(super::is_retryable_transport_error("connection reset by peer"));
        assert!(super::is_retryable_transport_error("session closed"));
        assert!(!super::is_retryable_transport_error("MCP tool is not allowed by policy: write"));
        assert!(!super::is_retryable_transport_error("invalid arguments"));
    }

    #[test]
    fn find_server_any_includes_disabled() {
        let mut server = make_server("stdio", "", &[]);
        server.enabled = false;
        let settings = settings_from(vec![server]);
        assert!(super::find_server(&settings, "test").is_none());
        assert!(super::find_server_any(&settings, "test").is_some());
    }

    fn settings_from(servers: Vec<McpServerConfig>) -> McpSettings {
        McpSettings {
            enabled: true,
            expose_tools: true,
            result_max_bytes: None,
            servers,
        }
    }
}
