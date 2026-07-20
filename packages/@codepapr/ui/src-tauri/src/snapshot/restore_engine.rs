use std::path::{Path, PathBuf};
use git2::{Repository, ResetType, Oid};
use super::types::{RestorePlan, RestoreResult, FileChange};
use super::snapshot_engine::SnapshotEngine;
use super::ignore_resolver::IgnoreResolver;

const BACKUP_REF: &str = "refs/codepapr-backup-before-reset";

fn code_papr_git_path(workspace: &Path) -> PathBuf {
    workspace.join(".CodePapr/git")
}

fn delta_status_code(delta: &git2::DiffDelta) -> &'static str {
    match delta.status() {
        git2::Delta::Added => "A",
        git2::Delta::Deleted => "D",
        git2::Delta::Modified => "M",
        git2::Delta::Renamed => "R",
        git2::Delta::Copied => "C",
        
        _ => "U",
    }
}

pub struct RestoreEngine {
    workspace: PathBuf,
}

impl RestoreEngine {
    pub fn new(workspace: &Path) -> Self {
        Self { workspace: workspace.to_path_buf() }
    }

    pub fn plan(&self, target_sha: &str) -> Result<RestorePlan, String> {
        let git_path = code_papr_git_path(&self.workspace);
        let repo = Repository::open(&git_path)
            .map_err(|e| format!("open repo: {}", e.message()))?;
        repo.set_workdir(&self.workspace, false)
            .map_err(|e| format!("set workdir: {}", e.message()))?;

        let oid = Oid::from_str(target_sha)
            .map_err(|e| format!("parse sha: {}", e.message()))?;
        let target_commit = repo.find_commit(oid)
            .map_err(|e| format!("find commit: {}", e.message()))?;
        let target_tree = target_commit.tree()
            .map_err(|e| format!("target tree: {}", e.message()))?;

        if target_tree.is_empty() {
            return Err("target checkpoint has an empty tree; refusing to plan reset".to_string());
        }

        let target_file_count = target_tree.len();
        let target_label = target_commit.message()
            .unwrap_or("")
            .lines().next().unwrap_or("").to_string();

        let head_tree = repo.head().ok()
            .and_then(|h| h.target())
            .and_then(|h_oid| repo.find_commit(h_oid).ok())
            .and_then(|c| c.tree().ok());

        let mut files_to_restore = Vec::new();
        let mut files_to_delete = Vec::new();
        let mut files_unchanged = 0usize;

        if let Some(ref head_tree) = head_tree {
            let mut diff = repo.diff_tree_to_tree(Some(head_tree), Some(&target_tree), None)
                .map_err(|e| format!("diff: {}", e.message()))?;

            let _ = diff.find_similar(None);

            let deltas: Vec<_> = diff.deltas().collect();
            for (i, delta) in deltas.iter().enumerate() {
                let status = delta_status_code(delta).to_string();
                let path = delta.new_file().path()
                    .or_else(|| delta.old_file().path())
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default();
                let old_path = if delta.status() == git2::Delta::Renamed {
                    delta.old_file().path().map(|p| p.to_string_lossy().to_string())
                } else { None };

                let (additions, deletions) = if let Ok(Some(patch)) = git2::Patch::from_diff(&diff, i) {
                    let (a, _d2, d) = patch.line_stats().unwrap_or((0, 0, 0));
                    (a, d)
                } else { (0, 0) };

                if status == "D" {
                    files_to_delete.push(path.clone());
                }
                files_to_restore.push(FileChange { path, old_path, status, additions, deletions });
            }

            let head_count = head_tree.len();
            let changed = files_to_restore.len();
            files_unchanged = head_count.saturating_sub(changed);
        }

        Ok(RestorePlan {
            target_sha: target_sha.to_string(),
            target_label,
            target_file_count,
            files_to_restore,
            files_to_delete,
            files_unchanged,
        })
    }

    pub fn execute(&self, target_sha: &str) -> Result<RestoreResult, String> {
        let git_path = code_papr_git_path(&self.workspace);
        let repo = Repository::open(&git_path)
            .map_err(|e| format!("open repo: {}", e.message()))?;
        repo.set_workdir(&self.workspace, false)
            .map_err(|e| format!("set workdir: {}", e.message()))?;

        let oid = Oid::from_str(target_sha)
            .map_err(|e| format!("parse sha: {}", e.message()))?;
        let target_commit = repo.find_commit(oid)
            .map_err(|e| format!("find commit: {}", e.message()))?;
        let target_tree = target_commit.tree()
            .map_err(|e| format!("target tree: {}", e.message()))?;

        if target_tree.is_empty() {
            return Err("target checkpoint has an empty tree; refusing reset to prevent data loss".to_string());
        }

        let head_tree = repo.head().ok()
            .and_then(|h| h.target())
            .and_then(|h_oid| repo.find_commit(h_oid).ok())
            .and_then(|c| c.tree().ok());

        let files_changed = match &head_tree {
            Some(prev) => {
                repo.diff_tree_to_tree(Some(prev), Some(&target_tree), None)
                    .map(|d| d.deltas().count()).unwrap_or(0)
            }
            None => target_tree.len(),
        };

        let mut backup_ref = None;
        if let Some(head_ref) = repo.head().ok() {
            if let Some(head_oid) = head_ref.target() {
                eprintln!("[CodePapr] restore_execute: backup ref -> {}", head_oid);
                match repo.reference(BACKUP_REF, head_oid, true, "codepapr backup before reset") {
                    Ok(_) => backup_ref = Some(BACKUP_REF.to_string()),
                    Err(e) => return Err(format!(
                        "failed to create backup ref: {} (refusing reset without safety net)", e.message()
                    )),
                }
            }
        }

        let mut checkout = git2::build::CheckoutBuilder::new();
        checkout.force();
        repo.reset(target_commit.as_object(), ResetType::Hard, Some(&mut checkout))
            .map_err(|e| format!("reset: {}", e.message()))?;

        eprintln!("[CodePapr] restore_execute: reset to {}, {} files changed", target_sha, files_changed);

        Ok(RestoreResult {
            ok: true,
            files_restored: files_changed,
            files_deleted: 0,
            backup_ref,
            error: None,
        })
    }

    pub fn undo(&self) -> Result<(), String> {
        let git_path = code_papr_git_path(&self.workspace);
        let repo = Repository::open(&git_path)
            .map_err(|e| format!("open repo: {}", e.message()))?;
        repo.set_workdir(&self.workspace, false)
            .map_err(|e| format!("set workdir: {}", e.message()))?;

        let backup_ref = repo.find_reference(BACKUP_REF)
            .map_err(|_| format!("backup ref {} not found", BACKUP_REF))?;
        let target_oid = backup_ref.target()
            .ok_or_else(|| "backup ref has no target".to_string())?;
        let target_commit = repo.find_commit(target_oid)
            .map_err(|e| format!("find backup commit: {}", e.message()))?;

        let mut checkout = git2::build::CheckoutBuilder::new();
        checkout.force();
        repo.reset(target_commit.as_object(), ResetType::Hard, Some(&mut checkout))
            .map_err(|e| format!("undo reset: {}", e.message()))?;

        eprintln!("[CodePapr] restore_undo: restored to {}", target_oid);

        Ok(())
    }
}
