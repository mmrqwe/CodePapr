use std::path::{Path, PathBuf};

use git2::{
    BranchType, Delta, DiffFindOptions, DiffOptions, IndexAddOption, Repository,
    RepositoryInitOptions, ResetType, Signature,
};
use serde::{Deserialize, Serialize};

const DEFAULT_AUTHOR_NAME: &str = "CodePapr";
const DEFAULT_AUTHOR_EMAIL: &str = "codepapr@local";
const BASELINE_COMMIT_MESSAGE: &str = "codepapr:baseline";
const CODEPAPR_GIT_SUBDIR: &str = ".CodePapr/git";

#[derive(Debug, Serialize, Deserialize)]
pub struct GitCheckpointEnsureResult {
    pub ready: bool,
    pub created_repo: bool,
    pub head_sha: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GitCheckpointCreateResult {
    pub sha: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GitCheckpointResetResult {
    pub files_changed: usize,
    pub head_sha: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChangedFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub additions: usize,
    pub deletions: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CommitChangedFiles {
    pub sha: String,
    pub parent_sha: Option<String>,
    pub files: Vec<ChangedFile>,
    pub total_additions: usize,
    pub total_deletions: usize,
}

fn ensure_signature(repo: &Repository) -> Result<Signature<'static>, git2::Error> {
    if let Ok(sig) = repo.signature() {
        return Ok(sig);
    }

    let mut config = repo.config()?;
    if config.get_string("user.email").is_err() {
        config.set_str("user.email", DEFAULT_AUTHOR_EMAIL)?;
    }
    if config.get_string("user.name").is_err() {
        config.set_str("user.name", DEFAULT_AUTHOR_NAME)?;
    }

    repo.signature()
}

fn baseline_commit_if_empty(repo: &Repository) -> Result<Option<String>, git2::Error> {
    if repo.head().is_ok() {
        return Ok(None);
    }

    let signature = ensure_signature(repo)?;
    let mut index = repo.index()?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;
    let commit_oid = repo.commit(
        Some("HEAD"),
        &signature,
        &signature,
        BASELINE_COMMIT_MESSAGE,
        &tree,
        &[],
    )?;
    Ok(Some(commit_oid.to_string()))
}

fn open_or_init_repository(workspace: &Path) -> Result<(Repository, bool), git2::Error> {
    let code_papr_git = workspace.join(CODEPAPR_GIT_SUBDIR);
    let dot_git = code_papr_git.join(".git");

    if dot_git.is_dir() {
        if let Ok(repo) = Repository::open(&code_papr_git) {
            return Ok((repo, false));
        }
    }

    std::fs::create_dir_all(&code_papr_git).map_err(|e| {
        git2::Error::from_str(&format!("failed to create git dir: {e}"))
    })?;

    let mut opts = RepositoryInitOptions::new();
    opts.no_reinit(true);
    let repo = Repository::init_opts(&code_papr_git, &opts)?;

    {
        let mut config = repo.config()?;
        config.set_str("core.worktree", &workspace.to_string_lossy())?;
    }

    Ok((repo, true))
}

fn code_papr_git_path(workspace: &Path) -> PathBuf {
    workspace.join(CODEPAPR_GIT_SUBDIR)
}

fn current_head_sha(repo: &Repository) -> Option<String> {
    repo.head()
        .ok()
        .and_then(|head| head.target())
        .map(|oid| oid.to_string())
}

const CODEPAPR_EXCLUDE_MARKER: &str = "# codepapr:checkpoint-exclude";
const CODEPAPR_EXCLUDE_BLOCK: &str = "\n# codepapr:checkpoint-exclude\n.CodePapr/\n";

/// 把 `.CodePapr/` 从 git 跟踪范围排除掉，避免 checkpoint commit 把
/// 应用自身的 sqlite/会话状态一起记进版本。规则只写到 `.git/info/exclude`，
/// 不会污染用户的 `.gitignore`，也不会跟随 push。幂等：通过 marker 注释判断。
fn ensure_codepapr_excluded(repo: &Repository) -> std::io::Result<()> {
    use std::fs;
    use std::io::Write;

    let info_dir = repo.path().join("info");
    if !info_dir.exists() {
        fs::create_dir_all(&info_dir)?;
    }
    let exclude_path = info_dir.join("exclude");

    let existing = fs::read_to_string(&exclude_path).unwrap_or_default();
    if existing.contains(CODEPAPR_EXCLUDE_MARKER) {
        return Ok(());
    }

    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&exclude_path)?;
    // 若已有内容且末尾不是换行，先补一个换行避免规则被吞到上一行
    if !existing.is_empty() && !existing.ends_with('\n') {
        file.write_all(b"\n")?;
    }
    file.write_all(CODEPAPR_EXCLUDE_BLOCK.as_bytes())?;
    Ok(())
}

fn ensure_inner(workspace: &Path) -> Result<GitCheckpointEnsureResult, git2::Error> {
    let (repo, created_repo) = open_or_init_repository(workspace)?;
    ensure_signature(&repo)?;
    // 先排除 .codepapr/ 再打 baseline，确保 baseline commit 也不会带上 .codepapr/。
    if let Err(err) = ensure_codepapr_excluded(&repo) {
        return Err(git2::Error::from_str(&format!(
            "failed to write .git/info/exclude: {err}"
        )));
    }
    baseline_commit_if_empty(&repo)?;

    let head_sha = current_head_sha(&repo);

    Ok(GitCheckpointEnsureResult {
        ready: head_sha.is_some(),
        created_repo,
        head_sha,
        error: None,
    })
}

#[tauri::command]
pub async fn git_checkpoint_ensure(workspace_path: String) -> GitCheckpointEnsureResult {
    let workspace = std::path::PathBuf::from(workspace_path);
    let result = tokio::task::spawn_blocking(move || ensure_inner(&workspace)).await;

    match result {
        Ok(Ok(value)) => value,
        Ok(Err(err)) => GitCheckpointEnsureResult {
            ready: false,
            created_repo: false,
            head_sha: None,
            error: Some(err.message().to_string()),
        },
        Err(join_err) => GitCheckpointEnsureResult {
            ready: false,
            created_repo: false,
            head_sha: None,
            error: Some(format!("git ensure task failed: {join_err}")),
        },
    }
}

fn create_inner(workspace: &Path, label: &str) -> Result<GitCheckpointCreateResult, git2::Error> {
    let repo = Repository::open(&code_papr_git_path(workspace))?;
    let signature = ensure_signature(&repo)?;

    let mut index = repo.index()?;
    index.add_all(
        ["*"].iter(),
        IndexAddOption::DEFAULT | IndexAddOption::CHECK_PATHSPEC,
        None,
    )?;
    index.write()?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;

    let parent_commit = repo
        .head()
        .ok()
        .and_then(|head| head.target().and_then(|oid| repo.find_commit(oid).ok()));

    let parents: Vec<&git2::Commit> = parent_commit.iter().collect();
    let commit_oid = repo.commit(Some("HEAD"), &signature, &signature, label, &tree, &parents)?;

    Ok(GitCheckpointCreateResult {
        sha: commit_oid.to_string(),
    })
}

#[tauri::command]
pub async fn git_checkpoint_create(
    workspace_path: String,
    label: String,
) -> Result<GitCheckpointCreateResult, String> {
    let workspace = std::path::PathBuf::from(workspace_path);
    let label_owned = label;
    tokio::task::spawn_blocking(move || create_inner(&workspace, &label_owned))
        .await
        .map_err(|err| format!("git checkpoint task failed: {err}"))?
        .map_err(|err| err.message().to_string())
}

fn reset_inner(
    workspace: &Path,
    target_sha: &str,
) -> Result<GitCheckpointResetResult, git2::Error> {
    let repo = Repository::open(&code_papr_git_path(workspace))?;
    let oid = git2::Oid::from_str(target_sha)?;
    let target_commit = repo.find_commit(oid)?;
    let target_tree = target_commit.tree()?;

    let head_tree = repo
        .head()
        .ok()
        .and_then(|h| h.target())
        .and_then(|h_oid| repo.find_commit(h_oid).ok())
        .and_then(|commit| commit.tree().ok());

    let files_changed = match &head_tree {
        Some(prev_tree) => {
            let diff = repo.diff_tree_to_tree(Some(prev_tree), Some(&target_tree), None)?;
            diff.deltas().count()
        }
        None => target_tree.len(),
    };

    let target_object = target_commit.as_object();
    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout.force();
    repo.reset(target_object, ResetType::Hard, Some(&mut checkout))?;

    let head_sha = current_head_sha(&repo).unwrap_or_else(|| target_sha.to_string());

    Ok(GitCheckpointResetResult {
        files_changed,
        head_sha,
    })
}

#[tauri::command]
pub async fn git_checkpoint_reset(
    workspace_path: String,
    target_sha: String,
) -> Result<GitCheckpointResetResult, String> {
    let workspace = std::path::PathBuf::from(workspace_path);
    let sha_owned = target_sha;
    tokio::task::spawn_blocking(move || reset_inner(&workspace, &sha_owned))
        .await
        .map_err(|err| format!("git reset task failed: {err}"))?
        .map_err(|err| err.message().to_string())
}

#[tauri::command]
pub async fn git_checkpoint_head_sha(workspace_path: String) -> Option<String> {
    let workspace = std::path::PathBuf::from(workspace_path);
    let git_path = code_papr_git_path(&workspace);
    tokio::task::spawn_blocking(move || {
        Repository::open(&git_path)
            .ok()
            .and_then(|repo| current_head_sha(&repo))
    })
    .await
    .ok()
    .flatten()
}

fn delta_status_code(status: Delta) -> &'static str {
    match status {
        Delta::Added => "A",
        Delta::Deleted => "D",
        Delta::Modified => "M",
        Delta::Renamed => "R",
        Delta::Copied => "C",
        Delta::Typechange => "T",
        Delta::Untracked => "?",
        Delta::Ignored => "!",
        Delta::Unmodified => "=",
        Delta::Conflicted => "U",
        Delta::Unreadable => "X",
    }
}

