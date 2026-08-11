use crate::browser::types::{
    BrowserDomContentType, BrowserPageActionResult, BrowserPageCloseResult, BrowserPageDomResult,
    BrowserPageScreenshotResult, BrowserPageSessionResult, BrowserScreenshotFormat,
    BrowserSelectorKind, ManagedBrowserPageSession, OpenBrowserResult,
};
use crate::shared::{
    canonical_workspace, normalize_relative_path, parse_browser_url, relative_string,
    resolve_existing_path, run_blocking_workspace_task, unix_millis,
};
use headless_chrome::{Browser, LaunchOptionsBuilder, Tab};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use std::sync::mpsc;

pub(crate) const MAX_BROWSER_DOM_BYTES: usize = 500_000;
pub(crate) const MAX_BROWSER_SCREENSHOT_BYTES: usize = 25_000_000;
const DEFAULT_BROWSER_TIMEOUT_SECONDS: u64 = 10;
const MAX_BROWSER_TIMEOUT_SECONDS: u64 = 120;

pub(crate) static BROWSER_PAGE_SESSIONS: OnceLock<
    Mutex<HashMap<String, ManagedBrowserPageSession>>,
> = OnceLock::new();

fn browser_page_sessions() -> &'static Mutex<HashMap<String, ManagedBrowserPageSession>> {
    BROWSER_PAGE_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn with_browser_page_sessions<T>(
    handler: impl FnOnce(&mut HashMap<String, ManagedBrowserPageSession>) -> Result<T, String>,
) -> Result<T, String> {
    let mut sessions = browser_page_sessions()
        .lock()
        .map_err(|_| "浏览页会话注册表锁定失败".to_string())?;
    handler(&mut sessions)
}

pub(crate) fn parse_browser_selector_kind(raw: Option<&str>) -> Result<BrowserSelectorKind, String> {
    match raw.unwrap_or("css").trim().to_lowercase().as_str() {
        "css" => Ok(BrowserSelectorKind::Css),
        "xpath" => Ok(BrowserSelectorKind::XPath),
        other => Err(format!("selectorType 只支持 css 或 xpath，当前为 {other}")),
    }
}

pub(crate) fn parse_browser_dom_content_type(raw: Option<&str>) -> Result<BrowserDomContentType, String> {
    match raw.unwrap_or("html").trim().to_lowercase().as_str() {
        "html" => Ok(BrowserDomContentType::Html),
        "text" => Ok(BrowserDomContentType::Text),
        other => Err(format!("contentType 只支持 html 或 text，当前为 {other}")),
    }
}

pub(crate) fn parse_browser_screenshot_format(raw: Option<&str>) -> Result<BrowserScreenshotFormat, String> {
    match raw.unwrap_or("png").trim().to_lowercase().as_str() {
        "png" => Ok(BrowserScreenshotFormat::Png),
        "jpeg" | "jpg" => Ok(BrowserScreenshotFormat::Jpeg),
        other => Err(format!("format 只支持 png 或 jpeg，当前为 {other}")),
    }
}

pub(crate) fn browser_action_timeout(timeout_seconds: Option<u64>) -> Duration {
    Duration::from_secs(
        timeout_seconds
            .unwrap_or(DEFAULT_BROWSER_TIMEOUT_SECONDS)
            .clamp(1, MAX_BROWSER_TIMEOUT_SECONDS),
    )
}

fn capture_screenshot_with_timeout(
    timeout: Duration,
    tab: Arc<Tab>,
    selector: Option<String>,
    selector_kind: BrowserSelectorKind,
    screenshot_format: BrowserScreenshotFormat,
) -> Result<Vec<u8>, String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let result = (|| {
            if let Some(sel) = selector.as_ref() {
                let el = find_browser_element(&tab, sel, selector_kind, timeout)?;
                el.capture_screenshot(screenshot_format.capture_format())
                    .map_err(|err| format!("截取页面元素截图失败: {err}"))
            } else {
                tab.capture_screenshot(
                    screenshot_format.capture_format(),
                    if matches!(screenshot_format, BrowserScreenshotFormat::Jpeg) {
                        Some(85)
                    } else {
                        None
                    },
                    None,
                    true,
                )
                .map_err(|err| format!("截取页面截图失败: {err}"))
            }
        })();
        let _ = tx.send(result);
    });
    rx.recv_timeout(timeout)
        .map_err(|_| format!("截图超时（最长 {} 秒），页面可能过于复杂", timeout.as_secs()))?
}

