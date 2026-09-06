#![recursion_limit = "256"]

use clap::{Parser, Subcommand};
use rpc_client::{JsonRpcNotification, RpcClient};
use std::path::PathBuf;
use tokio::sync::mpsc;

mod commands;
mod harness;
mod rpc_client;

#[derive(Parser, Debug)]
#[command(
    name = "codepapr",
    about = "CodePapr CLI - Local-first Coding Agent & Host-Client Toolchain",
    version = codepapr_core::version()
)]
struct Cli {
    #[arg(short = 'C', long, global = true, help = "Workspace directory path")]
    workspace: Option<String>,

    #[arg(long, global = true, help = "Server address (e.g. 127.0.0.1:9090)")]
    server: Option<String>,

    #[arg(long, global = true, help = "Output machine-readable JSON")]
    json: bool,

    #[arg(short = 'v', long, global = true, help = "Verbose output")]
    verbose: bool,

    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand, Debug)]
enum Commands {
    #[command(about = "Ping the CodePapr host server")]
    Ping,

    #[command(about = "Check development environment, server, runtime, and git")]
    Doctor,

    #[command(about = "Show workspace Git status")]
    Status,

    #[command(about = "Git operations via host server")]
    Git {
        #[command(subcommand)]
        cmd: commands::git::GitSubcommand,
    },

    #[command(about = "Workspace filesystem operations")]
    Fs {
        #[command(subcommand)]
        cmd: commands::fs::FsSubcommand,
    },

    #[command(about = "Execute a command in workspace shell environment")]
    Shell {
        #[arg(help = "Command to run")]
        command: String,

        #[arg(trailing_var_arg = true, allow_hyphen_values = true, help = "Command arguments")]
        args: Vec<String>,
    },

    #[command(about = "LSP diagnostics and availability inspection")]
    Lsp {
        #[command(subcommand)]
        cmd: commands::lsp::LspSubcommand,
    },

    #[command(about = "Manage or inspect the host daemon")]
    Server {
        #[command(subcommand)]
        cmd: commands::server::ServerCommand,
    },

    #[command(
        about = "Interact with the AI Coding Agent (single prompt or interactive REPL)",
        after_help = "DEPRECATED for automation: this REPL uses a legacy bypass payload (fixed tool table, agent mode only). External harnesses must use `codepapr run`."
    )]
    Chat(commands::chat::ChatArgs),

    #[command(about = "Run one task through the desktop Agent runtime (external harness entrypoint)")]
    Run(commands::run::RunArgs),
}

fn normalize_workspace_path(path_str: String) -> String {
    if let Some(stripped) = path_str.strip_prefix(r"\\?\") {
        stripped.to_string()
    } else {
        path_str
    }
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    match main_inner().await {
        Ok(code) => code,
        Err(err) => {
            eprintln!("Error: {err}");
            std::process::ExitCode::from(1)
        }
    }
}

