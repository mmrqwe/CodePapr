//! Thin JSON-RPC client that talks to a local `codepapr-server` over TCP.
//!
//! Desktop startup either connects to `CODEPAPR_SERVER_URL` or spawns
//! `codepapr-server --port 0` and attaches to the bound loopback port.
//! Core events arrive as JSON-RPC notifications `{ method: "event", params }`
//! and are forwarded onto the Tauri event bus.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct JsonRpcNotification {
    jsonrpc: String,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Clone, Deserialize)]
struct JsonRpcError {
    // Kept for wire-shape documentation; the reader pulls `code` straight
    // off the raw JSON (see the error branch in `handle_line`).
    #[allow(dead_code)]
    code: i64,
    message: String,
}

type PendingMap = HashMap<u64, oneshot::Sender<Result<Value, String>>>;

pub struct HostHandle {
    tx_writer: mpsc::UnboundedSender<String>,
    pending: Arc<AsyncMutex<PendingMap>>,
    next_id: AtomicU64,
    child: Mutex<Option<Child>>,
    alive: Arc<AtomicBool>,
    /// 本进程拉起的宿主。外部 `CODEPAPR_SERVER_URL` 为 false，断线后不重连。
    owned: bool,
}

static SLOT: Mutex<Option<Arc<HostHandle>>> = Mutex::new(None);
static APP: OnceLock<AppHandle> = OnceLock::new();
static RECONNECT: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static STOPPED: AtomicBool = AtomicBool::new(false);

fn current_host() -> Option<Arc<HostHandle>> {
    SLOT.lock().unwrap_or_else(|err| err.into_inner()).clone()
}

fn set_slot(host: Arc<HostHandle>) {
    *SLOT.lock().unwrap_or_else(|err| err.into_inner()) = Some(host);
}

pub fn global() -> Option<Arc<HostHandle>> {
    current_host()
}

pub fn from_app(app: &AppHandle) -> Result<Arc<HostHandle>, String> {
    if let Some(host) = current_host() {
        return Ok(host);
    }
    app.try_state::<Arc<HostHandle>>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| "codepapr-server 尚未连接".to_string())
}

pub async fn call(app: &AppHandle, method: &str, params: Value) -> Result<Value, String> {
    let host = ensure_connected(app).await?;
    match host.invoke(method, params.clone()).await {
        Err(err) if host.owned && !STOPPED.load(Ordering::SeqCst) && connection_lost(&err) => {
            let host = reconnect_owned(app).await?;
            host.invoke(method, params).await
        }
        other => other,
    }
}

pub fn call_blocking(method: &str, params: Value) -> Result<Value, String> {
    let Some(app) = APP.get() else {
        let host = current_host().ok_or_else(|| "codepapr-server 尚未连接".to_string())?;
        return tauri::async_runtime::block_on(host.invoke(method, params));
    };
    tauri::async_runtime::block_on(call(app, method, params))
}

fn connection_lost(err: &str) -> bool {
    err.contains("closed the connection")
        || err.contains("Server closed connection")
        || err.contains("server channel closed")
}

async fn ensure_connected(app: &AppHandle) -> Result<Arc<HostHandle>, String> {
    if STOPPED.load(Ordering::SeqCst) {
        return current_host()
            .filter(|host| host.alive.load(Ordering::SeqCst))
            .ok_or_else(|| "codepapr-server 正在关闭".to_string());
    }
    if let Some(host) = current_host() {
        if host.alive.load(Ordering::SeqCst) {
            return Ok(host);
        }
        if !host.owned {
            return Err("codepapr-server 连接已断开，外部宿主不会自动重连".to_string());
        }
    } else if std::env::var("CODEPAPR_SERVER_URL").is_ok() {
        return Err("codepapr-server 尚未连接".to_string());
    }
    reconnect_owned(app).await
}

