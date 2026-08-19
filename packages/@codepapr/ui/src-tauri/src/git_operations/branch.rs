use git2::BranchType;
use crate::snapshot::types::{GitBranch, GitOperationResult};
use super::{open_repo, validate_git_ref};

/// 校验分支名，与 TS 侧 `assertValidGitBranchName` 对齐，作为纵深防御。
/// 拒绝：空、`@`、以 `-`/`/` 开头、以 `/`/`.`/`.lock` 结尾、含 `..`/`//`/`@{`/`[`/
/// 空白/`~^:?*\\`/控制字符。
fn validate_branch_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("branchName 必须是非空字符串".to_string());
    }
    if trimmed == "@"
        || trimmed.starts_with('-')
        || trimmed.starts_with('/')
        || trimmed.ends_with('/')
        || trimmed.ends_with('.')
        || trimmed.ends_with(".lock")
        || trimmed.contains("..")
        || trimmed.contains("//")
        || trimmed.contains("@{")
        || trimmed.contains('[')
        || trimmed.chars().any(|c| {
            c.is_whitespace() || "~^:?*\\".contains(c) || (c as u32) < 0x20 || c as u32 == 0x7f
        })
    {
        return Err(format!("非法分支名: {}", name));
    }
    Ok(())
}

pub fn git_branch_list_impl(workspace: &std::path::Path) -> Vec<GitBranch> {
    let repo = match open_repo(workspace) {
        Ok(r) => r,
        Err(_) => return vec![],
    };

    let _head_oid = repo.head().ok().and_then(|h| h.target());

    let mut result = Vec::new();
    if let Ok(branches) = repo.branches(Some(BranchType::Local)) {
        for branch_entry in branches {
            let (branch, _bt) = match branch_entry { Ok(b) => b, Err(_) => continue };
            let name = branch.name().ok().flatten().unwrap_or("").to_string();
            let is_current = branch.is_head();
            let target_sha = branch.get().target()
                .map(|oid| oid.to_string())
                .unwrap_or_default();
            result.push(GitBranch {
                name, is_current, is_remote: false, target_sha,
            });
        }
    }

    result
}

