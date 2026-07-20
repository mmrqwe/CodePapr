use crate::snapshot::types::GitOperationResult;
use super::open_repo;

pub fn git_stage_impl(
    workspace: &std::path::Path,
    all: bool,
    pathspecs: &[String],
) -> GitOperationResult {
    let repo = match open_repo(workspace) {
        Ok(r) => r,
        Err(e) => return GitOperationResult {
            ok: false, action: "stage".to_string(), message: e, backup_ref: None,
        },
    };

    let mut index = match repo.index() {
        Ok(idx) => idx,
        Err(e) => return GitOperationResult {
            ok: false, action: "stage".to_string(),
            message: format!("index: {}", e.message()), backup_ref: None,
        },
    };

    if all || pathspecs.is_empty() {
        use crate::snapshot::ignore_resolver::IgnoreResolver;
        let resolver = IgnoreResolver::new(workspace);
        let files = resolver.collect_files();
        let mut added = 0;
        for file in &files {
            if index.add_path(file).is_ok() {
                added += 1;
            }
        }
        if let Err(e) = index.write() {
            return GitOperationResult {
                ok: false, action: "stage".to_string(),
                message: format!("write index: {}", e.message()), backup_ref: None,
            };
        }
        return GitOperationResult {
            ok: true, action: "stage".to_string(),
            message: format!("已暂存 {} 个文件", added), backup_ref: None,
        };
    }

    let mut added = 0;
    for path in pathspecs {
        let p = std::path::Path::new(path);
        if let Err(e) = index.add_path(p) {
            return GitOperationResult {
                ok: false, action: "stage".to_string(),
                message: format!("add {:?}: {}", path, e.message()), backup_ref: None,
            };
        }
        added += 1;
    }
    if let Err(e) = index.write() {
        return GitOperationResult {
            ok: false, action: "stage".to_string(),
            message: format!("write index: {}", e.message()), backup_ref: None,
        };
    }
    GitOperationResult {
        ok: true, action: "stage".to_string(),
        message: format!("已暂存 {} 个路径", added), backup_ref: None,
    }
}

#[tauri::command]
pub async fn git_stage(
    workspace_path: String,
    all: Option<bool>,
    pathspecs: Option<Vec<String>>,
) -> GitOperationResult {
    let workspace = std::path::PathBuf::from(workspace_path);
    git_stage_impl(&workspace, all.unwrap_or(false), &pathspecs.unwrap_or_default())
}
