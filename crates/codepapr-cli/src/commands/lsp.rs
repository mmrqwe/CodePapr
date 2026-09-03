use crate::rpc_client::RpcClient;
use serde_json::json;

#[derive(clap::Subcommand, Debug)]
pub enum LspSubcommand {
    #[command(about = "Check if a language server is available for a language")]
    Check {
        #[arg(help = "Language identifier (e.g. rust, typescript, python)")]
        language: String,
    },

    #[command(about = "Query LSP diagnostics for a language / file")]
    Diag {
        #[arg(help = "Language identifier")]
        language: String,

        #[arg(short, long, help = "Relative path to file to query diagnostics for")]
        path: Option<String>,
    },
}

pub async fn run(
    client: &RpcClient,
    workspace: &str,
    cmd: LspSubcommand,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    match cmd {
        LspSubcommand::Check { language } => {
            let res = client.call("lsp/queryAvailability", json!({
                "workspacePath": workspace,
                "languageId": language,
            })).await?;

            if json_mode {
                println!("{}", serde_json::to_string_pretty(&res)?);
            } else {
                let available = res.get("available").and_then(|v| v.as_bool()).unwrap_or(false);
                let mode = res.get("mode").and_then(|v| v.as_str()).unwrap_or("unknown");
                println!("LSP Availability for '{language}':");
                println!("  Available: {available}");
                println!("  Mode:      {mode}");
                if let Some(reason) = res.get("reason").and_then(|v| v.as_str()) {
                    println!("  Reason:    {reason}");
                }
            }
        }
        LspSubcommand::Diag { language, path } => {
            let res = client.call("lsp/diagnostics", json!({
                "workspacePath": workspace,
                "languageId": language,
                "relativePath": path,
            })).await?;

            if json_mode {
                println!("{}", serde_json::to_string_pretty(&res)?);
            } else if let Some(items) = res.get("diagnostics").and_then(|v| v.as_array()) {
                println!("Diagnostics ({}):", items.len());
                for item in items {
                    let severity = item.get("severity").and_then(|v| v.as_str()).unwrap_or("info");
                    let msg = item.get("message").and_then(|v| v.as_str()).unwrap_or("");
                    let file = item.get("file").and_then(|v| v.as_str()).unwrap_or("");
                    let line = item.get("line").and_then(|v| v.as_u64()).unwrap_or(0);
                    println!("  [{severity}] {file}:{line}: {msg}");
                }
            }
        }
    }
    Ok(())
}
