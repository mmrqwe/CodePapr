use std::{
    collections::HashMap,
    fs,
    sync::{Mutex, OnceLock},
};

use serde::Serialize;
use tauri::{
    http::{header::HeaderValue, Request, Response, StatusCode},
    UriSchemeContext,
};

use crate::papr_runtime;

static APP_WORKSPACES: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn app_workspaces() -> &'static Mutex<HashMap<String, String>> {
    APP_WORKSPACES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Build a plain HTTP response with the given status and body. Status codes
/// and the CORS header are static constants, so response construction
/// cannot fail.
fn resp(status: StatusCode, body: impl Into<Vec<u8>>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .body(body.into())
        .expect("static status code and header values cannot fail")
}

/// app_id 会被拼进文件服务路径（.CodePapr/apps/<app_id>/...）：拒绝一切
/// 路径形态的 id（"..", 分隔符等），防止注册出能服务 .CodePapr 内部文件
/// （如 project.sqlite）的「应用」。
fn is_valid_app_id(app_id: &str) -> bool {
    !app_id.is_empty()
        && app_id.len() <= 128
        && app_id != "."
        && app_id != ".."
        && !app_id.contains("..")
        && !app_id.contains('/')
        && !app_id.contains('\\')
}

/// papr.db 的 SQLite 文件（db.sqlite 及其 -wal/-shm 边车）不对外提供静态服务。
fn is_unservable_app_file(file_path: &str) -> bool {
    let lower = file_path.to_ascii_lowercase();
    lower.ends_with(".sqlite") || lower.ends_with(".sqlite-wal") || lower.ends_with(".sqlite-shm")
}

#[tauri::command]
pub fn register_app_workspace(app_id: String, workspace_path: String) {
    if !is_valid_app_id(&app_id) {
        return;
    }
    let mut map = app_workspaces().lock().unwrap_or_else(|e| e.into_inner());
    map.insert(app_id.clone(), workspace_path.clone());
    papr_runtime::app_context::register(&app_id, &workspace_path);
}

#[tauri::command]
pub fn unregister_app_workspace(app_id: String) {
    let mut map = app_workspaces().lock().unwrap_or_else(|e| e.into_inner());
    map.remove(&app_id);
    papr_runtime::app_context::unregister(&app_id);
    papr_runtime::manifest::clear_manifest(&app_id);
}

#[tauri::command]
pub fn check_port_available(port: u16) -> Result<bool, String> {
    // IPv4/IPv6 都探测：node 可能监听 :: 双栈，也可能只监听其一。
    let occupied = port_has_listener(("127.0.0.1", port)) || port_has_listener(("::1", port));
    Ok(!occupied)
}

/// 探测端口是否有服务：用 connect 而非 bind。
/// Rust std 的 TcpListener::bind 默认设 SO_REUSEADDR，macOS/BSD 下对同样
/// 带 REUSEADDR 的监听 socket（node/libuv 默认开启）绑定会成功 → 永远误判
/// 「端口空闲」，曾导致启动验证把活着的后端当死的杀掉。connect 无此语义
/// 陷阱：连得上 = 有监听，拒绝 = 无服务。
fn port_has_listener(addr: (&str, u16)) -> bool {
    use std::net::ToSocketAddrs;
    let Ok(mut addrs) = addr.to_socket_addrs() else {
        return false;
    };
    let Some(sock_addr) = addrs.next() else {
        return false;
    };
    std::net::TcpStream::connect_timeout(&sock_addr, std::time::Duration::from_millis(300)).is_ok()
}

