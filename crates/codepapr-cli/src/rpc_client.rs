use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: Value,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl std::fmt::Display for JsonRpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "RPC error [{}]: {}", self.code, self.message)
    }
}

impl std::error::Error for JsonRpcError {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcNotification {
    pub jsonrpc: String,
    pub method: String,
    pub params: Value,
}

pub struct RpcClient {
    tx_writer: mpsc::UnboundedSender<String>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, JsonRpcError>>>>>,
    next_id: AtomicU64,
    _child: Option<Child>,
}

impl RpcClient {
    /// Connect to a running TCP server, or auto-launch codepapr-server in stdio mode.
    pub async fn connect(
        server_addr: Option<&str>,
        workspace: Option<&str>,
        event_tx: Option<mpsc::UnboundedSender<JsonRpcNotification>>,
        verbose: bool,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        if let Some(addr) = server_addr {
            Self::connect_tcp(addr, event_tx).await
        } else if let Ok(addr) = std::env::var("CODEPAPR_SERVER_URL") {
            Self::connect_tcp(&addr, event_tx).await
        } else {
            Self::spawn_stdio(workspace, event_tx, verbose).await
        }
    }

    /// Connect to codepapr-server over TCP
    pub async fn connect_tcp(
        addr: &str,
        event_tx: Option<mpsc::UnboundedSender<JsonRpcNotification>>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let stream = TcpStream::connect(addr).await
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

        let pending = Arc::new(Mutex::new(HashMap::new()));
        let pending_clone = Arc::clone(&pending);
        let event_tx_clone = event_tx.clone();

        tokio::spawn(async move {
            let mut reader = BufReader::new(read_half).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                Self::dispatch_incoming_line(trimmed, &pending_clone, &event_tx_clone).await;
            }
        });

        Ok(Self {
            tx_writer,
            pending,
            next_id: AtomicU64::new(1),
            _child: None,
        })
    }

    /// Spawn a headless codepapr-server in stdio mode and communicate over pipes
    pub async fn spawn_stdio(
        workspace: Option<&str>,
        event_tx: Option<mpsc::UnboundedSender<JsonRpcNotification>>,
        verbose: bool,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let server_bin = find_server_binary()?;
        let mut cmd = Command::new(&server_bin);
        cmd.arg("--stdio");
        if let Some(ws) = workspace {
            cmd.arg("--workspace").arg(ws);
        }
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::piped());
        if verbose {
            cmd.stderr(std::process::Stdio::inherit());
        } else {
            cmd.stderr(std::process::Stdio::null());
        }

        let mut child = cmd.spawn()
            .map_err(|e| format!("Failed to spawn codepapr-server ({}): {e}", server_bin.display()))?;

        let stdin = child.stdin.take().ok_or("Failed to capture child stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to capture child stdout")?;

        let (tx_writer, mut rx_writer) = mpsc::unbounded_channel::<String>();
        let mut child_stdin = stdin;
        tokio::spawn(async move {
            while let Some(line) = rx_writer.recv().await {
                if child_stdin.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                let _ = child_stdin.flush().await;
            }
        });

        let pending = Arc::new(Mutex::new(HashMap::new()));
        let pending_clone = Arc::clone(&pending);
        let event_tx_clone = event_tx.clone();

        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                Self::dispatch_incoming_line(trimmed, &pending_clone, &event_tx_clone).await;
            }
        });

        Ok(Self {
            tx_writer,
            pending,
            next_id: AtomicU64::new(1),
            _child: Some(child),
        })
    }

    async fn dispatch_incoming_line(
        line: &str,
        pending: &Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, JsonRpcError>>>>>,
        event_tx: &Option<mpsc::UnboundedSender<JsonRpcNotification>>,
    ) {
        if let Ok(val) = serde_json::from_str::<Value>(line) {
            // Check if it's a notification
            if val.get("id").is_none() || val.get("id").unwrap().is_null() {
                if let Ok(notif) = serde_json::from_value::<JsonRpcNotification>(val) {
                    if let Some(tx) = event_tx {
                        let _ = tx.send(notif);
                    }
                }
                return;
            }

            // It's a response with an id
            if let Some(id_u64) = val.get("id").and_then(|v| v.as_u64()) {
                let mut guard = pending.lock().await;
                if let Some(sender) = guard.remove(&id_u64) {
                    if let Some(err_val) = val.get("error") {
                        if !err_val.is_null() {
                            let err: JsonRpcError = serde_json::from_value(err_val.clone()).unwrap_or_else(|_| {
                                JsonRpcError {
                                    code: -32603,
                                    message: err_val.to_string(),
                                    data: None,
                                }
                            });
                            let _ = sender.send(Err(err));
                            return;
                        }
                    }
                    let res = val.get("result").cloned().unwrap_or(Value::Null);
                    let _ = sender.send(Ok(res));
                }
            }
        }
    }

    /// Invoke a JSON-RPC method and await the result
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, Box<dyn std::error::Error>> {
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

        let line = format!("{}\n", serde_json::to_string(&req)?);
        self.tx_writer.send(line)
            .map_err(|_| "Failed to send request: server channel closed")?;

        let result = resp_rx.await
            .map_err(|_| "Server closed connection before responding")??;

        Ok(result)
    }
}

/// Find the codepapr-server binary in common locations
pub fn find_server_binary() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let bin_name = if cfg!(windows) {
        "codepapr-server.exe"
    } else {
        "codepapr-server"
    };

    // 1. Explicit env var
    if let Ok(env_path) = std::env::var("CODEPAPR_SERVER_BIN") {
        let p = PathBuf::from(env_path);
        if p.is_file() {
            return Ok(p);
        }
    }

    // 2. Next to the current executable
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            let candidate = parent.join(bin_name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    // 3. Current working directory / target folder
    let target_debug = Path::new("target").join("debug").join(bin_name);
    if target_debug.is_file() {
        return Ok(std::fs::canonicalize(target_debug)?);
    }
    let target_release = Path::new("target").join("release").join(bin_name);
    if target_release.is_file() {
        return Ok(std::fs::canonicalize(target_release)?);
    }

    // 4. In PATH
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
