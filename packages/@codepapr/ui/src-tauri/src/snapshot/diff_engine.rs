use std::path::{Path, PathBuf};
use git2::{Repository, Oid, DiffOptions};
use super::types::{FileDiff, CommitChangedFiles, FileChange};
use crate::git_operations::validate_git_ref;

fn code_papr_git_path(workspace: &Path) -> PathBuf {
    workspace.join(".CodePapr/git")
}

fn delta_status(delta: &git2::DiffDelta) -> &'static str {
    match delta.status() {
        git2::Delta::Added => "A",
        git2::Delta::Deleted => "D",
        git2::Delta::Modified => "M",
        git2::Delta::Renamed => "R",
        git2::Delta::Copied => "C",
        
        _ => "U",
    }
}

pub struct DiffEngine {
    workspace: PathBuf,
}

impl DiffEngine {
    pub fn new(workspace: &Path) -> Self {
        Self { workspace: workspace.to_path_buf() }
    }

    pub fn changed_files(&self, sha: &str) -> Result<CommitChangedFiles, String> {
        validate_git_ref(sha, "sha")?;

        let git_path = code_papr_git_path(&self.workspace);
        let repo = Repository::open(&git_path)
            .map_err(|e| format!("open repo: {}", e.message()))?;
        repo.set_workdir(&self.workspace, false)
            .map_err(|e| format!("set workdir: {}", e.message()))?;

        let oid = Oid::from_str(sha)
            .map_err(|e| format!("parse sha: {}", e.message()))?;
        let commit = repo.find_commit(oid)
            .map_err(|e| format!("find commit: {}", e.message()))?;
        let tree = commit.tree()
            .map_err(|e| format!("commit tree: {}", e.message()))?;

        let parent_tree = commit.parent(0).ok()
            .and_then(|p| p.tree().ok());

        let mut opts = DiffOptions::new();
        opts.include_untracked(false);

        let mut diff = match &parent_tree {
            Some(pt) => repo.diff_tree_to_tree(Some(pt), Some(&tree), Some(&mut opts))
                .map_err(|e| format!("diff: {}", e.message()))?,
            None => repo.diff_tree_to_tree(None, Some(&tree), Some(&mut opts))
                .map_err(|e| format!("diff: {}", e.message()))?,
        };

        let _ = diff.find_similar(None);

        let mut files = Vec::new();
        let mut total_additions = 0usize;
        let mut total_deletions = 0usize;

        let deltas: Vec<_> = diff.deltas().collect();
        for (i, delta) in deltas.iter().enumerate() {
            let status = delta_status(delta).to_string();
            let path = delta.new_file().path()
                .or_else(|| delta.old_file().path())
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let old_path = if delta.status() == git2::Delta::Renamed {
                delta.old_file().path().map(|p| p.to_string_lossy().to_string())
            } else { None };

            let (additions, deletions) = if let Ok(Some(patch)) = git2::Patch::from_diff(&diff, i) {
                let (_context, additions, deletions) = patch.line_stats().unwrap_or((0, 0, 0));
                (additions, deletions)
            } else { (0, 0) };

            total_additions += additions;
            total_deletions += deletions;
            files.push(FileChange { path, old_path, status, additions, deletions });
        }

        Ok(CommitChangedFiles {
            sha: sha.to_string(),
            parent_sha: commit.parent(0).ok().map(|p| p.id().to_string()),
            files,
            total_additions,
            total_deletions,
        })
    }

    pub fn diff_snapshots(&self, from_sha: &str, to_sha: &str) -> Result<Vec<FileDiff>, String> {
        validate_git_ref(from_sha, "fromSha")?;
        validate_git_ref(to_sha, "toSha")?;

        let git_path = code_papr_git_path(&self.workspace);
        let repo = Repository::open(&git_path)
            .map_err(|e| format!("open repo: {}", e.message()))?;
        repo.set_workdir(&self.workspace, false)
            .map_err(|e| format!("set workdir: {}", e.message()))?;

        let from_oid = Oid::from_str(from_sha)
            .map_err(|e| format!("parse from_sha: {}", e.message()))?;
        let to_oid = Oid::from_str(to_sha)
            .map_err(|e| format!("parse to_sha: {}", e.message()))?;

        let from_tree = repo.find_commit(from_oid)
            .and_then(|c| c.tree()).ok();
        let to_tree = repo.find_commit(to_oid)
            .and_then(|c| c.tree()).ok();

        let mut diff = repo.diff_tree_to_tree(
            from_tree.as_ref(), to_tree.as_ref(), None,
        ).map_err(|e| format!("diff: {}", e.message()))?;

        let mut files = Vec::new();
        let deltas: Vec<_> = diff.deltas().collect();
        for (i, delta) in deltas.iter().enumerate() {
            let status = delta_status(delta).to_string();
            let path = delta.new_file().path()
                .or_else(|| delta.old_file().path())
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let old_path = if delta.status() == git2::Delta::Renamed {
                delta.old_file().path().map(|p| p.to_string_lossy().to_string())
            } else { None };

            let (additions, deletions) = if let Ok(Some(patch)) = git2::Patch::from_diff(&diff, i) {
                let (_context, additions, deletions) = patch.line_stats().unwrap_or((0, 0, 0));
                (additions, deletions)
            } else { (0, 0) };

            files.push(FileDiff { path, old_path, status, additions, deletions, patch: None });
        }
        Ok(files)
    }

    pub fn file_content(&self, sha: &str, path: &str) -> Result<String, String> {
        validate_git_ref(sha, "sha")?;

        let git_path = code_papr_git_path(&self.workspace);
        let repo = Repository::open(&git_path)
            .map_err(|e| format!("open repo: {}", e.message()))?;
        repo.set_workdir(&self.workspace, false)
            .map_err(|e| format!("set workdir: {}", e.message()))?;

        let oid = Oid::from_str(sha)
            .map_err(|e| format!("parse sha: {}", e.message()))?;
        let commit = repo.find_commit(oid)
            .map_err(|e| format!("find commit: {}", e.message()))?;
        let tree = commit.tree()
            .map_err(|e| format!("commit tree: {}", e.message()))?;

        let entry = tree.get_path(&super::ignore_resolver::git_relative_path(std::path::Path::new(path)))
            .map_err(|e| format!("get_path {}: {}", path, e.message()))?;
        let blob = repo.find_blob(entry.id())
            .map_err(|e| format!("find_blob: {}", e.message()))?;
        let content = blob.content();

        // 二进制文件（含 NUL 字节）无法安全转成 UTF-8 字符串，返回占位提示。
        if content.contains(&0u8) {
            return Ok(format!(
                "[binary file: {} bytes, content omitted]",
                content.len()
            ));
        }

        let text = std::str::from_utf8(content)
            .map_err(|e| format!("utf8: {}", e))?;
        Ok(text.to_string())
    }
}