fn build_browser_launch_options() -> Result<headless_chrome::LaunchOptions<'static>, String> {
    let mut builder = LaunchOptionsBuilder::default();
    builder
        .headless(false)
        .enable_gpu(true)
        .enable_logging(false)
        .window_size(Some((1440, 900)))
        .idle_browser_timeout(Duration::from_secs(120))
        .args(vec![
            std::ffi::OsStr::new("--headless=new"),
            std::ffi::OsStr::new("--enable-webgl"),
            std::ffi::OsStr::new("--ignore-gpu-blocklist"),
        ]);

    builder
        .build()
        .map_err(|err| format!("构建浏览器启动参数失败: {err}"))
}

fn browser_page_state(
    session: &ManagedBrowserPageSession,
) -> Result<BrowserPageSessionResult, String> {
    let url = session.tab.get_url();
    let title = session.tab.get_title().unwrap_or_else(|_| url.clone());

    Ok(BrowserPageSessionResult {
        url,
        title,
        workspace_path: session.workspace_path.clone(),
        started_at: session.started_at,
        active: true,
    })
}

fn navigate_browser_tab(tab: &Arc<Tab>, url: &str) -> Result<(), String> {
    tab.navigate_to(url)
        .map_err(|err| format!("浏览器页面跳转失败: {err}"))?
        .wait_until_navigated()
        .map_err(|err| format!("等待页面完成跳转失败: {err}"))?;
    Ok(())
}

fn reload_browser_tab(tab: &Arc<Tab>) -> Result<(), String> {
    tab.reload(false, None)
        .map_err(|err| format!("浏览器页面刷新失败: {err}"))?
        .wait_until_navigated()
        .map_err(|err| format!("等待页面刷新完成失败: {err}"))?;
    Ok(())
}

fn is_browser_connection_closed(err: &str) -> bool {
    err.contains("underlying connection is closed")
        || err.contains("Unable to make method calls")
        || err.contains("connection is closed")
}

fn find_browser_element<'a>(
    tab: &'a Tab,
    selector: &str,
    selector_kind: BrowserSelectorKind,
    timeout: Duration,
) -> Result<headless_chrome::browser::tab::element::Element<'a>, String> {
    match selector_kind {
        BrowserSelectorKind::Css => tab
            .wait_for_element_with_custom_timeout(selector, timeout)
            .map_err(|err| format!("查找页面元素失败: {err}")),
        BrowserSelectorKind::XPath => tab
            .wait_for_xpath_with_custom_timeout(selector, timeout)
            .map_err(|err| format!("查找页面元素失败: {err}")),
    }
}

fn browser_page_action_result(
    action: &str,
    session: &ManagedBrowserPageSession,
    selector: Option<String>,
    selector_kind: Option<BrowserSelectorKind>,
) -> Result<BrowserPageActionResult, String> {
    let state = browser_page_state(session)?;
    Ok(BrowserPageActionResult {
        action: action.to_string(),
        url: state.url,
        title: state.title,
        selector,
        selector_type: selector_kind.map(|kind| kind.label().to_string()),
    })
}

fn browser_workspace_key(workspace_path: &str) -> Result<String, String> {
    Ok(canonical_workspace(workspace_path)?
        .to_string_lossy()
        .to_string())
}

fn truncate_browser_dom(content: String) -> (String, bool) {
    if content.len() <= MAX_BROWSER_DOM_BYTES {
        return (content, false);
    }

    let mut end = MAX_BROWSER_DOM_BYTES;
    while !content.is_char_boundary(end) {
        end -= 1;
    }

    (content[..end].to_string(), true)
}

pub(crate) fn default_browser_screenshot_path(format: BrowserScreenshotFormat) -> Result<PathBuf, String> {
    Ok(PathBuf::from(format!(
        ".CodePapr/browser/browser-{}.{}",
        unix_millis()?,
        format.extension()
    )))
}

