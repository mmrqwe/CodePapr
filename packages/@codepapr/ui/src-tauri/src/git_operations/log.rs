use std::path::PathBuf;
use crate::snapshot::types::GitLogEntry;
use super::open_repo;

pub fn git_log_impl(workspace: &std::path::Path, limit: usize) -> Vec<GitLogEntry> {
    let repo = match open_repo(workspace) {
        Ok(r) => r,
        Err(_) => return vec![],
    };

    let head_oid = repo.head().ok().and_then(|h| h.target());
    let mut revwalk = match repo.revwalk() {
        Ok(rw) => rw,
        Err(_) => return vec![],
    };
    revwalk.set_sorting(git2::Sort::TIME | git2::Sort::TOPOLOGICAL).ok();
    if revwalk.push_head().is_err() {
        return vec![];
    }

    let mut result = Vec::new();
    for oid in revwalk.take(limit) {
        let oid = match oid { Ok(o) => o, Err(_) => continue };
        let commit = match repo.find_commit(oid) { Ok(c) => c, Err(_) => continue };

        let sha = oid.to_string();
        let short_hash = sha[..7.min(sha.len())].to_string();
        let author = commit.author().name().unwrap_or("").to_string();
        let email = commit.author().email().unwrap_or("").to_string();
        let timestamp = commit.time().seconds();
        let message = commit.message().unwrap_or("").lines().next().unwrap_or("").to_string();
        let is_head = head_oid == Some(oid);

        let mut refs = Vec::new();
        if is_head {
            refs.push("HEAD".to_string());
        }

        result.push(GitLogEntry { sha, short_hash, author, email, timestamp, message, refs, is_head });
    }
    result
}

#[tauri::command]
pub async fn git_log(workspace_path: String, limit: Option<usize>) -> Vec<GitLogEntry> {
    // git2 历史遍历是重阻塞操作，放阻塞线程池，别卡 tokio 共享 runtime。
    crate::shared::run_blocking_workspace_task(move || -> Result<Vec<GitLogEntry>, String> {
        let workspace = std::path::PathBuf::from(workspace_path);
        Ok(git_log_impl(&workspace, limit.unwrap_or(20).min(100)))
    })
    .await
    .unwrap_or_default()
}
