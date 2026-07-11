use crate::shared::{
    canonical_workspace, expanded_path, normalize_workspace_filter, parse_browser_url,
    run_blocking_workspace_task, truncate_utf8, unix_millis,
};
use crate::shell::types::{
    BackgroundCommandResult, BackgroundProcessEntry, CommandResult, ManagedBackgroundProcess,
    StopAllBackgroundProcessesResult, StopBackgroundProcessResult,
};
use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::{BufRead, BufReader, Read},
    path::Path,
    process::{Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

pub(crate) const MAX_COMMAND_SECONDS: u64 = 600;
pub(crate) const MAX_OUTPUT_BYTES: usize = 200_000;
const MAX_BACKGROUND_LOG_LINES: usize = 48;
pub(crate) const BLOCKED_COMMANDS: &[&str] = &[
    "bash",
    "sh",
    "zsh",
    "fish",
    "cmd",
    "cmd.exe",
    "powershell",
    "powershell.exe",
    "pwsh",
    "sudo",
    "su",
    "doas",
    "login",
    "ssh",
    "scp",
    "sftp",
    "osascript",
];
const SHELL_SCRIPT_EXTENSIONS: [&str; 6] = [".sh", ".bash", ".zsh", ".command", ".ksh", ".fish"];

pub(crate) static BACKGROUND_PROCESSES: OnceLock<Mutex<HashMap<u32, ManagedBackgroundProcess>>> =
    OnceLock::new();

pub(crate) fn background_processes() -> &'static Mutex<HashMap<u32, ManagedBackgroundProcess>> {
    BACKGROUND_PROCESSES.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn cleanup_finished_background_processes(
    processes: &mut HashMap<u32, ManagedBackgroundProcess>,
) {
    let finished_pids: Vec<u32> = processes
        .iter_mut()
        .filter_map(|(pid, process)| match process.child.try_wait() {
            Ok(Some(_)) => Some(*pid),
            Ok(None) => None,
            Err(_) => Some(*pid),
        })
        .collect();

    for pid in finished_pids {
        processes.remove(&pid);
    }
}

pub(crate) fn with_background_processes<T>(
    handler: impl FnOnce(&mut HashMap<u32, ManagedBackgroundProcess>) -> Result<T, String>,
) -> Result<T, String> {
    let mut processes = background_processes()
        .lock()
        .map_err(|_| "后台进程注册表锁定失败".to_string())?;
    cleanup_finished_background_processes(&mut processes);
    handler(&mut processes)
}

fn append_output_line(tail: &Arc<Mutex<VecDeque<String>>>, line: String, max_lines: usize) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }

    let truncated: String = trimmed.chars().take(400).collect();
    let Ok(mut lines) = tail.lock() else {
        return;
    };

    lines.push_back(truncated);
    while lines.len() > max_lines {
        lines.pop_front();
    }
}

fn append_background_log_line(log_tail: &Arc<Mutex<VecDeque<String>>>, line: String) {
    append_output_line(log_tail, line, MAX_BACKGROUND_LOG_LINES);
}

fn spawn_background_log_reader<R>(
    reader: R,
    log_tail: Arc<Mutex<VecDeque<String>>>,
    stream_label: &'static str,
) where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let buffered = BufReader::new(reader);
        for line in buffered.lines() {
            match line {
                Ok(content) => {
                    append_background_log_line(&log_tail, format!("[{stream_label}] {content}"));
                }
                Err(_) => break,
            }
        }
    });
}

pub(crate) fn snapshot_background_log_tail(log_tail: &Arc<Mutex<VecDeque<String>>>) -> String {
    let Ok(lines) = log_tail.lock() else {
        return String::new();
    };

    lines.iter().cloned().collect::<Vec<_>>().join("\n")
}

fn command_allowed(command: &str) -> bool {
    let command_name = Path::new(command)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(command);
    !BLOCKED_COMMANDS.contains(&command_name)
}

fn looks_like_shell_script(command: &str) -> bool {
    let ext = Path::new(command)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e.to_ascii_lowercase()));
    ext.as_deref()
        .map(|e| SHELL_SCRIPT_EXTENSIONS.contains(&e))
        .unwrap_or(false)
}

pub(crate) fn scan_script_for_version_constraint(
    workspace: &Path,
    command: &str,
) -> Option<String> {
    if !looks_like_shell_script(command) {
        return None;
    }
    let script_path = {
        let p = Path::new(command);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            workspace.join(p)
        }
    };
    let content = match fs::read_to_string(&script_path) {
        Ok(c) if c.len() <= 500_000 => c,
        _ => return None,
    };
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(found) = super::guard::find_unquoted_shell_version_constraint(line) {
            return Some(found);
        }
    }
    None
}

