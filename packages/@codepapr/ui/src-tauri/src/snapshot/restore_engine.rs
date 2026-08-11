use std::path::{Path, PathBuf};
use git2::{Repository, ResetType, Oid, Tree};
use super::types::{RestorePlan, RestoreResult, FileChange};
use super::snapshot_engine::SnapshotEngine;
use super::ignore_resolver::{git_relative_path, IgnoreResolver};
use crate::git_operations::validate_git_ref;

/// 在 hard reset 之后清理"目标树中不存在但当前工作区存在"的未跟踪文件。
/// 这一步是必须的：libgit2 的 reset --hard 只恢复被跟踪的文件，
/// 不会删除自目标快照之后新增的未跟踪文件，导致恢复不彻底。
fn remove_untracked_not_in_tree(
    repo: &Repository,
    workspace: &Path,
    target_tree: &Tree,
) -> usize {
    let resolver = IgnoreResolver::new(workspace);
    let files = resolver.collect_files();
    let mut removed = 0usize;

    for relative in &files {
        if relative.components().any(|c| {
            matches!(c.as_os_str().to_str(), Some(".git" | ".CodePapr" | ".codepapr_git_backup"))
        }) {
            continue;
        }
        // Windows 上 relative 含 '\'，get_path 只按 '/' 解析：不转换会把
        // 树中实际存在的文件误判为"不在目标树"，hard reset 后将其删除。
        if target_tree.get_path(&git_relative_path(relative)).is_ok() {
            continue;
        }
        let abs = workspace.join(relative);
        if abs.is_file() || abs.is_symlink() {
            if std::fs::remove_file(&abs).is_ok() {
                removed += 1;
            }
        }
    }

    if removed > 0 {
        // 尝试清理空目录（自底向上），失败静默忽略
        let mut dirs: Vec<PathBuf> = files.iter()
            .filter_map(|f| f.parent().map(|p| p.to_path_buf()))
            .collect();
        dirs.sort_by(|a, b| b.components().count().cmp(&a.components().count()));
        dirs.dedup();
        for dir in dirs {
            let abs_dir = workspace.join(&dir);
            if abs_dir.is_dir() {
                // 如果目录为空则删除
                if let Ok(mut entries) = std::fs::read_dir(&abs_dir) {
                    if entries.next().is_none() {
                        let _ = std::fs::remove_dir(&abs_dir);
                    }
                }
            }
        }
    }

    removed
}

const BACKUP_REF: &str = "refs/codepapr-backup-before-reset";
const BACKUP_COMMIT_MESSAGE: &str = "codepapr:backup-before-reset";

/// 把任意 git 引用解析为提交（短 SHA / 完整 SHA / 分支名 / HEAD 等）。
/// 旧实现只认完整 40 位十六进制（Oid::from_str），工具定义却宣称接受
/// 「回退目标引用」——LLM 拿 shortHash/分支名必然失败（#23）。
fn resolve_target_commit<'repo>(repo: &'repo Repository, target_sha: &str) -> Result<git2::Commit<'repo>, String> {
    let object = repo
        .revparse_single(target_sha)
        .map_err(|e| format!("无法解析引用 '{target_sha}': {}", e.message()))?;
    let commit = object
        .peel_to_commit()
        .map_err(|e| format!("'{target_sha}' 不是提交对象: {}", e.message()))?;
    Ok(commit)
}

fn code_papr_git_path(workspace: &Path) -> PathBuf {
    workspace.join(".CodePapr/git")
}

