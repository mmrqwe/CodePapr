use std::path::{Path, PathBuf};
use git2::{Repository, ResetType, Oid, Tree};
use super::types::{RestorePlan, RestoreResult, FileChange};
use super::ignore_resolver::{git_relative_path, IgnoreResolver};
use crate::git_operations::validate_git_ref;

/// 列出工作区中"不在目标树"且未被 gitignore 忽略的文件（相对路径）。
/// plan（预览将被删除的未跟踪文件）与 execute（实际删除）共用同一份
/// 收集逻辑，保证预览与执行的影响范围严格一致。
fn list_files_not_in_tree(workspace: &Path, target_tree: &Tree) -> Vec<PathBuf> {
    let resolver = IgnoreResolver::new(workspace);
    let files = resolver.collect_files();
    files
        .into_iter()
        .filter(|relative| {
            if relative.components().any(|c| {
                matches!(c.as_os_str().to_str(), Some(".git" | ".CodePapr" | ".codepapr_git_backup"))
            }) {
                return false;
            }
            // Windows 上 relative 含 '\'，get_path 只按 '/' 解析：不转换会把
            // 树中实际存在的文件误判为"不在目标树"，hard reset 后将其删除。
            target_tree.get_path(&git_relative_path(relative)).is_err()
        })
        .collect()
}

