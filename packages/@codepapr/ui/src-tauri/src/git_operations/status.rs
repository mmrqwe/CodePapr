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
    // 新目录下的未跟踪文件必须展开成具体路径，否则面板会把 `pkg/` 当目录条目丢掉。
    opts.recurse_untracked_dirs(true);

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
        let mut path = entry.path().unwrap_or("").to_string();
        // libgit2 的 StatusEntry 通过 head_to_index/index_to_worktree 两个
        // DiffDelta 暴露重命名两侧路径。注意：检测到重命名时 entry.path()
        // 返回的是"旧路径"，新路径在 delta.new_file() 里——面板与选择性
        // 提交需要 path=新路径、old_path=旧路径才能把 rename 当作
        // "旧路径删除 + 新路径新增"正确处理。
        let mut old_path: Option<String> = None;
        let rename_delta = if status.contains(git2::Status::INDEX_RENAMED) {
            entry.head_to_index()
        } else if status.contains(git2::Status::WT_RENAMED) {
            entry.index_to_workdir()
        } else {
            None
        };
        if let Some(delta) = rename_delta {
            if let Some(new_path) = delta.new_file().path() {
                path = new_path.to_string_lossy().to_string();
            }
            old_path = delta.old_file().path().map(|p| p.to_string_lossy().to_string());
        }
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
    // 读锁：与写操作互斥，读读并发（面板 status+log 并行刷新不被串行）。
    crate::shared::run_blocking_workspace_task(move || -> Result<GitStatusResult, String> {
        let workspace = std::path::PathBuf::from(workspace_path);
        Ok(crate::shared::with_workspace_git_read_lock(&workspace, || {
            git_status_impl(&workspace)
        }))
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

    /// 新目录下的未跟踪文件必须展开成具体路径，否则前端会把 `nested/` 当目录丢掉。
    #[test]
    fn test_status_recurses_untracked_directories() {
        let workspace = temp_workspace("untracked-dir");
        let engine = SnapshotEngine::new(&workspace);
        engine.ensure();

        fs::write(workspace.join("tracked.txt"), "ok\n").unwrap();
        engine.create("baseline").expect("baseline");

        fs::create_dir_all(workspace.join("nested/inner")).unwrap();
        fs::write(workspace.join("nested/inner/new.txt"), "new\n").unwrap();

        let result = git_status_impl(&workspace);
        let nested = result.entries.iter().find(|e| e.path == "nested/inner/new.txt");
        assert!(nested.is_some(), "nested/inner/new.txt 应出现在状态里，不能只报 nested/: {:?}", result.entries.iter().map(|e| e.path.as_str()).collect::<Vec<_>>());
        let nested = nested.unwrap();
        assert!(nested.is_untracked, "nested 新文件应标记为未跟踪");
        assert!(
            !result.entries.iter().any(|e| e.path.ends_with('/')),
            "不应再以目录条目代替具体文件: {:?}",
            result.entries.iter().map(|e| e.path.as_str()).collect::<Vec<_>>()
        );

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

    /// 回归：重命名（删除旧文件 + 暂存同内容新文件）必须报告 old_path，
    /// 面板与选择性提交依赖它把 rename 当作"旧路径删除 + 新路径新增"。
    /// 旧实现 old_path 恒为 None，rename 的旧路径会残留进提交。
    #[test]
    fn test_status_reports_rename_old_path() {
        let workspace = temp_workspace("rename");
        let engine = SnapshotEngine::new(&workspace);
        engine.ensure();

        let content = "same content for rename detection\n";
        fs::write(workspace.join("original.txt"), content).unwrap();
        engine.create("baseline").expect("baseline");

        // 工作区改名：删除旧文件、新增同内容文件，并把两者都暂存进 index
        fs::remove_file(workspace.join("original.txt")).unwrap();
        fs::write(workspace.join("renamed.txt"), content).unwrap();
        let stage = super::super::stage::git_stage_impl(
            &workspace,
            false,
            &["original.txt".to_string(), "renamed.txt".to_string()],
        );
        assert!(stage.ok, "stage rename should succeed: {}", stage.message);

        let result = git_status_impl(&workspace);
        let entry = result
            .entries
            .iter()
            .find(|e| e.path == "renamed.txt")
            .expect("renamed.txt 应出现在状态里");
        assert_eq!(entry.index_status, "R", "应识别为索引重命名");
        assert_eq!(
            entry.old_path.as_deref(),
            Some("original.txt"),
            "必须报告重命名旧路径"
        );

        fs::remove_dir_all(&workspace).ok();
    }
}
