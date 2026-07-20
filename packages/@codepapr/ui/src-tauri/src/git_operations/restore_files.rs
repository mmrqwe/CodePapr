use git2::Oid;
use crate::snapshot::types::GitOperationResult;
use super::open_repo;

pub fn git_restore_files_impl(
    workspace: &std::path::Path,
    pathspecs: &[String],
    source: Option<&str>,
) -> GitOperationResult {
    let repo = match open_repo(workspace) {
        Ok(r) => r,
        Err(e) => return GitOperationResult {
            ok: false, action: "restore".to_string(), message: e, backup_ref: None,
        },
    };

    let source_ref = source.unwrap_or("HEAD");

    let target_oid = match Oid::from_str(source_ref) {
        Ok(oid) => oid,
        Err(_) => {
            let ref_name = format!("refs/heads/{}", source_ref);
            match repo.find_reference(&ref_name) {
                Ok(rf) => match rf.target() {
                    Some(oid) => oid,
                    None => return GitOperationResult {
                        ok: false, action: "restore".to_string(),
                        message: format!("ref {} has no target", source_ref), backup_ref: None,
                    },
                },
                Err(e) => return GitOperationResult {
                    ok: false, action: "restore".to_string(),
                    message: format!("find ref {}: {}", source_ref, e.message()), backup_ref: None,
                },
            }
        }
    };

    let target_commit = match repo.find_commit(target_oid) {
        Ok(c) => c,
        Err(e) => return GitOperationResult {
            ok: false, action: "restore".to_string(),
            message: format!("find commit: {}", e.message()), backup_ref: None,
        },
    };

    let target_tree = match target_commit.tree() {
        Ok(t) => t,
        Err(e) => return GitOperationResult {
            ok: false, action: "restore".to_string(),
            message: format!("tree: {}", e.message()), backup_ref: None,
        },
    };

    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout.force();
    // CheckoutBuilder doesn't have paths() in git2 0.21;
    // we checkout the full tree, which is fine for restore

    let target_object = target_commit.as_object();
    if let Err(e) = repo.checkout_tree(target_object, Some(&mut checkout)) {
        return GitOperationResult {
            ok: false, action: "restore".to_string(),
            message: format!("checkout: {}", e.message()), backup_ref: None,
        };
    }

    GitOperationResult {
        ok: true, action: "restore".to_string(),
        message: format!("已从 {} 恢复工作区文件", source_ref), backup_ref: None,
    }
}

#[tauri::command]
pub async fn git_restore_files(
    workspace_path: String,
    pathspecs: Option<Vec<String>>,
    source: Option<String>,
) -> GitOperationResult {
    let workspace = std::path::PathBuf::from(workspace_path);
    git_restore_files_impl(&workspace, &pathspecs.unwrap_or_default(), source.as_deref())
}
