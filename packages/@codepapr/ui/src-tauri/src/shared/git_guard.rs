//! 按工作区串行化 shadow-git 操作。
//!
//! shadow repo 上的所有 Tauri 命令都跑在阻塞线程池里，多个命令可以并发：
//! 每条用户消息触发的 checkpoint 快照、面板的 status/log 刷新、agent 的 git
//! 工具调用。libgit2 的 index.lock 只保证单次 index 写入的原子性，但多步
//! 流程（选择性提交 clear→read_tree→add→write→重载→write_tree→commit；
//! 备份快照 clear→add→write→mixed-reset）中途被其它写者插入时，可能提交
//! 错误的树，或把锁冲突直接暴露给用户。
//!
//! 这里提供按工作区的读写锁：读操作（status/log/diff/plan）共享并发，
//! 写操作（ensure/create/commit/restore/checkout）独占串行。锁只在阻塞线程
//! 内持有（命令的 async 壳不持锁），不会卡住 tokio 共享 runtime。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, RwLock};

use super::sync::{read, write};

fn workspace_locks() -> &'static RwLock<HashMap<PathBuf, Arc<RwLock<()>>>> {
    static LOCKS: OnceLock<RwLock<HashMap<PathBuf, Arc<RwLock<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| RwLock::new(HashMap::new()))
}

fn lock_for(workspace: &Path) -> Arc<RwLock<()>> {
    let key = workspace.to_path_buf();
    // 快路径：已注册的工作区用读锁取表，避免每次操作都抢全局写锁。
    if let Some(existing) = read(workspace_locks()).get(&key) {
        return existing.clone();
    }
    let mut map = write(workspace_locks());
    map.entry(key).or_insert_with(|| Arc::new(RwLock::new(()))).clone()
}

/// 在读锁下执行（同一工作区的读操作可并发）：status/log/diff/plan 等只读命令。
pub(crate) fn with_workspace_git_read_lock<R>(workspace: &Path, f: impl FnOnce() -> R) -> R {
    let lock = lock_for(workspace);
    let _guard = read(&lock);
    f()
}

/// 在写锁下执行（同一工作区独占）：所有会改动 shadow repo 的命令。
pub(crate) fn with_workspace_git_write_lock<R>(workspace: &Path, f: impl FnOnce() -> R) -> R {
    let lock = lock_for(workspace);
    let _guard = write(&lock);
    f()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    fn temp_workspace(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "codepapr-gitguard-{label}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    /// 写锁必须互斥：并发写者不得同时进入临界区（否则多步 git 流程会被交错）。
    #[test]
    fn write_locks_are_exclusive_per_workspace() {
        let workspace = temp_workspace("exclusive");
        let inside = Arc::new(AtomicUsize::new(0));
        let violations = Arc::new(AtomicUsize::new(0));

        let mut handles = Vec::new();
        for _ in 0..8 {
            let ws = workspace.clone();
            let inside = inside.clone();
            let violations = violations.clone();
            handles.push(std::thread::spawn(move || {
                with_workspace_git_write_lock(&ws, || {
                    if inside.fetch_add(1, Ordering::SeqCst) != 0 {
                        violations.fetch_add(1, Ordering::SeqCst);
                    }
                    std::thread::sleep(Duration::from_millis(5));
                    inside.fetch_sub(1, Ordering::SeqCst);
                });
            }));
        }
        for handle in handles {
            handle.join().unwrap();
        }
        assert_eq!(violations.load(Ordering::SeqCst), 0, "写锁临界区不得并发进入");
    }

    /// 读锁必须可共享：一个读锁持有期间，另一个读操作仍能进入
    /// （否则面板并行的 status+log 刷新会被串行拖慢）。
    #[test]
    fn read_locks_are_shared() {
        let workspace = temp_workspace("shared-read");
        let (tx, rx) = std::sync::mpsc::channel();

        let ws_a = workspace.clone();
        let tx_a = tx.clone();
        std::thread::spawn(move || {
            with_workspace_git_read_lock(&ws_a, || {
                let _ = tx_a.send(());
                std::thread::sleep(Duration::from_millis(1000));
            });
        });

        let ws_b = workspace.clone();
        let tx_b = tx;
        std::thread::spawn(move || {
            with_workspace_git_read_lock(&ws_b, || {
                let _ = tx_b.send(());
            });
        });

        // 第一个读锁持有 1s：若读锁互斥，第二个进入通知必然晚于 1s 到达。
        rx.recv_timeout(Duration::from_millis(500)).expect("第一个读锁应进入");
        rx.recv_timeout(Duration::from_millis(500))
            .expect("读锁应共享：第一个读锁持有期间第二个读操作必须能进入");
    }
}
