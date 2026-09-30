mod handler;
mod rpc;
mod tasks;

use std::sync::{Arc, Mutex};
use clap::Parser;
use codepapr_core::events::EventSink;
use rpc::{JsonRpcNotification, JsonRpcRequest, JsonRpcResponse};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::mpsc::UnboundedSender;

#[derive(Parser, Debug)]
#[command(name = "codepapr-server", about = "CodePapr Host Server / Daemon")]
struct Cli {
    /// Workspace root directory
    #[arg(short = 'C', long)]
    workspace: Option<String>,

    /// Run in stdio mode (default if no port specified)
    #[arg(long, default_value_t = true)]
    stdio: bool,

    /// Listen port for TCP (JSON-RPC over TCP). Use 0 to bind an ephemeral port.
    #[arg(short, long)]
    port: Option<u16>,

    /// Write the bound TCP port to this file (for desktop/CLI discovery)
    #[arg(long)]
    port_file: Option<String>,

    /// Read the TCP auth token from stdin until EOF. Used by the desktop
    /// parent so the token is not placed on the command line or in a file.
    #[arg(long, default_value_t = false)]
    auth_stdin: bool,

    /// Read the TCP auth token from this file (mode 0600). Manual / CLI use.
    #[arg(long)]
    auth_token_file: Option<String>,
}

struct ChannelEventSink {
    tx: UnboundedSender<String>,
}

impl EventSink for ChannelEventSink {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        let notif = JsonRpcNotification::new(
            "event",
            serde_json::json!({
                "event": event,
                "payload": payload,
            }),
        );
        if let Ok(line) = serde_json::to_string(&notif) {
            let _ = self.tx.send(format!("{line}\n"));
        }
    }
}

/// Fans core events out to every connected TCP client (and stdio).
struct BroadcastEventSink {
    clients: Arc<Mutex<Vec<UnboundedSender<String>>>>,
}

impl EventSink for BroadcastEventSink {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        let notif = JsonRpcNotification::new(
            "event",
            serde_json::json!({
                "event": event,
                "payload": payload,
            }),
        );
        let Ok(line) = serde_json::to_string(&notif) else {
            return;
        };
        let msg = format!("{line}\n");
        let mut clients = match self.clients.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        clients.retain(|tx| tx.send(msg.clone()).is_ok());
    }
}

fn normalize_workspace_path(ws: String) -> String {
    let p = std::path::PathBuf::from(&ws);
    let s = std::fs::canonicalize(&p)
        .map(|c| c.to_string_lossy().to_string())
        .unwrap_or(ws);
    if let Some(stripped) = s.strip_prefix(r"\\?\") {
        stripped.to_string()
    } else {
        s
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    let workspace = cli.workspace.clone().map(normalize_workspace_path);

    if let Some(port) = cli.port {
        let token = load_tcp_token(&cli).map_err(|err| {
            std::io::Error::new(std::io::ErrorKind::Other, err)
        })?;
        run_tcp_server(port, workspace, cli.port_file, token).await?;
    } else {
        run_stdio_server(workspace).await?;
    }

    Ok(())
}

async fn run_stdio_server(workspace: Option<String>) -> Result<(), Box<dyn std::error::Error>> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    let writer_handle = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(line) = rx.recv().await {
            let _ = stdout.write_all(line.as_bytes()).await;
            let _ = stdout.flush().await;
        }
    });

    let sink = Arc::new(ChannelEventSink { tx: tx.clone() });
    codepapr_core::symbol_provider::register_default_providers();
    let ctx = Arc::new(handler::ServerContext::new(workspace, sink.clone()));

    let stdin = tokio::io::stdin();
    let mut reader = BufReader::new(stdin).lines();
    let mut tasks = tokio::task::JoinSet::new();

    while let Ok(Some(line)) = reader.next_line().await {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let req: JsonRpcRequest = match serde_json::from_str(trimmed) {
            Ok(req) => req,
            Err(err) => {
                let resp = JsonRpcResponse::error(
                    serde_json::Value::Null,
                    -32700,
                    format!("Parse error: {err}"),
                );
                if let Ok(json) = serde_json::to_string(&resp) {
                    let _ = tx.send(format!("{json}\n"));
                }
                continue;
            }
        };

        let req_id = req.id.clone().unwrap_or(serde_json::Value::Null);
        let ctx = Arc::clone(&ctx);
        let tx = tx.clone();

        tasks.spawn(async move {
            let resp = match handler::handle_request(&ctx, &req.method, req.params).await {
                Ok(result) => JsonRpcResponse::success(req_id, result),
                Err(err_msg) => JsonRpcResponse::error(req_id, -32603, err_msg),
            };
            if let Ok(json) = serde_json::to_string(&resp) {
                let _ = tx.send(format!("{json}\n"));
            }
        });
    }

    while tasks.join_next().await.is_some() {}

    drop(tx);
    drop(sink);
    drop(ctx);
    let _ = writer_handle.await;

    Ok(())
}

