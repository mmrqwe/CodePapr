//! 命令路径授权闸门（后端强制）。
//!
//! 前端 `ensureCommandPathsAllowed` 只做提示与弹窗，可被绕过（例如直接调用
//! invoke、或前端提取逻辑漏掉可执行文件本体）。所有 spawn 入口在执行前必须
//! 经过本模块：命令字符串里出现的绝对路径（含首 token 的可执行文件本体）
//! 必须位于工作区内、或已获外部访问授权，否则拒绝执行。

use std::path::{Path, PathBuf};

use crate::shared::ensure_path_accessible_with_policy;

/// 与前端 SYSTEM_COMMAND_PATHS 保持一致：系统目录下的可执行文件无需授权。
const SYSTEM_COMMAND_PATHS: &[&str] = &[
    "/bin/",
    "/sbin/",
    "/usr/bin/",
    "/usr/sbin/",
    "/usr/local/bin/",
    "/opt/homebrew/bin/",
];

fn is_absolute_path_token(token: &str) -> bool {
    if token.starts_with('/') {
        return true;
    }
    // Windows 盘符路径（反斜杠已归一化为 /）：C:/、D:/ …
    let bytes = token.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && bytes[2] == b'/'
}

/// 从命令字符串提取绝对路径 token。与前端 extractAbsoluteCommandPaths 对齐：
/// 按空白/引号/shell 操作符切分，去掉首尾标点，反斜杠归一化，
/// **不跳过首 token**（可执行文件本体同样必须受检）。
pub(crate) fn extract_absolute_command_paths(command: &str) -> Vec<String> {
    let mut seen = Vec::new();
    for raw_token in command.split(|c: char| {
        c.is_whitespace()
            || matches!(c, '"' | '\'' | '`' | '=' | '<' | '>' | '|' | ';' | '&' | '(' | ')')
    }) {
        let trimmed = raw_token.trim_matches(|c| matches!(c, ',' | '.' | ';'));
        if trimmed.is_empty() {
            continue;
        }
        let normalized = trimmed.replace('\\', "/");
        if !is_absolute_path_token(&normalized) {
            continue;
        }
        if SYSTEM_COMMAND_PATHS
            .iter()
            .any(|prefix| normalized.starts_with(prefix))
        {
            continue;
        }
        if !seen.contains(&normalized) {
            seen.push(normalized);
        }
    }
    seen
}

fn collect_candidates<'a>(
    command: &'a str,
    args: impl IntoIterator<Item = &'a String>,
) -> Vec<String> {
    let mut candidates = extract_absolute_command_paths(command);
    for arg in args {
        for path in extract_absolute_command_paths(arg) {
            if !candidates.contains(&path) {
                candidates.push(path);
            }
        }
    }
    candidates
}

/// 把候选路径规范化后做授权判定。已存在的路径直接 canonicalize（解析符号
/// 链接，防止工作区内链接指向外部）；不存在的路径回退到最深已存在祖先，
/// 与 ensure_write_path_accessible 的语义一致。
fn canonical_probe(raw_path: &str) -> Result<PathBuf, String> {
    let path = Path::new(raw_path);
    if let Ok(canonical) = std::fs::canonicalize(path) {
        return Ok(canonical);
    }
    let mut probe = path
        .parent()
        .ok_or_else(|| format!("无法确定命令路径的父目录: {raw_path}"))?
        .to_path_buf();
    while !probe.exists() {
        probe = probe
            .parent()
            .ok_or_else(|| format!("命令路径无法定位: {raw_path}"))?
            .to_path_buf();
    }
    std::fs::canonicalize(&probe)
        .map_err(|err| format!("命令路径无法访问 {}: {err}", probe.display()))
}

