use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use std::{env, fs};

static EXPANDED_PATH: OnceLock<String> = OnceLock::new();

#[cfg(test)]
use std::sync::Mutex;

/// Serializes tests that override `CODEPAPR_TEST_HOME` so they do not leak into
/// parallel tests that also call `home_dir()`.
#[cfg(test)]
pub static TEST_HOME_LOCK: Mutex<()> = Mutex::new(());

fn append_if_dir(paths: &mut Vec<PathBuf>, path: impl Into<PathBuf>) {
    let path = path.into();
    if path.is_dir() && !paths.iter().any(|existing| existing == &path) {
        paths.push(path);
    }
}

fn append_common_command_dirs(paths: &mut Vec<PathBuf>) {
    #[cfg(target_os = "macos")]
    {
        append_if_dir(paths, "/opt/homebrew/bin");
        append_if_dir(paths, "/usr/local/bin");
        append_if_dir(paths, "/usr/bin");
        append_if_dir(paths, "/bin");
    }
    if let Ok(home) = env::var("HOME").or_else(|_| env::var("USERPROFILE")) {
        let home = Path::new(&home);
        append_if_dir(paths, home.join(".volta/bin"));
        append_if_dir(paths, home.join(".fnm"));
        append_if_dir(paths, home.join(".local/bin"));
        append_if_dir(paths, home.join(".cargo/bin"));
        if let Ok(entries) = fs::read_dir(home.join(".nvm/versions/node")) {
            let mut node_bins: Vec<PathBuf> = entries
                .flatten()
                .map(|entry| entry.path().join("bin"))
                .filter(|path| path.is_dir())
                .collect();
            node_bins.sort();
            for path in node_bins.into_iter().rev() {
                append_if_dir(paths, path);
            }
        }
        append_if_dir(paths, home.join(".yarn/bin"));
        append_if_dir(paths, home.join(".config/yarn/global/node_modules/.bin"));
    }
}

fn join_paths_or_current(paths: Vec<PathBuf>) -> String {
    env::join_paths(paths)
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|_| env::var("PATH").unwrap_or_default())
}

pub fn expanded_path() -> String {
    EXPANDED_PATH
        .get_or_init(|| {
            #[cfg(target_os = "macos")]
            {
                if let Ok(output) = std::process::Command::new("/usr/libexec/path_helper")
                    .arg("-s")
                    .output()
                {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    if let Some(line) = stdout.lines().find(|line| line.starts_with("PATH=")) {
                        let shell_path = line
                            .strip_prefix("PATH=")
                            .unwrap_or("")
                            .trim_matches('"')
                            .trim_matches('\'');
                        if !shell_path.is_empty() {
                            let home = env::var("HOME").unwrap_or_default();
                            let mut paths: Vec<PathBuf> = env::split_paths(shell_path)
                                .map(|path| {
                                    let s = path.to_string_lossy().to_string();
                                    if s.starts_with('~') {
                                        PathBuf::from(s.replacen('~', &home, 1))
                                    } else {
                                        path
                                    }
                                })
                                .collect();
                            append_common_command_dirs(&mut paths);
                            return join_paths_or_current(paths);
                        }
                    }
                }
            }

            let mut paths: Vec<PathBuf> = env::var_os("PATH")
                .map(|value| env::split_paths(&value).collect())
                .unwrap_or_default();
            append_common_command_dirs(&mut paths);
            join_paths_or_current(paths)
        })
        .clone()
}

/// Parsed user input for a workspace-relative path with optional line/column anchor.
#[derive(Debug, Clone)]
pub struct PathLocationInput {
    pub path: String,
    pub line: Option<usize>,
    pub column: Option<usize>,
}

