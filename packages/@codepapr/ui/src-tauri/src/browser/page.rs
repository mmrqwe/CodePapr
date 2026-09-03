use crate::browser::types::{
    BrowserDomContentType, BrowserPageActionResult, BrowserPageCloseResult, BrowserPageDomResult,
    BrowserPageScreenshotResult, BrowserPageSessionResult, BrowserScreenshotFormat,
    BrowserSelectorKind, ManagedBrowserPageSession, OpenBrowserResult,
};
use codepapr_core::shared::{
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
    time::{Duration, Instant},
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
            // Chrome 137+ 默认禁用了 SwiftShader 回退：headless（无 GPU 设备 /
            // 远程会话）下 WebGL 上下文直接拿不到，页面 JS 崩溃或 GPU 进程
            // 挂死，表现为等待导航超时 + 会话失联。允许不安全的软件 GL，
            // 保证 WebGL/c2d 双模式渲染对比可自动化。
            std::ffi::OsStr::new("--enable-unsafe-swiftshader"),
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
        navigation_warning: None,
    })
}

const NAVIGATION_SETTLE_GRACE: Duration = Duration::from_secs(3);

/// 探活 tab：能读到 document.readyState 即页面对象仍可用。
fn tab_ready_state(tab: &Arc<Tab>) -> Option<String> {
    tab.evaluate("function () { return document.readyState; }", false)
        .ok()
        .and_then(|object| object.value)
        .and_then(|value| value.as_str().map(str::to_string))
}

