use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// 用户主动停止子进程时给 SIGTERM 的宽限期。
const GRACEFUL_CHILD_REAP: Duration = Duration::from_secs(3);
/// 宿主退出时必须尽快 SIGKILL：macOS 没有 PR_SET_PDEATHSIG，
/// `process::exit` 也不会杀子进程；拖到数秒会让 Dock 显示「正在后台运行」。
const FAST_CHILD_REAP: Duration = Duration::from_millis(200);

static FAST_CHILD_REAP_ENABLED: AtomicBool = AtomicBool::new(false);

/// 进入宿主退出路径：后续 `kill_process_tree` / MCP close 等改用短超时。
pub(crate) fn enter_fast_child_reap() {
    FAST_CHILD_REAP_ENABLED.store(true, Ordering::SeqCst);
}

pub(crate) fn is_fast_child_reap() -> bool {
    FAST_CHILD_REAP_ENABLED.load(Ordering::Relaxed)
}

/// SIGTERM 后等待子进程退出的上限。宿主退出时缩短，避免清理卡住 `RunEvent::Exit`。
pub(crate) fn child_reap_timeout() -> Duration {
    if is_fast_child_reap() {
        FAST_CHILD_REAP
    } else {
        GRACEFUL_CHILD_REAP
    }
}

/// Run a blocking task on tokio's blocking thread pool.
pub async fn run_blocking_workspace_task<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(task)
        .await
        .map_err(|err| format!("后台任务执行失败: {err}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_child_reap_timeout_is_graceful() {
        // 测试进程不会走宿主 Exit 路径，默认必须保持 3s 优雅退出。
        assert!(
            !is_fast_child_reap(),
            "unit tests must not inherit the host-exit fast-reap flag"
        );
        assert_eq!(child_reap_timeout(), GRACEFUL_CHILD_REAP);
    }
}
