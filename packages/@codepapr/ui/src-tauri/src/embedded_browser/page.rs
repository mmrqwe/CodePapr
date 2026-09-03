//! 内置浏览器 Tauri 命令集。
//!
//! 命令签名与返回结构对齐 `browser::page`（headless Chrome 引擎），
//! 由 `browser::page` 各命令按引擎开关分发到此处。

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::webview::{DownloadEvent, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl};

use crate::browser::page::{
    browser_action_timeout, default_browser_screenshot_path, parse_browser_dom_content_type,
    parse_browser_screenshot_format, parse_browser_selector_kind, write_browser_binary_file,
    MAX_BROWSER_DOM_BYTES,
};
use crate::browser::types::{
    BrowserPageActionResult, BrowserPageCloseResult, BrowserPageDomResult,
    BrowserPageScreenshotResult, BrowserPageSessionResult,
};
use crate::embedded_browser::{
    find_session_by_label, get_session, insert_session, js, remove_session, screenshot,
    workspace_key, EmbeddedPageState, EmbeddedSession,
};
use codepapr_core::shared::{parse_browser_url, unix_millis};

const DEFAULT_WEBVIEW_WIDTH: f64 = 1280.0;
const DEFAULT_WEBVIEW_HEIGHT: f64 = 900.0;
const LOAD_WAIT_TIMEOUT: Duration = Duration::from_secs(20);
const EVAL_TIMEOUT: Duration = Duration::from_secs(10);
const POLL_INTERVAL: Duration = Duration::from_millis(100);
/// 两阶段协议中 Rust 侧轮询的额外宽限（JS 侧超时后还需一次 poll 取回错误）。
const WAIT_GRACE: Duration = Duration::from_secs(3);

const CHROME_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

static LABEL_COUNTER: AtomicU64 = AtomicU64::new(1);
static TOKEN_COUNTER: AtomicU64 = AtomicU64::new(1);

