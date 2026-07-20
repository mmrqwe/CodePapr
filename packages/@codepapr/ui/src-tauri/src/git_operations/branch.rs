use git2::BranchType;
use crate::snapshot::types::{GitBranch, GitOperationResult};
use super::open_repo;

pub fn git_branch_list_impl(workspace: &std::path::Path) -> Vec<GitBranch> {
    let repo = match open_repo(workspace) {
        Ok(r) => r,
        Err(_) => return vec![],
    };

    let _head_oid = repo.head().ok().and_then(|h| h.target());

    let mut result = Vec::new();
    if let Ok(branches) = repo.branches(Some(BranchType::Local)) {
        for branch_entry in branches {
            let (branch, _bt) = match branch_entry { Ok(b) => b, Err(_) => continue };
            let name = branch.name().ok().flatten().unwrap_or("").to_string();
            let is_current = branch.is_head();
            let target_sha = branch.get().target()
                .map(|oid| oid.to_string())
                .unwrap_or_default();
            result.push(GitBranch {
                name, is_current, is_remote: false, target_sha,
            });
        }
    }

    result
}

pub fn git_branch_checkout_impl(
    workspace: &std::path::Path,
    branch_name: &str,
    create: bool,
    create_if_missing: bool,
) -> GitOperationResult {
    let repo = match open_repo(workspace) {
        Ok(r) => r,
        Err(e) => return GitOperationResult {
            ok: false, action: "branch_checkout".to_string(), message: e, backup_ref: None,
        },
    };

    let branch = repo.find_branch(branch_name, BranchType::Local);
    let target_oid = if create || (create_if_missing && branch.is_err()) {
        let head_oid = repo.head().ok()
            .and_then(|h| h.target())
            .ok_or_else(|| "no HEAD".to_string());
        let head_oid = match head_oid { Ok(o) => o, Err(e) => return GitOperationResult {
            ok: false, action: "branch_checkout".to_string(), message: e, backup_ref: None,
        }};
        let commit = match repo.find_commit(head_oid) {
            Ok(c) => c, Err(e) => return GitOperationResult {
                ok: false, action: "branch_checkout".to_string(),
                message: format!("find commit: {}", e.message()), backup_ref: None,
            },
        };
        match repo.branch(branch_name, &commit, false) {
            Ok(b) => b.get().target().unwrap_or(head_oid),
            Err(e) => return GitOperationResult {
                ok: false, action: "branch_checkout".to_string(),
                message: format!("create branch: {}", e.message()), backup_ref: None,
            },
        }
    } else {
        match &branch {
            Ok(b) => match b.get().target() {
                Some(oid) => oid,
                None => return GitOperationResult {
                    ok: false, action: "branch_checkout".to_string(),
                    message: "branch has no target".to_string(), backup_ref: None,
                },
            },
            Err(e) => return GitOperationResult {
                ok: false, action: "branch_checkout".to_string(),
                message: format!("branch not found: {}", e.message()), backup_ref: None,
            },
        }
    };

    let ref_name = format!("refs/heads/{}", branch_name);
    if let Err(e) = repo.set_head(&ref_name) {
        return GitOperationResult {
            ok: false, action: "branch_checkout".to_string(),
            message: format!("set_head: {}", e.message()), backup_ref: None,
        };
    }

    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout.force();
    if let Err(e) = repo.checkout_head(Some(&mut checkout)) {
        return GitOperationResult {
            ok: false, action: "branch_checkout".to_string(),
            message: format!("checkout: {}", e.message()), backup_ref: None,
        };
    }

    GitOperationResult {
        ok: true, action: "branch_checkout".to_string(),
        message: format!("已切换到分支 {}", branch_name), backup_ref: None,
    }
}

#[tauri::command]
pub async fn git_branch_list(workspace_path: String) -> Vec<GitBranch> {
    let workspace = std::path::PathBuf::from(workspace_path);
    git_branch_list_impl(&workspace)
}

#[tauri::command]
pub async fn git_branch_checkout(
    workspace_path: String,
    branch_name: String,
    create: Option<bool>,
    create_if_missing: Option<bool>,
) -> GitOperationResult {
    let workspace = std::path::PathBuf::from(workspace_path);
    git_branch_checkout_impl(
        &workspace, &branch_name,
        create.unwrap_or(false),
        create_if_missing.unwrap_or(true),
    )
}