/// Resolve the user's home directory from environment variables.
pub fn home_dir() -> Result<PathBuf, String> {
    #[cfg(test)]
    {
        if let Some(home) = std::env::var_os("CODEPAPR_TEST_HOME") {
            if !home.is_empty() {
                return Ok(PathBuf::from(home));
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            if !profile.is_empty() {
                return Ok(PathBuf::from(profile));
            }
        }
    }

    if let Some(home) = std::env::var_os("HOME") {
        if !home.is_empty() {
            return Ok(PathBuf::from(home));
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            if !profile.is_empty() {
                return Ok(PathBuf::from(profile));
            }
        }
    }

    Err("无法定位用户主目录".to_string())
}

/// Canonicalise a workspace path and verify it is a directory.
pub fn canonical_workspace(workspace_path: &str) -> Result<PathBuf, String> {
    let workspace = std::fs::canonicalize(workspace_path)
        .map_err(|err| format!("无法访问项目文件夹: {err}"))?;
    if !workspace.is_dir() {
        return Err("项目文件夹不是目录".to_string());
    }
    Ok(workspace)
}

/// Reject filename components that would break git checkpoint or the
/// filesystem: control characters (0x00–0x1F, including NUL) and backslash
/// (`\`, which git treats as a path separator, causing `index.add_all` to
/// fail and silently breaking "reset to here").
fn validate_filename_component(part: &OsStr) -> Result<(), String> {
    let s = match part.to_str() {
        Some(s) => s,
        None => return Err("文件名包含非 UTF-8 字符".to_string()),
    };
    for (idx, ch) in s.char_indices() {
        if ch == '\\' {
            return Err(format!(
                "文件名不能包含反斜杠 '\\'（git 路径冲突），位置 {}",
                idx
            ));
        }
        if (ch as u32) < 0x20 {
            return Err(format!("文件名不能包含控制字符，位置 {}", idx));
        }
    }
    Ok(())
}

/// Normalise a relative path, rejecting `..`, absolute paths and prefixes.
pub fn normalize_relative_path(relative_path: Option<&str>) -> Result<PathBuf, String> {
    let mut normalized = PathBuf::new();
    let raw = relative_path.unwrap_or("").trim();
    if raw.is_empty() || raw == "." {
        return Ok(normalized);
    }

    for component in Path::new(raw).components() {
        match component {
            Component::Normal(part) => {
                validate_filename_component(part)?;
                normalized.push(part)
            }
            Component::CurDir => {}
            Component::ParentDir => return Err("路径不能包含 ..".to_string()),
            Component::RootDir | Component::Prefix(_) => {
                return Err("请使用相对于项目文件夹的路径".to_string())
            }
        }
    }

    Ok(normalized)
}

/// Parse a workspace path input that may contain line/column anchors
/// (e.g. `src/main.ts#L10C5` or `src/main.ts:10:5`).
pub fn parse_workspace_path_input(relative_path: Option<&str>) -> PathLocationInput {
    let raw = relative_path.unwrap_or("").trim();
    if raw.is_empty() {
        return PathLocationInput {
            path: String::new(),
            line: None,
            column: None,
        };
    }

    let mut line = None;
    let mut column = None;

    let without_fragment = match raw.rsplit_once('#') {
        Some((base, fragment)) => {
            let upper = fragment.to_ascii_uppercase();
            if let Some(line_digits) = upper.strip_prefix('L') {
                let line_part = line_digits
                    .split_once('C')
                    .map(|(head, _)| head)
                    .unwrap_or(line_digits)
                    .split('-')
                    .next()
                    .unwrap_or("");
                if !line_part.is_empty() && line_part.chars().all(|ch| ch.is_ascii_digit()) {
                    line = line_part.parse::<usize>().ok().filter(|value| *value > 0);
                    if let Some((_, column_part)) = upper.split_once('C') {
                        let column_digits = column_part.split('-').next().unwrap_or("");
                        if !column_digits.is_empty()
                            && column_digits.chars().all(|ch| ch.is_ascii_digit())
                        {
                            column = column_digits
                                .parse::<usize>()
                                .ok()
                                .filter(|value| *value > 0);
                        }
                    }
                    base
                } else {
                    raw
                }
            } else {
                raw
            }
        }
        _ => raw,
    };

    let stripped = if line.is_none() {
        let mut end = without_fragment.len();
        let mut values = Vec::new();
        while values.len() < 2 {
            let prefix = &without_fragment[..end];
            let Some(colon) = prefix.rfind(':') else {
                break;
            };
            let digits = &prefix[colon + 1..];
            if digits.is_empty() || !digits.chars().all(|ch| ch.is_ascii_digit()) {
                break;
            }
            values.push(digits.parse::<usize>().ok().filter(|value| *value > 0));
            end = colon;
        }

        if !values.is_empty() {
            values.reverse();
            line = values.first().and_then(|value| *value);
            column = values.get(1).and_then(|value| *value);
            without_fragment[..end].trim().to_string()
        } else {
            without_fragment.trim().to_string()
        }
    } else {
        without_fragment.trim().to_string()
    };

    PathLocationInput {
        path: stripped,
        line,
        column,
    }
}

/// Return only the path component from a workspace path input.
pub fn sanitize_workspace_path_input(relative_path: Option<&str>) -> String {
    parse_workspace_path_input(relative_path).path
}

/// Resolve a path against a workspace, canonicalising it and applying the
/// shared workspace/external access policy after traversal checks.
pub fn resolve_existing_path(
    workspace_path: &str,
    relative_path: Option<&str>,
) -> Result<(PathBuf, PathBuf), String> {
    let workspace = canonical_workspace(workspace_path)?;
    let raw = sanitize_workspace_path_input(relative_path);
    let candidate = if raw.is_empty() || raw == "." {
        workspace.clone()
    } else {
        let raw_path = PathBuf::from(&raw);
        if raw_path.is_absolute() {
            raw_path
        } else {
            workspace.join(normalize_relative_path(Some(&raw))?)
        }
    };
    let target =
        std::fs::canonicalize(candidate).map_err(|err| format!("路径不存在或无法访问: {err}"))?;
    ensure_path_accessible(&workspace, &target)?;
    Ok((workspace, target))
}

/// Hidden/system directories that must never be auto-authorized by YOLO.
/// Ordinary project dot-directories such as `.github` and `.vscode` remain
/// accessible when they are inside the trusted workspace.
const PROTECTED_EXTERNAL_DIRS: &[&str] = &[
    ".ssh",
    ".gnupg",
    ".config",
    ".aws",
    ".azure",
    ".kube",
    ".git",
    ".CodePapr",
];

pub fn is_protected_external_path(path: &Path) -> bool {
    let hidden_protected = path.components().any(|component| match component {
        Component::Normal(name) => PROTECTED_EXTERNAL_DIRS
            .iter()
            .any(|protected| name.to_string_lossy().eq_ignore_ascii_case(protected)),
        _ => false,
    });

    #[cfg(target_os = "windows")]
    {
        return hidden_protected || is_protected_windows_system_path(path);
    }

    #[cfg(not(target_os = "windows"))]
    {
        hidden_protected
    }
}

#[cfg(target_os = "windows")]
fn is_protected_windows_system_path(path: &Path) -> bool {
    let mut protected = Vec::new();
    for variable in [
        "WINDIR",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramData",
        "APPDATA",
        "LOCALAPPDATA",
    ] {
        if let Some(value) = std::env::var_os(variable) {
            protected.push(PathBuf::from(value));
        }
    }
    protected
        .iter()
        .any(|base| path_is_same_or_child(path, base))
}

pub fn path_is_same_or_child(path: &Path, base: &Path) -> bool {
    let path_value = path_key(path);
    let base_key = path_key(base);
    if base_key == "/" {
        return path_value.starts_with('/');
    }
    path_value == base_key || path_value.starts_with(&(base_key + "/"))
}

pub fn path_is_same(path: &Path, base: &Path) -> bool {
    path_key(path) == path_key(base)
}

fn path_key(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    #[cfg(target_os = "windows")]
    let value = value.to_lowercase();
    let value = value.strip_prefix("//?/").unwrap_or(&value);
    value.trim_end_matches('/').to_string()
}

pub fn ensure_path_accessible(workspace: &Path, target: &Path) -> Result<(), String> {
    let policy = crate::db::load_external_access_policy()?;
    ensure_path_accessible_with_policy(workspace, target, &policy)
}

/// 策略参数化的授权判定核心：工作区内直通；受保护目录一律拒绝；
/// 其余按 yolo / 已授权目录与文件裁决。供需要批量检查（一次载入策略）
/// 或单元测试（构造策略）的调用方复用。
pub fn ensure_path_accessible_with_policy(
    workspace: &Path,
    target: &Path,
    policy: &crate::db::ExternalAccessPolicy,
) -> Result<(), String> {
    if path_is_same_or_child(target, workspace) {
        return Ok(());
    }

    if is_protected_external_path(target) {
        return Err(format!(
            "安全限制：禁止访问受保护的隐藏目录 {}",
            target.display()
        ));
    }

    if policy.yolo {
        return Ok(());
    }

    let is_allowed_dir = policy.allowed_dirs.iter().any(|dir| {
        let allowed = Path::new(dir);
        path_is_same_or_child(target, allowed)
    });
    let is_allowed_file = policy
        .allowed_files
        .iter()
        .any(|file| path_is_same(target, Path::new(file)));
    if is_allowed_dir || is_allowed_file {
        return Ok(());
    }

    Err(format!(
        "外部路径未获授权：{}。请先授权该文件夹或文件",
        target.display()
    ))
}

pub fn ensure_write_path_accessible(workspace: &Path, target: &Path) -> Result<(), String> {
    if path_is_same_or_child(target, workspace) {
        return Ok(());
    }

    if target.exists() {
        let canonical_target = std::fs::canonicalize(target)
            .map_err(|err| format!("路径不存在或无法访问: {err}"))?;
        return ensure_path_accessible(workspace, &canonical_target);
    }

    let mut existing = target
        .parent()
        .ok_or_else(|| "无法确定目标文件目录".to_string())?
        .to_path_buf();
    while !existing.exists() {
        existing = existing
            .parent()
            .ok_or_else(|| "无法确定目标文件目录".to_string())?
            .to_path_buf();
    }
    let canonical_existing = std::fs::canonicalize(&existing)
        .map_err(|err| format!("无法访问目标目录: {err}"))?;
    ensure_path_accessible(workspace, &canonical_existing)
}

/// 校验写入路径在 base 之下的祖先链不含符号链接目录。
/// O_NOFOLLOW 只防末组件：中间目录若是指向 base 外的 symlink，open 会跟随，
/// 写入逃出沙箱（旧实现只做"先检查、后写入"的父目录校验，窗口期内可被换入）。
/// 注意：这是写前校验 + O_NOFOLLOW 打开的组合——检查与打开之间仍有极小
/// 竞态窗口，但预置 symlink（持 fs:write 的 app 或并发外部写者预埋）会被拒绝。
fn reject_symlinked_ancestors(target: &Path, base: &Path) -> Result<(), String> {
    let mut current = target;
    loop {
        let Some(parent) = current.parent() else {
            break;
        };
        // 到 base 为止（base 是 canonicalize 后的可信根；base 之上可能是
        // 系统符号链接挂载，不属于本闸门范围）。
        if parent == base || !path_is_same_or_child(parent, base) {
            break;
        }
        match std::fs::symlink_metadata(parent) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err(format!(
                        "安全限制：写入路径 {} 含符号链接目录 {}，已拒绝写入",
                        target.display(),
                        parent.display()
                    ));
                }
            }
            // 尚不存在的中间目录：继续向上查（更深的已存在祖先可能是 symlink）
            Err(_) => {}
        }
        current = parent;
    }
    Ok(())
}