/// 后端强制检查：命令与参数中出现的每个绝对路径都必须可访问。
/// 前端弹窗授权只是提示层；本检查是最终安全闸门。
pub(crate) fn ensure_command_paths_accessible(
    workspace: &Path,
    command: &str,
    args: &[String],
) -> Result<(), String> {
    let candidates = collect_candidates(command, args.iter());
    if candidates.is_empty() {
        return Ok(());
    }
    let policy = crate::db::load_external_access_policy()?;
    for candidate in candidates {
        let canonical = canonical_probe(&candidate)?;
        ensure_path_accessible_with_policy(workspace, &canonical, &policy)
            .map_err(|err| format!("命令路径未获授权 `{candidate}`：{err}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::ExternalAccessPolicy;
    use crate::shared::ensure_path_accessible_with_policy;
    use crate::test_helpers::TestWorkspace;

    fn policy_with(allowed_dirs: &[&str], allowed_files: &[&str]) -> ExternalAccessPolicy {
        ExternalAccessPolicy {
            yolo: false,
            allowed_dirs: allowed_dirs.iter().map(|s| s.to_string()).collect(),
            allowed_files: allowed_files.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn extraction_includes_first_token_executable() {
        // 回归：首 token（可执行文件本体）绝不能被跳过
        let paths = extract_absolute_command_paths("/tmp/evil/bin --flag /tmp/data.txt");
        assert_eq!(paths, vec!["/tmp/evil/bin", "/tmp/data.txt"]);
    }

    #[test]
    fn extraction_skips_system_paths_and_relative_tokens() {
        let paths = extract_absolute_command_paths(
            "/usr/local/bin/node script.js --out /tmp/x.log | /bin/ls",
        );
        assert_eq!(paths, vec!["/tmp/x.log"]);
    }

    #[test]
    fn extraction_splits_on_shell_operators_and_quotes() {
        let paths =
            extract_absolute_command_paths("sh -c '/tmp/a.sh && /tmp/b.sh || /tmp/c.sh; /tmp/d.sh'");
        assert_eq!(
            paths,
            vec!["/tmp/a.sh", "/tmp/b.sh", "/tmp/c.sh", "/tmp/d.sh"]
        );
    }

    #[test]
    fn extraction_normalizes_windows_separators() {
        let paths = extract_absolute_command_paths("C:\\Tools\\app.exe D:\\data\\in.txt");
        assert_eq!(paths, vec!["C:/Tools/app.exe", "D:/data/in.txt"]);
    }

    #[test]
    fn extraction_dedupes_candidates() {
        let paths = extract_absolute_command_paths("/tmp/a.sh /tmp/a.sh && /tmp/a.sh");
        assert_eq!(paths, vec!["/tmp/a.sh"]);
    }

    #[test]
    fn extraction_strips_surrounding_punctuation() {
        let paths = extract_absolute_command_paths("(/tmp/run.sh),");
        assert_eq!(paths, vec!["/tmp/run.sh"]);
    }

    #[test]
    fn collect_candidates_merges_command_and_args() {
        let args = vec!["--input /tmp/in.txt".to_string(), "plain".to_string()];
        let candidates = collect_candidates("/tmp/tool", args.iter());
        assert_eq!(candidates, vec!["/tmp/tool", "/tmp/in.txt"]);
    }

    #[test]
    fn workspace_internal_paths_are_allowed() {
        let ws = TestWorkspace::new("path-guard-internal");
        let target = ws.file_path("scripts/run.sh");
        let policy = policy_with(&[], &[]);
        assert!(ensure_path_accessible_with_policy(&ws.path, &target, &policy).is_ok());
    }

    #[test]
    fn external_paths_require_grant() {
        let ws = TestWorkspace::new("path-guard-external");
        let external = std::env::temp_dir().join("path-guard-elsewhere/tool");
        let policy = policy_with(&[], &[]);
        assert!(ensure_path_accessible_with_policy(&ws.path, &external, &policy).is_err());

        let granted_dir = std::env::temp_dir()
            .join("path-guard-elsewhere")
            .to_string_lossy()
            .into_owned();
        let dir_granted = policy_with(&[granted_dir.as_str()], &[]);
        assert!(ensure_path_accessible_with_policy(&ws.path, &external, &dir_granted).is_ok());

        let external_str = external.to_string_lossy().into_owned();
        let file_granted = policy_with(&[], &[external_str.as_str()]);
        assert!(ensure_path_accessible_with_policy(&ws.path, &external, &file_granted).is_ok());
    }

    #[test]
    fn protected_paths_are_rejected_even_with_grant() {
        let ws = TestWorkspace::new("path-guard-protected");
        let policy = policy_with(&["/Users/test/.ssh"], &["/Users/test/.ssh/id_rsa"]);
        assert!(ensure_path_accessible_with_policy(
            &ws.path,
            Path::new("/Users/test/.ssh/id_rsa"),
            &policy
        )
        .is_err());
    }

    #[test]
    fn yolo_allows_unprotected_external_paths() {
        let ws = TestWorkspace::new("path-guard-yolo");
        let policy = ExternalAccessPolicy {
            yolo: true,
            allowed_dirs: Vec::new(),
            allowed_files: Vec::new(),
        };
        let external = std::env::temp_dir().join("path-guard-yolo-target/tool");
        assert!(ensure_path_accessible_with_policy(&ws.path, &external, &policy).is_ok());
    }

    /// 工作区内的符号链接指向外部时，canonicalize 必须把逃逸解析出来并拒绝。
    #[cfg(unix)]
    #[test]
    fn symlink_escape_out_of_workspace_is_rejected() {
        let ws = TestWorkspace::new("path-guard-symlink");
        let external_dir = std::env::temp_dir().join("path-guard-symlink-outside");
        let _ = std::fs::create_dir_all(&external_dir);
        let external_file = external_dir.join("secret.sh");
        std::fs::write(&external_file, "#!/bin/sh\necho hi\n").unwrap();

        let link = ws.file_path("innocent.sh");
        std::os::unix::fs::symlink(&external_file, &link).unwrap();

        // canonical_probe 解析符号链接到工作区外 → 授权判定拒绝
        let canonical = canonical_probe(&link.to_string_lossy()).unwrap();
        let policy = policy_with(&[], &[]);
        assert!(ensure_path_accessible_with_policy(&ws.path, &canonical, &policy).is_err());

        let _ = std::fs::remove_dir_all(&external_dir);
    }

    #[test]
    fn canonical_probe_falls_back_to_existing_ancestor_for_missing_paths() {
        let missing = std::env::temp_dir().join("path-guard-missing-dir/nope/run.sh");
        let canonical = canonical_probe(&missing.to_string_lossy()).unwrap();
        // 回退到最深已存在祖先（temp_dir 本身），而不是报错
        assert!(canonical.exists());
    }
}