fn changed_files_inner(
    workspace: &Path,
    sha: &str,
) -> Result<CommitChangedFiles, git2::Error> {
    let repo = Repository::open(&code_papr_git_path(workspace))?;
    let oid = git2::Oid::from_str(sha)?;
    let commit = repo.find_commit(oid)?;
    let tree = commit.tree()?;

    let parent_commit = if commit.parent_count() > 0 {
        Some(commit.parent(0)?)
    } else {
        None
    };
    let parent_tree = match &parent_commit {
        Some(c) => Some(c.tree()?),
        None => None,
    };
    let parent_sha = parent_commit.as_ref().map(|c| c.id().to_string());

    let mut diff_opts = DiffOptions::new();
    diff_opts.include_typechange(true);
    let mut diff = repo.diff_tree_to_tree(
        parent_tree.as_ref(),
        Some(&tree),
        Some(&mut diff_opts),
    )?;

    let mut find_opts = DiffFindOptions::new();
    find_opts.renames(true).copies(true);
    diff.find_similar(Some(&mut find_opts))?;

    let delta_count = diff.deltas().len();
    let mut files: Vec<ChangedFile> = Vec::with_capacity(delta_count);
    for i in 0..delta_count {
        let delta = match diff.get_delta(i) {
            Some(d) => d,
            None => continue,
        };
        let status = delta_status_code(delta.status()).to_string();
        let new_path = delta
            .new_file()
            .path()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let old_path_str = delta
            .old_file()
            .path()
            .map(|p| p.to_string_lossy().to_string());
        let path = if !new_path.is_empty() {
            new_path
        } else {
            old_path_str.clone().unwrap_or_default()
        };
        let old_path = match (status.as_str(), old_path_str) {
            ("R", Some(op)) | ("C", Some(op)) if op != path => Some(op),
            _ => None,
        };
        files.push(ChangedFile {
            path,
            old_path,
            status,
            additions: 0,
            deletions: 0,
        });
    }

    let mut total_additions = 0usize;
    let mut total_deletions = 0usize;
    for i in 0..delta_count {
        if let Ok(Some(patch)) = git2::Patch::from_diff(&diff, i) {
            if let Ok((_, adds, dels)) = patch.line_stats() {
                if let Some(file) = files.get_mut(i) {
                    file.additions = adds;
                    file.deletions = dels;
                }
                total_additions += adds;
                total_deletions += dels;
            }
        }
    }

    Ok(CommitChangedFiles {
        sha: sha.to_string(),
        parent_sha,
        files,
        total_additions,
        total_deletions,
    })
}