#[tauri::command]
pub(crate) async fn run_workspace_command(
    workspace_path: String,
    command: String,
    args: Option<Vec<String>>,
    timeout_seconds: Option<u64>,
) -> Result<CommandResult, String> {
    run_blocking_workspace_task(move || {
        run_workspace_command_impl(workspace_path, command, args, timeout_seconds)
    })
    .await
}

pub(crate) fn run_workspace_command_impl(
    workspace_path: String,
    command: String,
    args: Option<Vec<String>>,
    timeout_seconds: Option<u64>,
) -> Result<CommandResult, String> {
    if !command_allowed(&command) {
        return Err(format!(
            "命令 `{command}` 被安全策略阻止。已阻止的入口: {}",
            BLOCKED_COMMANDS.join(", ")
        ));
    }

    let workspace = canonical_workspace(&workspace_path)?;

    if let Some(constraint) = scan_script_for_version_constraint(&workspace, &command) {
        return Err(format!(
            "脚本 `{command}` 包含未加引号的版本约束 `{constraint}`，\
            shell 会将其中的 > 或 = 解析为重定向操作符并生成空文件。\
            请在脚本中改用 pip install -r requirements.txt 或将约束用引号括起。"
        ));
    }

    let args = args.unwrap_or_default();
    let timeout = Duration::from_secs(timeout_seconds.unwrap_or(30).clamp(1, MAX_COMMAND_SECONDS));

    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut cmd = Command::new(&command);
    cmd.args(&args)
        .env("PATH", expanded_path())
        .current_dir(workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if command == "git" {
        let code_papr_git = std::path::Path::new(&workspace_path).join(".CodePapr/git");
        cmd.env("GIT_DIR", code_papr_git.join(".git"))
            .env("GIT_WORK_TREE", &workspace_path);
    }

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            return Ok(CommandResult {
                command,
                args,
                status: Some(-1),
                stdout: String::new(),
                stderr: format!("启动命令失败: {err}"),
                timed_out: false,
            });
        }
    };

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法捕获命令标准输出".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法捕获命令标准错误".to_string())?;

    let stdout_handle = thread::spawn(move || {
        let mut reader = stdout;
        let mut buffer = Vec::new();
        let _ = reader.read_to_end(&mut buffer);
        buffer
    });
    let stderr_handle = thread::spawn(move || {
        let mut reader = stderr;
        let mut buffer = Vec::new();
        let _ = reader.read_to_end(&mut buffer);
        buffer
    });

    let started = Instant::now();
    let mut timed_out = false;
    let status;
    loop {
        if let Some(exit_status) = child
            .try_wait()
            .map_err(|err| format!("等待命令失败: {err}"))?
        {
            status = exit_status.code();
            break;
        }
        if started.elapsed() >= timeout {
            timed_out = true;
            child
                .kill()
                .map_err(|err| format!("终止超时命令失败: {err}"))?;
            status = child
                .wait()
                .map_err(|err| format!("等待超时命令退出失败: {err}"))?
                .code();
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    let stdout = stdout_handle
        .join()
        .map_err(|_| "读取标准输出线程异常".to_string())?;
    let stderr = stderr_handle
        .join()
        .map_err(|_| "读取标准错误线程异常".to_string())?;

    let stdout_bytes = if stdout.len() > MAX_OUTPUT_BYTES {
        &stdout[..MAX_OUTPUT_BYTES]
    } else {
        &stdout
    };
    let stderr_bytes = if stderr.len() > MAX_OUTPUT_BYTES {
        &stderr[..MAX_OUTPUT_BYTES]
    } else {
        &stderr
    };

    Ok(CommandResult {
        command,
        args,
        status,
        stdout: truncate_utf8(stdout_bytes),
        stderr: truncate_utf8(stderr_bytes),
        timed_out,
    })
}

#[tauri::command]
pub(crate) fn start_workspace_background_command(
    workspace_path: String,
    command: String,
    args: Option<Vec<String>>,
    preview_url: Option<String>,
) -> Result<BackgroundCommandResult, String> {
    if !command_allowed(&command) {
        return Err(format!(
            "命令 `{command}` 被安全策略阻止。已阻止的入口: {}",
            BLOCKED_COMMANDS.join(", ")
        ));
    }

    let workspace = canonical_workspace(&workspace_path)?;

    if let Some(constraint) = scan_script_for_version_constraint(&workspace, &command) {
        return Err(format!(
            "脚本 `{command}` 包含未加引号的版本约束 `{constraint}`，\
            shell 会将其中的 > 或 = 解析为重定向操作符并生成空文件。\
            请在脚本中改用 pip install -r requirements.txt 或将约束用引号括起。"
        ));
    }

    let args = args.unwrap_or_default();
    let preview_url = preview_url
        .map(|raw_url| parse_browser_url(&raw_url))
        .transpose()?;
    let workspace_path = workspace.to_string_lossy().to_string();

    if let Some(existing_result) = with_background_processes(|processes| {
        for (pid, process) in processes.iter_mut() {
            if process.workspace_path == workspace_path
                && process.command == command
                && process.args == args
            {
                if preview_url.is_some() {
                    process.preview_url = preview_url.clone();
                }

                return Ok(Some(BackgroundCommandResult {
                    command: command.clone(),
                    args: args.clone(),
                    pid: Some(*pid),
                    started: false,
                    preview_url: process.preview_url.clone(),
                }));
            }
        }

        Ok(None)
    })? {
        return Ok(existing_result);
    }

    #[cfg(windows)]
    const CREATE_NO_WINDOW_BG: u32 = 0x08000000;
    let mut bg_cmd = Command::new(&command);
    bg_cmd
        .args(&args)
        .current_dir(&workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    bg_cmd.creation_flags(CREATE_NO_WINDOW_BG);
    let mut child = bg_cmd
        .spawn()
        .map_err(|err| format!("启动后台命令失败: {err}"))?;

    let log_tail = Arc::new(Mutex::new(VecDeque::new()));

    if let Some(stdout) = child.stdout.take() {
        spawn_background_log_reader(stdout, Arc::clone(&log_tail), "out");
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_background_log_reader(stderr, Arc::clone(&log_tail), "err");
    }

    let pid = child.id();
    let started_at = unix_millis()?;

    with_background_processes(|processes| {
        processes.insert(
            pid,
            ManagedBackgroundProcess {
                child,
                command: command.clone(),
                args: args.clone(),
                workspace_path: workspace_path.clone(),
                started_at,
                preview_url: preview_url.clone(),
                log_tail: Arc::clone(&log_tail),
            },
        );
        Ok(())
    })?;

    Ok(BackgroundCommandResult {
        command,
        args,
        pid: Some(pid),
        started: true,
        preview_url,
    })
}

#[tauri::command]
pub(crate) fn list_background_processes(
    workspace_path: Option<String>,
) -> Result<Vec<BackgroundProcessEntry>, String> {
    let workspace_filter = normalize_workspace_filter(workspace_path)?;

    with_background_processes(|processes| {
        let mut entries: Vec<BackgroundProcessEntry> = processes
            .iter()
            .filter(|(_, process)| {
                workspace_filter
                    .as_ref()
                    .map(|filter| &process.workspace_path == filter)
                    .unwrap_or(true)
            })
            .map(|(pid, process)| BackgroundProcessEntry {
                pid: *pid,
                command: process.command.clone(),
                args: process.args.clone(),
                workspace_path: process.workspace_path.clone(),
                started_at: process.started_at,
                preview_url: process.preview_url.clone(),
                log_tail: snapshot_background_log_tail(&process.log_tail),
            })
            .collect();

        entries.sort_by(|left, right| {
            right
                .started_at
                .cmp(&left.started_at)
                .then_with(|| left.pid.cmp(&right.pid))
        });

        Ok(entries)
    })
}

#[tauri::command]
pub(crate) fn stop_background_process(pid: u32) -> Result<StopBackgroundProcessResult, String> {
    with_background_processes(|processes| {
        let Some(mut process) = processes.remove(&pid) else {
            return Ok(StopBackgroundProcessResult {
                pid,
                stopped: false,
            });
        };

        let still_running = match process.child.try_wait() {
            Ok(Some(_)) => false,
            Ok(None) => true,
            Err(_) => true,
        };

        if still_running {
            let _ = process.child.kill();
            let _ = process.child.wait();
        }

        Ok(StopBackgroundProcessResult {
            pid,
            stopped: still_running,
        })
    })
}

#[tauri::command]
pub(crate) fn stop_all_background_processes(
    workspace_path: Option<String>,
) -> Result<StopAllBackgroundProcessesResult, String> {
    let workspace_filter = normalize_workspace_filter(workspace_path)?;

    with_background_processes(|processes| {
        let target_pids: Vec<u32> = processes
            .iter()
            .filter(|(_, process)| {
                workspace_filter
                    .as_ref()
                    .map(|filter| &process.workspace_path == filter)
                    .unwrap_or(true)
            })
            .map(|(pid, _)| *pid)
            .collect();

        let mut stopped = 0usize;

        for pid in target_pids {
            if let Some(mut process) = processes.remove(&pid) {
                let still_running = match process.child.try_wait() {
                    Ok(Some(_)) => false,
                    Ok(None) => true,
                    Err(_) => true,
                };

                if still_running {
                    let _ = process.child.kill();
                    let _ = process.child.wait();
                    stopped += 1;
                }
            }
        }

        Ok(StopAllBackgroundProcessesResult { stopped })
    })
}
