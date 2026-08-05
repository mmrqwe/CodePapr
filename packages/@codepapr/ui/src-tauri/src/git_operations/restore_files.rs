use crate::snapshot::types::GitOperationResult;
use super::{open_repo, validate_git_ref};

pub fn git_restore_files_impl(
    workspace: &std::path::Path,
    pathspecs: &[String],
    source: Option<&str>,
) -> GitOperationResult {
    let repo = match open_repo(workspace) {
        Ok(r) => r,
        Err(e) => return GitOperationResult {
            ok: false, action: "restore".to_string(), message: e, backup_ref: None,
        },
    };

    let source_ref = source.unwrap_or("HEAD");
    if let Err(e) = validate_git_ref(source_ref, "source") {
        return GitOperationResult {
            ok: false, action: "restore".to_string(), message: e, backup_ref: None,
        };
    }
    // 优先用 revparse_single 解析 ref，支持 "HEAD"、分支名、tag、SHA 等所有 git 引用语法。
    // 旧实现只尝试 Oid::from_str + refs/heads/{name}，导致默认 "HEAD" 会去找
    // refs/heads/HEAD（不存在），使整个 restore 功能在默认参数下一直报错。
    let target_oid = match repo.revparse_single(source_ref) {
        Ok(obj) => match obj.as_commit() {
            Some(commit) => commit.id(),
            None => match obj.id() {
                oid if oid.is_zero() => {
                    return GitOperationResult {
                        ok: false, action: "restore".to_string(),
                        message: format!("source {} 解析为空对象", source_ref), backup_ref: None,
                    };
                }
                oid => oid,
            },
        },
        Err(e) => return GitOperationResult {
            ok: false, action: "restore".to_string(),
            message: format!("resolve source {}: {}", source_ref, e.message()), backup_ref: None,
        },
    };

    let target_commit = match repo.find_commit(target_oid) {
        Ok(c) => c,
        Err(e) => return GitOperationResult {
            ok: false, action: "restore".to_string(),
            message: format!("find commit: {}", e.message()), backup_ref: None,
        },
    };

    // 验证 commit 有有效树（防止恢复到损坏的提交）。
    let _target_tree = match target_commit.tree() {
        Ok(t) => t,
        Err(e) => return GitOperationResult {
            ok: false, action: "restore".to_string(),
            message: format!("tree: {}", e.message()), backup_ref: None,
        },
    };

    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout.force();
    if !pathspecs.is_empty() {
        // 仅恢复指定路径，避免误伤工作区其它未提交改动。
        // git2 0.21 的 CheckoutBuilder::path() 每次添加一个 pathspec（无 paths() 批量方法）。
        for spec in pathspecs.iter().filter(|s| !s.trim().is_empty()) {
            checkout.path(spec);
        }
    }

    let target_object = target_commit.as_object();
    if let Err(e) = repo.checkout_tree(target_object, Some(&mut checkout)) {
        return GitOperationResult {
            ok: false, action: "restore".to_string(),
            message: format!("checkout: {}", e.message()), backup_ref: None,
        };
    }

    GitOperationResult {
        ok: true, action: "restore".to_string(),
        message: if pathspecs.is_empty() {
            format!("已从 {} 恢复工作区文件", source_ref)
        } else {
            format!("已从 {} 恢复 {} 个路径", source_ref, pathspecs.len())
        },
        backup_ref: None,
    }
}

#[tauri::command]
pub async fn git_restore_files(
    workspace_path: String,
    pathspecs: Option<Vec<String>>,
    source: Option<String>,
) -> GitOperationResult {
    // git2 恢复是重阻塞操作，放阻塞线程池，别卡 tokio 共享 runtime。
    crate::shared::run_blocking_workspace_task(move || -> Result<GitOperationResult, String> {
        let workspace = std::path::PathBuf::from(workspace_path);
        Ok(git_restore_files_impl(&workspace, &pathspecs.unwrap_or_default(), source.as_deref()))
    })
    .await
    .unwrap_or_else(|err| GitOperationResult {
        ok: false,
        action: "restore".to_string(),
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

    /// 回归 #2：带 pathspecs 的 restore 必须只恢复指定文件，不得覆盖其它文件改动。
    /// 之前实现完全忽略 pathspecs，会全树 checkout，破坏其它文件未提交改动。
    #[test]
    fn test_restore_with_pathspecs_does_not_touch_other_files() {
        let workspace = temp_workspace("pathspec");
        let engine = SnapshotEngine::new(&workspace);
        engine.ensure();

        // 基线：两个文件各有原始内容
        fs::write(workspace.join("keep.txt"), "keep-original\n").unwrap();
        fs::write(workspace.join("revert.txt"), "revert-original\n").unwrap();
        engine.create("baseline").expect("baseline");

        // 同时修改两个文件
        fs::write(workspace.join("keep.txt"), "keep-modified\n").unwrap();
        fs::write(workspace.join("revert.txt"), "revert-modified\n").unwrap();

        // 只恢复 revert.txt，保留 keep.txt 的改动
        let result = git_restore_files_impl(
            &workspace,
            &["revert.txt".to_string()],
            None,
        );
        assert!(result.ok, "restore should succeed: {}", result.message);

        let keep_content = fs::read_to_string(workspace.join("keep.txt")).unwrap();
        let revert_content = fs::read_to_string(workspace.join("revert.txt")).unwrap();
        assert_eq!(
            keep_content, "keep-modified\n",
            "keep.txt 必须保留未提交改动，恢复 pathspecs 不得误伤 (bug #2 回归)"
        );
        assert_eq!(
            revert_content, "revert-original\n",
            "revert.txt 必须已恢复到 HEAD 内容"
        );

        fs::remove_dir_all(&workspace).ok();
    }

    /// 不传 pathspecs 时仍然恢复整个工作树（保持原语义）。
    #[test]
    fn test_restore_without_pathspecs_resets_all() {
        let workspace = temp_workspace("all");
        let engine = SnapshotEngine::new(&workspace);
        engine.ensure();

        fs::write(workspace.join("a.txt"), "a-original\n").unwrap();
        fs::write(workspace.join("b.txt"), "b-original\n").unwrap();
        engine.create("baseline").expect("baseline");

        fs::write(workspace.join("a.txt"), "a-modified\n").unwrap();
        fs::write(workspace.join("b.txt"), "b-modified\n").unwrap();

        let result = git_restore_files_impl(&workspace, &[], None);
        assert!(result.ok, "restore should succeed: {}", result.message);

        assert_eq!(fs::read_to_string(workspace.join("a.txt")).unwrap(), "a-original\n");
        assert_eq!(fs::read_to_string(workspace.join("b.txt")).unwrap(), "b-original\n");

        fs::remove_dir_all(&workspace).ok();
    }
}
