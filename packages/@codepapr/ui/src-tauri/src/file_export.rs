#![forbid(unsafe_code)]

use std::path::{Component, Path, PathBuf};

use codepapr_core::shared::home_dir;

/// 把文本内容写入用户在保存对话框中选择的路径（主题 JSON 等导出用途）。
///
/// 前端虽然先经过系统保存对话框挑选路径，但 IPC 契约不强制这一点：被注入的
/// 渲染内容也能直接 `invoke('export_text_file')`。因此 Rust 侧独立校验：
/// - 路径不得含 `..` 段或隐藏目录/隐藏文件（挡住 `~/.zshrc`、`~/.ssh/*`）；
/// - 目标必须位于用户主目录之内（且不在 `~/Library` 中），
///   或位于已授权的外部目录（外部访问策略 `allowed_dirs`）、当前工作区内；
/// - 目标或父目录已存在时按规范化路径复核，符号链接指向白名单外一律拒绝。
#[tauri::command]
pub fn export_text_file(
    save_path: String,
    content: String,
    workspace_path: Option<String>,
) -> Result<(), String> {
    let target = PathBuf::from(&save_path);
    // 策略读取失败时退回空策略（与改造前 `if let Ok` 的静默降级一致）。
    let policy = codepapr_core::db::load_external_access_policy().unwrap_or_default();
    validate_export_target_with_policy(&target, workspace_path.as_deref(), &policy)?;
    write_export_target(&target, content.as_bytes())
}

