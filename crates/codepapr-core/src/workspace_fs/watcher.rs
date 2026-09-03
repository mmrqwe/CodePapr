//! Native recursive file watcher for the workspace tree.
//!
//! Replaces the previous 1.5s polling of `list_workspace_files`. The OS-level
//! watcher (FSEvents on macOS, inotify on Linux, ReadDirectoryChangesW on
//! Windows) notifies a callback whenever something under the workspace changes.
//! A 300ms debounce coalesces bursts (e.g. a `git checkout` touching many files)
//! into a single refresh signal, and events whose path touches an ignored directory
//! (`node_modules`, `target`, dot-dirs) are dropped before signalling so dependency
//! churn stays quiet.

use std::path::Path;
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};

use super::{path_touches_codepapr_content, path_touches_ignored_dir};

/// Quiet window that must elapse after the last filesystem event before a
/// single change event is emitted. Absorbs the rapid event bursts produced by
/// bulk operations (`npm install`, `git checkout`).
const DEBOUNCE_QUIET_MS: u64 = 300;
/// Block interval for the debounce loop when polling the event channel.
const DEBOUNCE_POLL_MS: u64 = 150;

pub const WORKSPACE_CHANGED_EVENT: &str = "workspace-files-changed";

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

pub fn start_workspace_watcher_impl(
    workspace_path: String,
    on_changed: Arc<dyn Fn() + Send + Sync + 'static>,
) -> Result<(), String> {
    // Replace any existing watcher first so switching workspaces is clean.
    stop_workspace_watcher_impl();

    let path = Path::new(&workspace_path);
    if !path.is_dir() {
        return Err(format!("工作区路径不是目录: {workspace_path}"));
    }

    let (event_tx, event_rx) = channel::<()>();
    let (stop_tx, stop_rx) = channel::<()>();

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
                    on_changed();
                    last_signal = None;
                }
            }
        }
    });

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

pub fn stop_workspace_watcher_impl() {
    if let Ok(mut guard) = watcher_state().lock() {
        if let Some(handle) = guard.take() {
            let _ = handle.stop_tx.send(());
        }
    }
}

pub fn stop_workspace_watcher() -> Result<(), String> {
    stop_workspace_watcher_impl();
    Ok(())
}