fn load_tcp_token(cli: &Cli) -> Result<String, String> {
    if cli.auth_stdin {
        return Ok(codepapr_core::host_auth::read_stdin_token()?);
    }
    if let Some(path) = &cli.auth_token_file {
        return Ok(codepapr_core::host_auth::read_token_file(std::path::Path::new(path))?);
    }
    let token = codepapr_core::host_auth::random_token();
    let path = match &cli.port_file {
        Some(port_file) => format!("{port_file}.auth"),
        None => std::env::temp_dir()
            .join(format!("codepapr-server-{}.auth", std::process::id()))
            .display()
            .to_string(),
    };
    codepapr_core::host_auth::write_token_file(std::path::Path::new(&path), &token)?;
    eprintln!("[codepapr-server] auth token written to {path}");
    Ok(token)
}

fn write_port_file(path: &str, port: u16) -> std::io::Result<()> {
    codepapr_core::host_auth::write_token_file(std::path::Path::new(path), &port.to_string())
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::Other, err))
}

async fn run_tcp_server(
    port: u16,
    workspace: Option<String>,
    port_file: Option<String>,
    token: String,
) -> Result<(), Box<dyn std::error::Error>> {
    let listener = TcpListener::bind(("127.0.0.1", port)).await?;
    let bound = listener.local_addr()?;
    eprintln!("[codepapr-server] listening on {bound}");
    if let Some(path) = port_file {
        write_port_file(&path, bound.port())?;
    }

    let clients: Arc<Mutex<Vec<UnboundedSender<String>>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::new(BroadcastEventSink {
        clients: Arc::clone(&clients),
    });
    codepapr_core::symbol_provider::register_default_providers();
    let ctx = Arc::new(handler::ServerContext::new(workspace, sink));
    let token = Arc::new(token);

    loop {
        let (socket, addr) = listener.accept().await?;
        eprintln!("[codepapr-server] client connected: {addr}");
        let ctx = Arc::clone(&ctx);
        let clients = Arc::clone(&clients);
        let token = Arc::clone(&token);

        tokio::spawn(async move {
            if let Err(err) = serve_tcp_client(socket, ctx, clients, token).await {
                eprintln!("[codepapr-server] client closed: {err}");
            }
        });
    }
}

