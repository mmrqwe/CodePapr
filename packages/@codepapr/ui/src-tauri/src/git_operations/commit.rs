use crate::snapshot::types::GitOperationResult;
use super::{open_repo, ensure_signature};

pub fn git_commit_impl(
    workspace: &std::path::Path,
    message: &str,
    stage_all: bool,
    pathspecs: &[String],
    allow_empty: bool,
) -> GitOperationResult {
    let repo = match open_repo(workspace) {
        Ok(r) => r,
        Err(e) => return GitOperationResult {
            ok: false, action: "commit".to_string(), message: e, backup_ref: None,
        },
    };

    let signature = match ensure_signature(&repo) {
        Ok(s) => s,
        Err(e) => return GitOperationResult {
            ok: false, action: "commit".to_string(), message: e, backup_ref: None,
        },
    };

    let trimmed_msg = message.trim();
    if trimmed_msg.is_empty() {
        return GitOperationResult {
            ok: false, action: "commit".to_string(),
            message: "commit message 不能为空".to_string(), backup_ref: None,
        };
    }

    if stage_all || !pathspecs.is_empty() {
        // 当仅提交指定 pathspecs（非 stage_all）时，先把 index 重置到 HEAD 的树，
        // 再在同一 index 对象上 stage 指定 pathspecs。这样最终提交的树 = HEAD 内容 +
        // 指定 pathspecs 的改动，与 `git commit -- <paths>` 语义一致，避免之前残留的
        // staged 状态污染本次提交。
        //
        // 注意：必须在同一个 idx 对象上完成 read_tree + add_path + write，不能委托给
        // git_stage_impl（它会另开 Repository，其 index 对象不反映此处的 read_tree）。
        //
        // 任何一步失败都必须显式返回错误，绝不能静默跳过——
        // 否则残留的 staged 内容会污染本次选择性提交（bug #3 回归）。
        if !stage_all && !pathspecs.is_empty() {
            let head_oid = match repo.head().ok().and_then(|h| h.target()) {
                Some(oid) => oid,
                None => return GitOperationResult {
                    ok: false, action: "commit".to_string(),
                    message: "无法获取 HEAD（空仓库？）".to_string(),
                    backup_ref: None,
                },
            };
            let head_commit = match repo.find_commit(head_oid) {
                Ok(c) => c,
                Err(e) => return GitOperationResult {
                    ok: false, action: "commit".to_string(),
                    message: format!("find HEAD commit: {}", e.message()),
                    backup_ref: None,
                },
            };
            let head_tree = match head_commit.tree() {
                Ok(t) => t,
                Err(e) => return GitOperationResult {
                    ok: false, action: "commit".to_string(),
                    message: format!("HEAD tree: {}", e.message()),
                    backup_ref: None,
                },
            };

            let mut idx = match repo.index() {
                Ok(idx) => idx,
                Err(e) => return GitOperationResult {
                    ok: false, action: "commit".to_string(),
                    message: format!("index: {}", e.message()), backup_ref: None,
                },
            };
            if let Err(e) = idx.clear() {
                return GitOperationResult {
                    ok: false, action: "commit".to_string(),
                    message: format!("clear index: {}", e.message()), backup_ref: None,
                };
            }
            if let Err(e) = idx.read_tree(&head_tree) {
                return GitOperationResult {
                    ok: false, action: "commit".to_string(),
                    message: format!("read_tree: {}", e.message()), backup_ref: None,
                };
            }

            for spec in pathspecs {
                let p = crate::snapshot::ignore_resolver::git_relative_path(std::path::Path::new(spec));
                if workspace.join(&p).exists() {
                    if let Err(e) = idx.add_path(&p) {
                        return GitOperationResult {
                            ok: false, action: "commit".to_string(),
                            message: format!("add {:?}: {}", spec, e.message()),
                            backup_ref: None,
                        };
                    }
                } else {
                    // 文件已从工作区删除：index 此刻是 HEAD 树，remove_path
                    // 即把该删除纳入本次提交（对齐 git commit -- <paths> 语义）。
                    if let Err(e) = idx.remove_path(&p) {
                        return GitOperationResult {
                            ok: false, action: "commit".to_string(),
                            message: format!("remove {:?}: {}", spec, e.message()),
                            backup_ref: None,
                        };
                    }
                }
            }

            if let Err(e) = idx.write() {
                return GitOperationResult {
                    ok: false, action: "commit".to_string(),
                    message: format!("write index: {}", e.message()), backup_ref: None,
                };
            }
        } else {
            // stage_all=true 或 pathspecs 为空但 stage_all=true 的路径：复用 git_stage_impl
            // 的"全量收集 + stage"逻辑。
            let stage_result = super::stage::git_stage_impl(workspace, stage_all, pathspecs);
            if !stage_result.ok {
                return GitOperationResult {
                    ok: false, action: "commit".to_string(),
                    message: format!("暂存失败: {}", stage_result.message), backup_ref: None,
                };
            }
        }
    }

    let mut index = match repo.index() {
        Ok(idx) => idx,
        Err(e) => return GitOperationResult {
            ok: false, action: "commit".to_string(),
            message: format!("index: {}", e.message()), backup_ref: None,
        },
    };

    let tree_oid = match index.write_tree() {
        Ok(oid) => oid,
        Err(e) => return GitOperationResult {
            ok: false, action: "commit".to_string(),
            message: format!("write_tree: {}", e.message()), backup_ref: None,
        },
    };

    let tree = match repo.find_tree(tree_oid) {
        Ok(t) => t,
        Err(e) => return GitOperationResult {
            ok: false, action: "commit".to_string(),
            message: format!("find_tree: {}", e.message()), backup_ref: None,
        },
    };

    let parent_commit = repo.head().ok()
        .and_then(|h| h.target())
        .and_then(|oid| repo.find_commit(oid).ok());

    if !allow_empty {
        if let Some(ref parent) = parent_commit {
            if let Ok(parent_tree) = parent.tree() {
                if tree.id() == parent_tree.id() {
                    return GitOperationResult {
                        ok: false, action: "commit".to_string(),
                        message: "没有改动可提交（可用 allowEmpty 跳过此检查）".to_string(),
                        backup_ref: None,
                    };
                }
            }
        }
    }

    let parents: Vec<&git2::Commit> = parent_commit.iter().collect();
    let commit_oid = match repo.commit(
        Some("HEAD"), &signature, &signature, message, &tree, &parents,
    ) {
        Ok(oid) => oid,
        Err(e) => return GitOperationResult {
            ok: false, action: "commit".to_string(),
            message: format!("commit: {}", e.message()), backup_ref: None,
        },
    };

    GitOperationResult {
        ok: true, action: "commit".to_string(),
        message: format!("已创建提交 {}", &commit_oid.to_string()[..7]),
        backup_ref: None,
    }
}