/// 等 load 事件超时后的降级判定：宽限期内轮询 readyState。headless WebGL 页
/// 常因 GPU 初始化/着色器编译拖住 load 事件，但 DOM 早已可用——旧实现在 10s
/// 后硬失败，还会把会话留在半死状态（后续命令全挂）。现在只要页面能响应
/// 探测就返回警告文本（Ok(Some)），彻底失联（renderer 崩溃/会话断开）才 Err。
fn wait_navigation_settled(tab: &Arc<Tab>, wait_err: &str) -> Result<Option<String>, String> {
    let deadline = Instant::now() + NAVIGATION_SETTLE_GRACE;
    let mut last: Option<String> = None;
    loop {
        last = tab_ready_state(tab).or(last);
        if let Some(state) = &last {
            if state != "loading" {
                return Ok(Some(format!(
                    "等待页面加载超时（{wait_err}）；document.readyState={state}，页面已可交互，DOM/截图可用。需要更完整的加载可加大 timeoutSeconds 或 reload 重试"
                )));
            }
        }
        if Instant::now() >= deadline {
            return match last {
                Some(state) => Ok(Some(format!(
                    "等待页面加载超时（{wait_err}）；document.readyState={state}（仍在加载），DOM/截图可用。建议加大 timeoutSeconds 后 reload"
                ))),
                None => Err(wait_err.to_string()),
            };
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn navigate_browser_tab(tab: &Arc<Tab>, url: &str) -> Result<Option<String>, String> {
    match tab
        .navigate_to(url)
        .map_err(|err| format!("浏览器页面跳转失败: {err}"))?
        .wait_until_navigated()
    {
        Ok(_) => Ok(None),
        Err(err) => wait_navigation_settled(tab, &format!("等待页面完成跳转失败: {err}")),
    }
}

fn reload_browser_tab(tab: &Arc<Tab>) -> Result<Option<String>, String> {
    match tab
        .reload(false, None)
        .map_err(|err| format!("浏览器页面刷新失败: {err}"))?
        .wait_until_navigated()
    {
        Ok(_) => Ok(None),
        Err(err) => wait_navigation_settled(tab, &format!("等待页面刷新完成失败: {err}")),
    }
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
    navigation_warning: Option<String>,
) -> Result<BrowserPageActionResult, String> {
    let state = browser_page_state(session)?;
    Ok(BrowserPageActionResult {
        action: action.to_string(),
        url: state.url,
        title: state.title,
        selector,
        selector_type: selector_kind.map(|kind| kind.label().to_string()),
        navigation_warning,
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
    // 存进 `.CodePapr/screenshots`（三级闸门的草稿前缀）而不是 `.CodePapr/browser`
    //（运行时私有）：Agent 截图后要能 read_image / bash 直接读，无需另指路径。
    Ok(PathBuf::from(format!(
        ".CodePapr/screenshots/browser-{}.{}",
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
    codepapr_core::shared::write_file_rejecting_symlink(&target, workspace, bytes)?;
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
    timeout_seconds: Option<u64>,
) -> Result<BrowserPageSessionResult, String> {
    let browser = Browser::new(build_browser_launch_options()?)
        .map_err(|err| format!("启动浏览器自动化会话失败: {err}"))?;
    let tab = browser
        .new_tab()
        .map_err(|err| format!("创建浏览器页面失败: {err}"))?;
    tab.set_default_timeout(browser_action_timeout(timeout_seconds));
    let warning = navigate_browser_tab(&tab, parsed_url)?;

    let session = ManagedBrowserPageSession {
        _browser: browser,
        tab,
        workspace_path: workspace_key.to_string(),
        started_at: unix_millis()?,
    };
    let mut result = browser_page_state(&session)?;
    result.navigation_warning = warning;
    sessions.insert(workspace_key.to_string(), session);
    Ok(result)
}

fn open_or_navigate_browser_page_session(
    workspace_path: &str,
    url: &str,
    timeout_seconds: Option<u64>,
) -> Result<BrowserPageSessionResult, String> {
    let workspace_key = browser_workspace_key(workspace_path)?;
    let parsed_url = parse_browser_url(url)?;
    let timeout = browser_action_timeout(timeout_seconds);

    with_browser_page_sessions(|sessions| {
        let mut failed_navigation: Option<String> = None;
        if let Some(session) = sessions.get_mut(&workspace_key) {
            session.tab.set_default_timeout(timeout);
            match navigate_browser_tab(&session.tab, &parsed_url) {
                Ok(warning) => {
                    let mut state = browser_page_state(session)?;
                    state.navigation_warning = warning;
                    return Ok(state);
                }
                Err(err) => {
                    // 导航硬失败意味着 tab 已失联（renderer 崩溃、会话断开）：
                    // 保留僵尸会话只会让后续每个命令都失败，探活重建一次。
                    failed_navigation = Some(err);
                }
            }
        }
        if failed_navigation.is_some() {
            if let Some(stale) = sessions.remove(&workspace_key) {
                let _ = stale.tab.close(true);
            }
        }
        match launch_browser_page_session(sessions, &workspace_key, &parsed_url, Some(timeout.as_secs())) {
            Ok(mut result) => {
                if let Some(original) = failed_navigation {
                    result.navigation_warning = Some(match result.navigation_warning.take() {
                        Some(existing) => format!("原会话导航失败（{original}），已重建浏览会话；{existing}"),
                        None => format!("原会话导航失败（{original}），已重建浏览会话"),
                    });
                }
                Ok(result)
            }
            Err(relaunch_err) => Err(match failed_navigation {
                Some(original) => format!("{relaunch_err}（且原会话导航失败：{original}）"),
                None => relaunch_err,
            }),
        }
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
    timeout_seconds: Option<u64>,
) -> Result<BrowserPageSessionResult, String> {
    if crate::embedded_browser::is_embedded_engine() {
        return crate::embedded_browser::page::embedded_browser_open(app, workspace_path, url).await;
    }
    run_blocking_workspace_task(move || {
        open_or_navigate_browser_page_session(&workspace_path, &url, timeout_seconds)
    }).await
}

#[tauri::command]
pub(crate) async fn navigate_browser_page(
    app: tauri::AppHandle,
    workspace_path: String,
    url: String,
    timeout_seconds: Option<u64>,
) -> Result<BrowserPageSessionResult, String> {
    if crate::embedded_browser::is_embedded_engine() {
        return crate::embedded_browser::page::embedded_browser_navigate(app, workspace_path, url).await;
    }
    run_blocking_workspace_task(move || {
        open_or_navigate_browser_page_session(&workspace_path, &url, timeout_seconds)
    }).await
}

/// `browser(get)` 的真实状态来源：headless 引擎的页会话存于本进程注册表，
/// 与前端 previewStore（预览面板会话）是两回事。此前 get 只读 previewStore，
/// 导航失败后 agent 看到的是「会话为空」而真实会话（含死 tab）仍在，无从判断。
#[tauri::command]
pub(crate) async fn get_browser_page_state(
    workspace_path: String,
) -> Result<Option<BrowserPageSessionResult>, String> {
    if crate::embedded_browser::is_embedded_engine() {
        return crate::embedded_browser::page::embedded_browser_session_state(workspace_path);
    }
    run_blocking_workspace_task(move || {
        let workspace_key = browser_workspace_key(&workspace_path)?;
        with_browser_page_sessions(|sessions| {
            match sessions.get_mut(&workspace_key) {
                Some(session) => Ok(Some(browser_page_state(session)?)),
                None => Ok(None),
            }
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn reload_browser_page(
    app: tauri::AppHandle,
    workspace_path: String,
    timeout_seconds: Option<u64>,
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

            session.tab.set_default_timeout(browser_action_timeout(timeout_seconds));
            let warning = reload_browser_tab(&session.tab)?;
            let mut state = browser_page_state(session)?;
            state.navigation_warning = warning;
            Ok(state)
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

            let mut navigation_warning = None;
            if wait_for_navigation.unwrap_or(false) {
                match session.tab.wait_until_navigated() {
                    Ok(_) => {}
                    Err(err) => {
                        navigation_warning = wait_navigation_settled(
                            &session.tab,
                            &format!("等待页面完成跳转失败: {err}"),
                        )?;
                    }
                }
            }

            browser_page_action_result("click", session, Some(selector), Some(selector_kind), navigation_warning)
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
            let mut navigation_warning = None;
            if wait_for_navigation.unwrap_or(false) {
                match session.tab.wait_until_navigated() {
                    Ok(_) => {}
                    Err(err) => {
                        navigation_warning = wait_navigation_settled(
                            &session.tab,
                            &format!("等待页面完成跳转失败: {err}"),
                        )?;
                    }
                }
            }

            browser_page_action_result("input", session, Some(selector), Some(selector_kind), navigation_warning)
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
        codepapr_core::shell::process_tree::kill_process_group_by_pid(*pid);
    }
    sessions.clear();
}
