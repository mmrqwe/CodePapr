use crate::shared::unix_millis;
use crate::shell::session::SHELL_SESSION_COUNTER;
use crate::shell::types::{ShellFamily, ShellSendInputResult};
use std::io::Write;
use std::path::Path;
use std::process::ChildStdin;
use std::sync::atomic::Ordering;
use std::sync::Mutex;

/// 允许作为会话 shell 的程序（按文件名小写匹配，含 Windows .exe 形式）。
/// open_shell_session 是 LLM 可调用工具，若允许把任意程序（ssh/sudo/任意
/// 二进制）当"shell"拉起，会绕过 BLOCKED_COMMANDS 拦截清单——
/// 例如 `open_shell_session(shell="ssh")` 可开出交互式远程会话。
const ALLOWED_SESSION_SHELLS: &[&str] = &[
    "sh",
    "bash",
    "zsh",
    "fish",
    "dash",
    "ksh",
    "csh",
    "tcsh",
    "cmd",
    "cmd.exe",
    "pwsh",
    "pwsh.exe",
    "powershell",
    "powershell.exe",
];

pub(crate) fn detect_default_shell(custom_shell: Option<String>) -> Result<String, String> {
    if let Some(shell) = custom_shell {
        let trimmed = shell.trim();
        if !trimmed.is_empty() {
            let name = Path::new(trimmed)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(trimmed)
                .to_lowercase();
            if !ALLOWED_SESSION_SHELLS.contains(&name.as_str()) {
                return Err(format!(
                    "安全限制：`{trimmed}` 不能作为会话 shell，仅允许 sh/bash/zsh/fish/dash/ksh/csh/tcsh/cmd/pwsh/powershell"
                ));
            }
            return Ok(trimmed.to_string());
        }
    }

    #[cfg(target_os = "windows")]
    {
        return Ok(std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string()));
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(shell) = std::env::var("SHELL") {
            let trimmed = shell.trim();
            if !trimmed.is_empty() {
                return Ok(trimmed.to_string());
            }
        }

        if Path::new("/bin/zsh").exists() {
            return Ok("/bin/zsh".to_string());
        }

        Ok("/bin/sh".to_string())
    }
}

pub(crate) fn create_shell_session_id() -> Result<String, String> {
    let counter = SHELL_SESSION_COUNTER.fetch_add(1, Ordering::Relaxed);
    Ok(format!("shell-{}-{counter}", unix_millis()?))
}

pub(crate) fn shell_token_looks_like_unquoted_version_constraint(token: &str) -> bool {
    const OPERATORS: [&str; 7] = [">=", "<=", "==", "!=", "~=", ">", "<"];

    if token
        .strip_prefix('=')
        .and_then(|right| right.chars().next())
        .map(|ch| ch.is_ascii_digit())
        .unwrap_or(false)
    {
        return true;
    }

    for operator in OPERATORS {
        if let Some(index) = token.find(operator) {
            let left = &token[..index];
            let right = &token[index + operator.len()..];
            let Some(first_right) = right.chars().next() else {
                continue;
            };

            if right.is_empty() {
                continue;
            }
            if !left.is_empty() && !left.chars().any(|ch| ch.is_ascii_alphabetic()) {
                continue;
            }
            if !first_right.is_ascii_digit() {
                continue;
            }

            return true;
        }
    }

    false
}

pub(crate) fn find_unquoted_shell_version_constraint(input: &str) -> Option<String> {
    let mut token = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut in_backtick = false;
    let mut escape_next = false;

    let flush = |token: &mut String| -> Option<String> {
        if token.is_empty() {
            return None;
        }

        let candidate = token.clone();
        token.clear();
        if shell_token_looks_like_unquoted_version_constraint(&candidate) {
            return Some(candidate);
        }

        None
    };

    for ch in input.chars() {
        if escape_next {
            escape_next = false;
            if !in_single && !in_double && !in_backtick {
                if ch == '\n' {
                    if let Some(found) = flush(&mut token) {
                        return Some(found);
                    }
                } else {
                    token.push(ch);
                }
            }
            continue;
        }

        if ch == '\\' && !in_single {
            escape_next = true;
            continue;
        }

        if ch == '\'' && !in_double && !in_backtick {
            in_single = !in_single;
            continue;
        }

        if ch == '"' && !in_single && !in_backtick {
            in_double = !in_double;
            continue;
        }

        if ch == '`' && !in_single && !in_double {
            in_backtick = !in_backtick;
            continue;
        }

        if in_single || in_double || in_backtick {
            continue;
        }

        if ch.is_whitespace() || matches!(ch, '|' | '&' | ';' | '(' | ')') {
            if let Some(found) = flush(&mut token) {
                return Some(found);
            }
            continue;
        }

        token.push(ch);
    }

    flush(&mut token)
}

pub(crate) fn detect_shell_family(shell: &str) -> ShellFamily {
    let base = Path::new(shell)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(shell)
        .to_ascii_lowercase();

    match base.as_str() {
        "cmd" | "cmd.exe" => ShellFamily::Cmd,
        "powershell" | "powershell.exe" | "pwsh" | "pwsh.exe" => ShellFamily::PowerShell,
        _ => ShellFamily::Posix,
    }
}

pub(crate) fn escape_shell_arg(arg: &str, family: ShellFamily) -> String {
    match family {
        ShellFamily::PowerShell => format!("'{}'", arg.replace('\'', "''")),
        ShellFamily::Cmd => {
            let escaped = arg.replace('"', "\"\"").replace('%', "%%");
            format!("\"{escaped}\"")
        }
        ShellFamily::Posix => format!("'{}'", arg.replace('\'', "'\"'\"'")),
    }
}

pub(crate) fn build_shell_command_line(
    shell: &str,
    command: &str,
    args: &[String],
) -> Result<String, String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("command 不能为空".to_string());
    }

    let family = detect_shell_family(shell);
    let mut parts = Vec::with_capacity(args.len() + 1);
    parts.push(escape_shell_arg(trimmed, family));
    for arg in args {
        parts.push(escape_shell_arg(arg, family));
    }
    Ok(parts.join(" "))
}

/// 向会话 stdin 写入 payload。只持有该会话自己的 stdin 锁，
/// 绝不持有全局 SHELL_SESSIONS 注册表锁——否则当子进程不读 stdin
/// （如正在执行长命令）导致管道写满时，write_all 会无限期阻塞，
/// 把所有会话的 list/read/send/close 全部卡死。
pub(crate) fn write_shell_payload(
    session_id: &str,
    stdin_lock: &Mutex<ChildStdin>,
    mut payload: String,
) -> Result<ShellSendInputResult, String> {
    if !payload.ends_with('\n') {
        payload.push('\n');
    }

    let mut stdin = stdin_lock
        .lock()
        .map_err(|_| format!("Shell 会话输入流锁定失败: {session_id}"))?;
    stdin
        .write_all(payload.as_bytes())
        .map_err(|err| format!("写入 Shell 会话失败: {err}"))?;
    stdin
        .flush()
        .map_err(|err| format!("刷新 Shell 输入失败: {err}"))?;

    Ok(ShellSendInputResult {
        session_id: session_id.to_string(),
        accepted: true,
    })
}