/// 写入目标文件的最终闸门：拒绝符号链接。
///
/// 只校验父目录的边界检查不够：`fs::write` 会跟随最终组件的符号链接，
/// 若目标本身是预置的 symlink（指向工作区/app data 之外），就会覆盖外部文件。
/// 本函数：
/// 1. 目标已存在且是 symlink → 拒绝；
/// 2. 目标已存在且是普通文件 → canonicalize 后仍必须位于 `base` 内；
/// 3. 祖先链（base 之下的中间目录）不得含 symlink（防中间目录换入逃逸）；
/// 4. Unix 上以 O_NOFOLLOW 打开，堵住"检查后、打开前被换入 symlink"的竞态窗口
///    （Windows 上创建 symlink 需要特权，回退到普通写入）。
pub fn write_file_rejecting_symlink(
    target: &Path,
    base: &Path,
    bytes: &[u8],
) -> Result<(), String> {
    reject_symlinked_ancestors(target, base)?;
    if let Ok(meta) = std::fs::symlink_metadata(target) {
        if meta.file_type().is_symlink() {
            return Err(format!(
                "安全限制：写入目标 {} 是符号链接，已拒绝写入",
                target.display()
            ));
        }
        let canonical = std::fs::canonicalize(target)
            .map_err(|err| format!("无法访问写入目标 {}: {err}", target.display()))?;
        if !path_is_same_or_child(&canonical, base) {
            return Err(format!(
                "安全限制：写入目标 {} 位于允许范围之外",
                target.display()
            ));
        }
    }

    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(target)
            .map_err(|err| format!("写入文件 {} 失败: {err}", target.display()))?;
        file.write_all(bytes)
            .map_err(|err| format!("写入文件 {} 失败: {err}", target.display()))
    }

    #[cfg(not(unix))]
    {
        std::fs::write(target, bytes)
            .map_err(|err| format!("写入文件 {} 失败: {err}", target.display()))
    }
}