/// 在 hard reset 之后清理"目标树中不存在但当前工作区存在"的未跟踪文件。
/// 这一步是必须的：libgit2 的 reset --hard 只恢复被跟踪的文件，
/// 不会删除自目标快照之后新增的未跟踪文件，导致恢复不彻底。
fn remove_untracked_not_in_tree(
    _repo: &Repository,
    workspace: &Path,
    target_tree: &Tree,
) -> usize {
    let files = list_files_not_in_tree(workspace, target_tree);
    let mut removed = 0usize;

    for relative in &files {
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
    // 备份提交只作为 undo 安全网，不得污染工作区 index：备份过程把当前
    // 磁盘状态（含未跟踪文件）全部 add 进 index，若放任不管，随后的 force
    // checkout 会把"备份暂存过、但目标树没有"的文件当作应删除条目处理
    // （restore 时误删 include_untracked=false 本应保留的未跟踪文件）。
    // Mixed 重置 index 回 HEAD 只动 index 不动工作区；HEAD 不存在时放弃。
    if let Ok(head) = repo.head() {
        if let Some(head_target) = head.target() {
            if let Ok(object) = repo.find_object(head_target, None) {
                let _ = repo.reset(&object, git2::ResetType::Mixed, None);
            }
        }
    }
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

        // execute 会删除"不在目标树"的未跟踪文件——plan 必须如实预览。
        // 只报告 HEAD 树中也不存在的文件：存在于 HEAD 树的已计入
        // files_to_delete（status D），不重复报告。
        let untracked_to_delete: Vec<String> = list_files_not_in_tree(&self.workspace, &target_tree)
            .into_iter()
            .filter(|relative| match &head_tree {
                Some(ht) => ht.get_path(&git_relative_path(relative)).is_err(),
                None => true,
            })
            .map(|relative| git_relative_path(&relative).to_string_lossy().to_string())
            .collect();

        // 将被覆盖的未提交改动（index/worktree 相对 HEAD 的改动，不含未跟踪
        // 新文件——它们由 untracked_to_delete 单独报告）。这些改动会进入
        // 备份快照（undo 可找回），但确认框必须让用户知情。
        let dirty_overwritten = repo
            .statuses(None)
            .map(|statuses| {
                statuses
                    .iter()
                    .filter(|entry| {
                        let st = entry.status();
                        st.is_index_new()
                            || st.is_index_modified()
                            || st.is_index_deleted()
                            || st.is_index_renamed()
                            || st.is_index_typechange()
                            || st.is_wt_modified()
                            || st.is_wt_deleted()
                            || st.is_wt_renamed()
                            || st.is_wt_typechange()
                            || st.is_conflicted()
                    })
                    .count()
            })
            .unwrap_or(0);

        Ok(RestorePlan {
            target_sha: target_sha.to_string(),
            target_label,
            target_file_count,
            files_to_restore,
            files_to_delete,
            files_unchanged,
            untracked_to_delete,
            dirty_overwritten,
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
        // backup_sha 一并返回：BACKUP_REF 是所有破坏性操作共用的单一引用，
        // 撤销方必须能用它校验备份未被后续操作覆盖（见 undo）。
        let (backup_ref, backup_sha) = match create_backup_snapshot(&repo, &self.workspace) {
            Ok(backup_oid) => {
                eprintln!("[CodePapr] restore_execute: backup ref -> {}", backup_oid);
                match repo.reference(BACKUP_REF, backup_oid, true, "codepapr backup before reset") {
                    Ok(_) => (Some(BACKUP_REF.to_string()), Some(backup_oid.to_string())),
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
        };

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
            backup_sha,
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

    /// expected_backup_sha：发起方（对话重置/面板回退）执行破坏性操作时拿到的
    /// 备份 commit SHA。BACKUP_REF 被所有破坏性操作共用，若重置之后又发生了
    /// 其它破坏性操作，BACKUP_REF 已指向别的状态——此时盲目 undo 会把工作区
    /// 恢复到错误快照。传入期望 SHA 时先校验，不一致即拒绝（fail-closed）。
    pub fn undo(&self, expected_backup_sha: Option<&str>) -> Result<(), String> {
        let git_path = code_papr_git_path(&self.workspace);
        let repo = Repository::open(&git_path)
            .map_err(|e| format!("open repo: {}", e.message()))?;
        repo.set_workdir(&self.workspace, false)
            .map_err(|e| format!("set workdir: {}", e.message()))?;

        let backup_ref = repo.find_reference(BACKUP_REF)
            .map_err(|_| format!("backup ref {} not found", BACKUP_REF))?;
        let target_oid = backup_ref.target()
            .ok_or_else(|| "backup ref has no target".to_string())?;

        if let Some(expected) = expected_backup_sha.map(str::trim).filter(|s| !s.is_empty()) {
            let expected_oid = Oid::from_str(expected)
                .map_err(|_| format!("非法的备份 SHA: {expected}"))?;
            if target_oid != expected_oid {
                return Err(
                    "备份引用在重置之后已被其它操作覆盖，撤销已中止（避免恢复到错误状态）"
                        .to_string(),
                );
            }
        }

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
        restore.undo(None).expect("undo should succeed");
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

        let err = restore.undo(None).expect_err("undo must refuse empty-tree backup");
        assert!(err.contains("empty tree"), "unexpected error: {err}");
        assert!(
            workspace.join("file.txt").exists(),
            "workspace must be untouched after refused undo"
        );

        fs::remove_dir_all(&workspace).ok();
    }

    /// 回归：BACKUP_REF 是所有破坏性操作共用的单一引用。重置之后若又发生
    /// 其它破坏性操作（备份被覆盖），带期望 SHA 的 undo 必须拒绝执行，
    /// 否则会静默恢复到错误状态。
    #[test]
    fn test_undo_refuses_when_backup_ref_was_overwritten() {
        let workspace = temp_workspace("backup-overwritten");
        let engine = SnapshotEngine::new(&workspace);
        engine.ensure();

        fs::write(workspace.join("file.txt"), "v1\n").unwrap();
        let cp1 = engine.create("cp1").expect("cp1");
        fs::write(workspace.join("file.txt"), "v2\n").unwrap();
        let cp2 = engine.create("cp2").expect("cp2");

        let restore = RestoreEngine::new(&workspace);
        let exec = restore.execute(&cp1.sha).expect("restore should succeed");
        let original_backup = exec.backup_sha.expect("execute must report backup sha");

        // 又一次破坏性操作覆盖了 BACKUP_REF
        restore.execute(&cp2.sha).expect("second restore should succeed");

        let err = restore
            .undo(Some(&original_backup))
            .expect_err("undo must refuse when backup ref was overwritten");
        assert!(err.contains("覆盖"), "unexpected error: {err}");
        assert_eq!(
            fs::read_to_string(workspace.join("file.txt")).unwrap(),
            "v2\n",
            "workspace must be untouched after refused undo"
        );

        // 不传期望 SHA 时保持旧语义（agent 工具依赖此行为）
        restore.undo(None).expect("unchecked undo should still work");

        fs::remove_dir_all(&workspace).ok();
    }

    /// 回归：execute 返回的 backup_sha 必须与 BACKUP_REF 实际指向一致，
    /// 传入该 SHA 的 undo 必须成功。
    #[test]
    fn test_undo_with_matching_expected_sha_succeeds() {
        let workspace = temp_workspace("backup-matching");
        let engine = SnapshotEngine::new(&workspace);
        engine.ensure();

        fs::write(workspace.join("file.txt"), "v1\n").unwrap();
        let cp = engine.create("cp").expect("cp");
        fs::write(workspace.join("file.txt"), "v2\n").unwrap();

        let restore = RestoreEngine::new(&workspace);
        let exec = restore.execute(&cp.sha).expect("restore should succeed");
        let backup = exec.backup_sha.expect("execute must report backup sha");

        restore
            .undo(Some(&backup))
            .expect("undo with matching sha should succeed");
        assert_eq!(
            fs::read_to_string(workspace.join("file.txt")).unwrap(),
            "v2\n",
            "undo must restore the pre-reset worktree state"
        );

        fs::remove_dir_all(&workspace).ok();
    }
}