async fn reconnect_owned(app: &AppHandle) -> Result<Arc<HostHandle>, String> {
    let _gate = RECONNECT.lock().await;
    if STOPPED.load(Ordering::SeqCst) {
        return Err("codepapr-server 正在关闭".to_string());
    }
    if let Some(host) = current_host() {
        if host.alive.load(Ordering::SeqCst) {
            return Ok(host);
        }
        if !host.owned {
            return Err("codepapr-server 连接已断开，外部宿主不会自动重连".to_string());
        }
        host.alive.store(false, Ordering::SeqCst);
        host.reap_child();
    }
    let mut last_err = "未知错误".to_string();
    for attempt in 0..3 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(200 * (1 << (attempt - 1)))).await;
        }
        match spawn_and_connect(app.clone()).await {
            Ok(handle) => {
                if let Err(err) = handle.invoke("initialize", json!({})).await {
                    last_err = err;
                    handle.reap_child();
                    continue;
                }
                let arc = Arc::new(handle);
                set_slot(Arc::clone(&arc));
                import_vault_secrets(app).await;
                return Ok(arc);
            }
            Err(err) => last_err = err,
        }
    }
    Err(format!("重连 codepapr-server 失败: {last_err}"))
}

impl HostHandle {
    pub async fn invoke(&self, method: &str, params: Value) -> Result<Value, String> {
        let req_id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (resp_tx, resp_rx) = oneshot::channel();
        {
            let mut guard = self.pending.lock().await;
            guard.insert(req_id, resp_tx);
        }
        let req = json!({
            "jsonrpc": "2.0",
            "id": req_id,
            "method": method,
            "params": params,
        });
        let line = format!(
            "{}\n",
            serde_json::to_string(&req).map_err(|e| e.to_string())?
        );
        self.tx_writer
            .send(line)
            .map_err(|_| "Failed to send request: server channel closed".to_string())?;
        resp_rx
            .await
            .map_err(|_| "Server closed connection before responding".to_string())?
    }

    fn reap_child(&self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(child) = child.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    pub fn shutdown(&self) {
        STOPPED.store(true, Ordering::SeqCst);
        let _ = tauri::async_runtime::block_on(self.invoke("lsp/stopAll", json!({})));
        let _ = tauri::async_runtime::block_on(self.invoke("agent/stopAll", json!({})));
        let _ = tauri::async_runtime::block_on(self.invoke("fs/stopWatcher", json!({})));
        let _ = tauri::async_runtime::block_on(self.invoke(
            "shell/stopAllBackground",
            json!({ "source": "host-exit" }),
        ));
        let _ = tauri::async_runtime::block_on(self.invoke("mcp/disconnectAll", json!({})));
        if let Ok(mut child) = self.child.lock() {
            if let Some(child) = child.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

impl Drop for HostHandle {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(child) = child.as_mut() {
                let _ = child.kill();
            }
        }
    }
}

pub async fn start(app: &AppHandle) -> Result<Arc<HostHandle>, String> {
    eprintln!("[CodePapr] host::start begin");
    let _ = APP.set(app.clone());
    if let Ok(addr) = std::env::var("CODEPAPR_SERVER_URL") {
        eprintln!("[CodePapr] host::start connect_tcp {addr}");
        codepapr_core::host_auth::ensure_loopback_addr(&addr)?;
        let token = std::env::var("CODEPAPR_AUTH_TOKEN")
            .map_err(|_| "CODEPAPR_SERVER_URL 需要同时设置 CODEPAPR_AUTH_TOKEN".to_string())?;
        let token = codepapr_core::host_auth::normalize_token(&token)?;
        let handle = connect_tcp(&addr, None, app.clone(), &token, false).await?;
        eprintln!("[CodePapr] host::start connected, sending initialize");
        handle.invoke("initialize", json!({})).await?;
        eprintln!("[CodePapr] host::start initialize ok");
        let arc = Arc::new(handle);
        set_slot(Arc::clone(&arc));
        return Ok(arc);
    }
    eprintln!("[CodePapr] host::start spawn_and_connect");
    reconnect_owned(app).await
}

pub async fn import_vault_secrets(app: &AppHandle) {
    let Ok(host) = from_app(app) else {
        return;
    };
    let secrets = app.state::<crate::vault::AppSecrets>();
    let mut map = serde_json::Map::new();
    if let Some(value) = secrets.get_secret(crate::secrets::PRIMARY_KEY_ACCOUNT) {
        map.insert("api_key".into(), Value::String(value));
    }
    if let Some(value) = secrets.get_secret(crate::secrets::MENTOR_KEY_ACCOUNT) {
        map.insert("mentor_api_key".into(), Value::String(value));
    }
    if let Some(value) = secrets.get_secret(crate::secrets::FAST_KEY_ACCOUNT) {
        map.insert("fast_api_key".into(), Value::String(value));
    }
    let imported = host.invoke("secrets/import", Value::Object(map)).await.is_ok();
    if imported {
        crate::secrets::mark_secrets_ready();
    }
}

async fn spawn_and_connect(app: AppHandle) -> Result<HostHandle, String> {
    let resource_dir = app.path().resource_dir().ok();
    eprintln!("[CodePapr] host: resource_dir={resource_dir:?}");
    let server_bin = find_server_binary(resource_dir.as_deref())?;
    eprintln!("[CodePapr] host: server_bin={}", server_bin.display());
    let port_file = std::env::temp_dir().join(format!(
        "codepapr-server-{}.port",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&port_file);
    eprintln!("[CodePapr] host: spawning");

    let token = codepapr_core::host_auth::random_token();
    let mut cmd = Command::new(&server_bin);
    cmd.arg("--port")
        .arg("0")
        .arg("--port-file")
        .arg(&port_file)
        .arg("--auth-stdin")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "Failed to spawn codepapr-server ({}): {e}",
            server_bin.display()
        )
    })?;
    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        stdin
            .write_all(token.as_bytes())
            .map_err(|err| format!("写入宿主认证令牌失败: {err}"))?;
        drop(stdin);
    } else {
        return Err("宿主进程没有标准输入，无法传递认证令牌".to_string());
    }

    eprintln!("[CodePapr] host: spawned pid={}", child.id());
    let stderr = child.stderr.take();
    let port = wait_for_bound_port(&port_file, stderr)?;
    eprintln!("[CodePapr] host: bound port {port}, connecting");
    connect_tcp(&format!("127.0.0.1:{port}"), Some(child), app, &token, true).await
}