async fn main_inner() -> Result<std::process::ExitCode, Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    let raw_workspace = match cli.workspace {
        Some(w) => {
            let p = PathBuf::from(&w);
            std::fs::canonicalize(&p)
                .map(|c| c.to_string_lossy().to_string())
                .unwrap_or(w)
        }
        None => {
            let cur = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            std::fs::canonicalize(&cur)
                .map(|c| c.to_string_lossy().to_string())
                .unwrap_or_else(|_| cur.to_string_lossy().to_string())
        }
    };
    let workspace = normalize_workspace_path(raw_workspace);

    // Special case: start server directly
    if let Some(Commands::Server { cmd: commands::server::ServerCommand::Start { port } }) = cli.command {
        commands::server::run_start(port, Some(workspace)).await?;
        return Ok(std::process::ExitCode::SUCCESS);
    }

    // Set up notifications channel
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<JsonRpcNotification>();

    // Connect to server (or auto-spawn stdio daemon)
    let client_res = RpcClient::connect(cli.server.as_deref(), Some(&workspace), Some(event_tx), cli.verbose).await;

    // Doctor can run even if server connection failed
    if let Some(Commands::Doctor) = cli.command {
        commands::doctor::run(client_res.as_ref().ok(), &workspace, cli.json).await?;
        return Ok(std::process::ExitCode::SUCCESS);
    }

    let client = client_res?;

    match cli.command {
        Some(Commands::Ping) => {
            commands::ping::run(&client, cli.json).await?;
        }
        Some(Commands::Doctor) => unreachable!(),
        Some(Commands::Status) => {
            commands::status::run(&client, &workspace, cli.json).await?;
        }
        Some(Commands::Git { cmd }) => {
            commands::git::run(&client, &workspace, cmd, cli.json).await?;
        }
        Some(Commands::Fs { cmd }) => {
            commands::fs::run(&client, &workspace, cmd, cli.json).await?;
        }
        Some(Commands::Shell { command, args }) => {
            commands::shell::run(&client, &workspace, command, args, cli.json).await?;
        }
        Some(Commands::Lsp { cmd }) => {
            commands::lsp::run(&client, &workspace, cmd, cli.json).await?;
        }
        Some(Commands::Server { cmd: commands::server::ServerCommand::Info }) => {
            commands::server::run_info(&client, cli.json).await?;
        }
        Some(Commands::Server { cmd: commands::server::ServerCommand::Start { .. } }) => unreachable!(),
        Some(Commands::Chat(args)) => {
            commands::chat::run(&client, &workspace, args, event_rx, cli.json).await?;
        }
        Some(Commands::Run(args)) => {
            let code =
                commands::run::run(&client, &workspace, args, &mut event_rx, cli.json).await;
            return Ok(std::process::ExitCode::from(code as u8));
        }
        None => {
            // Default: start chat session
            let default_args = commands::chat::ChatArgs {
                prompt: None,
                model: None,
                provider: None,
                api_key: None,
                base_url: None,
                system_prompt: None,
                yolo: false,
                raw: false,
            };
            commands::chat::run(&client, &workspace, default_args, event_rx, cli.json).await?;
        }
    }

    Ok(std::process::ExitCode::SUCCESS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_workspace_path() {
        assert_eq!(normalize_workspace_path(r"\\?\C:\project".to_string()), r"C:\project");
        assert_eq!(normalize_workspace_path(r"C:\project".to_string()), r"C:\project");
        assert_eq!(normalize_workspace_path("/home/user/project".to_string()), "/home/user/project");
    }

    #[test]
    fn test_cli_parse_ping() {
        let cli = Cli::try_parse_from(["codepapr", "ping"]).unwrap();
        match cli.command {
            Some(Commands::Ping) => {}
            _ => panic!("Expected Ping command"),
        }
    }

    #[test]
    fn test_cli_parse_shell() {
        let cli = Cli::try_parse_from(["codepapr", "shell", "git", "status", "--short"]).unwrap();
        match cli.command {
            Some(Commands::Shell { command, args }) => {
                assert_eq!(command, "git");
                assert_eq!(args, vec!["status", "--short"]);
            }
            _ => panic!("Expected Shell command"),
        }
    }

    #[test]
    fn test_cli_parse_chat_yolo() {
        let cli = Cli::try_parse_from(["codepapr", "chat", "--yolo", "hello world"]).unwrap();
        match cli.command {
            Some(Commands::Chat(args)) => {
                assert_eq!(args.prompt, Some("hello world".to_string()));
                assert!(args.yolo);
            }
            _ => panic!("Expected Chat command"),
        }
    }

    #[test]
    fn test_cli_parse_git_branch() {
        let cli = Cli::try_parse_from(["codepapr", "git", "branch"]).unwrap();
        match cli.command {
            Some(Commands::Git { cmd: commands::git::GitSubcommand::Branch { checkout, create } }) => {
                assert_eq!(checkout, None);
                assert!(!create);
            }
            _ => panic!("Expected Git Branch command"),
        }
    }

    #[test]
    fn test_cli_parse_run_tools_preset() {
        let cli = Cli::try_parse_from(["codepapr", "run", "--tools-preset", "minimal", "hi"]).unwrap();
        match cli.command {
            Some(Commands::Run(args)) => {
                assert_eq!(args.tools_preset.as_deref(), Some("minimal"));
                assert_eq!(args.prompt.as_deref(), Some("hi"));
            }
            _ => panic!("Expected Run command"),
        }
        // Invalid preset value rejected by value_parser.
        assert!(Cli::try_parse_from(["codepapr", "run", "--tools-preset", "sandbox", "hi"]).is_err());
        // Omitted → None (saved desktop profile flows through).
        let cli = Cli::try_parse_from(["codepapr", "run", "hi"]).unwrap();
        match cli.command {
            Some(Commands::Run(args)) => assert_eq!(args.tools_preset, None),
            _ => panic!("Expected Run command"),
        }
    }
}