/// 为"当前工作区实际状态"创建备份快照提交，返回其 Oid。
///
/// 与 `SnapshotEngine::create` 的关键区别：不移动 HEAD（commit 传 None），
/// 该提交只作为 restore/undo 的安全网存在，不进入快照时间线。
///
/// 旧实现的备份只是 `BACKUP_REF -> 当前 shadow HEAD`（最后一次快照），
/// 最后一次快照之后的工作区改动会被 reset 摧毁且 undo 无法恢复；
/// 现在备份内容 = 执行破坏性操作前的真实磁盘状态。
///
/// 工作区无可快照文件（空/全被忽略）时降级为备份当前 HEAD；
/// HEAD 也不存在则返回错误（调用方应拒绝无安全网的破坏性操作）。
fn create_backup_snapshot(repo: &Repository, workspace: &Path) -> Result<Oid, String> {
    let head_commit = repo
        .head()
        .ok()
        .and_then(|h| h.target())
        .and_then(|oid| repo.find_commit(oid).ok());

    let files = IgnoreResolver::new(workspace).collect_files();
    if files.is_empty() {
        return head_commit
            .map(|c| c.id())
            .ok_or_else(|| "没有可备份的内容（工作区为空且无 HEAD）".to_string());
    }

    let mut index = repo
        .index()
        .map_err(|e| format!("index: {}", e.message()))?;
    index.clear().map_err(|e| format!("clear index: {}", e.message()))?;

    let mut added = 0usize;
    let mut skipped = 0usize;
    for file in &files {
        // collect_files 返回 OS 原生分隔符（Windows 为 '\'），libgit2 只认 '/'
        match index.add_path(&git_relative_path(file)) {
            Ok(()) => added += 1,
            Err(e) => {
                skipped += 1;
                eprintln!(
                    "[CodePapr] backup_snapshot: add_path failed for {:?}: {}",
                    file,
                    e.message()
                );
            }
        }
    }
    if skipped > 0 {
        // #23：备份不完整（add_path 失败的未跟踪文件会被 reset 删除且无法
        // undo 恢复）绝不能继续——宁可拒绝整个 reset。
        return Err(format!(
            "备份快照不完整：{skipped} 个文件未能加入备份，已拒绝执行 reset（避免无法恢复的数据丢失）"
        ));
    }
    if added == 0 {
        return head_commit
            .map(|c| c.id())
            .ok_or_else(|| "备份快照未能添加任何文件".to_string());
    }

    index.write().map_err(|e| format!("write index: {}", e.message()))?;
    let tree_oid = index
        .write_tree()
        .map_err(|e| format!("write_tree: {}", e.message()))?;
    let tree = repo
        .find_tree(tree_oid)
        .map_err(|e| format!("find_tree: {}", e.message()))?;
    let signature = crate::git_operations::ensure_signature(repo)?;
    let parents: Vec<&git2::Commit> = head_commit.iter().collect();
    let oid = repo
        .commit(
            None,
            &signature,
            &signature,
            BACKUP_COMMIT_MESSAGE,
            &tree,
            &parents,
        )
        .map_err(|e| format!("backup commit: {}", e.message()))?;
    Ok(oid)
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
        validate_git_ref(target_sha, "targetSha")?;

        let git_path = code_papr_git_path(&self.workspace);
        let repo = Repository::open(&git_path)
            .map_err(|e| format!("open repo: {}", e.message()))?;
        repo.set_workdir(&self.workspace, false)
            .map_err(|e| format!("set workdir: {}", e.message()))?;

        // 旧实现用 Oid::from_str 只认完整 40 位 SHA——工具定义说接受引用
        // （分支名/短哈希），LLM 拿 shortHash 必失败。revparse 同时支持
        // 短 SHA、分支名、HEAD 等任意引用。
        let oid = resolve_target_commit(&repo, target_sha)?.id();
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
                    let (_context, additions, deletions) = patch.line_stats().unwrap_or((0, 0, 0));
                    (additions, deletions)
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
        validate_git_ref(target_sha, "targetSha")?;

        let git_path = code_papr_git_path(&self.workspace);
        let repo = Repository::open(&git_path)
            .map_err(|e| format!("open repo: {}", e.message()))?;
        repo.set_workdir(&self.workspace, false)
            .map_err(|e| format!("set workdir: {}", e.message()))?;

        let oid = resolve_target_commit(&repo, target_sha)?.id();
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

        let (files_changed, files_deleted) = match &head_tree {
            Some(prev) => {
                let diff = repo.diff_tree_to_tree(Some(prev), Some(&target_tree), None);
                match diff {
                    Ok(d) => {
                        let total = d.deltas().count();
                        let deleted = d.deltas()
                            .filter(|delta| delta.status() == git2::Delta::Deleted)
                            .count();
                        (total, deleted)
                    }
                    Err(_) => (0, 0),
                }
            }
            None => (target_tree.len(), 0),
        };

        // 备份 = reset 前工作区的真实状态（而非最后一次快照），
        // 确保最后一次快照之后新增/修改的文件也能通过 undo 找回。
        let mut backup_ref = None;
        match create_backup_snapshot(&repo, &self.workspace) {
            Ok(backup_oid) => {
                eprintln!("[CodePapr] restore_execute: backup ref -> {}", backup_oid);
                match repo.reference(BACKUP_REF, backup_oid, true, "codepapr backup before reset") {
                    Ok(_) => backup_ref = Some(BACKUP_REF.to_string()),
                    Err(e) => return Err(format!(
                        "failed to create backup ref: {} (refusing reset without safety net)", e.message()
                    )),
                }
            }
            Err(e) => {
                return Err(format!(
                    "failed to create backup snapshot: {e} (refusing reset without safety net)"
                ))
            }
        }

        let mut checkout = git2::build::CheckoutBuilder::new();
        checkout.force();
        repo.reset(target_commit.as_object(), ResetType::Hard, Some(&mut checkout))
            .map_err(|e| format!("reset: {}", e.message()))?;

        // 清理目标树中不存在的未跟踪文件，确保恢复后工作区与目标快照完全一致
        let untracked_removed = remove_untracked_not_in_tree(&repo, &self.workspace, &target_tree);
        let files_changed = files_changed + untracked_removed;
        let files_deleted = files_deleted + untracked_removed;

        eprintln!("[CodePapr] restore_execute: reset to {}, {} files changed ({} untracked removed)", target_sha, files_changed, untracked_removed);

        Ok(RestoreResult {
            ok: true,
            files_restored: files_changed,
            files_deleted,
            backup_ref,
            error: None,
        })
    }

    /// 在其它破坏性操作（如 shadow repo 的 force checkout——其 workdir 就是
    /// 用户工作区）之前创建当前工作区状态的备份并更新 BACKUP_REF，
    /// 使数据始终可以通过 restore_undo 找回。
    pub fn backup_current_state(&self) -> Result<String, String> {
        let git_path = code_papr_git_path(&self.workspace);
        let repo = Repository::open(&git_path)
            .map_err(|e| format!("open repo: {}", e.message()))?;
        repo.set_workdir(&self.workspace, false)
            .map_err(|e| format!("set workdir: {}", e.message()))?;
        let oid = create_backup_snapshot(&repo, &self.workspace)?;
        repo.reference(BACKUP_REF, oid, true, "codepapr backup before destructive op")
            .map_err(|e| format!("failed to update backup ref: {}", e.message()))?;
        Ok(oid.to_string())
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
        let target_tree = target_commit.tree()
            .map_err(|e| format!("backup tree: {}", e.message()))?;

        // 与 execute 对齐的空 tree 防护：备份目标若是空 baseline 提交，
        // reset + 未跟踪清理会删除工作区所有文件。
        if target_tree.is_empty() {
            return Err(
                "backup checkpoint has an empty tree; refusing undo to prevent data loss"
                    .to_string(),
            );
        }

        // undo 前先备份当前工作区状态：restore 之后用户新写的文件不丢失，
        // 且 undo 本身可再次 undo（在两个状态间可逆切换）。
        let current_oid = create_backup_snapshot(&repo, &self.workspace)
            .map_err(|e| format!("failed to backup current state before undo: {e}"))?;
        repo.reference(BACKUP_REF, current_oid, true, "codepapr backup before undo")
            .map_err(|e| format!("failed to update backup ref: {}", e.message()))?;

        let mut checkout = git2::build::CheckoutBuilder::new();
        checkout.force();
        repo.reset(target_commit.as_object(), ResetType::Hard, Some(&mut checkout))
            .map_err(|e| format!("undo reset: {}", e.message()))?;

        let removed = remove_untracked_not_in_tree(&repo, &self.workspace, &target_tree);

        eprintln!("[CodePapr] restore_undo: restored to {} ({} untracked removed)", target_oid, removed);

        Ok(())
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
            "codepapr-restore-{label}-{}",
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
    fn test_undo_recovers_changes_made_after_last_snapshot() {
        let workspace = temp_workspace("post-snapshot-changes");
        let engine = SnapshotEngine::new(&workspace);
        engine.ensure();

        fs::write(workspace.join("tracked.txt"), "v1\n").unwrap();
        let cp = engine.create("baseline").expect("baseline snapshot");

        // 最后一次快照之后：修改已跟踪文件 + 新增文件（都未快照）
        fs::write(workspace.join("tracked.txt"), "v2-unsnapshotted\n").unwrap();
        fs::write(workspace.join("brand-new.txt"), "new-unsnapshotted\n").unwrap();

        let restore = RestoreEngine::new(&workspace);
        let exec = restore.execute(&cp.sha).expect("restore should succeed");
        assert!(exec.ok);
        assert_eq!(fs::read_to_string(workspace.join("tracked.txt")).unwrap(), "v1\n");
        assert!(!workspace.join("brand-new.txt").exists());

        // undo 必须找回"最后一次快照之后"的改动（旧实现备份仅指向 HEAD 快照，会永久丢失）
        restore.undo().expect("undo should succeed");
        assert_eq!(
            fs::read_to_string(workspace.join("tracked.txt")).unwrap(),
            "v2-unsnapshotted\n",
            "post-snapshot modification must survive undo"
        );
        assert!(
            workspace.join("brand-new.txt").exists(),
            "post-snapshot new file must survive undo"
        );

        fs::remove_dir_all(&workspace).ok();
    }

    #[test]
    fn test_undo_refuses_empty_tree_backup() {
        let workspace = temp_workspace("empty-tree-undo");
        let engine = SnapshotEngine::new(&workspace);
        engine.ensure(); // 创建空 tree 的 baseline 提交

        fs::write(workspace.join("file.txt"), "content\n").unwrap();
        let cp = engine.create("with-file").expect("snapshot with file");

        let restore = RestoreEngine::new(&workspace);
        // 人为把 BACKUP_REF 指向空 baseline（模拟 force checkout 到空分支后的旧备份语义）
        let repo = Repository::open(code_papr_git_path(&workspace)).unwrap();
        let mut revwalk = repo.revwalk().unwrap();
        revwalk.push_head().unwrap();
        let baseline = revwalk
            .map(|o| o.unwrap())
            .last()
            .expect("should have baseline commit");
        repo.reference(BACKUP_REF, baseline, true, "test").unwrap();

        // 先正常 restore 一次（会重建备份），再强制把备份指回空 baseline 验证 undo 拒绝
        restore.execute(&cp.sha).expect("restore should succeed");
        repo.reference(BACKUP_REF, baseline, true, "test").unwrap();
        drop(repo);

        let err = restore.undo().expect_err("undo must refuse empty-tree backup");
        assert!(err.contains("empty tree"), "unexpected error: {err}");
        assert!(
            workspace.join("file.txt").exists(),
            "workspace must be untouched after refused undo"
        );

        fs::remove_dir_all(&workspace).ok();
    }
}