fn wait_for_bound_port(
    port_file: &Path,
    stderr: Option<std::process::ChildStderr>,
) -> Result<u16, String> {
    let deadline = Instant::now() + Duration::from_secs(15);
    let stderr_port = Arc::new(Mutex::new(None::<u16>));
    if let Some(stderr) = stderr {
        let slot = Arc::clone(&stderr_port);
        std::thread::spawn(move || {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                if let Some(port) = parse_listen_port(&line) {
                    *slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(port);
                }
                // Keep draining until the child exits. Closing this pipe early
                // SIGPIPEs codepapr-server when it logs "client connected".
                eprintln!("{line}");
            }
        });
    }

    while Instant::now() < deadline {
        if let Ok(text) = std::fs::read_to_string(port_file) {
            if let Ok(port) = text.trim().parse::<u16>() {
                if port > 0 {
                    return Ok(port);
                }
            }
        }
        if let Some(port) = *stderr_port.lock().unwrap_or_else(|e| e.into_inner()) {
            return Ok(port);
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    Err("Timed out waiting for codepapr-server to bind a TCP port".to_string())
}

fn parse_listen_port(line: &str) -> Option<u16> {
    let marker = "[codepapr-server] listening on ";
    let rest = line.trim().strip_prefix(marker)?;
    rest.rsplit(':').next()?.parse().ok()
}

async fn connect_tcp(
    addr: &str,
    child: Option<Child>,
    app: AppHandle,
    token: &str,
    owned: bool,
) -> Result<HostHandle, String> {
    codepapr_core::host_auth::ensure_loopback_addr(addr)?;
    let mut stream = TcpStream::connect(addr)
        .await
        .map_err(|e| format!("Failed to connect to codepapr-server at {addr}: {e}"))?;
    codepapr_core::host_auth::client_handshake(&mut stream, token).await?;
    let (read_half, mut write_half) = stream.into_split();

    let (tx_writer, mut rx_writer) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        while let Some(line) = rx_writer.recv().await {
            if write_half.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            let _ = write_half.flush().await;
        }
    });

    let pending = Arc::new(AsyncMutex::new(HashMap::new()));
    let pending_clone = Arc::clone(&pending);
    let alive = Arc::new(AtomicBool::new(true));
    let alive_reader = Arc::clone(&alive);
    tokio::spawn(async move {
        let mut reader = BufReader::new(read_half).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            dispatch_incoming_line(trimmed, &pending_clone, &app).await;
        }
        alive_reader.store(false, Ordering::SeqCst);
        fail_pending(&pending_clone, "codepapr-server closed the connection").await;
    });

    Ok(HostHandle {
        tx_writer,
        pending,
        next_id: AtomicU64::new(1),
        child: Mutex::new(child),
        alive,
        owned,
    })
}

