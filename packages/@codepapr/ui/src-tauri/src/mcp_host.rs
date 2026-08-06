use rmcp::{
    model::CallToolRequestParams,
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
use tauri::{AppHandle, Emitter};
use tokio::{process::Command, sync::Mutex as AsyncMutex};
use futures_util::future::join_all;

const DEFAULT_RESULT_MAX_BYTES: usize = 200_000;

type McpRunningClient = RunningService<RoleClient, ()>;
type SharedMcpClient = Arc<AsyncMutex<McpRunningClient>>;

static MCP_CLIENTS: OnceLock<AsyncMutex<HashMap<String, SharedMcpClient>>> = OnceLock::new();
static EXPANDED_PATH_CACHE: OnceLock<String> = OnceLock::new();
static PENDING_CONFIRMATIONS: OnceLock<AsyncMutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>> = OnceLock::new();
static STORED_SETTINGS: OnceLock<AsyncMutex<Option<McpSettings>>> = OnceLock::new();

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
    if server.force_readonly.iter().any(|p| matches_pattern(p, tool_name)) {
        return false;
    }
    if server.force_mutating.iter().any(|p| matches_pattern(p, tool_name)) {
        return true;
    }
    looks_mutating_tool(tool_name)
}

fn validate_tool_policy(server: &McpServerConfig, tool_name: &str) -> Result<(), String> {
    if !is_tool_allowed(server, tool_name) {
        return Err(format!("MCP tool is not allowed by policy: {tool_name}"));
    }
    if server.permission_mode == "read-only" && is_mutating_with_overrides(server, tool_name) {
        if server.allowed_tools.iter().any(|p| matches_pattern(p, tool_name)) {
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
    settings
        .servers
        .iter()
        .find(|server| server.enabled && server.id == server_id)
        .or_else(|| {
            let sanitized = sanitize_name_part(server_id);
            settings
                .servers
                .iter()
                .find(|server| server.enabled && sanitize_name_part(&server.id) == sanitized)
        })
        .cloned()
}

async fn connect_client(server: &McpServerConfig) -> Result<SharedMcpClient, String> {
    let timeout = Duration::from_secs(server.timeout_seconds.unwrap_or(60).clamp(5, 600));
    match server.transport.as_str() {
        "stdio" => connect_stdio(server, timeout).await,
        "sse" | "streamable-http" => connect_http(server, timeout).await,
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
    {
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
        if let Some(client) = guard.get(&key).cloned() {
            let closed = client.lock().await.is_closed();
            if !closed {
                return Ok(client);
            }
            guard.remove(&key);
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

fn truncate_json(value: Value, max_bytes: usize) -> Value {
    let text = match serde_json::to_string(&value) {
        Ok(text) => text,
        Err(_) => return value,
    };
    if text.len() <= max_bytes {
        return value;
    }

    let end = text
        .char_indices()
        .map(|(index, _)| index)
        .take_while(|index| *index <= max_bytes)
        .last()
        .unwrap_or(0);
    Value::String(format!(
        "{}\n...[MCP result truncated: {} bytes > {} bytes]",
        &text[..end],
        text.len(),
        max_bytes,
    ))
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

    let futures = enabled_servers.iter().map(|server| {
        let server = server.clone();
        async move {
            let server_id = sanitize_name_part(&server.id);
            let result = async {
                let client = get_or_connect_client(&server).await?;
                let client = client.lock().await;
                client
                    .list_all_tools()
                    .await
                    .map_err(|err| format!("Failed to list tools: {err}"))
            }
            .await;
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
    app: Option<AppHandle>,
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

    if server.require_confirmation && server.permission_mode != "read-only" {
        // Fail-closed：没有 UI 通道就无法向用户要确认。旧实现在 app 为 None
        // 时直接跳过确认执行，会把需要确认的工具放行。
        let Some(app_handle) = &app else {
            return Err(format!(
                "MCP tool '{tool_name}' on server '{}' requires user confirmation, but no UI channel is available",
                server.name
            ));
        };
        let request_id = format!("mcp_{}_{}", sanitize_name_part(&server_id), uuid_v4());
        let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
        pending_confirmations().lock().await.insert(request_id.clone(), tx);

        let _ = app_handle.emit(
            "mcp-confirm-request",
            McpConfirmRequest {
                request_id: request_id.clone(),
                server_id: sanitize_name_part(&server_id),
                server_name: server.name.clone(),
                tool_name: tool_name.clone(),
                arguments: arguments.clone(),
            },
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
    let client = get_or_connect_client(&server).await?;
    let client = client.lock().await;
    let result = tokio::time::timeout(
        timeout,
        client.call_tool(CallToolRequestParams::new(tool_name.clone()).with_arguments(args_object)),
    )
    .await
    .map_err(|_| format!("Timed out calling MCP tool '{tool_name}'"))?
    .map_err(|err| format!("Failed to call MCP tool: {err}"))?;
    let value = serde_json::to_value(result)
        .map_err(|err| format!("Failed to encode MCP result: {err}"))?;

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

/// Prune dead connections and return the list of server ids that were removed.
pub async fn health_check() -> Vec<String> {
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
    for key in dead_keys {
        guard.remove(&key);
        let server_id = key.split('\u{1e}').next().unwrap_or(&key).to_string();
        if !pruned.contains(&server_id) {
            pruned.push(server_id);
        }
    }
    pruned
}

pub async fn disconnect_all() -> Result<usize, String> {
    let mut guard = clients().lock().await;
    let clients_to_close: Vec<_> = guard.drain().map(|(_, client)| client).collect();
    drop(guard);

    let mut closed = 0;
    for client in clients_to_close {
        let mut locked = client.lock().await;
        let _ = locked.close_with_timeout(Duration::from_secs(2)).await;
        closed += 1;
    }
    Ok(closed)
}

pub fn disconnect_all_blocking() {
    // 由主线程的窗口关闭回调调用，该线程不在 tokio runtime 上下文里：
    // 旧实现 Handle::try_current() 在此必然失败而静默 return，MCP stdio
    // 子进程退出时从不被关闭。改用一次性 current-thread runtime 阻塞执行——
    // 无论本线程是否已有 runtime 都安全（独立实例，不构成嵌套 block_on）。
    let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return;
    };
    let _ = runtime.block_on(disconnect_all());
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
    let client = client.lock().await;
    let tools = client
        .list_all_tools()
        .await
        .map_err(|e| format!("Failed to list tools: {e}"))?;

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
    let server = find_server(&settings, &server_id)
        .ok_or_else(|| format!("MCP server not found: {server_id}"))?;
    let key = server_cache_key(&server);
    let server_id_prefix = format!("{}\u{1e}", sanitize_name_part(&server.id));

    let mut guard = clients().lock().await;
    // Match by exact key first, fall back to any client whose key starts with this server id (handles stale configs).
    let keys_to_close: Vec<String> = if guard.contains_key(&key) {
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
}
