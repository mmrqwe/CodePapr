use crate::rpc_client::RpcClient;
use serde_json::json;

pub async fn run(
    client: &RpcClient,
    workspace: &str,
    command: String,
    args: Vec<String>,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let res = client.call("shell/execute", json!({
        "workspacePath": workspace,
        "command": command,
        "args": if args.is_empty() { None } else { Some(args) },
    })).await?;

    if json_mode {
        println!("{}", serde_json::to_string_pretty(&res)?);
    } else {
        if let Some(stdout) = res.get("stdout").and_then(|v| v.as_str()) {
            if !stdout.is_empty() {
                print!("{stdout}");
                if !stdout.ends_with('\n') {
                    println!();
                }
            }
        }
        if let Some(stderr) = res.get("stderr").and_then(|v| v.as_str()) {
            if !stderr.is_empty() {
                eprint!("{stderr}");
                if !stderr.ends_with('\n') {
                    eprintln!();
                }
            }
        }
    }

    if let Some(status) = res.get("status").and_then(|v| v.as_i64()) {
        if status != 0 {
            std::process::exit(status as i32);
        }
    }

    Ok(())
}