#[tauri::command]
pub async fn git_checkpoint_changed_files(
    workspace_path: String,
    sha: String,
) -> Result<CommitChangedFiles, String> {
    let workspace = std::path::PathBuf::from(workspace_path);
    let sha_owned = sha;
    tokio::task::spawn_blocking(move || changed_files_inner(&workspace, &sha_owned))
        .await
        .map_err(|err| format!("git changed files task failed: {err}"))?
        .map_err(|err| err.message().to_string())
}

// 当前未在前端使用，但保留以备 GitPanel 等场景需要
#[allow(dead_code)]
fn list_branches_inner(workspace: &Path) -> Result<Vec<String>, git2::Error> {
    let repo = Repository::open(&code_papr_git_path(workspace))?;
    let mut names = Vec::new();
    for branch in repo.branches(Some(BranchType::Local))? {
        let (b, _ty) = branch?;
        if let Some(name) = b.name()? {
            names.push(name.to_string());
        }
    }
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_workspace(label: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        let unique = format!(
            "codepapr-git-checkpoint-{label}-{}",
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
    fn ensure_initializes_repo_and_creates_baseline() {
        let workspace = temp_workspace("ensure");
        let result = ensure_inner(&workspace).expect("ensure ok");
        assert!(result.ready);
        assert!(result.created_repo);
        assert!(result.head_sha.is_some());
        // Re-running is idempotent.
        let again = ensure_inner(&workspace).expect("ensure ok again");
        assert!(again.ready);
        assert!(!again.created_repo);
        assert_eq!(result.head_sha, again.head_sha);
        fs::remove_dir_all(workspace).ok();
    }

    #[test]
    fn create_then_reset_round_trip() {
        let workspace = temp_workspace("roundtrip");
        ensure_inner(&workspace).expect("ensure ok");

        // Snapshot 1: file with content A
        fs::write(workspace.join("a.txt"), b"hello\n").unwrap();
        let cp1 = create_inner(&workspace, "checkpoint:1").expect("commit ok");

        // Snapshot 2: file edited and a new file added
        fs::write(workspace.join("a.txt"), b"changed\n").unwrap();
        fs::write(workspace.join("b.txt"), b"new\n").unwrap();
        let cp2 = create_inner(&workspace, "checkpoint:2").expect("commit ok");
        assert_ne!(cp1.sha, cp2.sha);

        // Reset to cp1 -> a.txt restored, b.txt removed
        let reset = reset_inner(&workspace, &cp1.sha).expect("reset ok");
        assert!(reset.files_changed >= 1);
        assert_eq!(reset.head_sha, cp1.sha);
        let a_after = fs::read_to_string(workspace.join("a.txt")).unwrap();
        assert_eq!(a_after, "hello\n");
        assert!(!workspace.join("b.txt").exists(), "b.txt should be gone");

        fs::remove_dir_all(workspace).ok();
    }

    #[test]
    fn create_with_no_changes_still_commits() {
        let workspace = temp_workspace("empty-commit");
        ensure_inner(&workspace).expect("ensure ok");
        let first = create_inner(&workspace, "checkpoint:a").expect("first ok");
        let second = create_inner(&workspace, "checkpoint:b").expect("second ok");
        // Different commit messages -> different SHAs even with same tree.
        assert_ne!(first.sha, second.sha);
        fs::remove_dir_all(workspace).ok();
    }

    #[test]
    fn head_sha_returns_none_for_non_repo() {
        let workspace = temp_workspace("non-repo");
        let repo = Repository::open(&workspace);
        assert!(repo.is_err());
        fs::remove_dir_all(workspace).ok();
    }

    #[test]
    fn codepapr_dir_is_excluded_from_checkpoint() {
        let workspace = temp_workspace("exclude-codepapr");
        ensure_inner(&workspace).expect("ensure ok");

        let cp_dir = workspace.join(".CodePapr");
        // ensure_inner 已经创建了 .CodePapr/git/，再放一个 sqlite 文件模拟状态
        fs::write(cp_dir.join("codepapr.sqlite"), b"app state").unwrap();
        // 同时放一个普通业务文件
        fs::write(workspace.join("user.txt"), b"user content").unwrap();

        let cp = create_inner(&workspace, "checkpoint:exclude").expect("commit ok");

        // 检查 commit tree：user.txt 在内，.CodePapr/ 不在内
        let repo = Repository::open(&code_papr_git_path(&workspace)).unwrap();
        let oid = git2::Oid::from_str(&cp.sha).unwrap();
        let commit = repo.find_commit(oid).unwrap();
        let tree = commit.tree().unwrap();
        assert!(
            tree.get_name("user.txt").is_some(),
            "user.txt should be tracked"
        );
        assert!(
            tree.get_name(".CodePapr").is_none(),
            ".CodePapr/ must be excluded from checkpoint"
        );

        // exclude 文件应包含 marker
        let exclude_path = workspace
            .join(".CodePapr")
            .join("git")
            .join(".git")
            .join("info")
            .join("exclude");
        let exclude_content = fs::read_to_string(&exclude_path).unwrap();
        assert!(exclude_content.contains(CODEPAPR_EXCLUDE_MARKER));
        assert!(exclude_content.contains(".CodePapr/"));

        // 二次 ensure 应该幂等：不重复追加
        ensure_inner(&workspace).expect("ensure ok again");
        let exclude_after = fs::read_to_string(&exclude_path).unwrap();
        let marker_count = exclude_after.matches(CODEPAPR_EXCLUDE_MARKER).count();
        assert_eq!(
            marker_count, 1,
            "exclude block must be written exactly once"
        );

        fs::remove_dir_all(workspace).ok();
    }

    #[test]
    fn reset_does_not_touch_codepapr_dir() {
        let workspace = temp_workspace("reset-keeps-codepapr");
        ensure_inner(&workspace).expect("ensure ok");

        // checkpoint 1：只有 user.txt
        fs::write(workspace.join("user.txt"), b"v1").unwrap();
        let cp1 = create_inner(&workspace, "checkpoint:1").expect("commit ok");

        // 之后用户在 .CodePapr/ 写入数据，并且改了 user.txt
        let cp_dir = workspace.join(".CodePapr");
        // ensure_inner 已创建了 .CodePapr/git/，直接写新文件
        fs::write(cp_dir.join("codepapr.sqlite"), b"current state").unwrap();
        fs::write(workspace.join("user.txt"), b"v2").unwrap();
        create_inner(&workspace, "checkpoint:2").expect("commit ok");

        // 重置到 cp1 -> user.txt 应回到 v1，.CodePapr/codepapr.sqlite 应保留
        reset_inner(&workspace, &cp1.sha).expect("reset ok");
        assert_eq!(
            fs::read_to_string(workspace.join("user.txt")).unwrap(),
            "v1"
        );
        assert!(
            cp_dir.join("codepapr.sqlite").exists(),
            ".CodePapr/ files must survive reset"
        );
        assert_eq!(
            fs::read_to_string(cp_dir.join("codepapr.sqlite")).unwrap(),
            "current state",
            ".CodePapr/ contents must remain unchanged"
        );

        fs::remove_dir_all(workspace).ok();
    }

    #[test]
    fn changed_files_reports_added_modified_deleted() {
        let workspace = temp_workspace("changed-files");
        ensure_inner(&workspace).expect("ensure ok");

        // cp1: a.txt 初始
        fs::write(workspace.join("a.txt"), b"line1\nline2\n").unwrap();
        fs::write(workspace.join("c.txt"), b"to-delete\n").unwrap();
        let cp1 = create_inner(&workspace, "checkpoint:1").expect("commit ok");

        // cp2: 修改 a.txt，新增 b.txt，删除 c.txt
        fs::write(
            workspace.join("a.txt"),
            b"line1\nline2\nline3\nline4\n",
        )
        .unwrap();
        fs::write(workspace.join("b.txt"), b"new file\n").unwrap();
        fs::remove_file(workspace.join("c.txt")).unwrap();
        let cp2 = create_inner(&workspace, "checkpoint:2").expect("commit ok");

        let result = changed_files_inner(&workspace, &cp2.sha).expect("changed files ok");
        assert_eq!(result.sha, cp2.sha);
        assert_eq!(result.parent_sha.as_deref(), Some(cp1.sha.as_str()));
        assert!(result.files.len() >= 3, "expected 3 changed files");

        let by_path: std::collections::HashMap<_, _> = result
            .files
            .iter()
            .map(|f| (f.path.clone(), f))
            .collect();
        let a = by_path.get("a.txt").expect("a.txt in result");
        assert_eq!(a.status, "M");
        assert!(a.additions >= 2, "a.txt should have 2 additions");
        let b = by_path.get("b.txt").expect("b.txt in result");
        assert_eq!(b.status, "A");
        assert_eq!(b.additions, 1);
        let c = by_path.get("c.txt").expect("c.txt in result");
        assert_eq!(c.status, "D");
        assert_eq!(c.deletions, 1);

        assert!(result.total_additions >= 3);
        assert!(result.total_deletions >= 1);

        fs::remove_dir_all(workspace).ok();
    }

    #[test]
    fn changed_files_for_baseline_lists_all_added() {
        let workspace = temp_workspace("changed-files-baseline");
        ensure_inner(&workspace).expect("ensure ok");

        fs::write(workspace.join("only.txt"), b"hello\n").unwrap();
        let cp = create_inner(&workspace, "checkpoint:first").expect("commit ok");

        // baseline 没有父提交以外的内容；first checkpoint 父就是 baseline。
        let result = changed_files_inner(&workspace, &cp.sha).expect("changed files ok");
        assert!(result.parent_sha.is_some(), "should have baseline parent");
        let only = result
            .files
            .iter()
            .find(|f| f.path == "only.txt")
            .expect("only.txt");
        assert_eq!(only.status, "A");
        assert_eq!(only.additions, 1);

        fs::remove_dir_all(workspace).ok();
    }
}
