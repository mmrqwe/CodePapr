use crate::rpc_client::RpcClient;
use serde_json::json;

#[derive(clap::Subcommand, Debug)]
pub enum FsSubcommand {
    #[command(about = "List files and directories in the workspace")]
    List {
        #[arg(help = "Subpath relative to workspace")]
        subpath: Option<String>,

        #[arg(short, long, help = "Maximum directory recursion depth")]
        max_depth: Option<usize>,
    },

    #[command(about = "Read text file contents with line range support")]
    Read {
        #[arg(help = "Relative path to file")]
        path: String,

        #[arg(short, long, help = "Start line (1-based)")]
        start: Option<usize>,

        #[arg(short, long, help = "End line (1-based)")]
        end: Option<usize>,

        #[arg(short, long, help = "Maximum bytes to read")]
        max_bytes: Option<usize>,
    },

    #[command(about = "Search text across workspace files")]
    Search {
        #[arg(help = "Search query / regex")]
        query: String,

        #[arg(short, long, help = "Case sensitive search")]
        case_sensitive: bool,

        #[arg(short, long, help = "Treat query as regular expression")]
        regex: bool,

        #[arg(short, long, default_value_t = 50, help = "Maximum results limit")]
        max_results: usize,
    },

    #[command(about = "Write text content to a file")]
    Write {
        #[arg(help = "Relative path to file")]
        path: String,

        #[arg(help = "Content to write (use '-' to read from standard input)")]
        content: String,
    },

    #[command(about = "Delete a file from the workspace")]
    Delete {
        #[arg(help = "Relative path to file")]
        path: String,
    },
}

pub async fn run(
    client: &RpcClient,
    workspace: &str,
    cmd: FsSubcommand,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    match cmd {
        FsSubcommand::List { subpath, max_depth } => {
            let res = client.call("fs/listFiles", json!({
                "workspacePath": workspace,
                "subPath": subpath,
                "maxDepth": max_depth,
            })).await?;

            if json_mode {
                println!("{}", serde_json::to_string_pretty(&res)?);
            } else if let Some(entries) = res.get("entries").and_then(|v| v.as_array()) {
                println!("Files ({}):", entries.len());
                for e in entries {
                    let path = e.get("path").and_then(|v| v.as_str()).unwrap_or("");
                    let is_dir = e.get("isDir").and_then(|v| v.as_bool()).unwrap_or(false);
                    let bytes = e.get("bytes").and_then(|v| v.as_u64()).unwrap_or(0);
                    let type_tag = if is_dir { "DIR " } else { "FILE" };
                    if is_dir {
                        println!("  {} {}", type_tag, path);
                    } else {
                        println!("  {} {:>8} B  {}", type_tag, bytes, path);
                    }
                }
            }
        }
        FsSubcommand::Read { path, start, end, max_bytes } => {
            let res = client.call("fs/readTextFile", json!({
                "workspacePath": workspace,
                "path": path,
                "startLine": start,
                "endLine": end,
                "maxBytes": max_bytes,
            })).await?;

            if json_mode {
                println!("{}", serde_json::to_string_pretty(&res)?);
            } else {
                let content = res.get("content").and_then(|v| v.as_str()).unwrap_or("");
                let line_count = res.get("lineCount").and_then(|v| v.as_u64());
                if let Some(lc) = line_count {
                    eprintln!("# [{path}] (total lines: {lc})");
                }
                print!("{content}");
                if !content.ends_with('\n') {
                    println!();
                }
            }
        }
        FsSubcommand::Search { query, case_sensitive, regex, max_results } => {
            let res = client.call("fs/search", json!({
                "workspacePath": workspace,
                "query": query,
                "caseSensitive": case_sensitive,
                "isRegexp": regex,
                "maxResults": max_results,
            })).await?;

            if json_mode {
                println!("{}", serde_json::to_string_pretty(&res)?);
            } else if let Some(matches) = res.get("matches").and_then(|v| v.as_array()) {
                println!("Search results for \"{query}\" ({} matches):", matches.len());
                for m in matches {
                    let file = m.get("path").and_then(|v| v.as_str()).unwrap_or("");
                    let line = m.get("lineNumber").and_then(|v| v.as_u64()).unwrap_or(0);
                    let line_content = m.get("lineContent").and_then(|v| v.as_str()).unwrap_or("").trim();
                    println!("  {file}:{line}: {line_content}");
                }
            }
        }
        FsSubcommand::Write { path, content } => {
            let text = if content == "-" {
                use std::io::Read;
                let mut buf = String::new();
                std::io::stdin().read_to_string(&mut buf)?;
                buf
            } else {
                content
            };

            let res = client.call("fs/writeTextFile", json!({
                "workspacePath": workspace,
                "path": path,
                "content": text,
            })).await?;

            if json_mode {
                println!("{}", serde_json::to_string_pretty(&res)?);
            } else {
                println!("Wrote successfully to: {path}");
            }
        }
        FsSubcommand::Delete { path } => {
            let res = client.call("fs/deleteFile", json!({
                "workspacePath": workspace,
                "path": path,
            })).await?;

            // core returns false for a missing file: report it instead of
            // printing a false "Deleted" with exit 0.
            let deleted = res.get("data").unwrap_or(&res).as_bool().unwrap_or(false);
            if !deleted {
                return Err(format!("file not found in workspace: {path}").into());
            }
            if json_mode {
                println!("{}", serde_json::to_string_pretty(&res)?);
            } else {
                println!("Deleted: {path}");
            }
        }
    }
    Ok(())
}
