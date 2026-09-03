use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(target_os = "macos")]
use std::fs;

#[cfg(target_os = "macos")]
use crate::db;

#[cfg(target_os = "macos")]
fn profile_quote(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        // SBPL 字符串字面量内裸换行/制表符等控制字符会提前终止表达式或改变
        // 解析：工作区/外部路径理论上可含换行，必须一并转义。统一把 C0 控制
        // 字符（含 \n \r \t）替换为空格，保持规则语义同时杜绝注入。
        .chars()
        .map(|ch| {
            if ch.is_control() {
                ' '
            } else {
                ch
            }
        })
        .collect()
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

/// 命令运行必须放行读取的系统目录（工具链、二进制与 dylib）。
#[cfg(not(target_os = "windows"))]
fn unix_system_read_dirs() -> Vec<PathBuf> {
    [
        "/bin",
        "/usr",
        "/System",
        "/Library",
        "/private/etc",
        "/private/var/db",
        "/private/tmp",
        "/dev",
    ]
    .iter()
    .map(PathBuf::from)
    .collect()
}

/// 工具缓存/临时目录：沙箱中读写均放行。
#[cfg(not(target_os = "windows"))]
fn unix_tool_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![std::env::temp_dir()];
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        // 注意：不可整体放行 ~/.local（其 bin/ 在 PATH 内，可写即能植入
        // 持久化二进制）；只放行数据目录 ~/.local/share。
        for name in [".npm", ".cache", ".cargo", ".local/share", ".nvm", ".volta"] {
            dirs.push(home.join(name));
        }
    }
    dirs
}

/// HOME 下常见工具配置文件（只读）：git/npm 读不到会直接报错。
#[cfg(not(target_os = "windows"))]
fn unix_home_read_files() -> Vec<PathBuf> {
    let Some(home) = std::env::var_os("HOME") else {
        return Vec::new();
    };
    let home = PathBuf::from(home);
    [
        ".gitconfig",
        ".gitignore",
        ".gitignore_global",
        ".gitattributes",
        ".npmrc",
    ]
    .iter()
    .map(|name| home.join(name))
    .collect()
}

/// workspace/授权策略之外的读放行根集，与 build_profile 的规则保持同构：
/// 沙箱 profile 用它生成 file-read* 规则，命令预检（ensure_unix_command_path）
/// 用它放行系统路径。全部 canonicalize 后去重；不存在的路径跳过（与
/// add_subpath_rule 行为一致）。
///
/// Homebrew（Apple Silicon）：bin 目录只是符号链接，真实二进制与 dylib 在
/// Cellar/opt 下，必须放行整个前缀的读取，否则 node/python 等无法加载。
/// Intel 前缀 /usr/local 已被 /usr 规则覆盖。
#[cfg(not(target_os = "windows"))]
pub(crate) fn unix_allowed_read_roots() -> Vec<PathBuf> {
    let mut candidates = unix_system_read_dirs();
    candidates.extend(unix_tool_dirs());
    candidates.extend(std::env::split_paths(&crate::shared::expanded_path()));
    candidates.push(PathBuf::from("/opt/homebrew"));
    candidates.extend(unix_home_read_files());

    let mut roots: std::collections::BTreeSet<PathBuf> = std::collections::BTreeSet::new();
    for path in candidates {
        if path.as_os_str().is_empty() {
            continue;
        }
        if let Ok(canonical) = path.canonicalize() {
            roots.insert(canonical);
        }
    }
    roots.into_iter().collect()
}