pub(crate) fn write_browser_binary_file(
    workspace: &Path,
    relative_path: Option<String>,
    default_path: PathBuf,
    bytes: &[u8],
) -> Result<String, String> {
    if bytes.len() > MAX_BROWSER_SCREENSHOT_BYTES {
        return Err(format!(
            "浏览器输出文件超过上限 {MAX_BROWSER_SCREENSHOT_BYTES} bytes"
        ));
    }

    let normalized_path = if let Some(path) = relative_path {
        normalize_relative_path(Some(&path))?
    } else {
        default_path
    };
    if normalized_path.as_os_str().is_empty() {
        return Err("relativePath 不能为空".to_string());
    }

    let target = workspace.join(&normalized_path);
    let parent = target
        .parent()
        .ok_or_else(|| "无法确定浏览器输出目录".to_string())?;
    fs::create_dir_all(parent).map_err(|err| format!("创建浏览器输出目录失败: {err}"))?;
    let canonical_parent =
        fs::canonicalize(parent).map_err(|err| format!("无法访问浏览器输出目录: {err}"))?;
    if !canonical_parent.starts_with(workspace) {
        return Err("拒绝写入项目文件夹之外的路径".to_string());
    }

    // 父目录校验不能覆盖"目标本身是 symlink"的逃逸：写入走拒绝符号链接的闸门
    crate::shared::write_file_rejecting_symlink(&target, workspace, bytes)?;
    Ok(relative_string(workspace, &target))
}

fn open_target_in_browser(target: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(target)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|err| format!("打开浏览器失败: {err}"))?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        Command::new("cmd")
            .args(["/C", "start", "", target])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|err| format!("打开浏览器失败: {err}"))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(target)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|err| format!("打开浏览器失败: {err}"))?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("当前平台暂不支持打开浏览器".to_string())
}

fn launch_browser_page_session(
    sessions: &mut HashMap<String, ManagedBrowserPageSession>,
    workspace_key: &str,
    parsed_url: &str,
) -> Result<BrowserPageSessionResult, String> {
    let browser = Browser::new(build_browser_launch_options()?)
        .map_err(|err| format!("启动浏览器自动化会话失败: {err}"))?;
    let tab = browser
        .new_tab()
        .map_err(|err| format!("创建浏览器页面失败: {err}"))?;
    tab.set_default_timeout(browser_action_timeout(None));
    navigate_browser_tab(&tab, parsed_url)?;

    let session = ManagedBrowserPageSession {
        _browser: browser,
        tab,
        workspace_path: workspace_key.to_string(),
        started_at: unix_millis()?,
    };
    let result = browser_page_state(&session)?;
    sessions.insert(workspace_key.to_string(), session);
    Ok(result)
}

fn open_or_navigate_browser_page_session(
    workspace_path: &str,
    url: &str,
) -> Result<BrowserPageSessionResult, String> {
    let workspace_key = browser_workspace_key(workspace_path)?;
    let parsed_url = parse_browser_url(url)?;

    with_browser_page_sessions(|sessions| {
        let mut needs_relaunch = false;
        if let Some(session) = sessions.get_mut(&workspace_key) {
            match navigate_browser_tab(&session.tab, &parsed_url) {
                Ok(()) => return browser_page_state(session),
                Err(err) if is_browser_connection_closed(&err) => {
                    needs_relaunch = true;
                }
                Err(err) => return Err(err),
            }
        }
        if needs_relaunch {
            if let Some(stale) = sessions.remove(&workspace_key) {
                let _ = stale.tab.close(true);
            }
        }
        launch_browser_page_session(sessions, &workspace_key, &parsed_url)
    })
}

#[tauri::command]
pub(crate) fn open_browser_target(
    workspace_path: String,
    url: Option<String>,
    relative_path: Option<String>,
) -> Result<OpenBrowserResult, String> {
    if let Some(raw_url) = url {
        let parsed = parse_browser_url(&raw_url)?;
        open_target_in_browser(&parsed)?;
        return Ok(OpenBrowserResult {
            target: parsed,
            kind: "url".to_string(),
        });
    }

    if let Some(raw_relative_path) = relative_path {
        let (workspace, path) = resolve_existing_path(&workspace_path, Some(&raw_relative_path))?;
        if !path.is_file() {
            return Err("relativePath 必须指向项目内文件".to_string());
        }

        let open_target = path.to_string_lossy().to_string();
        open_target_in_browser(&open_target)?;
        return Ok(OpenBrowserResult {
            target: relative_string(&workspace, &path),
            kind: "file".to_string(),
        });
    }

    Err("url 和 relativePath 至少需要提供一个".to_string())
}

