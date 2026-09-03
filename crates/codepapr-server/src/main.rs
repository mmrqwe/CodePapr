mod handler;
mod rpc;

use std::sync::Arc;
use clap::Parser;
use codepapr_core::events::EventSink;
use rpc::{JsonRpcNotification, JsonRpcRequest, JsonRpcResponse};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

#[derive(Parser, Debug)]
#[command(name = "codepapr-server", about = "CodePapr Host Server / Daemon")]
struct Cli {
    /// Workspace root directory
    #[arg(short = 'C', long)]
    workspace: Option<String>,

    /// Run in stdio mode (default if no port specified)
    #[arg(long, default_value_t = true)]
    stdio: bool,

    /// Listen port for TCP (JSON-RPC over TCP)
    #[arg(short, long)]
    port: Option<u16>,
}

struct ChannelEventSink {
    tx: tokio::sync::mpsc::UnboundedSender<String>,
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

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    let workspace = cli.workspace.map(|ws| {
        let p = std::path::PathBuf::from(&ws);
        std::fs::canonicalize(&p)
            .map(|c| c.to_string_lossy().to_string())
            .unwrap_or(ws)
    });

    if let Some(port) = cli.port {
        run_tcp_server(port, workspace).await?;
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

async fn run_tcp_server(port: u16, workspace: Option<String>) -> Result<(), Box<dyn std::error::Error>> {
    let listener = TcpListener::bind(("127.0.0.1", port)).await?;
    eprintln!("[codepapr-server] listening on 127.0.0.1:{port}");

    loop {
        let (socket, addr) = listener.accept().await?;
        eprintln!("[codepapr-server] client connected: {addr}");
        let ws = workspace.clone();

        tokio::spawn(async move {
            let (read_half, mut write_half) = socket.into_split();
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();

            // Writer task
            tokio::spawn(async move {
                while let Some(line) = rx.recv().await {
                    if write_half.write_all(line.as_bytes()).await.is_err() {
                        break;
                    }
                    let _ = write_half.flush().await;
                }
            });

            let sink = Arc::new(ChannelEventSink { tx: tx.clone() });
            let ctx = Arc::new(handler::ServerContext::new(ws, sink));
            let mut reader = BufReader::new(read_half).lines();

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
        });
    }
}