/// 路径是否落在沙箱读放行根集内（系统目录/工具缓存/PATH 项/Homebrew）。
/// path_guard 用它做同一放行集判定，避免「沙箱放行、预检误拒」的漂移（#18）。
#[cfg(not(target_os = "windows"))]
pub(crate) fn path_is_allowed_read_root(path: &Path) -> bool {
    unix_allowed_read_roots()
        .iter()
        .any(|root| crate::shared::path_is_same_or_child(path, root))
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
fn build_profile(
    program: &str,
    workspace: &Path,
    access: Option<SandboxAccess>,
    app_write_dir: Option<&Path>,
) -> Result<String, String> {
    let access = access.unwrap_or_default();
    let policy = db::load_external_access_policy()?;
    let mut lines = vec![
        "(version 1)".to_string(),
        "(import \"system.sb\")".to_string(),
        "(deny default)".to_string(),
        "(allow process*)".to_string(),
        // IPC 放行：mach-lookup 是「找到系统服务」的入口，缺了它 `osascript`
        // 发不出 AppleEvents（-1728）；lsopen 是 LaunchServices 的专用沙箱操作，
        // 缺了它 `open` 一律 -54/kLSNoExecutableErr（内核日志可见 deny lsopen）。
        // 各 daemon 自带鉴权，文件/网络仍按本 profile 约束；且既已放行 process*
        // （任意可读二进制可执行），这些 IPC 放行的边际风险与之匹配。
        // sysctl-read 供 ps/pgrep 读进程表（纯读）。
        "(allow mach-lookup)".to_string(),
        "(allow lsopen)".to_string(),
        "(allow sysctl-read)".to_string(),
    ];
    // 网络轴：出站网络按开关；监听 localhost 由 allow_bind 单独控制（后端进程需要）。
    // 本平台 Node listen() 对应 SBPL 的 network-inbound，不是 network-bind：
    // 只放行 `(allow network-bind)` 时 bind/listen 一律 EPERM（errno=-1）。
    // network-inbound 不放出站。地址过滤器对本平台无效（`(local ip "127.0.0.1")`
    // 语法错误；`(local ip "localhost:*")` 不约束 bind 地址），回环约束由
    // app_start 的 check_port_bind_address 在启动期强制。
    if access.network {
        lines.push("(allow network*)".to_string());
    } else if access.allow_bind {
        lines.push("(allow network-bind)".to_string());
        lines.push("(allow network-inbound)".to_string());
    }
    // 所有读放行的根路径：用于推导祖先目录的 metadata 规则。
    // 与命令预检共用 unix_allowed_read_roots，保证两侧放行集不漂移。
    let mut read_roots: Vec<PathBuf> = Vec::new();

    for canonical in unix_allowed_read_roots() {
        lines.push(format!(
            "(allow file-read* (subpath \"{}\"))",
            profile_quote(&canonical)
        ));
        read_roots.push(canonical);
    }

    // 工具/临时目录额外放行写入（缓存性质）
    for path in unix_tool_dirs() {
        if path.as_os_str().is_empty() {
            continue;
        }
        add_subpath_rule(&mut lines, "allow", "file-write*", &path);
    }

    if policy.yolo && access.workspace_write {
        // YOLO 只对全权调用（主代理，access 默认全开）生效：允许读写全盘（受保护 HOME 目录除外）。
        add_subpath_rule(&mut lines, "allow", "file-read*", Path::new("/"));
        add_subpath_rule(&mut lines, "allow", "file-write*", Path::new("/"));
        // 全盘写会覆盖 PATH 内的用户二进制目录（~/.local/bin 不在旧保护清单里）：
        // 沙箱内命令可在其中植入持久化二进制，退出沙箱后仍能执行。这类目录
        // 只 deny 写、保留读（PATH 上的工具仍需可执行）。
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            for name in ["local/bin", "bin", ".local/bin", "Library/Python", "Library/Ruby"] {
                add_subpath_rule(&mut lines, "deny", "file-write*", &home.join(name));
            }
        }
    } else {
        if let Some(canonical) = add_subpath_rule(&mut lines, "allow", "file-read*", workspace) {
            read_roots.push(canonical);
        }
        if access.workspace_write {
            add_subpath_rule(&mut lines, "allow", "file-write*", workspace);
        }
        for path in policy
            .allowed_dirs
            .iter()
            .map(PathBuf::from)
            .chain(policy.allowed_files.iter().map(PathBuf::from))
        {
            if let Some(canonical) = add_subpath_rule(&mut lines, "allow", "file-read*", &path) {
                read_roots.push(canonical);
            }
            if access.workspace_write {
                add_subpath_rule(&mut lines, "allow", "file-write*", &path);
            }
        }
    }

    // 后端 app 自身的运行目录始终可写（DB/-wal/-shm、日志等运行时数据）：
    // local=read 只应限制工作区的其余部分，app 目录是它自己的数据域。
    // 缺了这条，只读工作区里的后端进程会在打开 SQLite（WAL 需写 -wal/-shm）时
    // 立刻 EPERM 崩溃，表现为 app_start 反复"进程已退出或端口未被监听"。
    if let Some(app_dir) = app_write_dir {
        if let Some(canonical) = add_subpath_rule(&mut lines, "allow", "file-write*", app_dir) {
            read_roots.push(canonical);
        }
    }

    if let Some(parent) = Path::new(program).parent() {
        if let Some(canonical) = add_subpath_rule(&mut lines, "allow", "file-read*", parent) {
            read_roots.push(canonical);
        }
    }

    apply_codepapr_agent_isolation(&mut lines, &mut read_roots, workspace, access, app_write_dir);

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

/// Agent bash 对工作区内 `.CodePapr` 的内核闸门：先整树 deny，再放行草稿
/// （tmp / tool-output / downloads）、已存在的 skills（只读，供 skill 包脚本）、
/// 以及 App 模式的 apps。后端 app_write_dir 在 deny 之后重新放行。
#[cfg(target_os = "macos")]
fn apply_codepapr_agent_isolation(
    lines: &mut Vec<String>,
    read_roots: &mut Vec<PathBuf>,
    workspace: &Path,
    access: SandboxAccess,
    app_write_dir: Option<&Path>,
) {
    let Ok(ws) = workspace.canonicalize() else {
        return;
    };
    let codepapr = ws.join(".CodePapr");
    lines.push(format!(
        "(deny file-read* (subpath \"{}\"))",
        profile_quote(&codepapr)
    ));
    lines.push(format!(
        "(deny file-write* (subpath \"{}\"))",
        profile_quote(&codepapr)
    ));

    for name in ["tmp", "tool-output", "downloads"] {
        let dir = codepapr.join(name);
        let _ = fs::create_dir_all(&dir);
        if let Some(canonical) = add_subpath_rule(lines, "allow", "file-read*", &dir) {
            read_roots.push(canonical);
        }
        if access.workspace_write {
            add_subpath_rule(lines, "allow", "file-write*", &dir);
        }
    }

    let skills = codepapr.join("skills");
    if skills.is_dir() {
        if let Some(canonical) = add_subpath_rule(lines, "allow", "file-read*", &skills) {
            read_roots.push(canonical);
        }
    }

    if access.allow_codepapr_apps {
        let apps = codepapr.join("apps");
        let _ = fs::create_dir_all(&apps);
        if let Some(canonical) = add_subpath_rule(lines, "allow", "file-read*", &apps) {
            read_roots.push(canonical);
        }
        if access.workspace_write {
            add_subpath_rule(lines, "allow", "file-write*", &apps);
        }
    }

    if let Some(app_dir) = app_write_dir {
        if let Some(canonical) = add_subpath_rule(lines, "allow", "file-read*", app_dir) {
            read_roots.push(canonical);
        }
        add_subpath_rule(lines, "allow", "file-write*", app_dir);
    }
}

/// 沙箱访问档：按两轴权限构建 sandbox-exec profile。
/// - `network`：出站网络（`network*`）。关 = 完全不能联网。
/// - `workspace_write`：工作区（及已授权外部路径）可写。关 = 只读。
/// - `allow_bind`：允许监听端口（后端进程需要；网络关时仍可监听 localhost 供 iframe 访问）。
/// - `allow_codepapr_apps`：放行 `.CodePapr/apps`（App 模式 / 应用内 Agent）。默认关。
#[derive(Debug, Clone, Copy)]
pub struct SandboxAccess {
    pub network: bool,
    pub workspace_write: bool,
    pub allow_bind: bool,
    pub allow_codepapr_apps: bool,
}

impl Default for SandboxAccess {
    fn default() -> Self {
        Self { network: true, workspace_write: true, allow_bind: false, allow_codepapr_apps: false }
    }
}

/// tauri 命令参数形态（camelCase），缺省字段回落到全权。
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxAccessArgs {
    #[serde(default = "sandbox_network_default")]
    pub network: bool,
    #[serde(default = "sandbox_workspace_write_default")]
    pub workspace_write: bool,
    #[serde(default)]
    pub allow_bind: bool,
    #[serde(default)]
    pub allow_codepapr_apps: bool,
}

fn sandbox_network_default() -> bool {
    true
}

fn sandbox_workspace_write_default() -> bool {
    true
}

impl From<SandboxAccessArgs> for SandboxAccess {
    fn from(args: SandboxAccessArgs) -> Self {
        Self {
            network: args.network,
            workspace_write: args.workspace_write,
            allow_bind: args.allow_bind,
            allow_codepapr_apps: args.allow_codepapr_apps,
        }
    }
}

/// 后端进程（allow_bind）的脚本所在目录：即使工作区只读，app 也要能写自己的
/// 运行时数据（DB/WAL/日志）。相对路径按进程工作目录解析（后端 app 的 cwd
/// 是其 app 目录，manifest args 里的 "server.js" 即相对该目录）；args[0] 是
/// 标志位（如 -c/-m）或无法推导时不放行。绝不能按工作区根解析：
/// "server.js" 的父目录会变成工作区根本身，等于给只读 app 放行整个工作区写。
#[cfg(target_os = "macos")]
fn backend_app_dir(args: &[String], cwd: &Path) -> Option<PathBuf> {
    let script = args.first().map(String::as_str)?;
    if script.starts_with('-') {
        return None;
    }
    let script_path = Path::new(script);
    let resolved = if script_path.is_absolute() {
        script_path.to_path_buf()
    } else {
        cwd.join(script_path)
    };
    let parent = resolved.parent()?;
    if parent.as_os_str().is_empty() {
        return None;
    }
    Some(parent.to_path_buf())
}

/// `cwd` 是进程的实际工作目录：backend_app_dir 按它解析 args 里的相对脚本
/// 路径。调用方必须传入与 `current_dir` 一致的值，否则沙箱写放行会落错目录。
pub fn sandboxed_command(
    program: &str,
    args: &[String],
    workspace: &Path,
    access: Option<SandboxAccess>,
    cwd: &Path,
) -> Result<Command, String> {
    #[cfg(target_os = "macos")]
    {
        let access = access.unwrap_or_default();
        let app_write_dir = if access.allow_bind {
            backend_app_dir(args, cwd)
        } else {
            None
        };
        let profile = build_profile(program, workspace, Some(access), app_write_dir.as_deref())?;
        let mut command = Command::new("/usr/bin/sandbox-exec");
        command.arg("-p").arg(profile).arg(program).args(args);
        return Ok(command);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = access;
        let cwd_canon = canonicalize_with_existing_ancestor(cwd)?;
        let ws_canon = canonicalize_with_existing_ancestor(workspace)?;
        if !cwd_canon.starts_with(&ws_canon) {
            return Err(format!(
                "工作目录必须位于工作区内（cwd={}, workspace={}）",
                cwd.display(),
                workspace.display()
            ));
        }
        let mut command = Command::new(program);
        command.args(args);
        Ok(command)
    }
}

pub(crate) fn sandboxed_shell_command(
    shell: &str,
    command_line: &str,
    workspace: &Path,
    access: Option<SandboxAccess>,
    cwd: &Path,
) -> Result<Command, String> {
    #[cfg(windows)]
    let shell_args = ["/C".to_string(), command_line.to_string()];
    #[cfg(not(windows))]
    let shell_args = ["-c".to_string(), command_line.to_string()];
    let mut command = sandboxed_command(shell, &shell_args, workspace, access, cwd)?;
    #[cfg(not(target_os = "windows"))]
    command.env("PATH", crate::shared::expanded_path());
    Ok(command)
}

fn shell_command_tokens(command: &str) -> Vec<String> {
    command
        .split(|character: char| character.is_whitespace() || "\"'`=<>|;&()".contains(character))
        .map(|token| token.trim_matches(|character| ",.;".contains(character)))
        .filter(|token| !token.is_empty())
        .map(ToString::to_string)
        .collect()
}

/// 规范化路径；路径尚不存在（如将要创建的文件）时回退到最近的已存在祖先目录。
fn canonicalize_with_existing_ancestor(path: &Path) -> Result<PathBuf, String> {
    match std::fs::canonicalize(path) {
        Ok(target) => Ok(target),
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
                .map_err(|err| format!("命令路径不存在或无法访问: {err}"))
        }
    }
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
    let target = canonicalize_with_existing_ancestor(Path::new(raw_path))?;
    crate::shared::ensure_path_accessible(workspace, &target)
}