/// 静态拒绝危险段：空路径、`..`、任意隐藏目录/隐藏文件。
fn reject_dangerous_segments(target: &Path) -> Result<(), String> {
    if target.as_os_str().is_empty() {
        return Err("导出路径为空".into());
    }
    for component in target.components() {
        match component {
            Component::ParentDir => return Err("导出路径不允许包含 ..".into()),
            Component::Normal(seg) => {
                let name = seg.to_string_lossy();
                if name.starts_with('.') {
                    return Err("导出路径不允许指向隐藏目录或隐藏文件".into());
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// 规范化目录（目标父目录可能尚不存在：向上找最近已存在祖先再拼回）。
fn resolve_dir(dir: &Path) -> Result<PathBuf, String> {
    if dir.exists() {
        return dir
            .canonicalize()
            .map_err(|e| format!("导出目录无效: {e}"));
    }
    let mut existing = dir.to_path_buf();
    let mut suffix: Vec<std::ffi::OsString> = Vec::new();
    loop {
        if existing.exists() {
            let mut canon = existing
                .canonicalize()
                .map_err(|e| format!("导出目录无效: {e}"))?;
            for seg in suffix.iter().rev() {
                canon.push(seg);
            }
            return Ok(canon);
        }
        match (
            existing.file_name().map(|f| f.to_os_string()),
            existing.parent().map(|p| p.to_path_buf()),
        ) {
            (Some(name), Some(parent)) if parent != existing => {
                suffix.push(name);
                existing = parent;
            }
            _ => return Err("导出目录不存在".into()),
        }
    }
}

/// 策略参数化的校验核心：`export_text_file` 传入从 app DB 读取的策略,
/// 单元测试传入构造的空策略,避免依赖本机真实数据库。
fn validate_export_target_with_policy(
    target: &Path,
    workspace_path: Option<&str>,
    policy: &codepapr_core::db::ExternalAccessPolicy,
) -> Result<(), String> {
    reject_dangerous_segments(target)?;
    let parent = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or("导出路径没有父目录")?;
    let resolved_parent = resolve_dir(parent)?;

    let mut allowed_roots: Vec<PathBuf> = Vec::new();
    let home = home_dir()?;
    // macOS 的 ~/Library 存放 Keychain 等敏感数据，即使未隐藏也必须排除。
    #[cfg(target_os = "macos")]
    if codepapr_core::shared::path_is_same_or_child(&resolved_parent, &home.join("Library")) {
        return Err("导出路径不允许位于 ~/Library 内".into());
    }
    allowed_roots.push(home);
    if let Some(ws) = workspace_path {
        if let Ok(canon_ws) = std::fs::canonicalize(ws) {
            allowed_roots.push(canon_ws);
        }
    }
    for dir in &policy.allowed_dirs {
        if let Ok(canon) = std::fs::canonicalize(dir) {
            allowed_roots.push(canon);
        }
    }

    let inside = allowed_roots.iter().any(|root| {
        let canon_root = match root.canonicalize() {
            Ok(c) => c,
            Err(_) => root.clone(),
        };
        codepapr_core::shared::path_is_same_or_child(&resolved_parent, &canon_root)
    });
    if !inside {
        return Err("导出路径必须位于用户主目录、当前工作区或已授权目录内".into());
    }

    // 目标已存在：按规范化路径复核（防符号链接指向白名单外）。
    if target.exists() {
        let canon_target = std::fs::canonicalize(target)
            .map_err(|e| format!("导出目标无效: {e}"))?;
        let still_inside = allowed_roots.iter().any(|root| {
            let canon_root = match root.canonicalize() {
                Ok(c) => c,
                Err(_) => root.clone(),
            };
            codepapr_core::shared::path_is_same_or_child(&canon_target, &canon_root)
        });
        if !still_inside {
            return Err("导出目标解析后位于允许范围之外".into());
        }
    }
    Ok(())
}

/// 写入目标：复用工作区写入闸门（拒绝符号链接 + O_NOFOLLOW）。
fn write_export_target(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = target.parent().unwrap_or(Path::new(""));
    let base = if parent.exists() {
        parent.canonicalize().unwrap_or_else(|_| parent.to_path_buf())
    } else {
        resolve_dir(parent)?
    };
    codepapr_core::shared::write_file_rejecting_symlink(target, &base, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> PathBuf {
        home_dir().expect("home dir")
    }

    /// 空策略：白名单只含主目录/工作区。测试不读真实 app DB，
    /// 保证在任何机器上结果一致（否则本机授权的目录会污染断言）。
    fn empty_policy() -> codepapr_core::db::ExternalAccessPolicy {
        codepapr_core::db::ExternalAccessPolicy::default()
    }

    fn check(target: &Path, workspace_path: Option<&str>) -> Result<(), String> {
        validate_export_target_with_policy(target, workspace_path, &empty_policy())
    }

    #[test]
    fn rejects_hidden_paths() {
        assert!(check(&home().join(".zshrc"), None).is_err());
        assert!(check(&home().join(".ssh").join("config.txt"), None).is_err());
        assert!(
            check(&home().join("Desktop").join(".hidden-dir").join("a.json"), None).is_err()
        );
    }

    #[test]
    fn rejects_parent_dir_segments() {
        let p = home().join("Desktop").join("..").join(".zshrc");
        assert!(check(&p, None).is_err());
    }

    #[test]
    fn rejects_outside_home() {
        assert!(check(Path::new("/tmp/evil/theme.json"), None).is_err());
        assert!(check(Path::new("/etc/hosts"), None).is_err());
    }

    #[test]
    fn rejects_nonexistent_root() {
        assert!(check(Path::new("/definitely/not/exist/theme.json"), None).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn rejects_library_dir() {
        assert!(check(&home().join("Library").join("evil.json"), None).is_err());
    }

    #[test]
    fn authorized_external_dir_is_accepted() {
        let tmp = std::env::temp_dir();
        let policy = codepapr_core::db::ExternalAccessPolicy {
            allowed_dirs: vec![tmp.to_string_lossy().into_owned()],
            ..Default::default()
        };
        let target = tmp.join(format!("codepapr-export-test-{}", std::process::id()));
        // 目标尚不存在也允许：父目录已存在且位于授权根内。
        let result = validate_export_target_with_policy(&target, None, &policy);
        assert!(result.is_ok(), "授权目录应被接受: {result:?}");
    }

    #[test]
    fn workspace_path_grants_access() {
        let tmp = std::env::temp_dir();
        let target = tmp.join(format!("codepapr-export-ws-{}", std::process::id()));
        let result = validate_export_target_with_policy(
            &target,
            Some(&tmp.to_string_lossy()),
            &empty_policy(),
        );
        assert!(result.is_ok(), "工作区路径应被接受: {result:?}");
    }

    #[test]
    fn export_text_file_reports_invalid_path() {
        let result = export_text_file(
            "/definitely/not/exist/dir/theme.json".to_string(),
            "{}".to_string(),
            None,
        );
        assert!(result.is_err());
    }
}
