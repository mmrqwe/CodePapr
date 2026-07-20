use std::path::PathBuf;
use git2::{Repository, StatusOptions};
use crate::snapshot::types::{GitStatusResult, GitStatusEntry};
use super::open_repo;

fn index_status_char(status: git2::Status) -> String {
    let mut s = String::new();
    if status.contains(git2::Status::INDEX_NEW) { s.push('A'); }
    else if status.contains(git2::Status::INDEX_MODIFIED) { s.push('M'); }
    else if status.contains(git2::Status::INDEX_DELETED) { s.push('D'); }
    else if status.contains(git2::Status::INDEX_RENAMED) { s.push('R'); }
    else { s.push(' '); }
    s
}

fn worktree_status_char(status: git2::Status) -> String {
    let mut s = String::new();
    if status.contains(git2::Status::WT_NEW) { s.push('?'); }
    else if status.contains(git2::Status::WT_MODIFIED) { s.push('M'); }
    else if status.contains(git2::Status::WT_DELETED) { s.push('D'); }
    else if status.contains(git2::Status::WT_RENAMED) { s.push('R'); }
    else { s.push(' '); }
    s
}

pub fn git_status_impl(workspace: &std::path::Path) -> GitStatusResult {
    let repo = match open_repo(workspace) {
        Ok(r) => r,
        Err(e) => return GitStatusResult {
            available: false, is_repo: false, branch: None, head_short: None,
            entries: vec![], message: Some(e),
        },
    };

    let mut opts = StatusOptions::new();
    opts.include_untracked(true);
    opts.renames_head_to_index(true);
    opts.recurse_untracked_dirs(false);

    let statuses = match repo.statuses(Some(&mut opts)) {
        Ok(s) => s,
        Err(e) => return GitStatusResult {
            available: false, is_repo: true, branch: None, head_short: None,
            entries: vec![], message: Some(e.message().to_string()),
        },
    };

    let branch = repo.head().ok()
        .and_then(|h| h.shorthand().ok().map(|s| s.to_string()));

    let head_short = repo.head().ok()
        .and_then(|h| h.target())
        .map(|oid| oid.to_string())
        .map(|s| s[..7.min(s.len())].to_string());

    let mut entries = Vec::new();
    for entry in statuses.iter() {
        let status = entry.status();
        let path = entry.path().unwrap_or("").to_string();
        let old_path = if status.contains(git2::Status::INDEX_RENAMED) || status.contains(git2::Status::WT_RENAMED) {
            // libgit2 doesn't expose old path via StatusEntry directly;
            // leave as None, frontend can infer from diff
            None
        } else { None };
        let is_untracked = status.contains(git2::Status::WT_NEW) && !status.contains(git2::Status::INDEX_NEW);
        entries.push(GitStatusEntry {
            path,
            old_path,
            index_status: index_status_char(status),
            worktree_status: worktree_status_char(status),
            is_untracked,
        });
    }

    GitStatusResult {
        available: true,
        is_repo: true,
        branch,
        head_short,
        entries,
        message: None,
    }
}

#[tauri::command]
pub async fn git_status(workspace_path: String) -> GitStatusResult {
    let workspace = std::path::PathBuf::from(workspace_path);
    git_status_impl(&workspace)
}
