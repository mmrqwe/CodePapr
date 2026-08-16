use std::path::{Path, PathBuf};
use git2::{Repository, RepositoryInitOptions, Signature};
use super::types::{EnsureResult, SnapshotInfo};
use super::ignore_resolver::{git_relative_path, IgnoreResolver};

const CODEPAPR_GIT_SUBDIR: &str = ".CodePapr/git";
const EXCLUDE_RULES: &[&str] = &[
    ".CodePapr/",
    ".git",
    "**/.git",
    "**/.git/",
    "**/.codepapr_git_backup/",
    "node_modules/",
    "dist/",
    "build/",
    "target/",
    "coverage/",
    ".next/",
    "__pycache__/",
    ".cache/",
    ".venv/",
    "venv/",
    ".idea/",
    ".vscode/",
    "*.sqlite3",
    "*.sqlite",
    "*.db-journal",
    "*.db-wal",
    ".DS_Store",
    "Thumbs.db",
    "desktop.ini",
];
const DEFAULT_AUTHOR_NAME: &str = "CodePapr";
const DEFAULT_AUTHOR_EMAIL: &str = "codepapr@local";
const BASELINE_COMMIT_MESSAGE: &str = "codepapr:baseline";

fn code_papr_git_path(workspace: &Path) -> PathBuf {
    workspace.join(CODEPAPR_GIT_SUBDIR)
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

fn ensure_codepapr_excluded(repo: &Repository) -> std::io::Result<()> {
    use std::fs;
    use std::io::Write;

    let info_dir = repo.path().join("info");
    if !info_dir.exists() {
        fs::create_dir_all(&info_dir)?;
    }
    let exclude_path = info_dir.join("exclude");
    let existing = fs::read_to_string(&exclude_path).unwrap_or_default();
    let existing_lines: Vec<&str> = existing.lines().map(|l| l.trim()).collect();

    let mut to_append: Vec<&str> = Vec::new();
    for rule in EXCLUDE_RULES {
        if !existing_lines.iter().any(|l| l == rule) {
            to_append.push(rule);
        }
    }

    if to_append.is_empty() {
        return Ok(());
    }

    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&exclude_path)?;

    if !existing.is_empty() && !existing.ends_with('\n') {
        file.write_all(b"\n")?;
    }
    for rule in to_append {
        file.write_all(format!("{}\n", rule).as_bytes())?;
    }
    Ok(())
}

pub struct SnapshotEngine {
    workspace: PathBuf,
}

impl SnapshotEngine {
    pub fn new(workspace: &Path) -> Self {
        Self { workspace: workspace.to_path_buf() }
    }

    pub fn ensure(&self) -> EnsureResult {
        let git_path = code_papr_git_path(&self.workspace);
        let dot_git = git_path.join(".git");

        // 清理可能因崩溃遗留的锁文件（config/index/HEAD/packed-refs .lock）。
        // 只删可证明陈旧的（存活超阈值）：无条件删除会把并发操作正在使用的
        // 活锁删掉，破坏写到一半的 index/ref。
        crate::shared::remove_stale_git_locks(&dot_git);

        if dot_git.is_dir() {
            match Repository::open(&git_path) {
                Ok(repo) => {
                    let _ = repo.set_workdir(&self.workspace, false);
                    let _ = ensure_codepapr_excluded(&repo);
                    let head_sha = repo.head().ok()
                        .and_then(|h| h.target())
                        .map(|oid| oid.to_string());
                    return EnsureResult {
                        ready: head_sha.is_some(),
                        created_repo: false,
                        head_sha,
                        error: None,
                    };
                }
                Err(_) => {}
            }
        }

        let _ = std::fs::create_dir_all(&git_path);
        let mut opts = RepositoryInitOptions::new();
        opts.no_reinit(true);
        let repo = match Repository::init_opts(&git_path, &opts) {
            Ok(r) => r,
            Err(e) => return EnsureResult {
                ready: false, created_repo: false, head_sha: None,
                error: Some(e.message().to_string()),
            },
        };

        {
            let mut config = match repo.config() {
                Ok(c) => c,
                Err(e) => return EnsureResult {
                    ready: false, created_repo: false, head_sha: None,
                    error: Some(e.message().to_string()),
                },
            };
            let _ = config.set_str("core.worktree", &self.workspace.to_string_lossy());
        }

        let _ = repo.set_workdir(&self.workspace, false);
        let _ = ensure_codepapr_excluded(&repo);

        if repo.head().is_err() {
            let _ = ensure_signature(&repo);
            if let Ok(mut index) = repo.index() {
                if let Ok(tree_oid) = index.write_tree() {
                    if let Ok(tree) = repo.find_tree(tree_oid) {
                        if let Ok(sig) = repo.signature() {
                            let _ = repo.commit(
                                Some("HEAD"), &sig, &sig,
                                BASELINE_COMMIT_MESSAGE, &tree, &[],
                            );
                        }
                    }
                }
            }
        }

        let head_sha = repo.head().ok()
            .and_then(|h| h.target())
            .map(|oid| oid.to_string());

        EnsureResult {
            ready: head_sha.is_some(),
            created_repo: true,
            head_sha,
            error: None,
        }
    }

