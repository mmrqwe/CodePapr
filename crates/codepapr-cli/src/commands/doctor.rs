use crate::rpc_client::RpcClient;
use serde_json::json;
use std::path::Path;

pub async fn run(
    client: Option<&RpcClient>,
    workspace: &str,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let ws_path = Path::new(workspace);
    let ws_exists = ws_path.exists();
    let ws_is_dir = ws_path.is_dir();

    // Check server binary
    let server_bin = crate::rpc_client::find_server_binary();
    let server_bin_ok = server_bin.is_ok();
    let server_bin_path = server_bin.as_ref().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();

    // Check node runtime
    let node_check = std::process::Command::new("node").arg("--version").output();
    let (node_ok, node_version) = match node_check {
        Ok(out) if out.status.success() => {
            (true, String::from_utf8_lossy(&out.stdout).trim().to_string())
        }
        _ => (false, "Not found".to_string()),
    };

    // Check sidecar script
    let sidecar_candidates = [
        ws_path.join("packages/@codepapr/ui/dist-sidecar/agent-runtime.mjs"),
        ws_path.join("dist-sidecar/agent-runtime.mjs"),
    ];
    let sidecar_found = sidecar_candidates.iter().find(|p| p.is_file()).map(|p| p.to_string_lossy().to_string());

    // Check server RPC connectivity
    let mut server_connected = false;
    let mut server_version = "Unknown".to_string();
    let mut git_repo = false;
    let mut git_branch = "Unknown".to_string();

    if let Some(c) = client {
        if let Ok(init_res) = c.call("initialize", json!({})).await {
            server_connected = true;
            if let Some(v) = init_res.get("serverInfo").and_then(|s| s.get("version")).and_then(|v| v.as_str()) {
                server_version = v.to_string();
            }
        }

        if let Ok(git_res) = c.call("git/status", json!({"workspacePath": workspace})).await {
            git_repo = git_res.get("isRepo").and_then(|v| v.as_bool()).unwrap_or(false);
            if let Some(b) = git_res.get("branch").and_then(|v| v.as_str()) {
                git_branch = b.to_string();
            }
        }
    }

    if json_mode {
        println!("{}", serde_json::to_string_pretty(&json!({
            "workspace": {
                "path": workspace,
                "exists": ws_exists,
                "isDir": ws_is_dir,
            },
            "server": {
                "binaryFound": server_bin_ok,
                "binaryPath": server_bin_path,
                "connected": server_connected,
                "version": server_version,
            },
            "git": {
                "isRepo": git_repo,
                "branch": git_branch,
            },
            "runtime": {
                "nodeFound": node_ok,
                "nodeVersion": node_version,
                "sidecarScript": sidecar_found,
            }
        }))?);
        return Ok(());
    }

    println!("CodePapr Environment Doctor");
    println!("============================");

    // 1. Workspace
    println!("\n[Workspace]");
    println!("  Path:        {workspace}");
    println!("  Status:      {}", if ws_exists && ws_is_dir { "✓ Directory exists" } else { "✗ Invalid directory" });

    // 2. Server
    println!("\n[Host Server]");
    if server_bin_ok {
        println!("  Binary:      ✓ Found at {server_bin_path}");
    } else {
        println!("  Binary:      ✗ Not found (run `cargo build -p codepapr-server`)");
    }
    if server_connected {
        println!("  Daemon RPC:  ✓ Connected (v{server_version})");
    } else {
        println!("  Daemon RPC:  ! Offline (auto-launch on command execution)");
    }

    // 3. Git
    println!("\n[Git Repository]");
    if git_repo {
        println!("  Status:      ✓ Valid repository");
        println!("  Branch:      {git_branch}");
    } else {
        println!("  Status:      ! Not a git repository");
    }

    // 4. Node.js & Sidecar
    println!("\n[Sidecar Agent Runtime]");
    if node_ok {
        println!("  Node.js:     ✓ Found ({node_version})");
    } else {
        println!("  Node.js:     ✗ Not found in PATH");
    }
    if let Some(sc) = sidecar_found {
        println!("  Sidecar:     ✓ Found at {sc}");
    } else {
        println!("  Sidecar:     ! Not built yet (run `npm run build:sidecar --workspace=@codepapr/ui`)");
    }

    println!("\nAll critical systems checked.");
    Ok(())
}