async fn serve_tcp_client(
    socket: tokio::net::TcpStream,
    ctx: Arc<handler::ServerContext>,
    clients: Arc<Mutex<Vec<UnboundedSender<String>>>>,
    token: Arc<String>,
) -> Result<(), String> {
    let (read_half, mut write_half) = socket.into_split();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if write_half.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            let _ = write_half.flush().await;
        }
    });

    let server_nonce = codepapr_core::host_auth::new_nonce();
    if tx
        .send(codepapr_core::host_auth::challenge_line(&server_nonce))
        .is_err()
    {
        return Err("写入认证挑战失败".to_string());
    }

    let mut reader = BufReader::new(read_half);
    let mut line = String::new();
    let first = tokio::time::timeout(std::time::Duration::from_secs(5), reader.read_line(&mut line))
        .await
        .map_err(|_| "认证超时".to_string())?
        .map_err(|err| format!("读取认证请求失败: {err}"))?;
    if first == 0 {
        return Err("客户端在认证前断开".to_string());
    }
    match codepapr_core::host_auth::accept_client_auth(&token, &server_nonce, &line) {
        Ok((id, proof)) => {
            let resp = JsonRpcResponse::success(
                id,
                serde_json::json!({ "serverProof": proof }),
            );
            if let Ok(json) = serde_json::to_string(&resp) {
                let _ = tx.send(format!("{json}\n"));
            }
        }
        Err(err) => {
            let resp = JsonRpcResponse::error(serde_json::Value::from(0), -32001, err.clone());
            if let Ok(json) = serde_json::to_string(&resp) {
                let _ = tx.send(format!("{json}\n"));
            }
            return Err(err);
        }
    }

    if let Ok(mut guard) = clients.lock() {
        guard.push(tx.clone());
    }

    loop {
        line.clear();
        let n = reader
            .read_line(&mut line)
            .await
            .map_err(|err| format!("读取请求失败: {err}"))?;
        if n == 0 {
            return Ok(());
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let req: JsonRpcRequest = match serde_json::from_str(trimmed) {
            Ok(req) => req,
            Err(err) => {
                let resp = JsonRpcResponse::error(
                    serde_json::Value::Null,
                    -32700,
                    format!("Parse error: {err}"),
                );
                if let Ok(json) = serde_json::to_string(&resp) {
                    let _ = tx.send(format!("{json}\n"));
                }
                continue;
            }
        };
        if req.method == "auth" {
            let resp = JsonRpcResponse::error(
                req.id.clone().unwrap_or(serde_json::Value::Null),
                -32001,
                "连接已经认证".to_string(),
            );
            if let Ok(json) = serde_json::to_string(&resp) {
                let _ = tx.send(format!("{json}\n"));
            }
            continue;
        }

        let req_id = req.id.clone().unwrap_or(serde_json::Value::Null);
        let ctx = Arc::clone(&ctx);
        let tx = tx.clone();
        tokio::spawn(async move {
            let resp = match handler::handle_request(&ctx, &req.method, req.params).await {
                Ok(result) => JsonRpcResponse::success(req_id, result),
                Err(err_msg) => JsonRpcResponse::error(req_id, -32603, err_msg),
            };
            if let Ok(json) = serde_json::to_string(&resp) {
                let _ = tx.send(format!("{json}\n"));
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::run_tcp_server;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

    async fn wait_port(path: &std::path::Path) -> u16 {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if let Ok(text) = std::fs::read_to_string(path) {
                if let Ok(port) = text.trim().parse::<u16>() {
                    if port > 0 {
                        return port;
                    }
                }
            }
            if std::time::Instant::now() > deadline {
                panic!("timed out waiting for {}", path.display());
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }

    #[tokio::test]
    async fn tcp_requires_auth_then_answers_ping() {
        let dir = std::env::temp_dir().join(format!(
            "codepapr-auth-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let port_file = dir.join("server.port");
        let token = codepapr_core::host_auth::random_token();
        let port_file_arg = port_file.display().to_string();
        let server_token = token.clone();
        tokio::spawn(async move {
            let _ = run_tcp_server(
                0,
                None,
                Some(port_file_arg),
                server_token,
            )
            .await;
        });
        let port = wait_port(&port_file).await;

        let mut bad = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        let rejected = codepapr_core::host_auth::client_handshake(&mut bad, &"x".repeat(64)).await;
        assert!(rejected.is_err(), "wrong token must fail: {rejected:?}");

        let mut good = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        codepapr_core::host_auth::client_handshake(&mut good, &token)
            .await
            .expect("matching token");
        good.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\",\"params\":{}}\n")
            .await
            .unwrap();
        let mut reader = tokio::io::BufReader::new(good);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        assert!(line.contains("pong"), "ping after auth: {line}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