#[tauri::command]
pub(crate) async fn open_browser_page(
    app: tauri::AppHandle,
    workspace_path: String,
    url: String,
) -> Result<BrowserPageSessionResult, String> {
    if crate::embedded_browser::is_embedded_engine() {
        return crate::embedded_browser::page::embedded_browser_open(app, workspace_path, url).await;
    }
    run_blocking_workspace_task(move || {
        open_or_navigate_browser_page_session(&workspace_path, &url)
    }).await
}

#[tauri::command]
pub(crate) async fn navigate_browser_page(
    app: tauri::AppHandle,
    workspace_path: String,
    url: String,
) -> Result<BrowserPageSessionResult, String> {
    if crate::embedded_browser::is_embedded_engine() {
        return crate::embedded_browser::page::embedded_browser_navigate(app, workspace_path, url).await;
    }
    run_blocking_workspace_task(move || {
        open_or_navigate_browser_page_session(&workspace_path, &url)
    }).await
}

#[tauri::command]
pub(crate) async fn reload_browser_page(
    app: tauri::AppHandle,
    workspace_path: String,
) -> Result<BrowserPageSessionResult, String> {
    if crate::embedded_browser::is_embedded_engine() {
        return crate::embedded_browser::page::embedded_browser_reload(app, workspace_path).await;
    }
    run_blocking_workspace_task(move || {
        let workspace_key = browser_workspace_key(&workspace_path)?;

        with_browser_page_sessions(|sessions| {
            let session = sessions
                .get_mut(&workspace_key)
                .ok_or_else(|| "当前工作区没有活动中的浏览页会话，请先打开页面。".to_string())?;

            reload_browser_tab(&session.tab)?;
            browser_page_state(session)
        })
    }).await
}

