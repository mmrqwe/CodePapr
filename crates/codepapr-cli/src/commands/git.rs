use crate::rpc_client::RpcClient;
use serde_json::json;

#[derive(clap::Subcommand, Debug)]
pub enum GitSubcommand {
    #[command(about = "Show repository status")]
    Status,

    #[command(about = "Show git diff")]
    Diff {
        #[arg(long, help = "Show staged diff")]
        staged: bool,

        #[arg(help = "Path specifications to filter diff")]
        pathspecs: Vec<String>,
    },

    #[command(about = "Stage files for commit")]
    Stage {
        #[arg(short, long, help = "Stage all modified and untracked files")]
        all: bool,

        #[arg(help = "Files to stage")]
        pathspecs: Vec<String>,
    },

    #[command(about = "Commit staged changes")]
    Commit {
        #[arg(short, long, help = "Commit message")]
        message: String,

        #[arg(short = 'a', long = "all", help = "Automatically stage files that have been modified and deleted")]
        stage_all: bool,

        #[arg(long, help = "Allow an empty commit")]
        allow_empty: bool,

        #[arg(help = "Specific files to commit")]
        pathspecs: Vec<String>,
    },

    #[command(about = "List or checkout branches")]
    Branch {
        #[arg(short, long, help = "Checkout branch name")]
        checkout: Option<String>,

        #[arg(long, help = "Create new branch when checking out")]
        create: bool,
    },
}

pub async fn run(
    client: &RpcClient,
    workspace: &str,
    cmd: GitSubcommand,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    match cmd {
        GitSubcommand::Status => {
            crate::commands::status::run(client, workspace, json_mode).await?;
        }
        GitSubcommand::Diff { staged, pathspecs } => {
            let res = client.call("git/diff", json!({
                "workspacePath": workspace,
                "staged": staged,
                "pathspecs": if pathspecs.is_empty() { None } else { Some(pathspecs) },
            })).await?;

            if json_mode {
                println!("{}", serde_json::to_string_pretty(&res)?);
            } else {
                let diff_text = res.get("diff").and_then(|v| v.as_str()).unwrap_or("");
                if diff_text.is_empty() {
                    println!("No differences found.");
                } else {
                    println!("{diff_text}");
                }
            }
        }
        GitSubcommand::Stage { all, pathspecs } => {
            let res = client.call("git/stage", json!({
                "workspacePath": workspace,
                "all": all,
                "pathspecs": if pathspecs.is_empty() { None } else { Some(pathspecs) },
            })).await?;

            if json_mode {
                println!("{}", serde_json::to_string_pretty(&res)?);
            } else {
                let success = res.get("success").and_then(|v| v.as_bool()).unwrap_or(true);
                if success {
                    println!("Files staged successfully.");
                } else if let Some(msg) = res.get("message").and_then(|v| v.as_str()) {
                    println!("Stage warning: {msg}");
                }
            }
        }
        GitSubcommand::Commit { message, stage_all, allow_empty, pathspecs } => {
            let res = client.call("git/commit", json!({
                "workspacePath": workspace,
                "message": message,
                "stageAll": stage_all,
                "allowEmpty": allow_empty,
                "pathspecs": if pathspecs.is_empty() { None } else { Some(pathspecs) },
            })).await?;

            if json_mode {
                println!("{}", serde_json::to_string_pretty(&res)?);
            } else {
                let commit_id = res.get("commitId").and_then(|v| v.as_str()).unwrap_or("unknown");
                println!("Committed successfully: [{commit_id}] {message}");
            }
        }
        GitSubcommand::Branch { checkout, create } => {
            if let Some(branch_name) = checkout {
                let res = client.call("git/branchCheckout", json!({
                    "workspacePath": workspace,
                    "branchName": branch_name,
                    "create": create,
                })).await?;

                if json_mode {
                    println!("{}", serde_json::to_string_pretty(&res)?);
                } else {
                    println!("Checked out branch: {branch_name}");
                }
            } else {
                let res = client.call("git/branchList", json!({
                    "workspacePath": workspace,
                })).await?;

                if json_mode {
                    println!("{}", serde_json::to_string_pretty(&res)?);
                } else {
                    let branches = if let Some(arr) = res.as_array() {
                        Some(arr)
                    } else {
                        res.get("branches").and_then(|v| v.as_array())
                    };

                    if let Some(branches) = branches {
                        println!("Branches:");
                        for b in branches {
                            let name = b.get("name").and_then(|v| v.as_str()).unwrap_or("");
                            let is_current = b.get("isCurrent")
                                .or_else(|| b.get("current"))
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false);
                            let is_remote = b.get("isRemote").and_then(|v| v.as_bool()).unwrap_or(false);
                            let prefix = if is_current { "* " } else { "  " };
                            let kind = if is_remote { " [remote]" } else { "" };
                            println!("{prefix}{name}{kind}");
                        }
                    }
                }
            }
        }
    }
    Ok(())
}