    /// Whether the workspace currently has any snapshotable files. Lets callers
    /// distinguish the benign "nothing to snapshot" case (empty/new workspace, or
    /// all files ignored) from genuine failures, without treating it as an error.
    pub fn has_snapshotable_files(&self) -> bool {
        !IgnoreResolver::new(&self.workspace).collect_files().is_empty()
    }

    pub fn create(&self, label: &str) -> Result<SnapshotInfo, String> {
        let git_path = code_papr_git_path(&self.workspace);
        let repo = Repository::open(&git_path)
            .map_err(|e| format!("open repo: {}", e.message()))?;
        repo.set_workdir(&self.workspace, false)
            .map_err(|e| format!("set workdir: {}", e.message()))?;

        let signature = ensure_signature(&repo)
            .map_err(|e| format!("signature: {}", e.message()))?;

        let resolver = IgnoreResolver::new(&self.workspace);
        let files = resolver.collect_files();

        eprintln!("[CodePapr] snapshot_create: {} files to snapshot", files.len());

        if files.is_empty() {
            return Err("no files to snapshot (workspace may be empty or all files ignored)".to_string());
        }

        let mut index = repo.index()
            .map_err(|e| format!("index: {}", e.message()))?;
        index.clear()
            .map_err(|e| format!("clear index: {}", e.message()))?;

        let mut added = 0usize;
        let mut skipped = 0usize;
        for file in &files {
            // collect_files 返回 OS 原生分隔符（Windows 为 '\'），libgit2
            // 只认 '/'：必须转换，否则 Windows 上快照会漏掉所有嵌套文件。
            match index.add_path(&git_relative_path(file)) {
                Ok(()) => added += 1,
                Err(e) => {
                    skipped += 1;
                    eprintln!("[CodePapr] snapshot_create: add_path failed for {:?}: {}", file, e.message());
                }
            }
        }

        eprintln!("[CodePapr] snapshot_create: {} files added to index", added);
        if skipped > 0 {
            // 不能静默：漏掉的文件在恢复时不会出现，必须让调用方可见。
            eprintln!("[CodePapr] snapshot_create: WARNING: {skipped} files were SKIPPED (snapshot is incomplete)");
        }

        if added == 0 {
            return Err("failed to add any files to index".to_string());
        }

        index.write()
            .map_err(|e| format!("write index: {}", e.message()))?;
        let tree_oid = index.write_tree()
            .map_err(|e| format!("write_tree: {}", e.message()))?;
        let tree = repo.find_tree(tree_oid)
            .map_err(|e| format!("find_tree: {}", e.message()))?;

        let parent_commit = repo.head().ok()
            .and_then(|h| h.target())
            .and_then(|oid| repo.find_commit(oid).ok());

        let parents: Vec<&git2::Commit> = parent_commit.iter().collect();
        let commit_oid = repo.commit(
            Some("HEAD"), &signature, &signature, label, &tree, &parents,
        ).map_err(|e| format!("commit: {}", e.message()))?;

        let head_sha = commit_oid.to_string();
        let short_hash = head_sha[..7.min(head_sha.len())].to_string();
        let timestamp = repo.find_commit(commit_oid)
            .map(|c| c.time().seconds())
            .unwrap_or(0);

        eprintln!("[CodePapr] snapshot_create: commit {}, {} files", head_sha, added);

        Ok(SnapshotInfo {
            sha: head_sha,
            short_hash,
            label: label.to_string(),
            timestamp,
            file_count: added,
            is_head: true,
            skipped_count: skipped,
        })
    }

