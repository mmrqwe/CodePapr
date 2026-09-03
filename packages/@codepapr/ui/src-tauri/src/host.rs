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
use std::sync::atomic::{AtomicU64, Ordering};
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
    code: i64,
    message: String,
}

type PendingMap = HashMap<u64, oneshot::Sender<Result<Value, String>>>;

pub struct HostHandle {
    tx_writer: mpsc::UnboundedSender<String>,
    pending: Arc<AsyncMutex<PendingMap>>,
    next_id: AtomicU64,
    child: Mutex<Option<Child>>,
}

static GLOBAL: OnceLock<Arc<HostHandle>> = OnceLock::new();

pub fn global() -> Option<Arc<HostHandle>> {
    GLOBAL.get().cloned()
}

pub fn from_app(app: &AppHandle) -> Result<Arc<HostHandle>, String> {
    if let Some(host) = global() {
        return Ok(host);
    }
    app.try_state::<Arc<HostHandle>>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| "codepapr-server 尚未连接".to_string())
}

pub async fn call(app: &AppHandle, method: &str, params: Value) -> Result<Value, String> {
    from_app(app)?.invoke(method, params).await
}

pub fn call_blocking(method: &str, params: Value) -> Result<Value, String> {
    let host = global().ok_or_else(|| "codepapr-server 尚未连接".to_string())?;
    tauri::async_runtime::block_on(host.invoke(method, params))
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

    pub fn shutdown(&self) {
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
    let handle = if let Ok(addr) = std::env::var("CODEPAPR_SERVER_URL") {
        eprintln!("[CodePapr] host::start connect_tcp {addr}");
        connect_tcp(&addr, None, app.clone()).await?
    } else {
        eprintln!("[CodePapr] host::start spawn_and_connect");
        spawn_and_connect(app.clone()).await?
    };
    eprintln!("[CodePapr] host::start connected, sending initialize");
    let _ = handle.invoke("initialize", json!({})).await?;
    eprintln!("[CodePapr] host::start initialize ok");
    let arc = Arc::new(handle);
    let _ = GLOBAL.set(Arc::clone(&arc));
    Ok(arc)
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
    if map.is_empty() {
        return;
    }
    let _ = host.invoke("secrets/import", Value::Object(map)).await;
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

    let mut cmd = Command::new(&server_bin);
    cmd.arg("--port")
        .arg("0")
        .arg("--port-file")
        .arg(&port_file)
        .stdin(Stdio::null())
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

    eprintln!("[CodePapr] host: spawned pid={}", child.id());
    let stderr = child.stderr.take();
    let port = wait_for_bound_port(&port_file, stderr)?;
    eprintln!("[CodePapr] host: bound port {port}, connecting");
    connect_tcp(&format!("127.0.0.1:{port}"), Some(child), app).await
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
) -> Result<HostHandle, String> {
    let stream = TcpStream::connect(addr)
        .await
        .map_err(|e| format!("Failed to connect to codepapr-server at {addr}: {e}"))?;
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
    tokio::spawn(async move {
        let mut reader = BufReader::new(read_half).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            dispatch_incoming_line(trimmed, &pending_clone, &app).await;
        }
        fail_pending(&pending_clone, "codepapr-server closed the connection").await;
    });

    Ok(HostHandle {
        tx_writer,
        pending,
        next_id: AtomicU64::new(1),
        child: Mutex::new(child),
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
