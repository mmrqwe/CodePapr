use crate::snapshot::types::GitOperationResult;
use super::{open_repo, ensure_signature};

pub fn git_commit_impl(
    workspace: &std::path::Path,
    message: &str,
    stage_all: bool,
    pathspecs: &[String],
    allow_empty: bool,
) -> GitOperationResult {
    let repo = match open_repo(workspace) {
        Ok(r) => r,
        Err(e) => return GitOperationResult {
            ok: false, action: "commit".to_string(), message: e, backup_ref: None,
        },
    };

    let signature = match ensure_signature(&repo) {
        Ok(s) => s,
        Err(e) => return GitOperationResult {
            ok: false, action: "commit".to_string(), message: e, backup_ref: None,
        },
    };

    if stage_all || !pathspecs.is_empty() {
        let stage_result = super::stage::git_stage_impl(workspace, stage_all, pathspecs);
        if !stage_result.ok {
            return GitOperationResult {
                ok: false, action: "commit".to_string(),
                message: format!("暂存失败: {}", stage_result.message), backup_ref: None,
            };
        }
    }

    let mut index = match repo.index() {
        Ok(idx) => idx,
        Err(e) => return GitOperationResult {
            ok: false, action: "commit".to_string(),
            message: format!("index: {}", e.message()), backup_ref: None,
        },
    };

    let tree_oid = match index.write_tree() {
        Ok(oid) => oid,
        Err(e) => return GitOperationResult {
            ok: false, action: "commit".to_string(),
            message: format!("write_tree: {}", e.message()), backup_ref: None,
        },
    };

    let tree = match repo.find_tree(tree_oid) {
        Ok(t) => t,
        Err(e) => return GitOperationResult {
            ok: false, action: "commit".to_string(),
            message: format!("find_tree: {}", e.message()), backup_ref: None,
        },
    };

    let parent_commit = repo.head().ok()
        .and_then(|h| h.target())
        .and_then(|oid| repo.find_commit(oid).ok());

    if !allow_empty {
        if let Some(ref parent) = parent_commit {
            if let Ok(parent_tree) = parent.tree() {
                if tree.id() == parent_tree.id() {
                    return GitOperationResult {
                        ok: false, action: "commit".to_string(),
                        message: "没有改动可提交（可用 allowEmpty 跳过此检查）".to_string(),
                        backup_ref: None,
                    };
                }
            }
        }
    }

    let parents: Vec<&git2::Commit> = parent_commit.iter().collect();
    let commit_oid = match repo.commit(
        Some("HEAD"), &signature, &signature, message, &tree, &parents,
    ) {
        Ok(oid) => oid,
        Err(e) => return GitOperationResult {
            ok: false, action: "commit".to_string(),
            message: format!("commit: {}", e.message()), backup_ref: None,
        },
    };

    GitOperationResult {
        ok: true, action: "commit".to_string(),
        message: format!("已创建提交 {}", &commit_oid.to_string()[..7]),
        backup_ref: None,
    }
}

#[tauri::command]
pub async fn git_commit(
    workspace_path: String,
    message: String,
    stage_all: Option<bool>,
    pathspecs: Option<Vec<String>>,
    allow_empty: Option<bool>,
) -> GitOperationResult {
    let workspace = std::path::PathBuf::from(workspace_path);
    git_commit_impl(
        &workspace, &message,
        stage_all.unwrap_or(false),
        &pathspecs.unwrap_or_default(),
        allow_empty.unwrap_or(false),
    )
}
