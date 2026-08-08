use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(target_os = "macos")]
use crate::db;

#[cfg(target_os = "macos")]
fn profile_quote(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

#[cfg(target_os = "macos")]
fn add_subpath_rule(lines: &mut Vec<String>, action: &str, class: &str, path: &Path) {
    if path.is_absolute() {
        lines.push(format!(
            "({action} {class} (subpath \"{}\"))",
            profile_quote(path)
        ));
    }
}

#[cfg(target_os = "macos")]
fn protected_home_paths() -> Vec<PathBuf> {
    let Some(home) = std::env::var_os("HOME") else {
        return Vec::new();
    };
    let home = PathBuf::from(home);
    [
        ".ssh",
        ".gnupg",
        ".config",
        ".aws",
        ".azure",
        ".kube",
        ".git",
        ".CodePapr",
    ]
    .into_iter()
    .map(|name| home.join(name))
    .collect()
}

#[cfg(target_os = "macos")]
fn build_profile(program: &str, workspace: &Path) -> Result<String, String> {
    let policy = db::load_external_access_policy()?;
    let mut lines = vec![
        "(version 1)".to_string(),
        "(import \"system.sb\")".to_string(),
        "(deny default)".to_string(),
        "(allow process*)".to_string(),
        "(allow network*)".to_string(),
    ];

    let system_read_dirs = [
        "/bin",
        "/usr",
        "/System",
        "/Library",
        "/private/etc",
        "/private/var/db",
        "/private/tmp",
        "/dev",
    ];
    for path in system_read_dirs.iter().map(Path::new) {
        add_subpath_rule(&mut lines, "allow", "file-read*", path);
    }
    for path in [
        std::env::temp_dir(),
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|home| home.join(".npm"))
            .unwrap_or_default(),
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|home| home.join(".cache"))
            .unwrap_or_default(),
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|home| home.join(".cargo"))
            .unwrap_or_default(),
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|home| home.join(".local"))
            .unwrap_or_default(),
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|home| home.join(".nvm"))
            .unwrap_or_default(),
    ] {
        if path.as_os_str().is_empty() {
            continue;
        }
        add_subpath_rule(&mut lines, "allow", "file-read*", &path);
        add_subpath_rule(&mut lines, "allow", "file-write*", &path);
    }

    for path in std::env::split_paths(&crate::shared::expanded_path()) {
        add_subpath_rule(&mut lines, "allow", "file-read*", &path);
    }

    if policy.yolo {
        add_subpath_rule(&mut lines, "allow", "file-read*", Path::new("/"));
        add_subpath_rule(&mut lines, "allow", "file-write*", Path::new("/"));
    } else {
        add_subpath_rule(&mut lines, "allow", "file-read*", workspace);
        add_subpath_rule(&mut lines, "allow", "file-write*", workspace);
        for path in policy
            .allowed_dirs
            .iter()
            .map(PathBuf::from)
            .chain(policy.allowed_files.iter().map(PathBuf::from))
        {
            add_subpath_rule(&mut lines, "allow", "file-read*", &path);
            add_subpath_rule(&mut lines, "allow", "file-write*", &path);
        }
    }

    if let Some(parent) = Path::new(program).parent() {
        add_subpath_rule(&mut lines, "allow", "file-read*", parent);
    }

    // YOLO is still bounded by the protected home directories. The explicit
    // deny rules are deliberately appended after the broad allow rules.
    for path in protected_home_paths() {
        add_subpath_rule(&mut lines, "deny", "file-read*", &path);
        add_subpath_rule(&mut lines, "deny", "file-write*", &path);
    }

    Ok(lines.join("\n"))
}

pub(crate) fn sandboxed_command(
    program: &str,
    args: &[String],
    workspace: &Path,
) -> Result<Command, String> {
    #[cfg(target_os = "macos")]
    {
        let profile = build_profile(program, workspace)?;
        let mut command = Command::new("/usr/bin/sandbox-exec");
        command.arg("-p").arg(profile).arg(program).args(args);
        return Ok(command);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = workspace;
        let mut command = Command::new(program);
        command.args(args);
        Ok(command)
    }
}

