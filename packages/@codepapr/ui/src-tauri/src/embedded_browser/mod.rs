//! 内置浏览器（嵌入式 WebView 引擎）。
//!
//! 用户与 Agent 共用同一个真实 WebView：Agent 的 browser 工具通过
//! Tauri 多 WebView API（`Window::add_child`）在主窗口内嵌一个子 WebView，
//! DOM 操作经 JS 注入完成，用户可在面板中直接浏览/接管。
//!
//! 与 `browser::page`（headless Chrome 引擎）通过引擎开关切换，
//! 命令签名与返回结构保持一致，上层工具契约不变。

pub(crate) mod js;
pub(crate) mod page;
pub(crate) mod screenshot;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use codepapr_core::shared::canonical_workspace;

const ENGINE_EMBEDDED: u8 = 0;
const ENGINE_HEADLESS: u8 = 1;

static BROWSER_ENGINE: AtomicU8 = AtomicU8::new(ENGINE_EMBEDDED);

pub(crate) fn is_embedded_engine() -> bool {
    BROWSER_ENGINE.load(Ordering::Relaxed) == ENGINE_EMBEDDED
}

pub(crate) fn engine_label() -> &'static str {
    if is_embedded_engine() {
        "embedded"
    } else {
        "headless"
    }
}

pub(crate) fn set_engine_by_label(label: &str) -> Result<(), String> {
    let value = match label.trim().to_lowercase().as_str() {
        "embedded" => ENGINE_EMBEDDED,
        "headless" => ENGINE_HEADLESS,
        other => {
            return Err(format!(
                "未知浏览器引擎: {other}（支持 embedded / headless）"
            ))
        }
    };
    BROWSER_ENGINE.store(value, Ordering::Relaxed);
    Ok(())
}

/// 页面最后已知状态（on_page_load / title 变化时更新）。
#[derive(Default)]
pub(crate) struct EmbeddedPageState {
    pub url: String,
    pub title: String,
}

pub(crate) struct EmbeddedSession {
    pub label: String,
    pub workspace_path: String,
    pub started_at: i64,
    pub webview: tauri::Webview<tauri::Wry>,
    pub state: Arc<Mutex<EmbeddedPageState>>,
    /// navigate/reload 后等待页面加载完成的一次性信号。
    pub load_waiter: Arc<Mutex<Option<tokio::sync::oneshot::Sender<String>>>>,
}

static SESSIONS: OnceLock<Mutex<HashMap<String, EmbeddedSession>>> = OnceLock::new();

fn sessions() -> &'static Mutex<HashMap<String, EmbeddedSession>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn workspace_key(workspace_path: &str) -> Result<String, String> {
    Ok(canonical_workspace(workspace_path)?
        .to_string_lossy()
        .to_string())
}

pub(crate) fn insert_session(key: &str, session: EmbeddedSession) {
    // 并发两次 open 同一工作区时，新会话会顶掉旧会话；必须显式关闭旧的
    // webview，否则旧实例泄漏（窗口仍在、CDP 连接不断）。
    if let Ok(mut map) = sessions().lock() {
        if let Some(old) = map.insert(key.to_string(), session) {
            let _ = old.webview.close();
        }
    }
}

pub(crate) fn get_session(key: &str) -> Option<EmbeddedSession> {
    sessions().lock().ok()?.get(key).map(clone_session)
}

pub(crate) fn remove_session(key: &str) -> Option<EmbeddedSession> {
    sessions().lock().ok()?.remove(key)
}

/// 按 webview label 反查会话（on_page_load / title 回调使用）。
pub(crate) fn find_session_by_label(label: &str) -> Option<(String, EmbeddedSession)> {
    let map = sessions().lock().ok()?;
    map.iter()
        .find(|(_, session)| session.label == label)
        .map(|(key, session)| (key.clone(), clone_session(session)))
}

/// 关闭所有嵌入式浏览器会话（应用退出时调用）。
pub(crate) fn close_all_sessions() {
    let Ok(mut map) = sessions().lock() else {
        return;
    };
    let webviews: Vec<tauri::Webview<tauri::Wry>> = map
        .values()
        .map(|session| session.webview.clone())
        .collect();
    map.clear();
    drop(map);
    for webview in webviews {
        let _ = webview.close();
    }
}

fn clone_session(session: &EmbeddedSession) -> EmbeddedSession {
    EmbeddedSession {
        label: session.label.clone(),
        workspace_path: session.workspace_path.clone(),
        started_at: session.started_at,
        webview: session.webview.clone(),
        state: Arc::clone(&session.state),
        load_waiter: Arc::clone(&session.load_waiter),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_switch_roundtrip() {
        set_engine_by_label("headless").unwrap();
        assert!(!is_embedded_engine());
        assert_eq!(engine_label(), "headless");
        set_engine_by_label("embedded").unwrap();
        assert!(is_embedded_engine());
        assert_eq!(engine_label(), "embedded");
        assert!(set_engine_by_label("unknown").is_err());
    }
}