/// 带诊断细节的端口探测：返回每个地址族的 connect 结果（conn=有监听 /
/// refused=无服务 / err:<kind>=其它错误）。供 app 启动轮询落盘勘验。
#[tauri::command]
pub fn check_port_available_detail(port: u16) -> Result<String, String> {
    fn probe(addr: (&str, u16)) -> String {
        use std::net::ToSocketAddrs;
        let Ok(mut addrs) = addr.to_socket_addrs() else {
            return "err:resolve".to_string();
        };
        let Some(sock_addr) = addrs.next() else {
            return "err:resolve".to_string();
        };
        match std::net::TcpStream::connect_timeout(&sock_addr, std::time::Duration::from_millis(300)) {
            Ok(_) => "conn".to_string(),
            Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => "refused".to_string(),
            Err(e) => format!("err:{:?}", e.kind()),
        }
    }
    Ok(format!("v4={} v6={}", probe(("127.0.0.1", port)), probe(("::1", port))))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortProbeResult {
    /// v4/v6 各自是否已有监听（connect 成功即视为被占用）。
    pub(crate) v4: bool,
    pub(crate) v6: bool,
}

/// 结构化端口探测：返回 v4/v6 各自是否有监听，供前端轮询做布尔判定。
/// 与 check_port_available_detail 的唯一区别是结构化返回值——调用方
/// 不应依赖子串解析诊断文本（如 "conn"）推断端口状态。
#[tauri::command]
pub fn check_port_available_structured(port: u16) -> Result<PortProbeResult, String> {
    Ok(PortProbeResult {
        v4: port_has_listener(("127.0.0.1", port)),
        v6: port_has_listener(("::1", port)),
    })
}

/// 端口当前监听进程的 PID 列表（无监听返回空）。用于 app 启动时验证端口
/// 归属：轮询到「端口被监听」≠「我们 spawn 的进程在监听」——外部进程抢占
/// 端口时旧实现照样判「启动成功」，返回死进程 pid；调用方必须核对归属。
#[tauri::command]
pub fn check_port_owner(port: u16) -> Vec<u32> {
    let output = std::process::Command::new("lsof")
        .args(["-ti", &format!(":{port}")])
        .output();
    if let Ok(out) = output {
        if out.status.success() {
            return String::from_utf8_lossy(&out.stdout)
                .lines()
                .filter_map(|line| line.trim().parse::<u32>().ok())
                .collect();
        }
    }
    Vec::new()
}

/// 端口监听者是否属于给定 pid 的进程组。
/// 注意：不能直接比 pid——后端经 sandbox-exec 包装时，注册表里的 pid 是
/// sandbox-exec（进程组组长），真正监听的 node 是组内孙进程。spawn 用
/// process_group(0) 使整棵进程树共享 pgid（== 组长 pid），因此正确判据是
/// 「任一监听进程的 pgid == 给定 pid」。lsof 拿不到（容器/CI）时返回 true
/// 退化为仅存活检查。
#[tauri::command]
pub fn check_port_owned_by(port: u16, pid: u32) -> bool {
    let listeners = check_port_owner(port);
    if listeners.is_empty() {
        return true;
    }
    listeners.iter().any(|listener| {
        // SAFETY: listener 是 lsof 返回的真实进程 pid；getpgid 接受任意 pid
        let pgid = unsafe { libc::getpgid(*listener as libc::pid_t) };
        pgid == pid as libc::pid_t
    })
}

/// 端口监听地址（lsof NAME 列解析出的 host 部分，如 "127.0.0.1"、"*"、
/// "::1"）。沙箱 SBPL 无法限制 bind 地址（`(local ip ...)` 过滤器在本平台
/// 对 bind 无效），回环约束必须在 app_start 启动期强制：`*` 或非回环地址
/// 说明后端把服务暴露到了局域网，启动必须失败并给出明确提示。
#[tauri::command]
pub fn check_port_bind_address(port: u16) -> Vec<String> {
    let output = std::process::Command::new("lsof")
        .args(["-nP", "-i", &format!(":{port}"), "-sTCP:LISTEN"])
        .output();
    if let Ok(out) = output {
        if out.status.success() {
            return parse_lsof_bind_hosts(&String::from_utf8_lossy(&out.stdout));
        }
    }
    Vec::new()
}

fn parse_lsof_bind_hosts(stdout: &str) -> Vec<String> {
    let mut hosts = Vec::new();
    for line in stdout.lines() {
        // NAME 列形如：TCP *:55331 (LISTEN) / TCP 127.0.0.1:8080 (LISTEN)
        // TCP [::1]:8080 (LISTEN) / TCP localhost:8080 (LISTEN)
        // 按 "TCP " 定位（不依赖列数，避免不同 lsof 版本列格式漂移）。
        let Some(tcp_pos) = line.find("TCP ") else {
            continue;
        };
        let rest = &line[tcp_pos + 4..];
        let Some(address) = rest.split_whitespace().next() else {
            continue;
        };
        // 括号 IPv6（[::1]:3456）取括号内；普通形式取首个 ':' 之前
        let host = if let Some(host_start) = address.strip_prefix('[') {
            host_start
                .find(']')
                .map(|end| host_start[..end].to_string())
                .unwrap_or_default()
        } else {
            address.split(':').next().unwrap_or("").to_string()
        };
        if !host.is_empty() {
            hosts.push(host);
        }
    }
    hosts
}

/// 监听地址是否为回环（127.0.0.0/8、::1、localhost）。当前仅由单元测试
/// 校验使用（供未来 app_start 监听地址校验），保留以待接线。
#[allow(dead_code)]
pub(crate) fn is_loopback_bind(host: &str) -> bool {
    host == "localhost" || host == "::1" || host == "127.0.0.1" || host.starts_with("127.")
}

pub fn handle_app_protocol<R: tauri::Runtime>(
    _ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let uri = request.uri().to_string();

    let path = uri
        .strip_prefix("codepapr-app://localhost/")
        .or_else(|| uri.strip_prefix("codepapr-app://"))
        .unwrap_or(&uri);

    let path = path.trim_start_matches('/');

    let serve_sdk = || {
        let mut response = resp(
            StatusCode::OK,
            papr_runtime::sdk_inject::get_sdk_js().as_bytes().to_vec(),
        );
        response.headers_mut().insert(
            "Content-Type",
            HeaderValue::from_static("application/javascript; charset=utf-8"),
        );
        response.headers_mut().insert("Cache-Control", HeaderValue::from_static("no-cache"));
        response
    };

    // Legacy SDK URL with no app id prefix.
    if path == "__papr_sdk.js" {
        return serve_sdk();
    }

    let (app_id, file_path) = match path.split_once('/') {
        Some((id, rest)) if !id.is_empty() => (id, rest),
        _ => {
            return resp(StatusCode::NOT_FOUND, "missing app id".to_string());
        }
    };

    if !is_valid_app_id(app_id) {
        return resp(StatusCode::FORBIDDEN, "invalid app id".to_string());
    }

    let file_path = if file_path.is_empty() { "index.html" } else { file_path };

    // Per-app SDK URL: codepapr-app://<appId>/__papr_sdk.js. The injected
    // <script src="/__papr_sdk.js"> resolves against the app's own origin, so
    // the request carries the appId as the URL host.
    if file_path == "__papr_sdk.js" {
        return serve_sdk();
    }

    if file_path.contains("..") || file_path.contains('\\') {
        return resp(StatusCode::FORBIDDEN, "path traversal blocked".to_string());
    }

    // papr.db 的数据库文件（含 WAL/SHM 边车）是 app 私有状态且可能正在被写入，
    // 不允许通过协议裸 serve。
    if is_unservable_app_file(file_path) {
        return resp(StatusCode::NOT_FOUND, "file not found".to_string());
    }

    let map = app_workspaces().lock().unwrap_or_else(|e| e.into_inner());
    let workspace = match map.get(app_id) {
        Some(ws) => ws.clone(),
        None => {
            return resp(StatusCode::NOT_FOUND, "app not registered".to_string());
        }
    };
    drop(map);

    let app_base = format!("{}/.CodePapr/apps/{}", workspace, app_id);
    let raw_path = format!("{}/{}", app_base, file_path);

    let canonical_base = match std::path::Path::new(&app_base).canonicalize() {
        Ok(p) => p,
        Err(_) => {
            return resp(StatusCode::NOT_FOUND, "app not found".to_string());
        }
    };

    let canonical_path = match std::path::Path::new(&raw_path).canonicalize() {
        Ok(p) => p,
        Err(_) => {
            return resp(StatusCode::NOT_FOUND, "file not found".to_string());
        }
    };

    if !canonical_path.starts_with(&canonical_base) {
        return resp(StatusCode::FORBIDDEN, "path traversal blocked".to_string());
    }

    let content = match fs::read(&canonical_path) {
        Ok(c) => c,
        Err(_) => {
            return resp(StatusCode::NOT_FOUND, "file not found".to_string());
        }
    };

    let mime = if file_path.ends_with(".html") || file_path.ends_with(".htm") {
        "text/html; charset=utf-8"
    } else if file_path.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if file_path.ends_with(".js") || file_path.ends_with(".mjs") {
        "application/javascript; charset=utf-8"
    } else if file_path.ends_with(".json") {
        "application/json; charset=utf-8"
    } else if file_path.ends_with(".svg") {
        "image/svg+xml"
    } else if file_path.ends_with(".png") {
        "image/png"
    } else if file_path.ends_with(".jpg") || file_path.ends_with(".jpeg") {
        "image/jpeg"
    } else if file_path.ends_with(".gif") {
        "image/gif"
    } else if file_path.ends_with(".webp") {
        "image/webp"
    } else if file_path.ends_with(".ico") {
        "image/x-icon"
    } else if file_path.ends_with(".woff2") {
        "font/woff2"
    } else {
        "application/octet-stream"
    };

    // 两轴模型的核心强制点：iframe 直接联网由 CSP 拦截，网络只能走 papr.http
    // （受权限管控）或后端 app 自身的 localhost 服务。CSP 由浏览器引擎执行，
    // JS 无法绕过。CDN 图表库（script-src https:）始终放行——脚本 URL 静态、
    // 且 connect-src/img-src 关闭时外部脚本无法回传数据。
    let csp: Option<String> = if file_path.ends_with(".html") || file_path.ends_with(".htm") {
        papr_runtime::manifest::get_manifest(app_id)
            .ok()
            .map(|m| {
                let access = papr_runtime::permission::resolve_effective_access(&m, app_id);
                build_app_csp(access, m.port)
            })
    } else {
        None
    };

    let body = if file_path.ends_with(".html") || file_path.ends_with(".htm") {
        let html = String::from_utf8_lossy(&content);
        let mut injected = papr_runtime::sdk_inject::inject_sdk_into_html(&html);

        let mut pre_scripts = String::new();
        pre_scripts.push_str("<script>window.__PAPR_PARENT_ORIGIN='tauri://localhost';</script>\n");

        if let Ok(manifest) = papr_runtime::manifest::get_manifest(app_id) {
            if let Some(port) = manifest.port {
                pre_scripts.push_str(&format!(
                    "<script>window.__PAPR_BACKEND_URL='http://localhost:{}';</script>\n",
                    port
                ));
            }
        }

        if let Some(pos) = injected.find("__papr_sdk.js") {
            if let Some(start) = injected[..pos].rfind("<script") {
                injected.insert_str(start, &pre_scripts);
            }
        }

        injected.into_bytes()
    } else {
        content
    };

    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", mime)
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-cache");
    if let Some(csp) = &csp {
        response = response.header("Content-Security-Policy", csp.as_str());
    }
    response
        .body(body)
        .expect("static status code and validated header values cannot fail")
}

/// 按两轴权限构建 app 文档的 CSP：
/// - 网络关：只允许同源 + 自身后端端口（无后端则纯同源），img/form 全禁外发；
/// - 网络开：额外放行 https/wss/ws 与 https 图片/表单；
/// - script-src 始终放行 https:（CDN 图表库），connect-src 关闭时无法回传数据。
pub(crate) fn build_app_csp(
    access: crate::papr_runtime::permission::PaprAccess,
    port: Option<u16>,
) -> String {
    let mut connect: Vec<String> = vec!["'self'".to_string()];
    let mut img: Vec<String> = vec!["'self'".to_string(), "data:".to_string()];
    let mut form: Vec<String> = vec!["'none'".to_string()];
    if let Some(p) = port {
        connect.push(format!("http://localhost:{p}"));
        connect.push(format!("http://127.0.0.1:{p}"));
    }
    if access.network {
        connect.push("https:".to_string());
        connect.push("wss:".to_string());
        connect.push("ws:".to_string());
        img.push("https:".to_string());
        form.push("https:".to_string());
    }
    format!(
        "default-src 'none'; script-src 'self' https: 'unsafe-inline' 'wasm-unsafe-eval'; \
         style-src 'self' 'unsafe-inline' https:; img-src {}; \
         font-src 'self' data: https:; media-src 'self' data: blob:; worker-src 'self' blob:; \
         connect-src {}; form-action {}",
        img.join(" "),
        connect.join(" "),
        form.join(" ")
    )
}

// ── App discovery ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct DiscoveredApp {
    pub app_id: String,
    pub title: String,
    pub html: String,
    pub manifest_json: Option<String>,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub port: Option<u16>,
}

