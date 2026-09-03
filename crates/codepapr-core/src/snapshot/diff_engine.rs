use std::path::{Path, PathBuf};
use git2::{Repository, Oid, DiffOptions};
use super::types::{FileDiff, CommitChangedFiles, FileChange};
use crate::git_operations::validate_git_ref;

fn code_papr_git_path(workspace: &Path) -> PathBuf {
    workspace.join(".CodePapr/git")
}

const WORKTREE_REF: &str = "WORKTREE";

fn delta_status(delta: &git2::DiffDelta) -> &'static str {
    match delta.status() {
        git2::Delta::Added | git2::Delta::Untracked => "A",
        git2::Delta::Deleted => "D",
        git2::Delta::Modified | git2::Delta::Typechange => "M",
        git2::Delta::Renamed => "R",
        git2::Delta::Copied => "C",
        _ => "U",
    }
}

fn resolve_commit_oid(repo: &Repository, spec: &str) -> Result<Oid, String> {
    repo.revparse_single(spec)
        .map_err(|e| format!("resolve '{spec}': {}", e.message()))?
        .peel_to_commit()
        .map_err(|e| format!("'{spec}' 不是提交对象: {}", e.message()))
        .map(|c| c.id())
}

fn file_diffs_from_diff(diff: &git2::Diff<'_>) -> Vec<FileDiff> {
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
        } else {
            None
        };

        let (additions, deletions) = if let Ok(Some(patch)) = git2::Patch::from_diff(diff, i) {
            let (_context, additions, deletions) = patch.line_stats().unwrap_or((0, 0, 0));
            (additions, deletions)
        } else {
            (0, 0)
        };

        files.push(FileDiff {
            path,
            old_path,
            status,
            additions,
            deletions,
            patch: None,
        });
    }
    files
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

    /// 对比两个引用之间的文件改动。
    ///
    /// `from_sha` / `to_sha` 走 revparse，支持完整 SHA、短 SHA、`HEAD`、
    /// `abc123~1` 这类相对引用。特殊值 `WORKTREE` 作为 `to_sha` 时，对比
    /// 的是 from 树与当前工作区（含未跟踪文件）——Git 面板「与当前对比」用。
    /// 必须打开 `.CodePapr/git` 影子仓库：工作区本身常常不是 git 仓库，
    /// 在 cwd=workspace 跑 `git diff` 会得到 "Not a git repository / --no-index"。
    pub fn diff_snapshots(&self, from_sha: &str, to_sha: &str) -> Result<Vec<FileDiff>, String> {
        validate_git_ref(from_sha, "fromSha")?;
        let to_worktree = to_sha == WORKTREE_REF;
        if !to_worktree {
            validate_git_ref(to_sha, "toSha")?;
        }

        let git_path = code_papr_git_path(&self.workspace);
        let repo = Repository::open(&git_path)
            .map_err(|e| format!("open repo: {}", e.message()))?;
        repo.set_workdir(&self.workspace, false)
            .map_err(|e| format!("set workdir: {}", e.message()))?;

        let from_oid = resolve_commit_oid(&repo, from_sha)?;
        let from_tree = repo
            .find_commit(from_oid)
            .map_err(|e| format!("find from commit: {}", e.message()))?
            .tree()
            .map_err(|e| format!("from commit tree: {}", e.message()))?;

        let diff = if to_worktree {
            let mut opts = DiffOptions::new();
            opts.include_untracked(true);
            opts.recurse_untracked_dirs(true);
            repo.diff_tree_to_workdir(Some(&from_tree), Some(&mut opts))
                .map_err(|e| format!("diff worktree: {}", e.message()))?
        } else {
            let to_oid = resolve_commit_oid(&repo, to_sha)?;
            let to_tree = repo
                .find_commit(to_oid)
                .map_err(|e| format!("find to commit: {}", e.message()))?
                .tree()
                .map_err(|e| format!("to commit tree: {}", e.message()))?;
            repo.diff_tree_to_tree(Some(&from_tree), Some(&to_tree), None)
                .map_err(|e| format!("diff: {}", e.message()))?
        };

        Ok(file_diffs_from_diff(&diff))
    }

    pub fn file_content(&self, sha: &str, path: &str) -> Result<String, String> {
        validate_git_ref(sha, "sha")?;

        let git_path = code_papr_git_path(&self.workspace);
        let repo = Repository::open(&git_path)
            .map_err(|e| format!("open repo: {}", e.message()))?;
        repo.set_workdir(&self.workspace, false)
            .map_err(|e| format!("set workdir: {}", e.message()))?;

        // revparse 同时支持完整 SHA、短 SHA、分支名、HEAD 与 `sha~1`。
        // 旧实现 Oid::from_str 只认完整 40 位 SHA。
        let oid = resolve_commit_oid(&repo, sha)?;
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

    /// 读取 shadow repo 索引（INDEX）中某路径的内容，供编辑器 diff 的
    /// staged 视图使用。路径不在索引中（未暂存/已删除）时返回错误。
    pub fn index_file_content(&self, path: &str) -> Result<String, String> {
        let git_path = code_papr_git_path(&self.workspace);
        let repo = Repository::open(&git_path)
            .map_err(|e| format!("open repo: {}", e.message()))?;

        let rel = super::ignore_resolver::git_relative_path(std::path::Path::new(path));
        let index = repo.index()
            .map_err(|e| format!("index: {}", e.message()))?;
        let entry = index
            .get_path(&rel, 0)
            .ok_or_else(|| format!("路径不在索引中: {path}"))?;
        let blob = repo.find_blob(entry.id)
            .map_err(|e| format!("find_blob: {}", e.message()))?;
        let content = blob.content();

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snapshot::SnapshotEngine;
    use std::fs;

    fn temp_workspace(label: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        let unique = format!(
            "codepapr-diffengine-{label}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        path.push(unique);
        fs::create_dir_all(&path).unwrap();
        path
    }

    /// 回归：file_content 必须支持 "HEAD" 等引用（编辑器 diff 用 HEAD 取基线）。
    /// 旧实现 Oid::from_str 只认完整 40 位 SHA，"HEAD" 必然失败。
    #[test]
    fn test_file_content_accepts_head_ref() {
        let workspace = temp_workspace("head-ref");
        let engine = SnapshotEngine::new(&workspace);
        engine.ensure();
        fs::write(workspace.join("a.txt"), "committed\n").unwrap();
        engine.create("baseline").expect("baseline");

        let diff_engine = DiffEngine::new(&workspace);
        let content = diff_engine
            .file_content("HEAD", "a.txt")
            .expect("file_content('HEAD') should succeed");
        assert_eq!(content, "committed\n");

        fs::remove_dir_all(&workspace).ok();
    }

    /// 回归：index_file_content 读取 shadow 索引中的内容（staged diff 视图）。
    #[test]
    fn test_index_file_content_reads_staged_version() {
        let workspace = temp_workspace("index-content");
        let engine = SnapshotEngine::new(&workspace);
        engine.ensure();
        fs::write(workspace.join("a.txt"), "v1\n").unwrap();
        engine.create("baseline").expect("baseline");

        fs::write(workspace.join("a.txt"), "v2-staged\n").unwrap();
        let stage = crate::git_operations::stage::git_stage_impl(
            &workspace,
            false,
            &["a.txt".to_string()],
        );
        assert!(stage.ok, "stage should succeed: {}", stage.message);

        let diff_engine = DiffEngine::new(&workspace);
        let content = diff_engine
            .index_file_content("a.txt")
            .expect("index_file_content should succeed");
        assert_eq!(content, "v2-staged\n");

        // 未暂存/不在索引中的路径必须报错而非 panic
        assert!(diff_engine.index_file_content("missing.txt").is_err());

        fs::remove_dir_all(&workspace).ok();
    }

    /// 回归：Git 面板「与之前对比」传的是 `{sha}~1`，必须走 revparse
    /// 而不是 Oid::from_str（后者只认完整 40 位 SHA）。
    #[test]
    fn test_diff_snapshots_accepts_parent_revparse() {
        let workspace = temp_workspace("parent-rev");
        let engine = SnapshotEngine::new(&workspace);
        engine.ensure();
        fs::write(workspace.join("a.txt"), "v1\n").unwrap();
        engine.create("first").expect("first");
        fs::write(workspace.join("a.txt"), "v2\n").unwrap();
        let second = engine.create("second").expect("second");

        let diff_engine = DiffEngine::new(&workspace);
        let files = diff_engine
            .diff_snapshots(&format!("{}~1", second.sha), &second.sha)
            .expect("parent revparse should succeed");
        assert!(
            files.iter().any(|f| f.path == "a.txt" && f.status == "M"),
            "parent..commit 应包含 a.txt 修改: {:?}",
            files
        );

        fs::remove_dir_all(&workspace).ok();
    }

    /// 回归：Git 面板「与当前对比」必须 diff 影子仓库的提交树 vs 工作区，
    /// 不能在用户工作区 cwd 跑 `git diff`（工作区常常不是 git 仓库）。
    #[test]
    fn test_diff_snapshots_to_worktree_shows_workdir_changes() {
        let workspace = temp_workspace("worktree");
        let engine = SnapshotEngine::new(&workspace);
        engine.ensure();
        fs::write(workspace.join("a.txt"), "v1\n").unwrap();
        let snap = engine.create("baseline").expect("baseline");

        fs::write(workspace.join("a.txt"), "v2\n").unwrap();
        fs::write(workspace.join("new.txt"), "new\n").unwrap();
        fs::create_dir_all(workspace.join("nested")).unwrap();
        fs::write(workspace.join("nested/added.ts"), "added\n").unwrap();

        let diff_engine = DiffEngine::new(&workspace);
        let files = diff_engine
            .diff_snapshots(&snap.sha, "WORKTREE")
            .expect("diff to worktree should succeed");
        assert!(
            files.iter().any(|f| f.path == "a.txt" && f.status == "M"),
            "工作区修改应出现: {:?}",
            files
        );
        assert!(
            files.iter().any(|f| f.path == "new.txt" && f.status == "A"),
            "未跟踪新文件应出现: {:?}",
            files
        );
        assert!(
            files.iter().any(|f| f.path == "nested/added.ts" && f.status == "A"),
            "未跟踪子目录文件应出现: {:?}",
            files
        );

        fs::remove_dir_all(&workspace).ok();
    }
}