async fn fail_pending(pending: &Arc<AsyncMutex<PendingMap>>, message: &str) {
    let mut guard = pending.lock().await;
    for (_, sender) in guard.drain() {
        let _ = sender.send(Err(message.to_string()));
    }
}

async fn dispatch_incoming_line(line: &str, pending: &Arc<AsyncMutex<PendingMap>>, app: &AppHandle) {
    let Ok(val) = serde_json::from_str::<Value>(line) else {
        return;
    };
    if val.get("id").is_none() || val.get("id").is_some_and(|id| id.is_null()) {
        if let Ok(notif) = serde_json::from_value::<JsonRpcNotification>(val) {
            if notif.method == "event" {
                let event = notif
                    .params
                    .get("event")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                let payload = notif.params.get("payload").cloned().unwrap_or(Value::Null);
                if !event.is_empty() {
                    let _ = app.emit(event, payload);
                }
            }
        }
        return;
    }
    let Some(id_u64) = val.get("id").and_then(|v| v.as_u64()) else {
        return;
    };
    let mut guard = pending.lock().await;
    let Some(sender) = guard.remove(&id_u64) else {
        return;
    };
    if let Some(err_val) = val.get("error") {
        if !err_val.is_null() {
            let message = serde_json::from_value::<JsonRpcError>(err_val.clone())
                .map(|err| err.message)
                .unwrap_or_else(|_| err_val.to_string());
            let _ = sender.send(Err(format!("RPC error [{}]: {message}", err_val.get("code").and_then(|c| c.as_i64()).unwrap_or(-32603))));
            return;
        }
    }
    let _ = sender.send(Ok(val.get("result").cloned().unwrap_or(Value::Null)));
}

fn find_server_binary(resource_dir: Option<&Path>) -> Result<PathBuf, String> {
    let bin_name = if cfg!(windows) {
        "codepapr-server.exe"
    } else {
        "codepapr-server"
    };

    if let Ok(env_path) = std::env::var("CODEPAPR_SERVER_BIN") {
        let p = PathBuf::from(env_path);
        if p.is_file() {
            return Ok(p);
        }
    }

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            let candidate = parent.join(bin_name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    if let Some(resource) = resource_dir {
        let candidate = resource.join(bin_name);
        if candidate.is_file() {
            return Ok(candidate);
        }
        let sidecar = resource.join("bin").join(bin_name);
        if sidecar.is_file() {
            return Ok(sidecar);
        }
        let nested = resource.join("_up_").join(bin_name);
        if nested.is_file() {
            return Ok(nested);
        }
    }

    for folder in ["debug", "release"] {
        let candidate = Path::new("target").join(folder).join(bin_name);
        if candidate.is_file() {
            return std::fs::canonicalize(candidate).map_err(|e| e.to_string());
        }
        let candidate = Path::new("../../../../target").join(folder).join(bin_name);
        if candidate.is_file() {
            return std::fs::canonicalize(candidate).map_err(|e| e.to_string());
        }
    }

    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(bin_name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    Err("Could not locate `codepapr-server` binary. Build it with `cargo build -p codepapr-server` or set CODEPAPR_SERVER_BIN.".into())
}