#[tauri::command]
pub async fn git_commit(
    workspace_path: String,
    message: String,
    stage_all: Option<bool>,
    pathspecs: Option<Vec<String>>,
    allow_empty: Option<bool>,
) -> GitOperationResult {
    // git2 提交是重阻塞操作，放阻塞线程池，别卡 tokio 共享 runtime。
    crate::shared::run_blocking_workspace_task(move || -> Result<GitOperationResult, String> {
        let workspace = std::path::PathBuf::from(workspace_path);
        Ok(git_commit_impl(
            &workspace, &message,
            stage_all.unwrap_or(false),
            &pathspecs.unwrap_or_default(),
            allow_empty.unwrap_or(false),
        ))
    })
    .await
    .unwrap_or_else(|err| GitOperationResult {
        ok: false,
        action: "commit".to_string(),
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
            "codepapr-commit-{label}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        path.push(unique);
        fs::create_dir_all(&path).unwrap();
        path
    }

    /// 回归 #3：先 stage 文件 A，然后 commit(pathspecs=[B]) 不应把 A 带入提交。
    /// 旧实现不清空 index，A 残留的 staged 状态会污染只提交 B 的意图。
    #[test]
    fn test_selective_commit_excludes_prior_staged_content() {
        let workspace = temp_workspace("selective");
        let engine = SnapshotEngine::new(&workspace);
        engine.ensure();

        fs::write(workspace.join("a.txt"), "a-v1\n").unwrap();
        fs::write(workspace.join("b.txt"), "b-v1\n").unwrap();
        engine.create("baseline").expect("baseline");

        // 修改两个文件
        fs::write(workspace.join("a.txt"), "a-v2\n").unwrap();
        fs::write(workspace.join("b.txt"), "b-v2\n").unwrap();

        // 先 stage a.txt（模拟 agent 调用 git(action: stage, pathspecs: ['a.txt'])）
        let stage_a = super::super::stage::git_stage_impl(
            &workspace,
            false,
            &["a.txt".to_string()],
        );
        assert!(stage_a.ok, "stage a.txt should succeed: {}", stage_a.message);

        // 现在只 commit b.txt
        let commit_result = git_commit_impl(
            &workspace,
            "only b",
            false,
            &["b.txt".to_string()],
            false,
        );
        assert!(commit_result.ok, "commit should succeed: {}", commit_result.message);

        // 验证：最新提交里应该只有 b.txt 的改动，a.txt 不在提交内
        let repo = git2::Repository::open(workspace.join(".CodePapr/git")).unwrap();
        let head = repo.head().unwrap();
        let head_commit = repo.find_commit(head.target().unwrap()).unwrap();
        let parent = head_commit.parent(0).unwrap();
        let diff = repo
            .diff_tree_to_tree(
                Some(&parent.tree().unwrap()),
                Some(&head_commit.tree().unwrap()),
                None,
            )
            .unwrap();

        let changed_paths: Vec<String> = diff
            .deltas()
            .map(|d| {
                d.new_file()
                    .path()
                    .or_else(|| d.old_file().path())
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default()
            })
            .collect();

        assert!(
            changed_paths.iter().any(|p| p == "b.txt"),
            "b.txt 应该在提交里, got {:?}", changed_paths
        );
        assert!(
            !changed_paths.iter().any(|p| p == "a.txt"),
            "a.txt 不应混入本次选择性提交 (bug #3 回归), got {:?}", changed_paths
        );

        fs::remove_dir_all(&workspace).ok();
    }

    #[test]
    fn test_commit_stage_all_path() {
        let workspace = temp_workspace("stage_all");
        let engine = SnapshotEngine::new(&workspace);
        engine.ensure();

        fs::write(workspace.join("x.txt"), "x-v1\n").unwrap();
        engine.create("baseline").expect("baseline");
        fs::write(workspace.join("x.txt"), "x-v2\n").unwrap();
        fs::write(workspace.join("y.txt"), "y-v1\n").unwrap();

        let result = git_commit_impl(&workspace, "all changes", true, &[], false);
        assert!(result.ok, "commit stage_all should succeed: {}", result.message);

        fs::remove_dir_all(&workspace).ok();
    }
}
