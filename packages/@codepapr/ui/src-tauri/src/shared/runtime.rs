/// Run a blocking task on Tauri's async runtime thread pool.
pub(crate) async fn run_blocking_workspace_task<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|err| format!("后台任务执行失败: {err}"))?
}