pub(crate) fn sandboxed_shell_command(
    shell: &str,
    command_line: &str,
    workspace: &Path,
) -> Result<Command, String> {
    #[cfg(windows)]
    let shell_args = ["/C".to_string(), command_line.to_string()];
    #[cfg(not(windows))]
    let shell_args = ["-c".to_string(), command_line.to_string()];
    let mut command = sandboxed_command(shell, &shell_args, workspace)?;
    #[cfg(not(target_os = "windows"))]
    command.env("PATH", crate::shared::expanded_path());
    Ok(command)
}

#[cfg(target_os = "windows")]
fn windows_command_tokens(command: &str) -> Vec<String> {
    command
        .split(|character: char| character.is_whitespace() || "\"'`=<>|;&()".contains(character))
        .map(|token| token.trim_matches(|character: char| ",.;".contains(character)))
        .filter(|token| !token.is_empty())
        .map(ToString::to_string)
        .collect()
}

#[cfg(target_os = "windows")]
fn windows_absolute_token(token: &str) -> bool {
    let bytes = token.as_bytes();
    token.starts_with("\\\\")
        || token.starts_with('/')
        || (bytes.len() >= 3 && bytes[1] == b':' && matches!(bytes[2], b'\\' | b'/'))
}

#[cfg(target_os = "windows")]
fn ensure_windows_command_path(workspace: &Path, raw_path: &str) -> Result<(), String> {
    let path = Path::new(raw_path);
    let target = match std::fs::canonicalize(path) {
        Ok(target) => target,
        Err(_) => {
            let mut parent = path
                .parent()
                .ok_or_else(|| "无法确定命令路径的父目录".to_string())?;
            while !parent.exists() {
                parent = parent
                    .parent()
                    .ok_or_else(|| "命令路径不存在或无法访问".to_string())?;
            }
            std::fs::canonicalize(parent)
                .map_err(|err| format!("命令路径不存在或无法访问: {err}"))?
        }
    };
    crate::shared::ensure_path_accessible(workspace, &target)
}

#[cfg(target_os = "windows")]
fn reject_dynamic_windows_shell_syntax(command: &str) -> Result<(), String> {
    let percent_count = command
        .chars()
        .filter(|character| *character == '%')
        .count();
    let has_variable = command.char_indices().any(|(index, character)| {
        character == '$'
            && command[index + character.len_utf8()..]
                .chars()
                .next()
                .map(|next| next.is_ascii_alphanumeric() || matches!(next, '{' | '('))
                .unwrap_or(false)
    });
    if percent_count >= 2
        || has_variable
        || command.contains('`')
        || command.contains("..")
        || command.contains("~/")
        || command.contains("~\\")
    {
        return Err(
            "Windows 安全限制：命令包含无法可靠判断访问范围的动态路径，请改用明确的绝对路径或在项目目录内执行"
                .to_string(),
        );
    }
    Ok(())
}

pub(crate) fn validate_restricted_command(
    command: &str,
    args: &[String],
    workspace: &Path,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        for argument in args {
            for token in windows_command_tokens(argument) {
                if windows_absolute_token(&token) {
                    ensure_windows_command_path(workspace, &token)?;
                }
            }
        }
        let _ = command;
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (command, args, workspace);
    }
    Ok(())
}

pub(crate) fn validate_restricted_shell_command(
    command: &str,
    workspace: &Path,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        reject_dynamic_windows_shell_syntax(command)?;
        for (index, token) in windows_command_tokens(command).into_iter().enumerate() {
            if index > 0 && windows_absolute_token(&token) {
                ensure_windows_command_path(workspace, &token)?;
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (command, workspace);
    }
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::sandboxed_command;
    use std::fs;

    #[test]
    fn sandboxed_runtime_command_can_start() {
        let workspace =
            std::env::temp_dir().join(format!("codepapr-sandbox-test-{}", std::process::id()));
        fs::create_dir_all(&workspace).expect("sandbox test workspace should exist");

        let mut command = sandboxed_command("/bin/echo", &["sandbox-ok".to_string()], &workspace)
            .expect("sandbox command should build");
        let output = command.output().expect("sandbox command should start");

        let _ = fs::remove_dir_all(&workspace);
        assert!(
            output.status.success(),
            "sandbox stderr: {:?}",
            output.stderr
        );
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "sandbox-ok");
    }
}