    pub fn list(&self, limit: usize) -> Vec<SnapshotInfo> {
        let git_path = code_papr_git_path(&self.workspace);
        let repo = match Repository::open(&git_path) {
            Ok(r) => r,
            Err(_) => return vec![],
        };
        let _ = repo.set_workdir(&self.workspace, false);

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
            let label = commit.message().unwrap_or("").lines().next().unwrap_or("").to_string();
            let timestamp = commit.time().seconds();
            let is_head = head_oid == Some(oid);

            let file_count = commit.tree()
                .map(|t| t.len())
                .unwrap_or(0);

            result.push(SnapshotInfo { sha, short_hash, label, timestamp, file_count, is_head, skipped_count: 0 });
        }
        result
    }

    pub fn head_sha(&self) -> Option<String> {
        let git_path = code_papr_git_path(&self.workspace);
        let repo = Repository::open(&git_path).ok()?;
        repo.head().ok()
            .and_then(|h| h.target())
            .map(|oid| oid.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_workspace(label: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        let unique = format!("codepapr-snapshot-{label}-{}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
        path.push(unique);
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn test_snapshot_create_and_restore() {
        let workspace = temp_workspace("smoke");
        let engine = SnapshotEngine::new(&workspace);

        // 1. Ensure
        let result = engine.ensure();
        assert!(result.ready, "ensure should succeed");

        // 2. Create a file and snapshot
        fs::write(workspace.join("test.txt"), b"hello").unwrap();
        let cp1 = engine.create("checkpoint #1").expect("create cp1");
        assert!(cp1.file_count >= 1, "should have files");

        // 3. Modify and snapshot again
        fs::write(workspace.join("test.txt"), b"modified").unwrap();
        let _cp2 = engine.create("checkpoint #2").expect("create cp2");

        // 4. List
        let list = engine.list(10);
        assert!(list.len() >= 2, "should list snapshots");

        // 5. Restore to cp1
        use crate::snapshot::RestoreEngine;
        let restore = RestoreEngine::new(&workspace);
        let plan = restore.plan(&cp1.sha).expect("plan should work");
        assert!(!plan.target_sha.is_empty());

        let exec = restore.execute(&cp1.sha).expect("execute should work");
        assert!(exec.ok);
        assert!(exec.backup_ref.is_some());

        let content = fs::read_to_string(workspace.join("test.txt")).unwrap();
        assert_eq!(content, "hello", "file should be restored");

        // 6. Undo
        restore.undo().expect("undo should work");
        let content2 = fs::read_to_string(workspace.join("test.txt")).unwrap();
        assert_eq!(content2, "modified", "file should be restored after undo");

        fs::remove_dir_all(&workspace).ok();
    }

    #[test]
    /// #23：工具定义宣称接受「回退目标引用」——短 SHA、分支名、HEAD 都必须
    /// 可解析。旧实现 Oid::from_str 只认完整 40 位 SHA，LLM 拿 shortHash 必失败。
    fn restore_plan_accepts_short_sha_and_head_ref() {
        let workspace = temp_workspace("restore-short-sha");
        let engine = SnapshotEngine::new(&workspace);
        engine.ensure();
        fs::write(workspace.join("a.txt"), b"v1\n").expect("should write fixture");
        let cp = engine.create("checkpoint #1").expect("create cp1");

        let restore = crate::snapshot::RestoreEngine::new(&workspace);

        // 短 SHA（8 位）
        let short = &cp.sha[..8];
        let plan = restore
            .plan(short)
            .expect("short sha should resolve via revparse");
        assert_eq!(plan.target_label, "checkpoint #1");

        // HEAD 引用
        let plan_head = restore.plan("HEAD").expect("HEAD should resolve");
        assert!(!plan_head.target_sha.is_empty());
        assert_eq!(plan_head.target_label, "checkpoint #1");

        // execute 同样接受短 SHA（含备份 + 恢复全链路）
        let exec = restore
            .execute(short)
            .expect("execute with short sha should work");
        assert!(exec.ok);
        assert_eq!(
            fs::read_to_string(workspace.join("a.txt")).expect("should read back"),
            "v1\n"
        );

        fs::remove_dir_all(&workspace).ok();
    }

    /// #24：恢复后清理「快照之后新建的未跟踪文件」（硬 reset 只恢复被跟踪
    /// 文件，未跟踪文件会残留——恢复必须彻底）。此前因 #[test] 属性被重复
    /// 放在上一个用例上，本用例从未被运行。
    #[test]
    fn test_restore_removes_untracked_files_created_after_snapshot() {
        let workspace = temp_workspace("untracked-cleanup");
        let engine = SnapshotEngine::new(&workspace);
        engine.ensure();

        fs::write(workspace.join("existing.txt"), "original\n").unwrap();
        let cp = engine.create("baseline").expect("baseline snapshot");

        // 在快照之后新建一个未跟踪文件
        fs::write(workspace.join("untracked.txt"), "should be removed\n").unwrap();
        assert!(workspace.join("untracked.txt").exists(), "untracked file should exist before restore");

        // 恢复到快照
        use crate::snapshot::RestoreEngine;
        let restore = RestoreEngine::new(&workspace);
        let exec = restore.execute(&cp.sha).expect("restore execute");
        assert!(exec.ok, "restore should succeed");

        // 未跟踪文件应被清理
        assert!(
            !workspace.join("untracked.txt").exists(),
            "untracked file should be removed after restore (bug: hard reset leaves untracked files)"
        );
        // 已有文件应正确恢复
        assert_eq!(
            fs::read_to_string(workspace.join("existing.txt")).unwrap(),
            "original\n"
        );

        // Undo 后，untracked 文件不应回来了（因为它在备份快照中也不存在）
        // 但备份快照是 restore 前的 HEAD，也就是包含 untracked 之前的状态...
        // 实际上 backup_ref 指向的是 restore 前的 HEAD，那里没有 untracked.txt，
        // 因为 untracked 文件从未被 snapshot 过。所以 undo 后它也不存在。
        // 这里只验证 undo 不报错即可。
        restore.undo().expect("undo should work");

        fs::remove_dir_all(&workspace).ok();
    }

    #[test]
    fn test_ensure_does_not_create_git_file() {
        let workspace = temp_workspace("no-git-file");
        let engine = SnapshotEngine::new(&workspace);
        engine.ensure();

        assert!(
            !workspace.join(".git").exists(),
            "ensure() must not create a .git file in the workspace"
        );
        assert!(
            workspace.join(".CodePapr/git/.git").is_dir(),
            "snapshot repo .git dir should exist"
        );

        fs::remove_dir_all(&workspace).ok();
    }

    #[test]
    fn test_git_file_not_collected() {
        use crate::snapshot::ignore_resolver::IgnoreResolver;

        let workspace = temp_workspace("git-file-exclude");
        fs::write(workspace.join("normal.txt"), "hello\n").unwrap();
        fs::write(workspace.join(".git"), "gitdir: /some/path/.git\n").unwrap();

        let resolver = IgnoreResolver::new(&workspace);
        let files = resolver.collect_files();
        let names: Vec<String> = files.iter()
            .map(|f| f.to_string_lossy().to_string())
            .collect();

        assert!(names.contains(&"normal.txt".to_string()), "normal file should be collected");
        assert!(!names.contains(&".git".to_string()), ".git file must not be collected");

        fs::remove_dir_all(&workspace).ok();
    }

    #[test]
    fn test_codepapr_dir_not_collected() {
        use crate::snapshot::ignore_resolver::IgnoreResolver;

        let workspace = temp_workspace("codepapr-exclude");
        fs::write(workspace.join("app.rs"), "fn main() {}\n").unwrap();
        fs::create_dir_all(workspace.join(".CodePapr")).unwrap();
        fs::write(workspace.join(".CodePapr/project.sqlite"), "data").unwrap();

        let resolver = IgnoreResolver::new(&workspace);
        let files = resolver.collect_files();

        assert!(
            !files.iter().any(|f| f.to_string_lossy().contains(".CodePapr")),
            ".CodePapr files must not be collected"
        );

        fs::remove_dir_all(&workspace).ok();
    }

    #[test]
    fn test_restore_preserves_git_file_and_codepapr_dir() {
        let workspace = temp_workspace("preserve-git");
        let engine = SnapshotEngine::new(&workspace);
        engine.ensure();

        fs::write(workspace.join("code.txt"), "v1\n").unwrap();
        fs::write(workspace.join(".git"), "gitdir: /some/path/.git\n").unwrap();
        fs::create_dir_all(workspace.join(".CodePapr")).unwrap();
        fs::write(workspace.join(".CodePapr/project.sqlite"), "data").unwrap();

        let cp = engine.create("baseline").expect("baseline snapshot");

        fs::write(workspace.join("code.txt"), "v2\n").unwrap();

        use crate::snapshot::RestoreEngine;
        let restore = RestoreEngine::new(&workspace);
        let exec = restore.execute(&cp.sha).expect("restore should succeed");
        assert!(exec.ok);

        assert_eq!(fs::read_to_string(workspace.join("code.txt")).unwrap(), "v1\n");
        assert!(
            workspace.join(".git").exists(),
            ".git file must survive restore"
        );
        assert!(
            workspace.join(".CodePapr/project.sqlite").exists(),
            ".CodePapr data must survive restore"
        );

        fs::remove_dir_all(&workspace).ok();
    }

    #[test]
    fn test_full_agent_workflow_stage_commit_status_diff_restore() {
        use crate::git_operations::stage::git_stage_impl;
        use crate::git_operations::commit::git_commit_impl;
        use crate::git_operations::status::git_status_impl;
        use crate::git_operations::diff::git_diff_impl;
        use crate::git_operations::restore_files::git_restore_files_impl;
        use crate::snapshot::RestoreEngine;

        let workspace = temp_workspace("e2e-agent");
        let engine = SnapshotEngine::new(&workspace);
        let ensure = engine.ensure();
        assert!(ensure.ready, "ensure should succeed");
        assert!(!workspace.join(".git").exists(), "no .git file after ensure");

        fs::write(workspace.join("main.rs"), "fn main() {}\n").unwrap();
        fs::write(workspace.join("lib.rs"), "pub fn add() {}\n").unwrap();
        let _baseline = engine.create("baseline").expect("baseline");

        fs::write(workspace.join("main.rs"), "fn main() { println!(\"v2\"); }\n").unwrap();

        let status = git_status_impl(&workspace);
        assert!(status.available, "status should be available");
        assert!(
            status.entries.iter().any(|e| e.path == "main.rs" && e.worktree_status == "M"),
            "main.rs should show as modified"
        );

        let diff = git_diff_impl(&workspace, false, &[]);
        assert!(diff.available, "diff should be available");
        assert!(diff.diff.contains("main.rs"), "diff should contain main.rs");

        let stage = git_stage_impl(&workspace, false, &["main.rs".to_string()]);
        assert!(stage.ok, "stage should succeed: {}", stage.message);

        let commit = git_commit_impl(&workspace, "update main", false, &["main.rs".to_string()], false);
        assert!(commit.ok, "commit should succeed: {}", commit.message);

        let diff_after = git_diff_impl(&workspace, false, &[]);
        assert!(
            !diff_after.diff.contains("main.rs"),
            "main.rs should not appear in diff after commit"
        );

        let checkpoint = engine.create("checkpoint").expect("checkpoint");

        fs::write(workspace.join("main.rs"), "fn main() { println!(\"v3\"); }\n").unwrap();
        fs::write(workspace.join("new_file.txt"), "should be removed\n").unwrap();

        let restore = RestoreEngine::new(&workspace);
        let exec = restore.execute(&checkpoint.sha).expect("restore should succeed");
        assert!(exec.ok);

        assert_eq!(
            fs::read_to_string(workspace.join("main.rs")).unwrap(),
            "fn main() { println!(\"v2\"); }\n",
            "main.rs should be restored to checkpoint content"
        );
        assert!(
            !workspace.join("new_file.txt").exists(),
            "untracked file should be removed after restore"
        );
        assert!(
            !workspace.join(".git").exists(),
            "no .git file should exist after restore"
        );
        assert!(
            workspace.join(".CodePapr/git/.git").is_dir(),
            "shadow repo should be intact"
        );

        let restore_file = git_restore_files_impl(&workspace, &["main.rs".to_string()], None, None);
        assert!(restore_file.ok, "git_restore_files should succeed: {}", restore_file.message);

        restore.undo().expect("undo should work");

        let snapshots = engine.list(10);
        assert!(snapshots.len() >= 2, "should have at least 2 snapshots");

        fs::remove_dir_all(&workspace).ok();
    }
}