#[tauri::command]
pub fn scan_workspace_apps(workspace_path: String) -> Vec<DiscoveredApp> {
    let apps_dir = std::path::PathBuf::from(&workspace_path).join(".CodePapr/apps");
    if !apps_dir.is_dir() {
        return vec![];
    }

    let entries = match fs::read_dir(&apps_dir) {
        Ok(e) => e,
        Err(_) => return vec![],
    };

    let mut apps = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let Some(app_id) = path.file_name().and_then(|n| n.to_str()).map(|s| s.to_string()) else {
            continue;
        };

        let manifest = match papr_runtime::manifest::load_manifest(&apps_dir, &app_id) {
            Ok(m) => m,
            Err(_) => continue,
        };

        let entry_file = manifest.entry.as_deref().unwrap_or("index.html");
        let index_path = path.join(entry_file);
        if !index_path.is_file() {
            continue;
        }

        let html = match fs::read_to_string(&index_path) {
            Ok(s) => s,
            Err(_) => continue,
        };

        let manifest_json = serde_json::to_string(&manifest).ok();

        papr_runtime::manifest::store_manifest(&app_id, manifest.clone());

        apps.push(DiscoveredApp {
            app_id,
            title: manifest.name,
            html,
            manifest_json,
            command: manifest.command,
            args: manifest.args,
            port: manifest.port,
        });
    }

    apps
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn resolve_protocol_path(uri: &str) -> (String, String) {
        let path = uri
            .strip_prefix("codepapr-app://localhost/")
            .or_else(|| uri.strip_prefix("codepapr-app://"))
            .unwrap_or(uri);

        let path = path.trim_start_matches('/');

        if path == "__papr_sdk.js" {
            return ("__system__".into(), "__papr_sdk.js".into());
        }

        match path.split_once('/') {
            Some((id, rest)) if !id.is_empty() => {
                if rest == "__papr_sdk.js" {
                    return ("__system__".into(), "__papr_sdk.js".into());
                }
                (id.to_string(), rest.to_string())
            }
            _ => (String::new(), String::new()),
        }
    }

    #[test]
    fn protocol_path_with_scheme_prefix() {
        let (app_id, file) = resolve_protocol_path("codepapr-app://localhost/my-app/index.html");
        assert_eq!(app_id, "my-app");
        assert_eq!(file, "index.html");
    }

    #[test]
    fn protocol_path_per_app_origin() {
        // New format: the appId is the URL host, giving each app its own origin.
        let (app_id, file) = resolve_protocol_path("codepapr-app://my-app/index.html");
        assert_eq!(app_id, "my-app");
        assert_eq!(file, "index.html");
    }

    #[test]
    fn protocol_path_per_app_sdk() {
        let (_app_id, file) = resolve_protocol_path("codepapr-app://my-app/__papr_sdk.js");
        assert_eq!(file, "__papr_sdk.js");
    }

    #[test]
    fn protocol_path_without_scheme_leading_slash() {
        let (app_id, file) = resolve_protocol_path("/my-app/index.html");
        assert_eq!(app_id, "my-app");
        assert_eq!(file, "index.html");
    }

    #[test]
    fn protocol_path_sdk_js() {
        let (app_id, file) = resolve_protocol_path("/__papr_sdk.js");
        assert_eq!(app_id, "__system__");
        assert_eq!(file, "__papr_sdk.js");
    }

    #[test]
    fn protocol_path_sdk_js_no_leading_slash() {
        let (app_id, file) = resolve_protocol_path("__papr_sdk.js");
        assert_eq!(app_id, "__system__");
        assert_eq!(file, "__papr_sdk.js");
    }

    #[test]
    fn protocol_path_root_returns_index() {
        let (_app_id, _file) = resolve_protocol_path("/my-app/");
        // path.trim_start_matches('/') → "my-app/"
        // split_once('/') → ("my-app", "")
    }

    #[test]
    fn scan_discovers_app_with_valid_manifest() {
        let tmp = std::env::temp_dir().join(format!("papr-scan-{}", std::process::id()));
        let apps_dir = tmp.join(".CodePapr/apps/valid-app");
        fs::create_dir_all(&apps_dir).unwrap();

        let manifest = r#"{"spec":"papr/0.1","name":"ValidApp","version":"1.0","permissions":["storage:read"]}"#;
        fs::write(apps_dir.join("manifest.json"), manifest).unwrap();
        fs::write(apps_dir.join("index.html"), "<html><title>Test</title></html>").unwrap();

        let result = scan_workspace_apps(tmp.to_string_lossy().to_string());
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].app_id, "valid-app");
        assert_eq!(result[0].title, "ValidApp");
        assert!(result[0].manifest_json.is_some());

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn scan_skips_dir_without_manifest() {
        let tmp = std::env::temp_dir().join(format!("papr-scan-nomanifest-{}", std::process::id()));
        let apps_dir = tmp.join(".CodePapr/apps/no-manifest-app");
        fs::create_dir_all(&apps_dir).unwrap();
        fs::write(apps_dir.join("index.html"), "<html></html>").unwrap();

        let result = scan_workspace_apps(tmp.to_string_lossy().to_string());
        assert!(result.is_empty());

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn scan_skips_dir_with_invalid_manifest() {
        let tmp = std::env::temp_dir().join(format!("papr-scan-bad-{}", std::process::id()));
        let apps_dir = tmp.join(".CodePapr/apps/bad-app");
        fs::create_dir_all(&apps_dir).unwrap();
        fs::write(apps_dir.join("manifest.json"), "not json").unwrap();
        fs::write(apps_dir.join("index.html"), "<html></html>").unwrap();

        let result = scan_workspace_apps(tmp.to_string_lossy().to_string());
        assert!(result.is_empty());

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn e2e_scan_complete_app_with_all_fields() {
        let tmp = std::env::temp_dir().join(format!("papr-e2e-{}", std::process::id()));
        let apps_dir = tmp.join(".CodePapr/apps/full-app");
        fs::create_dir_all(&apps_dir).unwrap();

        let manifest = r#"{"spec":"papr/0.1","name":"Full App","version":"0.1.0","permissions":["storage:read","storage:write","http:get","fs:read","fs:write","agent:run:assistant"],"agents":[{"name":"assistant","model":"main","systemPrompt":"You are a test agent.","tools":["read","web_search"],"maxToolRounds":10}],"command":"node","args":["server.js"],"port":3456}"#;
        fs::write(apps_dir.join("manifest.json"), manifest).unwrap();
        fs::write(apps_dir.join("index.html"), "<html><head><title>Full App</title></head><body><h1>Hello</h1></body></html>").unwrap();

        let result = scan_workspace_apps(tmp.to_string_lossy().to_string());
        assert_eq!(result.len(), 1);
        let app = &result[0];
        assert_eq!(app.app_id, "full-app");
        assert_eq!(app.title, "Full App");
        assert!(app.html.contains("<h1>Hello</h1>"));
        assert!(app.manifest_json.is_some());
        assert_eq!(app.command.as_deref(), Some("node"));
        assert_eq!(app.port, Some(3456));

        let manifest_json = app.manifest_json.as_deref().unwrap();
        assert!(manifest_json.contains("agent:run:assistant"));
        assert!(manifest_json.contains("node"));
        assert!(manifest_json.contains("server.js"));

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn sqlite_files_are_not_servable() {
        assert!(is_unservable_app_file("db.sqlite"));
        assert!(is_unservable_app_file("db.sqlite-wal"));
        assert!(is_unservable_app_file("db.sqlite-shm"));
        assert!(is_unservable_app_file("DB.SQLITE"));
        assert!(is_unservable_app_file("data/nested.sqlite"));
        assert!(!is_unservable_app_file("index.html"));
        assert!(!is_unservable_app_file("server.js"));
        assert!(!is_unservable_app_file("sqlite.txt"));
    }

    #[test]
    fn lsof_bind_hosts_parsing() {
        // 通配监听（0.0.0.0）与回环监听、IPv6 括号形式都要正确解析出 host
        let sample = "COMMAND  PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME\n\
            node    123  mmr    3u   IPv4 0x92669b5f4405df      0t0  TCP *:3456 (LISTEN)\n\
            python  456  mmr    4u   IPv6 0x92669b5f4405e0      0t0  TCP 127.0.0.1:3456 (LISTEN)\n\
            python  456  mmr    5u   IPv6 0x92669b5f4405e1      0t0  TCP [::1]:3456 (LISTEN)\n";
        let hosts = parse_lsof_bind_hosts(sample);
        assert_eq!(hosts, vec!["*".to_string(), "127.0.0.1".to_string(), "::1".to_string()]);
    }

    #[test]
    fn lsof_bind_hosts_parsing_ignores_header_and_empty() {
        assert!(parse_lsof_bind_hosts("").is_empty());
        assert!(parse_lsof_bind_hosts("COMMAND PID USER NAME\n").is_empty());
        // 无 "TCP " 标记的行必须忽略（注意测试文本里不能出现该子串）
        assert!(parse_lsof_bind_hosts("random line without the marker\n").is_empty());
    }

    #[test]
    fn loopback_bind_detection() {
        assert!(is_loopback_bind("127.0.0.1"));
        assert!(is_loopback_bind("127.0.0.2"));
        assert!(is_loopback_bind("::1"));
        assert!(is_loopback_bind("localhost"));
        assert!(!is_loopback_bind("*"));
        assert!(!is_loopback_bind("192.168.1.5"));
        assert!(!is_loopback_bind("0.0.0.0"));
        assert!(!is_loopback_bind("fe80::1"));
    }

    #[test]
    fn csp_blocks_direct_network_when_network_off() {
        use crate::papr_runtime::permission::{PaprAccess, PaprLocalAccess};
        let access = PaprAccess { local: PaprLocalAccess::Read, network: false };
        let csp = build_app_csp(access, None);
        // 无后端：connect-src 只有同源，任何外发通道关闭
        assert!(csp.contains("connect-src 'self';"), "got: {csp}");
        assert!(csp.contains("form-action 'none'"), "got: {csp}");
        assert!(!csp.contains("wss:"), "got: {csp}");
        // connect/img/form 不允许 https（font-src/script-src 的 https: 是给 CDN 的，不算外发通道）
        assert!(!csp.contains("connect-src 'self' https:"), "got: {csp}");
        assert!(!csp.contains("img-src 'self' data: https:"), "got: {csp}");
        // CDN 脚本仍然放行（图表库）
        assert!(csp.contains("script-src 'self' https:"), "got: {csp}");
    }

    #[test]
    fn csp_allows_own_backend_port_when_network_off() {
        use crate::papr_runtime::permission::{PaprAccess, PaprLocalAccess};
        let access = PaprAccess { local: PaprLocalAccess::Read, network: false };
        let csp = build_app_csp(access, Some(3456));
        assert!(csp.contains("http://localhost:3456"), "got: {csp}");
        assert!(csp.contains("http://127.0.0.1:3456"), "got: {csp}");
        assert!(!csp.contains("wss:"), "got: {csp}");
    }

    #[test]
    fn csp_opens_public_network_when_network_on() {
        use crate::papr_runtime::permission::{PaprAccess, PaprLocalAccess};
        let access = PaprAccess { local: PaprLocalAccess::Read, network: true };
        let csp = build_app_csp(access, None);
        assert!(csp.contains("connect-src 'self' https: wss: ws:"), "got: {csp}");
        assert!(csp.contains("form-action 'none' https:"), "got: {csp}");
        assert!(csp.contains("img-src 'self' data: https:"), "got: {csp}");
    }
}