/// Convert an absolute path to a workspace-relative forward-slash string.
pub fn relative_string(workspace: &Path, path: &Path) -> String {
    path.strip_prefix(workspace)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Normalise an optional workspace filter, canonicalising if present.
pub fn normalize_workspace_filter(
    workspace_path: Option<String>,
) -> Result<Option<String>, String> {
    workspace_path
        .map(|path| {
            canonical_workspace(&path).map(|workspace| workspace.to_string_lossy().to_string())
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_base(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("codepapr-write-guard-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("test base dir should be created");
        // 与实际调用点一致：base 均为 canonicalize 后的路径（macOS /var → /private/var）
        std::fs::canonicalize(&dir).expect("test base dir should canonicalize")
    }

    #[test]
    fn write_new_and_existing_regular_files() {
        let base = test_base("regular");

        let fresh = base.join("new.txt");
        write_file_rejecting_symlink(&fresh, &base, b"hello").expect("new file should write");
        assert_eq!(std::fs::read(&fresh).unwrap(), b"hello");

        write_file_rejecting_symlink(&fresh, &base, b"world").expect("overwrite should write");
        assert_eq!(std::fs::read(&fresh).unwrap(), b"world");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_target_escaping_base_is_rejected() {
        let base = test_base("symlink");
        let outside_dir = std::env::temp_dir()
            .join(format!("codepapr-write-guard-outside-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&outside_dir);
        std::fs::create_dir_all(&outside_dir).expect("outside dir should exist");
        let outside_file = outside_dir.join("victim.txt");
        std::fs::write(&outside_file, b"original").expect("victim should exist");

        // 工作区内预置 symlink 指向外部文件：写入必须被拒绝，外部文件不得被覆盖
        let link = base.join("innocent.txt");
        std::os::unix::fs::symlink(&outside_file, &link).expect("symlink should be created");

        let err = write_file_rejecting_symlink(&link, &base, b"pwned")
            .expect_err("symlink target must be rejected");
        assert!(err.contains("符号链接"), "unexpected error: {err}");
        assert_eq!(std::fs::read(&outside_file).unwrap(), b"original");

        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&outside_dir);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_even_inside_base_is_rejected() {
        let base = test_base("symlink-inside");
        let real = base.join("real.txt");
        std::fs::write(&real, b"original").expect("real file should exist");
        let link = base.join("link.txt");
        std::os::unix::fs::symlink(&real, &link).expect("symlink should be created");

        // 即使链接目标在 base 内也拒绝：写入方拿到的路径语义与链接不符，
        // 统一拒绝最简单且无歧义
        assert!(write_file_rejecting_symlink(&link, &base, b"x").is_err());
        assert_eq!(std::fs::read(&real).unwrap(), b"original");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_intermediate_directory_is_rejected() {
        let base = test_base("symlink-dir");
        let outside_dir = std::env::temp_dir()
            .join(format!("codepapr-write-guard-outside-dir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&outside_dir);
        std::fs::create_dir_all(&outside_dir).expect("outside dir should exist");
        let outside_victim = outside_dir.join("victim.txt");

        // base/escape 是预置 symlink 目录（指向 base 外）：写入 base/escape/evil.txt
        // 必须被祖先链检查拒绝，外部目录不得出现文件。
        let escape = base.join("escape");
        std::os::unix::fs::symlink(&outside_dir, &escape).expect("symlink dir should be created");

        let err = write_file_rejecting_symlink(&escape.join("evil.txt"), &base, b"pwned")
            .expect_err("symlinked intermediate directory must be rejected");
        assert!(err.contains("符号链接目录"), "unexpected error: {err}");
        assert!(!outside_victim.exists());

        // 深层中间目录同样是符号链接：base/a/link/b.txt（link → 外部）
        let nested = base.join("a").join("link").join("b.txt");
        let _ = std::fs::create_dir_all(base.join("a"));
        let link_dir = base.join("a").join("link");
        std::os::unix::fs::symlink(&outside_dir, &link_dir).expect("nested symlink dir");
        assert!(
            write_file_rejecting_symlink(&nested, &base, b"pwned").is_err(),
            "nested symlinked ancestor must be rejected"
        );

        // 正常深层目录不受影响
        std::fs::create_dir_all(base.join("ok").join("deep")).unwrap();
        write_file_rejecting_symlink(&base.join("ok").join("deep").join("f.txt"), &base, b"fine")
            .expect("regular deep path should write");

        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&outside_dir);
    }
}
