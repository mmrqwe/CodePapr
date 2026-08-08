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
fn add_subpath_rule(
    lines: &mut Vec<String>,
    action: &str,
    class: &str,
    path: &Path,
) -> Option<PathBuf> {
    // 内核按规范（真实）路径匹配规则：/var/folders/...（→ /private/var/folders/...）
    // 这类含符号链接的路径必须先规范化，否则规则永远不生效。规范化失败（路径不存在）
    // 则跳过该规则。
    let canonical = path.canonicalize().ok()?;
    lines.push(format!(
        "({action} {class} (subpath \"{}\"))",
        profile_quote(&canonical)
    ));
    Some(canonical)
}

/// 收集路径的所有严格祖先目录。node/npm 的 realpathSync 与一般路径解析需要
/// lstat 允许路径链上的每个祖先目录，否则报 EPERM。
#[cfg(target_os = "macos")]
fn collect_ancestors(path: &Path, out: &mut std::collections::BTreeSet<PathBuf>) {
    let mut parent = path.parent();
    while let Some(dir) = parent {
        if dir.as_os_str().is_empty() {
            break;
        }
        out.insert(dir.to_path_buf());
        parent = dir.parent();
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
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut lines = vec![
        "(version 1)".to_string(),
        "(import \"system.sb\")".to_string(),
        "(deny default)".to_string(),
        "(allow process*)".to_string(),
        "(allow network*)".to_string(),
    ];
    // 所有读放行的根路径：用于推导祖先目录的 metadata 规则
    let mut read_roots: Vec<PathBuf> = Vec::new();

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
        if let Some(canonical) = add_subpath_rule(&mut lines, "allow", "file-read*", path) {
            read_roots.push(canonical);
        }
    }

    let tool_dirs: Vec<PathBuf> = {
        let mut dirs = vec![std::env::temp_dir()];
        if let Some(home) = &home {
            for name in [".npm", ".cache", ".cargo", ".local", ".nvm", ".volta"] {
                dirs.push(home.join(name));
            }
        }
        dirs
    };
    for path in &tool_dirs {
        if path.as_os_str().is_empty() {
            continue;
        }
        if let Some(canonical) = add_subpath_rule(&mut lines, "allow", "file-read*", path) {
            read_roots.push(canonical);
        }
        add_subpath_rule(&mut lines, "allow", "file-write*", path);
    }

    for path in std::env::split_paths(&crate::shared::expanded_path()) {
        if let Some(canonical) = add_subpath_rule(&mut lines, "allow", "file-read*", &path) {
            read_roots.push(canonical);
        }
    }

    // Homebrew（Apple Silicon）：bin 目录只是符号链接，真实二进制与 dylib 在
    // Cellar/opt 下，必须放行整个前缀的读取，否则 node/python 等无法加载。
    // Intel 前缀 /usr/local 已被上面的 /usr 规则覆盖。
    let homebrew_prefix = Path::new("/opt/homebrew");
    if homebrew_prefix.is_dir() {
        if let Some(canonical) =
            add_subpath_rule(&mut lines, "allow", "file-read*", homebrew_prefix)
        {
            read_roots.push(canonical);
        }
    }

    // HOME 下常见工具配置（只读）：git/npm 读不到会直接报错
    if let Some(home) = &home {
        for name in [
            ".gitconfig",
            ".gitignore",
            ".gitignore_global",
            ".gitattributes",
            ".npmrc",
        ] {
            if let Some(canonical) =
                add_subpath_rule(&mut lines, "allow", "file-read*", &home.join(name))
            {
                read_roots.push(canonical);
            }
        }
    }

    if policy.yolo {
        add_subpath_rule(&mut lines, "allow", "file-read*", Path::new("/"));
        add_subpath_rule(&mut lines, "allow", "file-write*", Path::new("/"));
    } else {
        if let Some(canonical) = add_subpath_rule(&mut lines, "allow", "file-read*", workspace) {
            read_roots.push(canonical);
        }
        add_subpath_rule(&mut lines, "allow", "file-write*", workspace);
        for path in policy
            .allowed_dirs
            .iter()
            .map(PathBuf::from)
            .chain(policy.allowed_files.iter().map(PathBuf::from))
        {
            if let Some(canonical) = add_subpath_rule(&mut lines, "allow", "file-read*", &path) {
                read_roots.push(canonical);
            }
            add_subpath_rule(&mut lines, "allow", "file-write*", &path);
        }
    }

    if let Some(parent) = Path::new(program).parent() {
        if let Some(canonical) = add_subpath_rule(&mut lines, "allow", "file-read*", parent) {
            read_roots.push(canonical);
        }
    }

    // 读放行路径的祖先目录必须可 lstat：node/npm 的 realpathSync 与一般路径
    // 解析会逐级 stat 祖先（如 /opt、/private/var/folders/...），缺一个就 EPERM。
    let mut ancestors: std::collections::BTreeSet<PathBuf> = std::collections::BTreeSet::new();
    for root in &read_roots {
        collect_ancestors(root, &mut ancestors);
    }
    for ancestor in ancestors {
        lines.push(format!(
            "(allow file-read-metadata (literal \"{}\"))",
            profile_quote(&ancestor)
        ));
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
    use super::{build_profile, sandboxed_command};
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

    #[test]
    fn profile_canonicalizes_symlinked_paths() {
        let workspace =
            std::env::temp_dir().join(format!("codepapr-sandbox-profile-{}", std::process::id()));
        fs::create_dir_all(&workspace).expect("sandbox test workspace should exist");
        let profile = build_profile("/bin/zsh", &workspace).expect("profile should build");
        let _ = fs::remove_dir_all(&workspace);

        // 临时目录规则必须是规范化后的 /private/var/folders 形式，
        // 否则内核永远匹配不到（/var/folders 是符号链接）。
        let canonical_tmp = std::env::temp_dir()
            .canonicalize()
            .expect("temp dir should canonicalize");
        assert!(
            profile.contains(&format!("(subpath \"{}\")", canonical_tmp.display())),
            "profile must contain canonical temp dir rule; got:\n{profile}"
        );
        assert!(
            !profile.contains("(subpath \"/var/folders"),
            "profile must not contain non-canonical /var/folders rules"
        );
    }

    #[test]
    fn profile_grants_ancestor_metadata_for_read_roots() {
        let workspace = std::env::temp_dir().join(format!(
            "codepapr-sandbox-ancestors-{}",
            std::process::id()
        ));
        fs::create_dir_all(&workspace).expect("sandbox test workspace should exist");
        let profile = build_profile("/bin/zsh", &workspace).expect("profile should build");
        let _ = fs::remove_dir_all(&workspace);

        // node/npm 的 realpathSync 需要 lstat 允许路径链上的每个祖先目录
        assert!(
            profile.contains("(allow file-read-metadata (literal \"/\"))"),
            "profile must allow metadata on /; got:\n{profile}"
        );
        let canonical_workspace = std::env::temp_dir()
            .canonicalize()
            .expect("temp dir should canonicalize");
        let parent = canonical_workspace.display().to_string();
        assert!(
            profile.contains(&format!(
                "(allow file-read-metadata (literal \"{parent}\"))"
            )),
            "profile must allow metadata on workspace parent {parent}; got:\n{profile}"
        );
    }

    #[test]
    fn sandboxed_command_can_write_to_temp_dir() {
        let workspace =
            std::env::temp_dir().join(format!("codepapr-sandbox-tmpw-{}", std::process::id()));
        fs::create_dir_all(&workspace).expect("sandbox test workspace should exist");

        let probe = std::env::temp_dir().join(format!("codepapr-probe-{}", std::process::id()));
        let script = format!("touch {} && echo TMP_WRITE_OK", probe.display());
        let mut command =
            sandboxed_command("/bin/zsh", &["-c".to_string(), script], &workspace)
                .expect("sandbox command should build");
        command.env("PATH", crate::shared::expanded_path());
        let output = command.output().expect("sandbox command should start");

        let _ = fs::remove_dir_all(&workspace);
        let _ = fs::remove_file(&probe);
        assert!(
            output.status.success(),
            "temp write should be allowed; stderr: {:?}",
            output.stderr
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("TMP_WRITE_OK"));
    }

    #[test]
    fn sandboxed_homebrew_node_can_start_when_present() {
        let node = std::path::Path::new("/opt/homebrew/bin/node");
        if !node.exists() {
            return; // 非 Homebrew 环境跳过
        }
        let workspace =
            std::env::temp_dir().join(format!("codepapr-sandbox-node-{}", std::process::id()));
        fs::create_dir_all(&workspace).expect("sandbox test workspace should exist");

        let mut command = sandboxed_command(
            "/opt/homebrew/bin/node",
            &["-e".to_string(), "console.log('node-ok')".to_string()],
            &workspace,
        )
        .expect("sandbox command should build");
        let output = command.output().expect("sandbox command should start");

        let _ = fs::remove_dir_all(&workspace);
        assert!(
            output.status.success(),
            "homebrew node must run in sandbox; stderr: {:?}",
            output.stderr
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("node-ok"));
    }

    #[test]
    fn sandboxed_homebrew_npm_can_run_when_present() {
        // npm 是 node 脚本：验证模块解析（祖先目录 lstat）+ ~/.npm + 临时目录全链路
        let npm = std::path::Path::new("/opt/homebrew/bin/npm");
        if !npm.exists() {
            return;
        }
        let workspace =
            std::env::temp_dir().join(format!("codepapr-sandbox-npm-{}", std::process::id()));
        fs::create_dir_all(&workspace).expect("sandbox test workspace should exist");

        let mut command =
            sandboxed_command("/opt/homebrew/bin/npm", &["--version".to_string()], &workspace)
                .expect("sandbox command should build");
        // 与真实调用路径一致：cwd 必须在工作区内，否则 process.cwd() 会被拒
        command
            .current_dir(&workspace)
            .env("PATH", crate::shared::expanded_path());
        let output = command.output().expect("sandbox command should start");

        let _ = fs::remove_dir_all(&workspace);
        assert!(
            output.status.success(),
            "homebrew npm must run in sandbox; stderr: {:?}",
            output.stderr
        );
    }
}