fn next_label() -> String {
    format!(
        "embedded-browser-{}",
        LABEL_COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

fn next_token() -> String {
    format!(
        "tok-{}-{}",
        unix_millis().unwrap_or(0),
        TOKEN_COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

fn state_snapshot(session: &EmbeddedSession) -> (String, String) {
    let state = session
        .state
        .lock()
        .map(|guard| (guard.url.clone(), guard.title.clone()));
    state.unwrap_or_default()
}

fn session_result(session: &EmbeddedSession) -> Result<BrowserPageSessionResult, String> {
    let (url, title) = state_snapshot(session);
    Ok(BrowserPageSessionResult {
        url,
        title,
        workspace_path: session.workspace_path.clone(),
        started_at: session.started_at,
        active: true,
    })
}

/// 执行同步 JS 并取回 JSON 结果。
async fn eval_json(
    webview: &tauri::Webview<tauri::Wry>,
    script: &str,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    // eval_with_callback 要求 Fn 闭包（可能多次调用），用 Mutex<Option> 保证只发送一次。
    let tx_slot = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
    let tx_clone = std::sync::Arc::clone(&tx_slot);
    let script_owned = script.to_string();
    webview
        .eval_with_callback(script_owned, move |result| {
            if let Some(tx) = tx_clone.lock().ok().and_then(|mut guard| guard.take()) {
                let _ = tx.send(result);
            }
        })
        .map_err(|err| format!("JS 执行失败: {err}"))?;

    let raw = tokio::time::timeout(timeout, rx)
        .await
        .map_err(|_| format!("JS 执行超时（{} 秒）", timeout.as_secs()))?
        .map_err(|_| "JS 执行通道已关闭".to_string())?;

    serde_json::from_str(&raw).map_err(|err| format!("JS 结果解析失败: {err} | raw: {raw}"))
}

fn extract_error(value: &serde_json::Value) -> String {
    value
        .get("error")
        .and_then(|item| item.as_str())
        .map(|message| message.to_string())
        .unwrap_or_else(|| format!("JS 执行失败: {value}"))
}

/// 两阶段协议：Phase 1 启动等待型操作，随后轮询 Phase 2 取回结果。
async fn run_wait_action(
    webview: &tauri::Webview<tauri::Wry>,
    phase1_script: &str,
    token: &str,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let started = eval_json(webview, phase1_script, EVAL_TIMEOUT).await?;
    if started.get("ok").and_then(|item| item.as_bool()) != Some(true) {
        return Err(extract_error(&started));
    }

    let poll_script = js::poll_script(token);
    let deadline = Instant::now() + timeout + WAIT_GRACE;
    loop {
        let polled = eval_json(webview, &poll_script, EVAL_TIMEOUT).await?;
        if polled.get("done").and_then(|item| item.as_bool()) == Some(true) {
            let result = polled
                .get("result")
                .cloned()
                .unwrap_or_else(|| json!({ "ok": false, "error": "页面未返回操作结果" }));
            if result.get("ok").and_then(|item| item.as_bool()) == Some(true) {
                return Ok(result);
            }
            return Err(extract_error(&result));
        }
        if Instant::now() > deadline {
            return Err("等待页面操作完成超时".to_string());
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// 注册加载等待信号；在触发导航前调用以避免竞态。
fn arm_load_waiter(session: &EmbeddedSession) -> tokio::sync::oneshot::Receiver<String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    if let Ok(mut guard) = session.load_waiter.lock() {
        *guard = Some(tx);
    }
    rx
}

async fn wait_for_load(
    rx: tokio::sync::oneshot::Receiver<String>,
    timeout: Duration,
) -> Option<String> {
    tokio::time::timeout(timeout, rx)
        .await
        .ok()
        .and_then(|inner| inner.ok())
}

fn parse_url(raw: &str) -> Result<url::Url, String> {
    let parsed = parse_browser_url(raw)?;
    url::Url::parse(&parsed).map_err(|err| format!("URL 解析失败: {err}"))
}

fn emit_state_changed(app: &AppHandle, session: &EmbeddedSession) {
    let (url, title) = state_snapshot(session);
    let _ = app.emit(
        "embedded-browser://state-changed",
        json!({
            "workspacePath": session.workspace_path,
            "url": url,
            "title": title,
        }),
    );
}

// ──── 会话生命周期 ────

async fn open_or_navigate(
    app: AppHandle,
    workspace_path: String,
    url: String,
) -> Result<BrowserPageSessionResult, String> {
    let key = workspace_key(&workspace_path)?;
    let target = parse_url(&url)?;

    if let Some(session) = get_session(&key) {
        let rx = arm_load_waiter(&session);
        session
            .webview
            .navigate(target)
            .map_err(|err| format!("内置浏览器跳转失败: {err}"))?;
        wait_for_load(rx, LOAD_WAIT_TIMEOUT).await;
        let result = session_result(&session)?;
        emit_state_changed(&app, &session);
        return Ok(result);
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| "主窗口不存在，无法创建内置浏览器".to_string())?;

    let label = next_label();
    let state = std::sync::Arc::new(std::sync::Mutex::new(EmbeddedPageState {
        url: target.to_string(),
        title: String::new(),
    }));
    let load_waiter: std::sync::Arc<
        std::sync::Mutex<Option<tokio::sync::oneshot::Sender<String>>>,
    > = std::sync::Arc::new(std::sync::Mutex::new(None));

    let page_load_state = std::sync::Arc::clone(&state);
    let page_load_waiter = std::sync::Arc::clone(&load_waiter);
    let title_state = std::sync::Arc::clone(&state);
    let new_window_label = label.clone();
    let new_window_app = app.clone();
    let download_workspace = key.clone();

    let builder = WebviewBuilder::new(&label, WebviewUrl::External(target.clone()))
        .user_agent(CHROME_USER_AGENT)
        .initialization_script(js::HELPER_INIT_SCRIPT)
        .zoom_hotkeys_enabled(true)
        .on_navigation(|nav_url| matches!(nav_url.scheme(), "http" | "https"))
        .on_page_load(move |webview, payload| {
            if !matches!(payload.event(), PageLoadEvent::Finished) {
                return;
            }
            let finished_url = payload.url().to_string();
            if let Some((_, session)) = find_session_by_label(webview.label()) {
                if let Ok(mut guard) = session.state.lock() {
                    guard.url = finished_url.clone();
                }
                if let Ok(mut waiter) = session.load_waiter.lock() {
                    if let Some(tx) = waiter.take() {
                        let _ = tx.send(finished_url);
                    }
                }
                emit_state_changed(webview.app_handle(), &session);
            } else {
                // 会话尚未登记（首次加载）：直接更新共享状态。
                if let Ok(mut guard) = page_load_state.lock() {
                    guard.url = finished_url.clone();
                }
                if let Ok(mut waiter) = page_load_waiter.lock() {
                    if let Some(tx) = waiter.take() {
                        let _ = tx.send(finished_url);
                    }
                }
            }
        })
        .on_document_title_changed(move |webview, title| {
            if let Some((_, session)) = find_session_by_label(webview.label()) {
                if let Ok(mut guard) = session.state.lock() {
                    guard.title = title;
                }
                emit_state_changed(webview.app_handle(), &session);
            } else if let Ok(mut guard) = title_state.lock() {
                guard.title = title;
            }
        })
        .on_new_window(move |new_url, _features| {
            if matches!(new_url.scheme(), "http" | "https") {
                if let Some(webview) = new_window_app.get_webview(&new_window_label) {
                    let _ = webview.navigate(new_url);
                }
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .on_download(move |_webview, event| {
            if let DownloadEvent::Requested {
                url: download_url,
                destination,
            } = event
            {
                if let Ok(workspace) = codepapr_core::shared::canonical_workspace(&download_workspace) {
                    let file_name = download_url
                        .path_segments()
                        .and_then(|mut segments| segments.next_back())
                        .filter(|name| !name.is_empty())
                        .unwrap_or("download");
                    let sanitized: String = file_name
                        .chars()
                        .map(|ch| {
                            if ch.is_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                                ch
                            } else {
                                '_'
                            }
                        })
                        .collect();
                    let sanitized = if sanitized.is_empty() || sanitized.chars().all(|c| c == '.') {
                        // 纯点文件名("..")会逃逸出 downloads 目录,拒绝并回退。
                        "download".to_string()
                    } else {
                        sanitized
                    };
                    let dir = workspace.join(".CodePapr").join("downloads");
                    let _ = std::fs::create_dir_all(&dir);
                    *destination = dir.join(sanitized);
                }
            }
            true
        });

    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(DEFAULT_WEBVIEW_WIDTH, DEFAULT_WEBVIEW_HEIGHT),
        )
        .map_err(|err| format!("创建内置浏览器失败: {err}"))?;

    // 默认隐藏：面板打开时由前端 show + set_bounds。
    let _ = webview.hide();

    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    if let Ok(mut guard) = load_waiter.lock() {
        *guard = Some(tx);
    }

    let session = EmbeddedSession {
        label,
        workspace_path: key,
        started_at: unix_millis()?,
        webview,
        state,
        load_waiter,
    };
    insert_session(&session.workspace_path, session_clone_for_insert(&session));
    wait_for_load(rx, LOAD_WAIT_TIMEOUT).await;
    let result = session_result(&session)?;
    emit_state_changed(&app, &session);
    Ok(result)
}

fn session_clone_for_insert(session: &EmbeddedSession) -> EmbeddedSession {
    EmbeddedSession {
        label: session.label.clone(),
        workspace_path: session.workspace_path.clone(),
        started_at: session.started_at,
        webview: session.webview.clone(),
        state: std::sync::Arc::clone(&session.state),
        load_waiter: std::sync::Arc::clone(&session.load_waiter),
    }
}

fn require_session(workspace_path: &str) -> Result<(String, EmbeddedSession), String> {
    let key = workspace_key(workspace_path)?;
    let session = get_session(&key)
        .ok_or_else(|| "当前工作区没有活动中的内置浏览会话，请先打开页面。".to_string())?;
    Ok((key, session))
}

// ──── Tauri 命令 ────

#[tauri::command]
pub(crate) async fn embedded_browser_open(
    app: AppHandle,
    workspace_path: String,
    url: String,
) -> Result<BrowserPageSessionResult, String> {
    open_or_navigate(app, workspace_path, url).await
}

#[tauri::command]
pub(crate) async fn embedded_browser_navigate(
    app: AppHandle,
    workspace_path: String,
    url: String,
) -> Result<BrowserPageSessionResult, String> {
    open_or_navigate(app, workspace_path, url).await
}

#[tauri::command]
pub(crate) async fn embedded_browser_reload(
    _app: AppHandle,
    workspace_path: String,
) -> Result<BrowserPageSessionResult, String> {
    let (_, session) = require_session(&workspace_path)?;
    let rx = arm_load_waiter(&session);
    session
        .webview
        .eval("location.reload()")
        .map_err(|err| format!("内置浏览器刷新失败: {err}"))?;
    wait_for_load(rx, LOAD_WAIT_TIMEOUT).await;
    session_result(&session)
}

#[tauri::command]
pub(crate) async fn embedded_browser_history(
    _app: AppHandle,
    workspace_path: String,
    direction: String,
) -> Result<BrowserPageSessionResult, String> {
    let (_, session) = require_session(&workspace_path)?;
    let rx = arm_load_waiter(&session);
    let script = match direction.as_str() {
        "forward" => js::HISTORY_FORWARD_SCRIPT,
        _ => js::HISTORY_BACK_SCRIPT,
    };
    session
        .webview
        .eval(script)
        .map_err(|err| format!("内置浏览器历史导航失败: {err}"))?;
    wait_for_load(rx, LOAD_WAIT_TIMEOUT).await;
    session_result(&session)
}

#[tauri::command]
pub(crate) async fn embedded_browser_click(
    _app: AppHandle,
    workspace_path: String,
    selector: String,
    selector_type: Option<String>,
    wait_for_navigation: Option<bool>,
    timeout_seconds: Option<u64>,
) -> Result<BrowserPageActionResult, String> {
    let (_, session) = require_session(&workspace_path)?;
    let selector_kind = parse_browser_selector_kind(selector_type.as_deref())?;
    let timeout = browser_action_timeout(timeout_seconds);
    let token = next_token();
    let script = js::click_script(
        &token,
        &selector,
        selector_kind.label(),
        timeout.as_millis() as u64,
    );

    let result = run_wait_action(&session.webview, &script, &token, timeout).await?;

    if wait_for_navigation.unwrap_or(false) {
        let rx = arm_load_waiter(&session);
        wait_for_load(rx, timeout).await;
    }

    let (url, title) = state_from_result(&result).unwrap_or_else(|| state_snapshot(&session));
    Ok(BrowserPageActionResult {
        action: "click".to_string(),
        url,
        title,
        selector: Some(selector),
        selector_type: Some(selector_kind.label().to_string()),
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn embedded_browser_input(
    _app: AppHandle,
    workspace_path: String,
    selector: String,
    text: String,
    selector_type: Option<String>,
    clear: Option<bool>,
    submit: Option<bool>,
    wait_for_navigation: Option<bool>,
    timeout_seconds: Option<u64>,
) -> Result<BrowserPageActionResult, String> {
    let (_, session) = require_session(&workspace_path)?;
    let selector_kind = parse_browser_selector_kind(selector_type.as_deref())?;
    let timeout = browser_action_timeout(timeout_seconds);
    let token = next_token();
    let script = js::input_script(
        &token,
        &selector,
        selector_kind.label(),
        &text,
        clear.unwrap_or(true),
        submit.unwrap_or(false),
        timeout.as_millis() as u64,
    );

    let result = run_wait_action(&session.webview, &script, &token, timeout).await?;

    if wait_for_navigation.unwrap_or(false) {
        let rx = arm_load_waiter(&session);
        wait_for_load(rx, timeout).await;
    }

    let (url, title) = state_from_result(&result).unwrap_or_else(|| state_snapshot(&session));
    Ok(BrowserPageActionResult {
        action: "input".to_string(),
        url,
        title,
        selector: Some(selector),
        selector_type: Some(selector_kind.label().to_string()),
    })
}

#[tauri::command]
pub(crate) async fn embedded_browser_read_dom(
    _app: AppHandle,
    workspace_path: String,
    selector: Option<String>,
    selector_type: Option<String>,
    content_type: Option<String>,
    timeout_seconds: Option<u64>,
) -> Result<BrowserPageDomResult, String> {
    let (_, session) = require_session(&workspace_path)?;
    let selector_kind = parse_browser_selector_kind(selector_type.as_deref())?;
    let dom_content_type = parse_browser_dom_content_type(content_type.as_deref())?;
    let timeout = browser_action_timeout(timeout_seconds);
    let token = next_token();
    let script = js::read_dom_script(
        &token,
        selector.as_deref(),
        selector_kind.label(),
        dom_content_type.label(),
        timeout.as_millis() as u64,
    );

    let result = run_wait_action(&session.webview, &script, &token, timeout).await?;

    let content = result
        .get("content")
        .and_then(|item| item.as_str())
        .unwrap_or_default()
        .to_string();
    let (content, truncated) = truncate_dom(content);
    let (url, title) = state_from_result(&result).unwrap_or_else(|| state_snapshot(&session));

    Ok(BrowserPageDomResult {
        url,
        title,
        selector: selector.clone(),
        selector_type: selector.as_ref().map(|_| selector_kind.label().to_string()),
        content_type: dom_content_type.label().to_string(),
        content,
        truncated,
    })
}

#[tauri::command]
pub(crate) async fn embedded_browser_screenshot(
    _app: AppHandle,
    workspace_path: String,
    relative_path: Option<String>,
    selector: Option<String>,
    selector_type: Option<String>,
    format: Option<String>,
    timeout_seconds: Option<u64>,
) -> Result<BrowserPageScreenshotResult, String> {
    let (key, session) = require_session(&workspace_path)?;
    let screenshot_format = parse_browser_screenshot_format(format.as_deref())?;
    let selector_kind = parse_browser_selector_kind(selector_type.as_deref())?;
    let timeout = browser_action_timeout(timeout_seconds);

    // 元素截图降级：滚动到视口中央后截整屏（WKWebView 无 CDP 元素截图能力）。
    if let Some(sel) = selector.as_ref() {
        let scroll_script = js::scroll_into_view_script(sel, selector_kind.label());
        let scrolled = eval_json(&session.webview, &scroll_script, timeout.min(EVAL_TIMEOUT)).await;
        if let Ok(value) = scrolled {
            if value.get("ok").and_then(|item| item.as_bool()) != Some(true) {
                return Err(extract_error(&value));
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    let bytes =
        screenshot::capture_webview_screenshot(session.webview.clone(), screenshot_format).await?;

    let workspace = codepapr_core::shared::canonical_workspace(&key)?;
    let path = write_browser_binary_file(
        &workspace,
        relative_path,
        default_browser_screenshot_path(screenshot_format)?,
        &bytes,
    )?;
    let (url, title) = state_snapshot(&session);

    Ok(BrowserPageScreenshotResult {
        url,
        title,
        path,
        bytes: bytes.len(),
        format: screenshot_format.label().to_string(),
        selector,
        selector_type: None,
    })
}

#[tauri::command]
pub(crate) async fn embedded_browser_close(
    _app: AppHandle,
    workspace_path: String,
) -> Result<BrowserPageCloseResult, String> {
    let key = workspace_key(&workspace_path)?;
    let Some(session) = remove_session(&key) else {
        return Ok(BrowserPageCloseResult {
            workspace_path: key,
            closed: false,
        });
    };
    let _ = session.webview.close();
    Ok(BrowserPageCloseResult {
        workspace_path: key,
        closed: true,
    })
}

#[tauri::command]
pub(crate) async fn embedded_browser_get_state(
    _app: AppHandle,
    workspace_path: String,
) -> Result<serde_json::Value, String> {
    let key = workspace_key(&workspace_path)?;
    let Some(session) = get_session(&key) else {
        return Ok(json!({ "active": false }));
    };
    // 优先读页面实时状态（SPA 路由变化不触发 page load 事件），失败回退缓存状态。
    let mut url_title = state_snapshot(&session);
    if let Ok(live) = eval_json(&session.webview, js::STATE_SCRIPT, Duration::from_secs(3)).await {
        if let Some((url, title)) = state_from_result(&live) {
            url_title = (url, title);
        }
    }
    Ok(json!({
        "active": true,
        "url": url_title.0,
        "title": url_title.1,
        "workspacePath": session.workspace_path,
        "startedAt": session.started_at,
    }))
}

#[tauri::command]
pub(crate) async fn embedded_browser_set_bounds(
    _app: AppHandle,
    workspace_path: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let (_, session) = require_session(&workspace_path)?;
    if width <= 0.0 || height <= 0.0 {
        return Err("内置浏览器面板尺寸必须为正数".to_string());
    }
    session
        .webview
        .set_bounds(tauri::Rect {
            position: LogicalPosition::new(x, y).into(),
            size: LogicalSize::new(width, height).into(),
        })
        .map_err(|err| format!("调整内置浏览器位置失败: {err}"))
}

#[tauri::command]
pub(crate) async fn embedded_browser_show(
    _app: AppHandle,
    workspace_path: String,
) -> Result<(), String> {
    let (_, session) = require_session(&workspace_path)?;
    session
        .webview
        .show()
        .map_err(|err| format!("显示内置浏览器失败: {err}"))
}

#[tauri::command]
pub(crate) async fn embedded_browser_hide(
    _app: AppHandle,
    workspace_path: String,
) -> Result<(), String> {
    let (_, session) = require_session(&workspace_path)?;
    session
        .webview
        .hide()
        .map_err(|err| format!("隐藏内置浏览器失败: {err}"))
}

// ──── 引擎开关 ────

#[tauri::command]
pub(crate) fn set_browser_engine(engine: String) -> Result<(), String> {
    crate::embedded_browser::set_engine_by_label(&engine)
}

#[tauri::command]
pub(crate) fn get_browser_engine() -> Result<String, String> {
    Ok(crate::embedded_browser::engine_label().to_string())
}

// ──── 辅助 ────

fn state_from_result(result: &serde_json::Value) -> Option<(String, String)> {
    let url = result.get("url").and_then(|item| item.as_str())?;
    let title = result
        .get("title")
        .and_then(|item| item.as_str())
        .unwrap_or(url);
    Some((url.to_string(), title.to_string()))
}

fn truncate_dom(content: String) -> (String, bool) {
    if content.len() <= MAX_BROWSER_DOM_BYTES {
        return (content, false);
    }
    let mut end = MAX_BROWSER_DOM_BYTES;
    while !content.is_char_boundary(end) {
        end -= 1;
    }
    (content[..end].to_string(), true)
}