pub fn git_branch_checkout_impl(
    workspace: &std::path::Path,
    branch_name: &str,
    create: bool,
    create_if_missing: bool,
    start_point: Option<&str>,
) -> GitOperationResult {
    if let Err(e) = validate_branch_name(branch_name) {
        return GitOperationResult {
            ok: false, action: "branch_checkout".to_string(), message: e, backup_ref: None,
        };
    }

    let repo = match open_repo(workspace) {
        Ok(r) => r,
        Err(e) => return GitOperationResult {
            ok: false, action: "branch_checkout".to_string(), message: e, backup_ref: None,
        },
    };

    // 解析起始点引用：优先用 start_point，否则回退到 HEAD
    let resolve_start_oid = || -> Result<git2::Oid, String> {
        if let Some(sp) = start_point {
            validate_git_ref(sp, "startPoint")?;
            let obj = repo.revparse_single(sp)
                .map_err(|e| format!("resolve startPoint {}: {}", sp, e.message()))?;
            let commit = obj.into_commit()
                .map_err(|_| format!("startPoint {} 不是一个有效的提交对象", sp))?;
            Ok(commit.id())
        } else {
            repo.head().ok()
                .and_then(|h| h.target())
                .ok_or_else(|| "no HEAD".to_string())
        }
    };

    let branch = repo.find_branch(branch_name, BranchType::Local);
    let _target_oid = if create || (create_if_missing && branch.is_err()) {
        let start_oid = match resolve_start_oid() {
            Ok(o) => o,
            Err(e) => return GitOperationResult {
                ok: false, action: "branch_checkout".to_string(), message: e, backup_ref: None,
            },
        };
        let commit = match repo.find_commit(start_oid) {
            Ok(c) => c, Err(e) => return GitOperationResult {
                ok: false, action: "branch_checkout".to_string(),
                message: format!("find commit: {}", e.message()), backup_ref: None,
            },
        };
        match repo.branch(branch_name, &commit, false) {
            Ok(b) => b.get().target().unwrap_or(start_oid),
            Err(e) => return GitOperationResult {
                ok: false, action: "branch_checkout".to_string(),
                message: format!("create branch: {}", e.message()), backup_ref: None,
            },
        }
    } else {
        match &branch {
            Ok(b) => match b.get().target() {
                Some(oid) => oid,
                None => return GitOperationResult {
                    ok: false, action: "branch_checkout".to_string(),
                    message: "branch has no target".to_string(), backup_ref: None,
                },
            },
            Err(e) => return GitOperationResult {
                ok: false, action: "branch_checkout".to_string(),
                message: format!("branch not found: {}", e.message()), backup_ref: None,
            },
        }
    };

    // shadow repo 的 workdir 就是用户工作区：force checkout 会直接覆盖工作区文件。
    // 备份必须在 set_head 之前完成：set_head 会移动 HEAD，若备份失败中止切换，
    // HEAD 必须尚未移动——否则 HEAD 指向新分支而工作区未变，status 会显示
    // 全部文件为改动，后续 checkpoint 还会提交到错误的分支上。
    // 备份失败且工作区确有可快照文件时中止切换（fail-closed，防无安全网覆盖）。
    let backup_ref = match crate::snapshot::RestoreEngine::new(workspace).backup_current_state() {
        Ok(oid) => Some(oid),
        Err(e) => {
            if crate::snapshot::SnapshotEngine::new(workspace).has_snapshotable_files() {
                return GitOperationResult {
                    ok: false, action: "branch_checkout".to_string(),
                    message: format!("切换前备份工作区失败，已中止以防数据丢失: {e}"),
                    backup_ref: None,
                };
            }
            None
        }
    };

    // force checkout 会静默覆盖工作区未提交改动：在 set_head 之前按"旧 HEAD"
    // 统计将被覆盖的改动文件数，在结果消息中显式告知用户（改动已备份到
    // BACKUP_REF，可 restore_undo 找回）。set_head 之后统计会相对新分支的树
    // 计算，语义错误。
    let dirty_count = repo
        .statuses(None)
        .map(|statuses| {
            statuses
                .iter()
                .filter(|entry| {
                    let st = entry.status();
                    st.is_wt_new()
                        || st.is_wt_modified()
                        || st.is_wt_deleted()
                        || st.is_wt_renamed()
                        || st.is_wt_typechange()
                        || st.is_conflicted()
                })
                .count()
        })
        .unwrap_or(0);

    let ref_name = format!("refs/heads/{}", branch_name);
    if let Err(e) = repo.set_head(&ref_name) {
        return GitOperationResult {
            ok: false, action: "branch_checkout".to_string(),
            message: format!("set_head: {}", e.message()), backup_ref,
        };
    }

    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout.force();
    if let Err(e) = repo.checkout_head(Some(&mut checkout)) {
        // HEAD 已移动：把备份引用返回给调用方，便于通过 restore_undo 恢复。
        return GitOperationResult {
            ok: false, action: "branch_checkout".to_string(),
            message: format!("checkout: {}", e.message()), backup_ref,
        };
    }

    GitOperationResult {
        ok: true, action: "branch_checkout".to_string(),
        message: if dirty_count > 0 {
            format!(
                "已切换到分支 {}（覆盖 {} 个未提交改动文件，已备份，可撤销恢复）",
                branch_name, dirty_count
            )
        } else {
            format!("已切换到分支 {}", branch_name)
        },
        backup_ref,
    }
}

