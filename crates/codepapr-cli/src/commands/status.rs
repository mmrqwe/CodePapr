use crate::rpc_client::RpcClient;
use serde_json::json;

pub async fn run(client: &RpcClient, workspace: &str, json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    let res = client.call("git/status", json!({
        "workspacePath": workspace,
    })).await?;

    if json_mode {
        println!("{}", serde_json::to_string_pretty(&res)?);
        return Ok(());
    }

    let is_repo = res.get("isRepo").and_then(|v| v.as_bool()).unwrap_or(false);
    if !is_repo {
        println!("Workspace is not a Git repository: {workspace}");
        if let Some(msg) = res.get("message").and_then(|v| v.as_str()) {
            println!("Note: {msg}");
        }
        return Ok(());
    }

    let branch = res.get("branch").and_then(|v| v.as_str()).unwrap_or("detached");
    let head = res.get("headShort").and_then(|v| v.as_str()).unwrap_or("unknown");

    println!("Branch: {branch} (HEAD: {head})");
    println!("Workspace: {workspace}\n");

    if let Some(entries) = res.get("entries").and_then(|v| v.as_array()) {
        if entries.is_empty() {
            println!("Working tree clean - no staged or unstaged changes.");
        } else {
            println!("Changes ({}):", entries.len());
            for entry in entries {
                let path = entry.get("path").and_then(|v| v.as_str()).unwrap_or("");
                let staged = entry.get("staged").and_then(|v| v.as_bool()).unwrap_or(false);
                let status_str = entry.get("status").and_then(|v| v.as_str()).unwrap_or("modified");
                let staged_tag = if staged { "[staged]" } else { "        " };
                println!("  {} {:10} {}", staged_tag, status_str, path);
            }
        }
    }

    Ok(())
}
