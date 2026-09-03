use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::db::{self, ExternalAccessPolicy};
use crate::shared::{
    canonical_workspace, is_protected_external_path, path_is_same, path_is_same_or_child,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalPathCheck {
    pub(crate) path: String,
    pub(crate) canonical_path: String,
    pub(crate) exists: bool,
    pub(crate) in_workspace: bool,
    pub(crate) allowed: bool,
    pub(crate) protected: bool,
}

fn canonical_existing_path(raw_path: &str) -> Result<PathBuf, String> {
    let path = Path::new(raw_path);
    fs::canonicalize(path).map_err(|err| format!("路径不存在或无法访问: {err}"))
}

fn canonical_access_probe(raw_path: &str) -> Result<(PathBuf, bool), String> {
    match fs::canonicalize(raw_path) {
        Ok(path) => Ok((path, true)),
        Err(_) => {
            let mut probe = Path::new(raw_path)
                .parent()
                .ok_or_else(|| "无法确定目标路径的父目录".to_string())?
                .to_path_buf();
            while !probe.exists() {
                probe = probe
                    .parent()
                    .ok_or_else(|| "路径不存在或无法访问".to_string())?
                    .to_path_buf();
            }
            let canonical =
                fs::canonicalize(&probe).map_err(|err| format!("路径不存在或无法访问: {err}"))?;
            Ok((canonical, false))
        }
    }
}

fn policy_allows(policy: &ExternalAccessPolicy, path: &Path) -> bool {
    if policy.yolo {
        return true;
    }
    policy.allowed_dirs.iter().any(|dir| {
        let allowed = Path::new(dir);
        path_is_same_or_child(path, allowed)
    }) || policy
        .allowed_files
        .iter()
        .any(|file| path_is_same(path, Path::new(file)))
}

pub fn check_external_path(
    workspace_path: String,
    raw_path: String,
) -> Result<ExternalPathCheck, String> {
    let workspace = canonical_workspace(&workspace_path)?;
    let (canonical_path, exists) = canonical_access_probe(&raw_path)?;
    let in_workspace = path_is_same_or_child(&canonical_path, &workspace);
    let protected = !in_workspace && is_protected_external_path(&canonical_path);
    let allowed = in_workspace
        || (!protected && policy_allows(&db::load_external_access_policy()?, &canonical_path));

    Ok(ExternalPathCheck {
        path: raw_path,
        canonical_path: canonical_path.to_string_lossy().to_string(),
        exists,
        in_workspace,
        allowed,
        protected,
    })
}

pub fn get_external_access_policy() -> Result<ExternalAccessPolicy, String> {
    db::load_external_access_policy()
}

pub fn set_external_access_yolo(enabled: bool) -> Result<ExternalAccessPolicy, String> {
    let mut policy = db::load_external_access_policy()?;
    policy.yolo = enabled;
    db::save_external_access_policy(&policy)
}

pub fn grant_external_access(
    workspace_path: String,
    raw_path: String,
    scope: String,
) -> Result<ExternalAccessPolicy, String> {
    let workspace = canonical_workspace(&workspace_path)?;
    let canonical_path = canonical_existing_path(&raw_path)?;
    if path_is_same_or_child(&canonical_path, &workspace) {
        return Err("项目内路径无需外部授权".to_string());
    }
    if is_protected_external_path(&canonical_path) {
        return Err(format!(
            "安全限制：禁止授权受保护的隐藏目录 {}",
            canonical_path.display()
        ));
    }

    let mut policy = db::load_external_access_policy()?;
    match scope.as_str() {
        "directory" => {
            if !canonical_path.is_dir() {
                return Err("只能把目录授权为文件夹".to_string());
            }
            let value = canonical_path.to_string_lossy().to_string();
            if !policy.allowed_dirs.iter().any(|dir| dir == &value) {
                policy.allowed_dirs.push(value);
            }
        }
        "file" => {
            if !canonical_path.is_file() {
                return Err("只能把文件授权为文件".to_string());
            }
            let value = canonical_path.to_string_lossy().to_string();
            if !policy.allowed_files.iter().any(|file| file == &value) {
                policy.allowed_files.push(value);
            }
        }
        _ => return Err("授权范围必须是 directory 或 file".to_string()),
    }

    db::save_external_access_policy(&policy)
}

pub fn revoke_external_access(
    raw_path: String,
    scope: String,
) -> Result<ExternalAccessPolicy, String> {
    let canonical_path = canonical_existing_path(&raw_path)?;
    let canonical_string = canonical_path.to_string_lossy().to_string();
    let mut policy = db::load_external_access_policy()?;
    match scope.as_str() {
        "directory" => policy.allowed_dirs.retain(|dir| dir != &canonical_string),
        "file" => policy
            .allowed_files
            .retain(|file| file != &canonical_string),
        _ => return Err("撤销范围必须是 directory 或 file".to_string()),
    }
    db::save_external_access_policy(&policy)
}

pub fn clear_external_access_grants() -> Result<ExternalAccessPolicy, String> {
    let mut policy = db::load_external_access_policy()?;
    policy.allowed_dirs.clear();
    policy.allowed_files.clear();
    db::save_external_access_policy(&policy)
}

#[cfg(test)]
mod tests {
    use super::{is_protected_external_path, policy_allows};
    use crate::db::ExternalAccessPolicy;
    use crate::shared::path_is_same_or_child;
    #[cfg(target_os = "windows")]
    use crate::shared::path_is_same;
    use std::path::Path;

    #[test]
    fn directory_grants_are_boundary_aware() {
        let policy = ExternalAccessPolicy {
            yolo: false,
            allowed_dirs: vec!["/tmp/approved".to_string()],
            allowed_files: vec!["/tmp/one.txt".to_string()],
        };

        assert!(policy_allows(&policy, Path::new("/tmp/approved/file.txt")));
        assert!(!policy_allows(
            &policy,
            Path::new("/tmp/approved-sibling/file.txt")
        ));
        assert!(policy_allows(&policy, Path::new("/tmp/one.txt")));
        assert!(!policy_allows(&policy, Path::new("/tmp/one.txt.bak")));
    }

    #[test]
    fn protected_hidden_directories_are_not_yolo_candidates() {
        assert!(is_protected_external_path(Path::new(
            "/Users/test/.ssh/id_rsa"
        )));
        assert!(is_protected_external_path(Path::new(
            "/Users/test/.CodePapr/project.sqlite"
        )));
        assert!(!is_protected_external_path(Path::new(
            "/Users/test/.vscode/settings.json"
        )));
    }

    #[test]
    fn path_comparison_handles_separators_and_case() {
        assert!(path_is_same_or_child(
            Path::new("C:\\Work\\Project\\src"),
            Path::new("C:/Work/Project")
        ));
        assert!(!path_is_same_or_child(
            Path::new("C:\\Work\\Project2"),
            Path::new("C:/Work/Project")
        ));

        #[cfg(target_os = "windows")]
        assert!(path_is_same(
            Path::new("C:\\Work\\File.txt"),
            Path::new("c:/work/file.TXT")
        ));
    }
}
