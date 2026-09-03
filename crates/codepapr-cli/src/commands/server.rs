use crate::rpc_client::RpcClient;
use serde_json::json;

#[derive(clap::Subcommand, Debug)]
pub enum ServerCommand {
    #[command(about = "Query running server capabilities and info")]
    Info,

    #[command(about = "Start the standalone codepapr-server daemon in foreground")]
    Start {
        #[arg(short, long, help = "Port to listen on (TCP mode)")]
        port: Option<u16>,
    },
}

pub async fn run_info(client: &RpcClient, json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    let res = client.call("initialize", json!({})).await?;
    if json_mode {
        println!("{}", serde_json::to_string_pretty(&res)?);
    } else {
        println!("CodePapr Server Information:");
        if let Some(info) = res.get("serverInfo") {
            println!("  Name:    {}", info.get("name").and_then(|v| v.as_str()).unwrap_or("unknown"));
            println!("  Version: {}", info.get("version").and_then(|v| v.as_str()).unwrap_or("unknown"));
        }
        if let Some(caps) = res.get("capabilities") {
            println!("  Capabilities:");
            if let Some(obj) = caps.as_object() {
                for (k, v) in obj {
                    println!("    - {k}: {v}");
                }
            }
        }
        if let Some(ws) = res.get("workspace").and_then(|v| v.as_str()) {
            println!("  Default Workspace: {ws}");
        }
    }
    Ok(())
}

pub async fn run_start(port: Option<u16>, workspace: Option<String>) -> Result<(), Box<dyn std::error::Error>> {
    let bin = crate::rpc_client::find_server_binary()?;
    let mut cmd = tokio::process::Command::new(bin);
    if let Some(p) = port {
        cmd.arg("--port").arg(p.to_string());
    } else {
        cmd.arg("--stdio");
    }
    if let Some(ws) = workspace {
        cmd.arg("--workspace").arg(ws);
    }
    cmd.stdin(std::process::Stdio::inherit());
    cmd.stdout(std::process::Stdio::inherit());
    cmd.stderr(std::process::Stdio::inherit());

    let mut child = cmd.spawn()?;
    child.wait().await?;
    Ok(())
}