#[tauri::command]
pub async fn git_branch_list(workspace_path: String) -> Vec<GitBranch> {
    // git2 分支遍历是重阻塞操作，放阻塞线程池，别卡 tokio 共享 runtime。
    crate::shared::run_blocking_workspace_task(move || -> Result<Vec<GitBranch>, String> {
        let workspace = std::path::PathBuf::from(workspace_path);
        Ok(crate::shared::with_workspace_git_read_lock(&workspace, || {
            git_branch_list_impl(&workspace)
        }))
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub async fn git_branch_checkout(
    workspace_path: String,
    branch_name: String,
    create: Option<bool>,
    create_if_missing: Option<bool>,
    start_point: Option<String>,
) -> GitOperationResult {
    // git2 切换分支是重阻塞操作，放阻塞线程池，别卡 tokio 共享 runtime。
    // 写锁：备份→set_head→force checkout 是多步流程，必须独占。
    crate::shared::run_blocking_workspace_task(move || -> Result<GitOperationResult, String> {
        let workspace = std::path::PathBuf::from(workspace_path);
        Ok(crate::shared::with_workspace_git_write_lock(&workspace, || {
            git_branch_checkout_impl(
                &workspace, &branch_name,
                create.unwrap_or(false),
                create_if_missing.unwrap_or(true),
                start_point.as_deref(),
            )
        }))
    })
    .await
    .unwrap_or_else(|err| GitOperationResult {
        ok: false,
        action: "branch-checkout".to_string(),
        message: err,
        backup_ref: None,
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
            "codepapr-branch-{label}-{}",
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
    fn test_validate_branch_name_accepts_valid() {
        assert!(validate_branch_name("main").is_ok());
        assert!(validate_branch_name("feature/foo").is_ok());
        assert!(validate_branch_name("release-1.0").is_ok());
        assert!(validate_branch_name("bugfix/fix-123").is_ok());
    }

    #[test]
    fn test_validate_branch_name_rejects_invalid() {
        // 回归 #8：Tauri 命令缺少分支名校验，恶意/异常 agent 可传特殊字符。
        assert!(validate_branch_name("").is_err());
        assert!(validate_branch_name("   ").is_err());
        assert!(validate_branch_name("@").is_err());
        assert!(validate_branch_name("-foo").is_err());
        assert!(validate_branch_name("/foo").is_err());
        assert!(validate_branch_name("foo/").is_err());
        assert!(validate_branch_name("foo.").is_err());
        assert!(validate_branch_name("foo.lock").is_err());
        assert!(validate_branch_name("foo..bar").is_err());
        assert!(validate_branch_name("foo//bar").is_err());
        assert!(validate_branch_name("foo@{bar").is_err());
        assert!(validate_branch_name("foo[bar").is_err());
        assert!(validate_branch_name("foo bar").is_err());
        assert!(validate_branch_name("foo*bar").is_err());
        assert!(validate_branch_name("foo?bar").is_err());
        assert!(validate_branch_name("foo\\bar").is_err());
    }

    /// 回归 #8：调用 git_branch_checkout_impl 时，非法分支名应被拒绝在 Tauri 命令层，
    /// 不应到达 libgit2。
    #[test]
    fn test_branch_checkout_rejects_invalid_name_at_impl_layer() {
        let workspace = temp_workspace("reject");
        let engine = SnapshotEngine::new(&workspace);
        engine.ensure();

        let result = git_branch_checkout_impl(&workspace, "bad name", false, true, None);
        assert!(!result.ok, "非法分支名必须被拒绝");
        assert!(result.message.contains("非法分支名"), "错误消息应说明非法分支名");

        let result = git_branch_checkout_impl(&workspace, "-leading-dash", false, true, None);
        assert!(!result.ok, "以 - 开头的分支名必须被拒绝");

        fs::remove_dir_all(&workspace).ok();
    }

    #[test]
    fn test_branch_checkout_create_and_switch() {
        let workspace = temp_workspace("create");
        let engine = SnapshotEngine::new(&workspace);
        engine.ensure();
        fs::write(workspace.join("a.txt"), "a\n").unwrap();
        engine.create("baseline").expect("baseline");

        let result = git_branch_checkout_impl(
            &workspace,
            "feature/test",
            false,  // 不强制 create
            true,   // create_if_missing=true
            None,   // start_point=None
        );
        assert!(result.ok, "创建并切换分支应成功: {}", result.message);

        let branches = git_branch_list_impl(&workspace);
        assert!(
            branches.iter().any(|b| b.name == "feature/test"),
            "新分支应在列表中: {:?}", branches.iter().map(|b| &b.name).collect::<Vec<_>>()
        );

        fs::remove_dir_all(&workspace).ok();
    }

    /// 回归：备份失败中止切换时，HEAD 必须尚未移动。旧实现先 set_head 再备份，
    /// 备份失败中止后 HEAD 已指向新分支而工作区未变——status 显示全部文件为
    /// 改动，后续 checkpoint 还会提交到错误的分支上。
    #[test]
    fn test_branch_checkout_abort_leaves_head_untouched_when_backup_fails() {
        let workspace = temp_workspace("backup-fail");
        let engine = SnapshotEngine::new(&workspace);
        engine.ensure();
        fs::write(workspace.join("a.txt"), "a\n").unwrap();
        engine.create("baseline").expect("baseline");

        let repo = git2::Repository::open(workspace.join(".CodePapr/git")).unwrap();
        let original_branch = repo
            .head()
            .unwrap()
            .shorthand()
            .unwrap_or("")
            .to_string();
        drop(repo);

        // 新鲜的 index.lock（未超陈旧阈值，不会被 open_repo 清理）会让
        // 备份快照的 index.write() 失败，从而触发 fail-closed 中止。
        let lock_path = workspace.join(".CodePapr/git/.git/index.lock");
        fs::write(&lock_path, "locked").unwrap();

        let result = git_branch_checkout_impl(&workspace, "feature/x", false, true, None);
        assert!(!result.ok, "备份失败时必须中止切换: {}", result.message);
        assert!(
            result.message.contains("备份工作区失败"),
            "错误消息应说明备份失败: {}",
            result.message
        );

        let repo = git2::Repository::open(workspace.join(".CodePapr/git")).unwrap();
        assert_eq!(
            repo.head().unwrap().shorthand().unwrap_or(""),
            original_branch,
            "中止切换后 HEAD 必须仍在原分支"
        );
        drop(repo);
        assert_eq!(fs::read_to_string(workspace.join("a.txt")).unwrap(), "a\n");

        fs::remove_file(&lock_path).ok();
        fs::remove_dir_all(&workspace).ok();
    }

    /// 回归 #12：带未提交改动切换分支时，force checkout 会覆盖工作区文件——
    /// 结果消息必须显式告知覆盖了多少改动文件（不得无声丢弃），且必须有
    /// 备份引用（restore_undo 可找回）。
    #[test]
    fn test_branch_checkout_with_dirty_worktree_reports_overwritten_files() {
        let workspace = temp_workspace("dirty");
        let engine = SnapshotEngine::new(&workspace);
        engine.ensure();
        fs::write(workspace.join("a.txt"), "a\n").unwrap();
        engine.create("baseline").expect("baseline");

        // 制造未提交改动（a.txt 修改 + 新文件 b.txt）
        fs::write(workspace.join("a.txt"), "a-modified\n").unwrap();
        fs::write(workspace.join("b.txt"), "b\n").unwrap();

        let result = git_branch_checkout_impl(
            &workspace,
            "feature/dirty",
            false,
            true,
            None,
        );
        assert!(result.ok, "切换应成功: {}", result.message);
        assert!(
            result.message.contains("覆盖"),
            "消息必须说明覆盖了未提交改动: {}", result.message
        );
        assert!(
            result.backup_ref.is_some(),
            "覆盖未提交改动前必须创建备份引用（可撤销恢复）"
        );

        fs::remove_dir_all(&workspace).ok();
    }
}