#[tauri::command]
pub(crate) async fn click_browser_page_element(
    app: tauri::AppHandle,
    workspace_path: String,
    selector: String,
    selector_type: Option<String>,
    wait_for_navigation: Option<bool>,
    timeout_seconds: Option<u64>,
) -> Result<BrowserPageActionResult, String> {
    if crate::embedded_browser::is_embedded_engine() {
        return crate::embedded_browser::page::embedded_browser_click(
            app, workspace_path, selector, selector_type, wait_for_navigation, timeout_seconds,
        ).await;
    }
    run_blocking_workspace_task(move || {
        let workspace_key = browser_workspace_key(&workspace_path)?;
        let selector_kind = parse_browser_selector_kind(selector_type.as_deref())?;
        let timeout = browser_action_timeout(timeout_seconds);

        with_browser_page_sessions(|sessions| {
            let session = sessions
                .get_mut(&workspace_key)
                .ok_or_else(|| "当前工作区没有活动中的浏览页会话，请先打开页面。".to_string())?;

            let element =
                find_browser_element(session.tab.as_ref(), &selector, selector_kind, timeout)?;
            element
                .scroll_into_view()
                .map_err(|err| format!("滚动到页面元素失败: {err}"))?;
            element
                .click()
                .map_err(|err| format!("点击页面元素失败: {err}"))?;

            if wait_for_navigation.unwrap_or(false) {
                session
                    .tab
                    .wait_until_navigated()
                    .map_err(|err| format!("等待页面完成跳转失败: {err}"))?;
            }

            browser_page_action_result("click", session, Some(selector), Some(selector_kind))
        })
    }).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn input_browser_page_text(
    app: tauri::AppHandle,
    workspace_path: String,
    selector: String,
    text: String,
    selector_type: Option<String>,
    clear: Option<bool>,
    submit: Option<bool>,
    wait_for_navigation: Option<bool>,
    timeout_seconds: Option<u64>,
) -> Result<BrowserPageActionResult, String> {
    if crate::embedded_browser::is_embedded_engine() {
        return crate::embedded_browser::page::embedded_browser_input(
            app, workspace_path, selector, text, selector_type, clear, submit,
            wait_for_navigation, timeout_seconds,
        ).await;
    }
    run_blocking_workspace_task(move || {
        let workspace_key = browser_workspace_key(&workspace_path)?;
        let selector_kind = parse_browser_selector_kind(selector_type.as_deref())?;
        let timeout = browser_action_timeout(timeout_seconds);

        with_browser_page_sessions(|sessions| {
            let session = sessions
                .get_mut(&workspace_key)
                .ok_or_else(|| "当前工作区没有活动中的浏览页会话，请先打开页面。".to_string())?;

            let element =
                find_browser_element(session.tab.as_ref(), &selector, selector_kind, timeout)?;
            element
                .scroll_into_view()
                .map_err(|err| format!("滚动到输入元素失败: {err}"))?;
            if clear.unwrap_or(true) {
                let _ = element.call_js_fn(
                    r#"
                    function clearInputValue() {
                        if ('value' in this) {
                            this.value = '';
                            this.dispatchEvent(new Event('input', { bubbles: true }));
                            this.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                        return true;
                    }
                    "#,
                    vec![],
                    false,
                );
            }
            element
                .click()
                .map_err(|err| format!("聚焦输入元素失败: {err}"))?;
            element
                .type_into(&text)
                .map_err(|err| format!("向页面输入文本失败: {err}"))?;

            if submit.unwrap_or(false) {
                session
                    .tab
                    .press_key("Enter")
                    .map_err(|err| format!("提交页面输入失败: {err}"))?;
            }
            if wait_for_navigation.unwrap_or(false) {
                session
                    .tab
                    .wait_until_navigated()
                    .map_err(|err| format!("等待页面完成跳转失败: {err}"))?;
            }

            browser_page_action_result("input", session, Some(selector), Some(selector_kind))
        })
    }).await
}

#[tauri::command]
pub(crate) async fn read_browser_page_dom(
    app: tauri::AppHandle,
    workspace_path: String,
    selector: Option<String>,
    selector_type: Option<String>,
    content_type: Option<String>,
    timeout_seconds: Option<u64>,
) -> Result<BrowserPageDomResult, String> {
    if crate::embedded_browser::is_embedded_engine() {
        return crate::embedded_browser::page::embedded_browser_read_dom(
            app, workspace_path, selector, selector_type, content_type, timeout_seconds,
        ).await;
    }
    run_blocking_workspace_task(move || {
        let workspace_key = browser_workspace_key(&workspace_path)?;
        let timeout = browser_action_timeout(timeout_seconds);
        let selector_kind = parse_browser_selector_kind(selector_type.as_deref())?;
        let dom_content_type = parse_browser_dom_content_type(content_type.as_deref())?;

        with_browser_page_sessions(|sessions| {
            let session = sessions
                .get_mut(&workspace_key)
                .ok_or_else(|| "当前工作区没有活动中的浏览页会话，请先打开页面。".to_string())?;

            let content = if let Some(selector) = selector.as_ref() {
                let element =
                    find_browser_element(session.tab.as_ref(), selector, selector_kind, timeout)?;
                match dom_content_type {
                    BrowserDomContentType::Html => element
                        .get_content()
                        .map_err(|err| format!("读取页面元素 HTML 失败: {err}"))?,
                    BrowserDomContentType::Text => element
                        .get_inner_text()
                        .map_err(|err| format!("读取页面元素文本失败: {err}"))?,
                }
            } else {
                match dom_content_type {
                    BrowserDomContentType::Html => session
                        .tab
                        .get_content()
                        .map_err(|err| format!("读取页面 HTML 失败: {err}"))?,
                    BrowserDomContentType::Text => {
                        let remote = session
                            .tab
                            .evaluate(
                                "document.body ? document.body.innerText : (document.documentElement ? document.documentElement.innerText : '')",
                                false,
                            )
                            .map_err(|err| format!("读取页面文本失败: {err}"))?;
                        remote
                            .value
                            .map(|value| match value {
                                serde_json::Value::String(text) => text,
                                other => other.to_string(),
                            })
                            .unwrap_or_default()
                    }
                }
            };

            let (content, truncated) = truncate_browser_dom(content);
            let state = browser_page_state(session)?;
            let has_selector = selector.is_some();

            Ok(BrowserPageDomResult {
                url: state.url,
                title: state.title,
                selector,
                selector_type: if has_selector {
                    Some(selector_kind.label().to_string())
                } else {
                    None
                },
                content_type: dom_content_type.label().to_string(),
                content,
                truncated,
            })
        })
    }).await
}

#[tauri::command]
pub(crate) async fn screenshot_browser_page(
    app: tauri::AppHandle,
    workspace_path: String,
    relative_path: Option<String>,
    selector: Option<String>,
    selector_type: Option<String>,
    format: Option<String>,
    timeout_seconds: Option<u64>,
) -> Result<BrowserPageScreenshotResult, String> {
    if crate::embedded_browser::is_embedded_engine() {
        return crate::embedded_browser::page::embedded_browser_screenshot(
            app, workspace_path, relative_path, selector, selector_type, format, timeout_seconds,
        ).await;
    }
    run_blocking_workspace_task(move || {
        let workspace = canonical_workspace(&workspace_path)?;
        let workspace_key = workspace.to_string_lossy().to_string();
        let screenshot_format = parse_browser_screenshot_format(format.as_deref())?;
        let timeout = browser_action_timeout(timeout_seconds);
        let selector_kind = parse_browser_selector_kind(selector_type.as_deref())?;

        with_browser_page_sessions(|sessions| {
            let session = sessions
                .get_mut(&workspace_key)
                .ok_or_else(|| "当前工作区没有活动中的浏览页会话，请先打开页面。".to_string())?;

            let has_selector = selector.is_some();
            let selector_for_result = selector.clone();
            let tab = Arc::clone(&session.tab);
            let bytes = capture_screenshot_with_timeout(
                timeout,
                tab,
                selector,
                selector_kind,
                screenshot_format,
            )?;

            let path = write_browser_binary_file(
                &workspace,
                relative_path,
                default_browser_screenshot_path(screenshot_format)?,
                &bytes,
            )?;
            let state = browser_page_state(session)?;

            Ok(BrowserPageScreenshotResult {
                url: state.url,
                title: state.title,
                path,
                bytes: bytes.len(),
                format: screenshot_format.label().to_string(),
                selector: selector_for_result,
                selector_type: if has_selector {
                    Some(selector_kind.label().to_string())
                } else {
                    None
                },
            })
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn close_browser_page(app: tauri::AppHandle, workspace_path: String) -> Result<BrowserPageCloseResult, String> {
    if crate::embedded_browser::is_embedded_engine() {
        return crate::embedded_browser::page::embedded_browser_close(app, workspace_path).await;
    }
    run_blocking_workspace_task(move || {
        let workspace_key = browser_workspace_key(&workspace_path)?;

        with_browser_page_sessions(|sessions| {
            let Some(session) = sessions.remove(&workspace_key) else {
                return Ok(BrowserPageCloseResult {
                    workspace_path: workspace_key,
                    closed: false,
                });
            };

            let _ = session.tab.close(true);

            Ok(BrowserPageCloseResult {
                workspace_path: workspace_key,
                closed: true,
            })
        })
    }).await
}

pub(crate) fn close_all_browser_pages() {
    let Ok(mut sessions) = browser_page_sessions().lock() else { return };
    let pids: Vec<u32> = sessions
        .values()
        .filter_map(|s| s._browser.get_process_id())
        .collect();
    // 只按 PID 强杀 Chrome，不做任何 CDP 往返：`tab.close()` 是 CDP 调用，
    // idle_browser_timeout 高达 120s——Chrome 挂死时会在主线程（或退出线程）
    // 阻塞两分钟，拖死应用退出链路。会话注册表直接清空（drop 触发
    // BrowserInner::drop 的 close_on_drop，但它内部同样是 try/ok 尽力而为）。
    for pid in &pids {
        // 整组/整树杀：只 SIGTERM 主进程会让 renderer/gpu/网络等子进程
        // 变成孤儿继续存活，长期占用资源与端口。
        crate::shell::process_tree::kill_process_group_by_pid(*pid);
    }
    sessions.clear();
}
