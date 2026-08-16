use git2::StatusOptions;
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
    // git2 状态遍历是重阻塞操作，放阻塞线程池，别卡 tokio 共享 runtime。
    crate::shared::run_blocking_workspace_task(move || -> Result<GitStatusResult, String> {
        let workspace = std::path::PathBuf::from(workspace_path);
        Ok(git_status_impl(&workspace))
    })
    .await
    .unwrap_or_else(|err| GitStatusResult {
        available: false,
        is_repo: false,
        branch: None,
        head_short: None,
        entries: Vec::new(),
        message: Some(err),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snapshot::SnapshotEngine;
    use std::fs;

    fn temp_workspace(label: &str) -> std::path::PathBuf {
        let mut path = std::env::temp_dir();
        let unique = format!(
            "codepapr-status-{label}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        path.push(unique);
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn test_status_reports_untracked_and_modified() {
        let workspace = temp_workspace("basic");
        let engine = SnapshotEngine::new(&workspace);
        engine.ensure();

        fs::write(workspace.join("committed.txt"), "v1\n").unwrap();
        engine.create("baseline").expect("baseline");

        // 新增未跟踪文件
        fs::write(workspace.join("new.txt"), "new\n").unwrap();
        // 修改已提交文件
        fs::write(workspace.join("committed.txt"), "v2\n").unwrap();

        let result = git_status_impl(&workspace);
        assert!(result.available, "status should be available");
        assert!(result.is_repo, "should be a repo");

        let new_entry = result.entries.iter().find(|e| e.path == "new.txt");
        assert!(new_entry.is_some(), "new.txt 应出现在状态里");
        let new_entry = new_entry.unwrap();
        assert!(new_entry.is_untracked, "new.txt 应标记为未跟踪");
        assert_eq!(new_entry.worktree_status, "?");

        let modified = result.entries.iter().find(|e| e.path == "committed.txt");
        assert!(modified.is_some(), "committed.txt 应出现在状态里");
        let modified = modified.unwrap();
        assert_eq!(modified.worktree_status, "M", "committed.txt 应标记为已修改");

        fs::remove_dir_all(&workspace).ok();
    }

    #[test]
    fn test_status_returns_unavailable_when_repo_missing() {
        let workspace = temp_workspace("no-repo");
        // 不调用 engine.ensure()，模拟仓库未初始化
        let result = git_status_impl(&workspace);
        assert!(!result.available || !result.is_repo, "未初始化时应返回不可用或非 repo");

        fs::remove_dir_all(&workspace).ok();
    }
}