#[cfg(not(target_os = "windows"))]
fn unix_absolute_token(token: &str) -> bool {
    token.starts_with('/')
}

/// Unix 平台的命令路径预检，与 sandbox-exec profile 的放行集对齐：
/// 1. workspace 子路径直接放行（工作区内的 .git/.config 等是合法项目数据）；
/// 2. 受保护目录先于放行集拒绝——profile 的 deny 规则追加在 allow 之后、
///    优先级更高，PATH 里的 ~/.config/yarn 等子路径不得放行；
/// 3. 命中 unix_allowed_read_roots（系统/工具/PATH/Homebrew）放行；
/// 4. 其余交给 ensure_path_accessible 按 yolo/已授权目录与文件裁决。
#[cfg(not(target_os = "windows"))]
fn ensure_unix_command_path(workspace: &Path, raw_path: &str) -> Result<(), String> {
    let target = canonicalize_with_existing_ancestor(Path::new(raw_path))?;
    if crate::shared::path_is_same_or_child(&target, workspace) {
        return Ok(());
    }
    if crate::shared::is_protected_external_path(&target) {
        return Err(format!(
            "安全限制：禁止访问受保护的隐藏目录 {}",
            target.display()
        ));
    }
    if unix_allowed_read_roots()
        .iter()
        .any(|root| crate::shared::path_is_same_or_child(&target, root))
    {
        return Ok(());
    }
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

/// 无内核沙箱的 Unix 平台（Linux 等）：macOS 有 sandbox-exec 在运行时按真实
/// 路径裁决，这些平台没有运行时强制层。~、$VAR、反引号、进程替换等动态语法
/// 由 shell 在运行时展开，静态无法裁决其访问范围，必须预先拒绝
/// （与 Windows 的 reject_dynamic_windows_shell_syntax 同一思路）。
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn reject_dynamic_unix_shell_syntax(command: &str) -> Result<(), String> {
    let has_variable = command.char_indices().any(|(index, character)| {
        character == '$'
            && command[index + character.len_utf8()..]
                .chars()
                .next()
                .map(|next| next.is_ascii_alphanumeric() || matches!(next, '{' | '('))
                .unwrap_or(false)
    });
    let has_tilde_token = shell_command_tokens(command)
        .iter()
        .any(|token| token.starts_with('~'));
    if has_variable
        || has_tilde_token
        || command.contains('`')
        || command.contains("..")
        || command.contains("<(")
        || command.contains(">(")
    {
        return Err(
            "安全限制：当前平台没有内核级沙箱，无法裁决 ~、$变量、反引号、进程替换等动态路径，请改用项目内相对路径或已授权的明确绝对路径"
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
            for token in shell_command_tokens(argument) {
                if windows_absolute_token(&token) {
                    ensure_windows_command_path(workspace, &token)?;
                }
            }
        }
        let _ = command;
    }

    #[cfg(target_os = "macos")]
    {
        for argument in args {
            for token in shell_command_tokens(argument) {
                if unix_absolute_token(&token) {
                    ensure_unix_command_path(workspace, &token)?;
                }
            }
        }
        let _ = command;
    }

    // 其余非 Windows 平台（Linux 等）没有内核沙箱兜底（macOS 的 sandbox-exec
    // 在运行时按真实路径裁决）：直接命令（program + argv，无 shell 展开）的
    // 相对路径参数若含 `..` 路径段，会在工作区 cwd 下越狱读/写工作区外文件。
    // 旧实现只检查绝对路径 token（ensure_unix_command_path），`cat ../../etc/
    // passwd` 这类相对路径完全放行。shell 路径有 reject_dynamic_unix_shell_
    // syntax 兜底，直接命令路径之前没有。按路径段匹配（`..` 作为完整段）避免
    // 误伤 `HEAD..HEAD~1`（git 区间语法）等合法 token。
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let has_parent_dir_segment = |token: &str| token.split('/').any(|seg| seg == "..");
        // 直接命令的 command 与 args 都是单 argv 条目：按原始字符串检查 `..`
        // 路径段——不能过 shell_command_tokens（其 trim_matches(",.;") 会把
        // 裸 ".." 裁成空 token 漏检，`cat ..` 就能越狱到父目录）。
        if has_parent_dir_segment(command) {
            return Err(format!(
                "安全限制：当前平台没有内核级沙箱，命令本体不能包含 .. 路径段（{command}），请使用工作区内的相对路径或已授权的绝对路径"
            ));
        }
        for argument in args {
            if has_parent_dir_segment(argument) {
                return Err(format!(
                    "安全限制：当前平台没有内核级沙箱，命令参数中的相对路径不能包含 .. 路径段（{argument}），请改用工作区内的相对路径或已授权的绝对路径"
                ));
            }
            for token in shell_command_tokens(argument) {
                if unix_absolute_token(&token) {
                    ensure_unix_command_path(workspace, &token)?;
                }
            }
        }
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
        for (index, token) in shell_command_tokens(command).into_iter().enumerate() {
            if index > 0 && windows_absolute_token(&token) {
                ensure_windows_command_path(workspace, &token)?;
            }
        }
    }

    // macOS 有 sandbox-exec：内核沙箱在运行时按真实路径裁决（含动态语法的
    // 展开结果），预拒会误杀合法命令；只检查字面绝对路径 token。
    #[cfg(target_os = "macos")]
    {
        for (index, token) in shell_command_tokens(command).into_iter().enumerate() {
            if index > 0 && unix_absolute_token(&token) {
                ensure_unix_command_path(workspace, &token)?;
            }
        }
    }

    // 其余非 Windows 平台（Linux 等）没有运行时裁决层：先拒绝无法静态裁决的
    // 动态语法，再检查字面绝对路径 token。
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        reject_dynamic_unix_shell_syntax(command)?;
        for (index, token) in shell_command_tokens(command).into_iter().enumerate() {
            if index > 0 && unix_absolute_token(&token) {
                ensure_unix_command_path(workspace, &token)?;
            }
        }
    }
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::{
        backend_app_dir, build_profile, profile_quote, sandboxed_command,
        validate_restricted_command, validate_restricted_shell_command, SandboxAccess,
    };
    use std::fs;
    use std::path::{Path, PathBuf};

    #[test]
    fn sandboxed_runtime_command_can_start() {
        let workspace =
            std::env::temp_dir().join(format!("codepapr-sandbox-test-{}", std::process::id()));
        fs::create_dir_all(&workspace).expect("sandbox test workspace should exist");

        let mut command =
            sandboxed_command("/bin/echo", &["sandbox-ok".to_string()], &workspace, None, &workspace)
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

    /// 回归 #17：profile_quote 必须转义控制字符——含换行的路径若原样嵌入
    /// SBPL 字面量会提前终止表达式（注入）。转义为空格后规则仍合法。
    #[test]
    #[cfg(target_os = "macos")]
    fn profile_quote_escapes_control_characters() {
        let quoted = profile_quote(Path::new("/tmp/evil\nline\"quote\\back"));
        assert!(!quoted.contains('\n'), "换行必须被转义: {quoted:?}");
        assert!(!quoted.contains('\r'), "回车必须被转义: {quoted:?}");
        assert!(!quoted.contains('\t'), "制表符必须被转义: {quoted:?}");
        // 反斜杠与双引号保持原有转义语义
        assert!(quoted.contains("\\\\"), "反斜杠必须保留转义: {quoted:?}");
        assert!(quoted.contains("\\\""), "双引号必须保留转义: {quoted:?}");

        // 常规路径不受影响
        let normal = profile_quote(Path::new("/Users/example/Work/My App"));
        assert_eq!(normal, "/Users/example/Work/My App");
    }

    #[test]
    fn profile_canonicalizes_symlinked_paths() {        let workspace =
            std::env::temp_dir().join(format!("codepapr-sandbox-profile-{}", std::process::id()));
        fs::create_dir_all(&workspace).expect("sandbox test workspace should exist");
        let profile =
            build_profile("/bin/zsh", &workspace, None, None).expect("profile should build");
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
    fn profile_respects_two_axis_access() {
        let workspace =
            std::env::temp_dir().join(format!("codepapr-sandbox-axis-{}", std::process::id()));
        fs::create_dir_all(&workspace).expect("sandbox test workspace should exist");

        // 网络关 + 工作区只读：无 network*、无工作区写规则
        let restricted = build_profile(
            "/bin/zsh",
            &workspace,
            Some(SandboxAccess { network: false, workspace_write: false, allow_bind: false, allow_codepapr_apps: false }),
            None,
        )
        .expect("profile should build");
        assert!(!restricted.contains("(allow network*)"), "got:\n{restricted}");
        assert!(
            !restricted.contains(&format!("(allow file-write* (subpath \"{}\")", workspace.display())),
            "workspace write must be absent:\n{restricted}"
        );
        assert!(!restricted.contains("(allow network-bind)"), "got:\n{restricted}");
        assert!(!restricted.contains("(allow network-inbound)"), "got:\n{restricted}");

        // 后端进程（网络关）：允许 bind + inbound（Node listen 需要后者），无出站。
        // 回环约束不在 SBPL 层，由 app_start 的 check_port_bind_address 强制。
        let backend = build_profile(
            "/bin/zsh",
            &workspace,
            Some(SandboxAccess { network: false, workspace_write: true, allow_bind: true, allow_codepapr_apps: false }),
            None,
        )
        .expect("profile should build");
        assert!(backend.contains("(allow network-bind)"), "got:\n{backend}");
        assert!(backend.contains("(allow network-inbound)"), "got:\n{backend}");
        assert!(!backend.contains("(allow network*)"), "got:\n{backend}");

        // 网络开：完整 network*
        let full = build_profile(
            "/bin/zsh",
            &workspace,
            Some(SandboxAccess { network: true, workspace_write: true, allow_bind: false, allow_codepapr_apps: false }),
            None,
        )
        .expect("profile should build");
        assert!(full.contains("(allow network*)"), "got:\n{full}");

        let _ = fs::remove_dir_all(&workspace);
    }

    #[test]
    fn profile_denies_codepapr_except_scratch() {
        let workspace =
            std::env::temp_dir().join(format!("codepapr-sandbox-cp-{}", std::process::id()));
        fs::create_dir_all(workspace.join(".CodePapr/git")).expect("internal dir");
        fs::write(workspace.join(".CodePapr/git/HEAD"), b"secret\n").expect("write secret");

        let profile = build_profile("/bin/zsh", &workspace, None, None).expect("profile");
        let codepapr = workspace
            .canonicalize()
            .expect("workspace")
            .join(".CodePapr");
        assert!(
            profile.contains(&format!(
                "(deny file-read* (subpath \"{}\"))",
                codepapr.display()
            )),
            "must deny .CodePapr:\n{profile}"
        );
        let tmp = codepapr.join("tmp");
        assert!(
            profile.contains(&format!(
                "(allow file-read* (subpath \"{}\"))",
                tmp.canonicalize().expect("tmp").display()
            )),
            "must allow scratch tmp:\n{profile}"
        );
        assert!(
            !profile.contains(&format!(
                "(allow file-read* (subpath \"{}\"))",
                codepapr.join("git").display()
            )),
            "must not allow git:\n{profile}"
        );

        let apps_flag = build_profile(
            "/bin/zsh",
            &workspace,
            Some(SandboxAccess {
                network: true,
                workspace_write: true,
                allow_bind: false,
                allow_codepapr_apps: true,
            }),
            None,
        )
        .expect("profile");
        let apps = codepapr.join("apps");
        assert!(
            apps_flag.contains(&format!(
                "(allow file-read* (subpath \"{}\"))",
                apps.canonicalize().expect("apps").display()
            )),
            "flag must allow apps:\n{apps_flag}"
        );

        let _ = fs::remove_dir_all(&workspace);
    }

    #[test]
    fn sandboxed_ls_codepapr_is_denied_but_scratch_is_readable() {
        let workspace =
            std::env::temp_dir().join(format!("codepapr-sandbox-lscp-{}", std::process::id()));
        fs::create_dir_all(workspace.join(".CodePapr/git")).expect("internal dir");
        fs::write(workspace.join(".CodePapr/git/HEAD"), b"secret\n").expect("write secret");

        let mut denied = sandboxed_command(
            "/bin/ls",
            &[".CodePapr".to_string()],
            &workspace,
            None,
            &workspace,
        )
        .expect("command");
        denied.current_dir(&workspace);
        let denied_out = denied.output().expect("run");
        let denied_stdout = String::from_utf8_lossy(&denied_out.stdout);
        assert!(
            !denied_out.status.success() || !denied_stdout.contains("git"),
            "ls .CodePapr must not list internals; stdout={denied_stdout} stderr={:?}",
            String::from_utf8_lossy(&denied_out.stderr)
        );

        let mut allowed = sandboxed_command(
            "/bin/ls",
            &[".CodePapr/tmp".to_string()],
            &workspace,
            None,
            &workspace,
        )
        .expect("command");
        allowed.current_dir(&workspace);
        let allowed_out = allowed.output().expect("run");
        assert!(
            allowed_out.status.success(),
            "ls scratch tmp must succeed; stderr={:?}",
            String::from_utf8_lossy(&allowed_out.stderr)
        );

        let _ = fs::remove_dir_all(&workspace);
    }

    /// 回归：profile 必须放行 mach-lookup、lsopen 与 sysctl-read，否则
    /// `open`（内核 deny lsopen → -54/kLSNoExecutableErr）、`osascript`
    /// AppleEvents（-1728）、`ps`/`pgrep`（sysctl kern.proc）全部失效。
    /// 与两轴权限无关，任何访问档下都要存在。
    #[test]
    fn profile_allows_mach_lookup_and_sysctl_read() {
        let workspace =
            std::env::temp_dir().join(format!("codepapr-sandbox-ipc-{}", std::process::id()));
        fs::create_dir_all(&workspace).expect("sandbox test workspace should exist");

        for access in [
            None,
            Some(SandboxAccess { network: false, workspace_write: false, allow_bind: false, allow_codepapr_apps: false }),
            Some(SandboxAccess { network: true, workspace_write: true, allow_bind: true, allow_codepapr_apps: false }),
        ] {
            let profile = build_profile("/bin/zsh", &workspace, access, None)
                .expect("profile should build");
            assert!(profile.contains("(allow mach-lookup)"), "got:\n{profile}");
            assert!(profile.contains("(allow lsopen)"), "got:\n{profile}");
            assert!(profile.contains("(allow sysctl-read)"), "got:\n{profile}");
        }

        let _ = fs::remove_dir_all(&workspace);
    }

    /// 功能测试的工作区不能放在系统临时目录里：临时目录在沙箱中始终可写，
    /// 会掩盖"工作区只读"的断言。
    fn home_test_workspace(suffix: &str) -> PathBuf {
        let home = std::env::var_os("HOME").expect("HOME must be set");
        PathBuf::from(home).join(format!("codepapr-sandbox-{suffix}-{}", std::process::id()))
    }

    #[test]
    fn backend_profile_grants_app_dir_write_under_read_only_workspace() {
        let workspace = home_test_workspace("appdir-p");
        let app_dir = workspace.join("apps").join("demo");
        fs::create_dir_all(&app_dir).expect("app dir should exist");

        let profile = build_profile(
            "/bin/zsh",
            &workspace,
            Some(SandboxAccess { network: true, workspace_write: false, allow_bind: true, allow_codepapr_apps: false }),
            Some(app_dir.as_path()),
        )
        .expect("profile should build");
        let canonical_app_dir = app_dir.canonicalize().expect("app dir should canonicalize");
        let canonical_workspace = workspace.canonicalize().expect("workspace should canonicalize");
        let _ = fs::remove_dir_all(&workspace);

        assert!(
            profile.contains(&format!(
                "(allow file-write* (subpath \"{}\"))",
                canonical_app_dir.display()
            )),
            "app dir must be writable for backend spawns; got:\n{profile}"
        );
        assert!(
            !profile.contains(&format!(
                "(allow file-write* (subpath \"{}\"))",
                canonical_workspace.display()
            )),
            "workspace itself must stay read-only; got:\n{profile}"
        );
    }

    #[test]
    fn backend_spawn_can_write_app_dir_but_not_rest_of_workspace() {
        let workspace = home_test_workspace("appdir-f");
        let app_dir = workspace.join("apps").join("demo");
        fs::create_dir_all(&app_dir).expect("app dir should exist");

        let app_probe = app_dir.join("runtime.txt");
        let ws_probe = workspace.join("outside.txt");
        let script = app_dir.join("run.sh");
        fs::write(
            &script,
            format!(
                "touch {} && echo APP_WRITE_OK\ntouch {} && echo WS_WRITE_OK\nexit 0\n",
                app_probe.display(),
                ws_probe.display()
            ),
        )
        .expect("script should be written");

        let access = SandboxAccess { network: false, workspace_write: false, allow_bind: true, allow_codepapr_apps: false };
        let mut command = sandboxed_command(
            "/bin/zsh",
            &[script.display().to_string()],
            &workspace,
            Some(access),
            &app_dir,
        )
        .expect("sandbox command should build");
        let output = command.output().expect("sandbox command should start");

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let app_written = app_probe.exists();
        let ws_written = ws_probe.exists();
        let _ = fs::remove_dir_all(&workspace);

        assert!(
            stdout.contains("APP_WRITE_OK") && app_written,
            "backend must write into its own app dir; stdout={stdout} stderr={:?}",
            output.stderr
        );
        assert!(
            !stdout.contains("WS_WRITE_OK") && !ws_written,
            "backend must not write the rest of a read-only workspace"
        );
    }

    #[test]
    fn non_backend_spawn_gets_no_app_dir_write() {
        let workspace = home_test_workspace("appdir-n");
        let app_dir = workspace.join("apps").join("demo");
        fs::create_dir_all(&app_dir).expect("app dir should exist");

        let app_probe = app_dir.join("runtime.txt");
        let script = app_dir.join("run.sh");
        fs::write(
            &script,
            format!("touch {} && echo APP_WRITE_OK\nexit 0\n", app_probe.display()),
        )
        .expect("script should be written");

        // allow_bind=false（非后端 spawn）：即使 args[0] 指向脚本也不放行 app 目录写
        let access = SandboxAccess { network: false, workspace_write: false, allow_bind: false, allow_codepapr_apps: false };
        let mut command = sandboxed_command(
            "/bin/zsh",
            &[script.display().to_string()],
            &workspace,
            Some(access),
            &app_dir,
        )
        .expect("sandbox command should build");
        let output = command.output().expect("sandbox command should start");

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let written = app_probe.exists();
        let _ = fs::remove_dir_all(&workspace);

        assert!(
            !stdout.contains("APP_WRITE_OK") && !written,
            "non-backend spawn must not gain app dir write; stdout={stdout}"
        );
    }

    /// 回归：相对脚本路径必须按进程工作目录解析，不能按工作区根解析。
    /// 旧实现 workspace.join("server.js").parent() = 工作区根，等于给
    /// local=read 的后端 app 放行整个工作区的 file-write*。
    #[test]
    fn backend_app_dir_resolves_relative_script_against_cwd() {
        let workspace = PathBuf::from("/tmp/codepapr-ws");
        let app_dir = workspace.join(".CodePapr/apps/demo");

        let resolved = backend_app_dir(&["server.js".to_string()], &app_dir)
            .expect("relative script must resolve against cwd");
        assert_eq!(resolved, app_dir, "app dir must be the script's parent under cwd");

        // 绝对脚本不受 cwd 影响
        let abs = backend_app_dir(
            &["/opt/tools/runner/main.py".to_string()],
            &app_dir,
        )
        .expect("absolute script must resolve to its own parent");
        assert_eq!(abs, PathBuf::from("/opt/tools/runner"));

        // args[0] 是标志位（node -e / python -m / zsh -c）：无脚本可推导，不放行
        assert!(backend_app_dir(&["-c".to_string(), "node server.js".to_string()], &app_dir).is_none());
        assert!(backend_app_dir(&["-m".to_string(), "http.server".to_string()], &app_dir).is_none());
        assert!(backend_app_dir(&[], &app_dir).is_none());
    }

    /// 功能回归（math-mentor 事故）：manifest args 是相对 app 目录的
    /// "server.js"，cwd=app 目录时后端必须能写自己的目录、不能写只读工作区。
    #[test]
    fn backend_spawn_relative_args_with_app_cwd_writes_only_app_dir() {
        let workspace = home_test_workspace("appdir-rel");
        let app_dir = workspace.join(".CodePapr/apps/demo");
        fs::create_dir_all(&app_dir).expect("app dir should exist");

        let app_probe = app_dir.join("runtime.txt");
        let ws_probe = workspace.join("outside.txt");
        fs::write(
            app_dir.join("run.sh"),
            format!(
                "touch {} && echo APP_WRITE_OK\ntouch {} && echo WS_WRITE_OK\nexit 0\n",
                app_probe.display(),
                ws_probe.display()
            ),
        )
        .expect("script should be written");

        let access = SandboxAccess { network: false, workspace_write: false, allow_bind: true, allow_codepapr_apps: false };
        let mut command = sandboxed_command(
            "/bin/zsh",
            &["run.sh".to_string()],
            &workspace,
            Some(access),
            &app_dir,
        )
        .expect("sandbox command should build");
        command.current_dir(&app_dir);
        let output = command.output().expect("sandbox command should start");

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let app_written = app_probe.exists();
        let ws_written = ws_probe.exists();
        let _ = fs::remove_dir_all(&workspace);

        assert!(
            stdout.contains("APP_WRITE_OK") && app_written,
            "relative script under app cwd must write its own dir; stdout={stdout} stderr={:?}",
            output.stderr
        );
        assert!(
            !stdout.contains("WS_WRITE_OK") && !ws_written,
            "read-only workspace must stay read-only; stdout={stdout}"
        );
    }

    #[test]
    fn profile_grants_ancestor_metadata_for_read_roots() {        let workspace = std::env::temp_dir().join(format!(
            "codepapr-sandbox-ancestors-{}",
            std::process::id()
        ));
        fs::create_dir_all(&workspace).expect("sandbox test workspace should exist");
        // 显式 workspace_write=false：否则本机若开启 YOLO 外部访问策略，
        // profile 走全盘放行分支，workspace 专属规则（本测试的断言对象）不生成。
        let profile = build_profile(
            "/bin/zsh",
            &workspace,
            Some(SandboxAccess { network: false, workspace_write: false, allow_bind: false, allow_codepapr_apps: false }),
            None,
        )
        .expect("profile should build");
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
            sandboxed_command("/bin/zsh", &["-c".to_string(), script], &workspace, None, &workspace)
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
            None,
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
            sandboxed_command(
                "/opt/homebrew/bin/npm",
                &["--version".to_string()],
                &workspace,
                None,
                &workspace,
            )
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

    #[test]
    fn unix_validation_allows_workspace_and_system_paths() {
        // 工作区不能放在临时目录：临时目录本身是放行根，会掩盖工作区断言
        let workspace = home_test_workspace("unixval-ok");
        fs::create_dir_all(&workspace).expect("workspace should exist");
        let probe = workspace.join("a.txt");
        fs::write(&probe, "x").expect("probe should be written");

        validate_restricted_command("cat", &[probe.display().to_string()], &workspace)
            .expect("workspace path must pass");
        validate_restricted_command("ls", &["/usr/bin".to_string()], &workspace)
            .expect("system path must pass");
        validate_restricted_shell_command(&format!("cat {}", probe.display()), &workspace)
            .expect("shell command with workspace path must pass");
        validate_restricted_shell_command("echo hello && ls -la", &workspace)
            .expect("relative shell command must pass");

        // 工作区内的 .git 是合法项目数据：workspace 判定先于受保护目录规则
        let ws_git_file = workspace.join(".git").join("config");
        fs::create_dir_all(ws_git_file.parent().unwrap()).expect(".git dir should exist");
        fs::write(&ws_git_file, "x").expect("git config should be written");
        validate_restricted_command("cat", &[ws_git_file.display().to_string()], &workspace)
            .expect("workspace .git must pass");

        // 尚不存在的工作区路径（将要创建的文件）：回退祖先目录判定
        let future = workspace.join("not-created-yet.txt");
        validate_restricted_command("touch", &[future.display().to_string()], &workspace)
            .expect("nonexistent workspace path must pass via ancestor fallback");

        let _ = fs::remove_dir_all(&workspace);
    }

    #[test]
    fn unix_validation_rejects_protected_and_unauthorized_paths() {
        let workspace = home_test_workspace("unixval-deny");
        fs::create_dir_all(&workspace).expect("workspace should exist");
        let home = PathBuf::from(std::env::var_os("HOME").expect("HOME must be set"));
        let pid = std::process::id();

        // 受保护目录：即使 YOLO 模式也必须拒绝（与 profile 尾部 deny 规则一致）
        let protected_dir = home.join(format!("codepapr-unixval-protected-{pid}"));
        let protected_file = protected_dir.join(".aws").join("credentials");
        fs::create_dir_all(protected_file.parent().unwrap())
            .expect("protected dir should exist");
        fs::write(&protected_file, "x").expect("protected file should be written");

        let err = validate_restricted_command(
            "cat",
            &[protected_file.display().to_string()],
            &workspace,
        )
        .expect_err("protected path must be rejected");
        assert!(err.contains("受保护"), "unexpected error: {err}");

        let err = validate_restricted_shell_command(
            &format!("cat {}", protected_file.display()),
            &workspace,
        )
        .expect_err("protected path in shell command must be rejected");
        assert!(err.contains("受保护"), "unexpected error: {err}");

        // 未授权外部路径：非 YOLO 策略下拒绝
        let outside_dir = home.join(format!("codepapr-unixval-outside-{pid}"));
        let outside_file = outside_dir.join("secret.txt");
        fs::create_dir_all(&outside_dir).expect("outside dir should exist");
        fs::write(&outside_file, "x").expect("outside file should be written");

        if !crate::db::load_external_access_policy()
            .expect("policy should load")
            .yolo
        {
            let err = validate_restricted_command(
                "cat",
                &[outside_file.display().to_string()],
                &workspace,
            )
            .expect_err("unauthorized outside path must be rejected");
            assert!(err.contains("未获授权"), "unexpected error: {err}");

            let err = validate_restricted_shell_command(
                &format!("cat {}", outside_file.display()),
                &workspace,
            )
            .expect_err("unauthorized outside path in shell command must be rejected");
            assert!(err.contains("未获授权"), "unexpected error: {err}");
        }

        let _ = fs::remove_dir_all(&protected_dir);
        let _ = fs::remove_dir_all(&outside_dir);
        let _ = fs::remove_dir_all(&workspace);
    }
}

#[cfg(all(test, not(any(target_os = "macos", target_os = "windows"))))]
mod linux_tests {
    use super::{reject_dynamic_unix_shell_syntax, validate_restricted_command};

    #[test]
    fn dynamic_syntax_is_rejected_without_kernel_sandbox() {
        for command in [
            "cat ~/.ssh/id_rsa",
            "tar czf x.tgz ~/.aws",
            "cat $HOME/.aws/credentials",
            "cat ${HOME}/.ssh/id_rsa",
            "echo $(whoami)",
            "cat `echo /etc/passwd`",
            "ls ..",
            "cat ../secret.txt",
            "diff <(cat /etc/passwd) x",
            "cd ~",
        ] {
            assert!(
                reject_dynamic_unix_shell_syntax(command).is_err(),
                "should reject: {command}"
            );
        }
    }

    #[test]
    fn plain_commands_still_pass() {
        for command in [
            "ls -la",
            "cat notes.txt",
            "npm run build",
            "grep -r TODO src",
            "echo 100%",
            "python train.py --epochs 10",
        ] {
            assert!(
                reject_dynamic_unix_shell_syntax(command).is_ok(),
                "should allow: {command}"
            );
        }
    }

    /// #19：直接命令（program + argv）的相对路径参数含 `..` 路径段必须拒绝。
    /// 旧实现只检查绝对路径 token——`cat ../../etc/passwd` 直接越狱读工作区外
    /// 文件，Linux 无 sandbox-exec 兜底。
    #[test]
    fn direct_command_parent_dir_segments_are_rejected() {
        let workspace = std::path::PathBuf::from("/tmp/codepapr-linux-guard");
        for (command, args) in [
            ("cat", vec!["../../etc/passwd".to_string()]),
            ("cat", vec!["a/../b.txt".to_string()]),
            ("cat", vec!["..".to_string()]),
            ("ls", vec!["-la".to_string(), "sub/../../..".to_string()]),
            ("../../bin/evil", vec![]),
            ("./../escape.sh", vec![]),
        ] {
            match validate_restricted_command(command, &args, &workspace) {
                Ok(()) => panic!("CASE {command:?} {args:?} was NOT rejected"),
                Err(e) if e.contains("安全限制") => {}
                Err(e) => panic!("CASE {command:?} {args:?} rejected with unexpected error: {e}"),
            }
        }
    }

    /// 合法 token 不受影响：git 区间语法（HEAD..HEAD~1）、版本号、相对路径。
    #[test]
    fn direct_command_legit_tokens_still_pass() {
        let workspace = std::path::PathBuf::from("/tmp/codepapr-linux-guard");
        for (command, args) in [
            ("git", vec!["log".to_string(), "HEAD..HEAD~1".to_string()]),
            ("cat", vec!["notes.txt".to_string()]),
            ("ls", vec!["-la".to_string(), "src".to_string()]),
            ("python", vec!["train.py".to_string(), "--lr=0.1.0".to_string()]),
        ] {
            validate_restricted_command(command, &args, &workspace)
                .unwrap_or_else(|e| panic!("should pass: {command} {args:?} -> {e}"));
        }
    }
}
