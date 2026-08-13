//! Native recursive file watcher for the workspace tree.
//!
//! Replaces the previous 1.5s polling of `list_workspace_files`. The OS-level
//! watcher (FSEvents on macOS, inotify on Linux, ReadDirectoryChangesW on
//! Windows) emits a `workspace-files-changed` Tauri event whenever something
//! under the workspace changes. A 300ms debounce coalesces bursts (e.g. a
//! `git checkout` touching many files) into a single refresh signal, and
//! events whose path touches an ignored directory (`node_modules`, `target`,
//! dot-dirs) are dropped before signalling so dependency churn stays quiet.

use std::path::Path;
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

use super::{path_touches_codepapr_content, path_touches_ignored_dir};

/// Quiet window that must elapse after the last filesystem event before a
/// single `workspace-files-changed` event is emitted. Absorbs the rapid
/// event bursts produced by bulk operations (`npm install`, `git checkout`).
const DEBOUNCE_QUIET_MS: u64 = 300;
/// Block interval for the debounce loop when polling the event channel.
const DEBOUNCE_POLL_MS: u64 = 150;

const WORKSPACE_CHANGED_EVENT: &str = "workspace-files-changed";

struct WatcherHandle {
    /// Dropping the watcher stops OS-level watching.
    _watcher: RecommendedWatcher,
    stop_tx: Sender<()>,
    _debounce_thread: thread::JoinHandle<()>,
}

fn watcher_state() -> &'static Mutex<Option<WatcherHandle>> {
    static WATCHER: OnceLock<Mutex<Option<WatcherHandle>>> = OnceLock::new();
    WATCHER.get_or_init(|| Mutex::new(None))
}

pub(crate) fn start_workspace_watcher_impl(
    app: AppHandle,
    workspace_path: String,
) -> Result<(), String> {
    // Replace any existing watcher first so switching workspaces is clean.
    stop_workspace_watcher_impl();

    let path = Path::new(&workspace_path);
    if !path.is_dir() {
        return Err(format!("工作区路径不是目录: {workspace_path}"));
    }

    let (event_tx, event_rx) = channel::<()>();
    let (stop_tx, stop_rx) = channel::<()>();

    // Debounce thread: coalesces signals into a single Tauri event after a
    // quiet period. Holds an AppHandle clone (Send + Sync) to emit events.
    let app_for_emit = app.clone();
    let debounce_thread = thread::spawn(move || {
        let mut last_signal: Option<Instant> = None;
        loop {
            match event_rx.recv_timeout(Duration::from_millis(DEBOUNCE_POLL_MS)) {
                Ok(()) => last_signal = Some(Instant::now()),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            if stop_rx.try_recv().is_ok() {
                break;
            }
            if let Some(moment) = last_signal {
                if moment.elapsed() >= Duration::from_millis(DEBOUNCE_QUIET_MS) {
                    let _ = app_for_emit.emit(WORKSPACE_CHANGED_EVENT, ());
                    last_signal = None;
                }
            }
        }
    });

    // Watcher callback: runs on notify's internal thread. Only forwards a
    // signal for content-affecting events on non-ignored paths.
    let signal_tx = event_tx;
    let mut watcher = RecommendedWatcher::new(
        move |result: Result<notify::Event, notify::Error>| {
            let event = match result {
                Ok(event) => event,
                Err(_) => return,
            };
            if event.kind.is_access() {
                return;
            }
            // Drop events that only touch ignored directories (node_modules,
            // target, dot-dirs) so dependency churn stays quiet. .CodePapr 下
            // 的用户可见内容子树（apps/skills/commands/agents）例外放行：
            // app_render / skill 安装落盘后依赖 watcher 的视图需要刷新（#22）。
            if event
                .paths
                .iter()
                .all(|p| path_touches_ignored_dir(p) && !path_touches_codepapr_content(p))
            {
                return;
            }
            let _ = signal_tx.send(());
        },
        Config::default(),
    )
    .map_err(|err| format!("启动文件监听失败: {err}"))?;

    watcher
        .watch(path, RecursiveMode::Recursive)
        .map_err(|err| format!("监听工作区失败: {err}"))?;

    let handle = WatcherHandle {
        _watcher: watcher,
        stop_tx,
        _debounce_thread: debounce_thread,
    };
    if let Ok(mut guard) = watcher_state().lock() {
        *guard = Some(handle);
    }
    Ok(())
}

pub(crate) fn stop_workspace_watcher_impl() {
    if let Ok(mut guard) = watcher_state().lock() {
        if let Some(handle) = guard.take() {
            let _ = handle.stop_tx.send(());
            // `handle._watcher` drops here -> OS watching stops; the callback
            // closure (and its `signal_tx`) drops too, which disconnects the
            // debounce thread's receiver and lets it exit promptly.
        }
    }
}

#[tauri::command]
pub(crate) fn start_workspace_watcher(
    app: AppHandle,
    workspace_path: String,
) -> Result<(), String> {
    start_workspace_watcher_impl(app, workspace_path)
}

#[tauri::command]
pub(crate) fn stop_workspace_watcher() -> Result<(), String> {
    stop_workspace_watcher_impl();
    Ok(())
}
