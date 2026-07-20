use std::path::{Path, PathBuf};
use git2::{IndexAddOption, Repository, RepositoryInitOptions, Signature};
use crate::workspace_fs::should_ignore_dir;
use super::types::{EnsureResult, SnapshotInfo};
use super::ignore_resolver::IgnoreResolver;

const CODEPAPR_GIT_SUBDIR: &str = ".CodePapr/git";
const EXCLUDE_RULES: &[&str] = &[
    ".CodePapr/",
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
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&exclude_path)?;

    if !existing.is_empty() && !existing.ends_with('\n') {
        file.write_all(b"\n")?;
    }
    for rule in EXCLUDE_RULES {
        let line = format!("{}\n", rule);
        if !existing.contains(rule) {
            file.write_all(line.as_bytes())?;
        }
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

        if dot_git.is_dir() {
            match Repository::open(&git_path) {
                Ok(repo) => {
                    let _ = repo.set_workdir(&self.workspace, true);
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

        let _ = repo.set_workdir(&self.workspace, true);
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
        for file in &files {
            match index.add_path(file) {
                Ok(()) => added += 1,
                Err(e) => {
                    eprintln!("[CodePapr] snapshot_create: add_path failed for {:?}: {}", file, e.message());
                }
            }
        }

        eprintln!("[CodePapr] snapshot_create: {} files added to index", added);

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
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        eprintln!("[CodePapr] snapshot_create: commit {}, {} files", head_sha, added);

        Ok(SnapshotInfo {
            sha: head_sha,
            short_hash,
            label: label.to_string(),
            timestamp,
            file_count: added,
            is_head: true,
        })
    }

    pub fn list(&self, limit: usize) -> Vec<SnapshotInfo> {
        let git_path = code_papr_git_path(&self.workspace);
        let repo = match Repository::open(&git_path) {
            Ok(r) => r,
            Err(_) => return vec![],
        };
        let _ = repo.set_workdir(&self.workspace, true);

        let head_oid = repo.head().ok().and_then(|h| h.target());
        let mut revwalk = match repo.revwalk() {
            Ok(rw) => rw,
            Err(_) => return vec![],
        };
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

            result.push(SnapshotInfo { sha, short_hash, label, timestamp, file_count, is_head });
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
