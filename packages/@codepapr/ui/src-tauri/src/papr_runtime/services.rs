use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::net::ToSocketAddrs;
use std::path::PathBuf;

use base64::Engine;
use serde::Serialize;

use crate::papr_runtime::permission;
use codepapr_core::shared::{canonical_workspace, parse_browser_url};
use codepapr_core::web::client::build_papr_http_client;
use codepapr_core::web::text::{html_to_text, truncate_text_to_bytes};

const MAX_PAPR_HTTP_BYTES: usize = 500_000;
const PAPR_HTTP_POST_MAX_BYTES: usize = 100_000;

pub(crate) fn is_internal_ipv4(ip: std::net::Ipv4Addr) -> bool {
    let octets = ip.octets();
    ip.is_loopback()           // 127.0.0.0/8
        || ip.is_private()     // 10/8, 172.16/12, 192.168/16
        || ip.is_link_local()  // 169.254/16 (incl. cloud metadata 169.254.169.254)
        || ip.is_unspecified() // 0.0.0.0
        || octets[0] == 0      // 0.0.0.0/8 "this" network
        || (octets[0] == 100 && (64..=127).contains(&octets[1])) // CGNAT 100.64/10
}

pub(crate) fn is_internal_ipv6(ip: std::net::Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return is_internal_ipv4(mapped); // ::ffff:127.0.0.1 etc.
    }
    if ip.is_loopback() || ip.is_unspecified() {
        return true; // ::1, ::
    }
    // RFC 4291 §2.5.5.1 IPv4-compatible 形式 ::a.b.c.d（如 [::127.0.0.1]）：
    // 前 5 段全零、后两段构成 IPv4。to_ipv4_mapped() 只认 ::ffff: 前缀，
    // 漏判该兼容形式会让 SSRF 检查直接放过回环/内网目标。
    let segments = ip.segments();
    if segments[0] == 0
        && segments[1] == 0
        && segments[2] == 0
        && segments[3] == 0
        && segments[4] == 0
    {
        let v4 = std::net::Ipv4Addr::new(
            (segments[5] >> 8) as u8,
            (segments[5] & 0xff) as u8,
            (segments[6] >> 8) as u8,
            (segments[6] & 0xff) as u8,
        );
        if is_internal_ipv4(v4) {
            return true;
        }
    }
    let first = segments[0];
    (first & 0xfe00) == 0xfc00 // fc00::/7 unique-local (fd00::/8 too)
        || (first & 0xffc0) == 0xfe80 // fe80::/10 link-local
}

fn is_internal_domain(host: &str) -> bool {
    let h = host.to_lowercase();
    h == "localhost"
        || h.ends_with(".localhost")
        || h.ends_with(".local")
        || h.ends_with(".internal")
}

/// Block loopback / private / link-local / unspecified targets. The URL is
/// parsed with the WHATWG `url` crate so IPv4 special forms (decimal
/// `2130706433`, short `127.1`, hex/octal octets) are normalised to a canonical
/// address before the range checks, closing string-parsing bypasses.
pub(crate) fn is_private_or_internal_url(url: &str) -> bool {
    match url::Url::parse(url) {
        Ok(parsed) => match parsed.host() {
            Some(url::Host::Ipv4(ip)) => is_internal_ipv4(ip),
            Some(url::Host::Ipv6(ip)) => is_internal_ipv6(ip),
            Some(url::Host::Domain(domain)) => is_internal_domain(domain),
            None => true,
        },
        Err(_) => true,
    }
}

/// Resolve a domain host and verify every resolved address is public, returning
/// a vetted `(domain, socket_addr)` to pin via `RequestBuilder::resolve`. Pinning
/// closes the DNS-rebinding TOCTOU window where a public domain re-resolves to an
/// internal IP between validation and connect. IP-literal hosts need no resolution
/// (they are already range-checked by `is_private_or_internal_url`).
///
/// 异步解析（tokio::net::lookup_host）：本函数在 async tauri command 内调用，
/// 用阻塞的 ToSocketAddrs 会卡住 tokio worker 线程。
async fn resolve_safe_socket_addr(
    parsed: &url::Url,
) -> Result<Option<(String, std::net::SocketAddr)>, String> {
    let host = match parsed.host() {
        Some(url::Host::Domain(domain)) => domain.to_string(),
        Some(_) => return Ok(None),
        None => return Err("URL 缺少主机".to_string()),
    };
    let port = parsed.port_or_known_default().unwrap_or(443);
    let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|err| format!("DNS 解析失败 {host}: {err}"))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("DNS 解析无结果: {host}"));
    }
    for addr in &addrs {
        let internal = match addr.ip() {
            std::net::IpAddr::V4(v4) => is_internal_ipv4(v4),
            std::net::IpAddr::V6(v6) => is_internal_ipv6(v6),
        };
        if internal {
            return Err(format!("安全限制：{host} 解析到内网/本地地址 {}", addr.ip()));
        }
    }
    Ok(Some((host, addrs[0])))
}

/// `resolve_safe_socket_addr` 的阻塞版本：供 spawn_blocking 内的阻塞客户端
/// （fetch_web_url / download_web_file）复用同一套 DNS 解析 + 逐地址内网校验，
/// 防止 DNS rebinding 在"校验后、连接前"把公网域名重新解析到内网地址。
pub(crate) fn resolve_safe_socket_addr_blocking(
    parsed: &url::Url,
) -> Result<Option<(String, std::net::SocketAddr)>, String> {
    let host = match parsed.host() {
        Some(url::Host::Domain(domain)) => domain.to_string(),
        Some(_) => return Ok(None),
        None => return Err("URL 缺少主机".to_string()),
    };
    let port = parsed.port_or_known_default().unwrap_or(443);
    let addrs: Vec<std::net::SocketAddr> = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|err| format!("DNS 解析失败 {host}: {err}"))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("DNS 解析无结果: {host}"));
    }
    for addr in &addrs {
        let internal = match addr.ip() {
            std::net::IpAddr::V4(v4) => is_internal_ipv4(v4),
            std::net::IpAddr::V6(v6) => is_internal_ipv6(v6),
        };
        if internal {
            return Err(format!("安全限制：{host} 解析到内网/本地地址 {}", addr.ip()));
        }
    }
    Ok(Some((host, addrs[0])))
}

/// 把一个响应块追加到缓冲区，最多累计到 `cap` 字节。
/// 返回 true 表示已达上限且仍有剩余数据（应停止读取并标记 truncated）。
/// 纯函数以便单测；网络循环见 read_body_capped。
fn append_capped(buffer: &mut Vec<u8>, chunk: &[u8], cap: usize) -> bool {
    let remaining = cap.saturating_sub(buffer.len());
    if remaining == 0 {
        return !chunk.is_empty();
    }
    if chunk.len() > remaining {
        buffer.extend_from_slice(&chunk[..remaining]);
        return true;
    }
    buffer.extend_from_slice(chunk);
    false
}

/// 流式读取响应体，累计达到 `cap` 字节立即停止——恶意/超大响应无法把内存
/// 撑过上限（旧实现 bytes() 全量读取，max_bytes 只在读完后截断文本）。
/// 返回 `(body, truncated)`；truncated 表示响应在上限处被截断。
async fn read_body_capped(
    mut response: reqwest::Response,
    cap: usize,
) -> Result<(Vec<u8>, bool), String> {
    let mut buffer: Vec<u8> = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|err| format!("读取响应失败: {err}"))?
    {
        if append_capped(&mut buffer, &chunk, cap) {
            return Ok((buffer, true));
        }
    }
    Ok((buffer, false))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaprHttpResult {
    status: u16,
    body: String,
    content_type: Option<String>,
    truncated: bool,
}

fn app_data_dir(workspace_path: &str, app_id: &str) -> Result<PathBuf, String> {
    let workspace = canonical_workspace(workspace_path)?;
    Ok(workspace
        .join(".CodePapr")
        .join("apps")
        .join(app_id)
        .join("data"))
}

fn resolve_app_path(workspace_path: &str, app_id: &str, relative: &str) -> Result<PathBuf, String> {
    let base = app_data_dir(workspace_path, app_id)?;
    let resolved = base.join(relative);

    let canonical_base = base.canonicalize().map_err(|_| {
        format!("app data directory does not exist: {}", base.display())
    })?;

    let canonical_path = match resolved.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            let parent = resolved.parent().ok_or_else(|| "invalid path".to_string())?;
            let canonical_parent = parent.canonicalize().map_err(|_| {
                "parent directory does not exist".to_string()
            })?;
            if !canonical_parent.starts_with(&canonical_base) {
                return Err("path traversal blocked".to_string());
            }
            return Ok(resolved);
        }
    };

    if !canonical_path.starts_with(&canonical_base) {
        return Err("path traversal blocked".to_string());
    }

    Ok(resolved)
}

// ── HTTP commands ──────────────────────────────────────────────────────

const ALLOWED_HTTP_METHODS: &[&str] = &["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];
const MAX_HTTP_HEADERS: usize = 16;
const MAX_HEADER_NAME: usize = 64;
const MAX_HEADER_VALUE: usize = 4096;

fn header_name_allowed(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    if n.starts_with("proxy-") {
        return false;
    }
    matches!(
        n.as_str(),
        "authorization" | "accept" | "content-type" | "accept-language" | "if-none-match" | "if-modified-since"
    ) || n.starts_with("x-")
}

pub(crate) fn sanitize_http_headers(
    raw: Option<HashMap<String, String>>,
) -> Result<Vec<(String, String)>, String> {
    let Some(map) = raw else {
        return Ok(Vec::new());
    };
    if map.len() > MAX_HTTP_HEADERS {
        return Err(format!("headers 最多 {MAX_HTTP_HEADERS} 个"));
    }
    let mut out = Vec::with_capacity(map.len());
    for (key, value) in map {
        if key.is_empty() || key.len() > MAX_HEADER_NAME || value.len() > MAX_HEADER_VALUE {
            return Err("header 名称或值过长".to_string());
        }
        if key.bytes().any(|b| b == b'\r' || b == b'\n' || b == b':')
            || value.bytes().any(|b| b == b'\r' || b == b'\n')
        {
            return Err("header 含非法字符".to_string());
        }
        if !header_name_allowed(&key) {
            return Err(format!("不允许的请求头: {key}"));
        }
        out.push((key, value));
    }
    Ok(out)
}

fn parse_http_method(method: &str) -> Result<reqwest::Method, String> {
    let upper = method.trim().to_ascii_uppercase();
    if !ALLOWED_HTTP_METHODS.contains(&upper.as_str()) {
        return Err(format!(
            "不支持的 HTTP 方法: {method}（允许 GET/POST/PUT/PATCH/DELETE/HEAD）"
        ));
    }
    upper
        .parse()
        .map_err(|_| format!("不支持的 HTTP 方法: {method}"))
}

/// JSON/文本原样返回（只按字节封顶）。仅 GET 且 content-type 为 HTML 时抽取正文，
/// 避免把 JSON API 抽成纯文本。
pub(crate) fn decode_http_body(
    content_type: Option<&str>,
    body: &[u8],
    max: usize,
    scrape_html: bool,
) -> (String, bool) {
    let body_str = String::from_utf8_lossy(body).into_owned();
    let ct = content_type.unwrap_or("").to_ascii_lowercase();
    let is_structured = ct.contains("json") || ct.contains("javascript") || ct.contains("xml");
    let is_html = !is_structured
        && (ct.contains("html") || (scrape_html && body_str.contains("<html")));
    let text = if is_html && scrape_html {
        html_to_text(&body_str)
    } else {
        body_str
    };
    truncate_text_to_bytes(text, max)
}

async fn papr_http_request_inner(
    app_id: &str,
    capability: &str,
    method: reqwest::Method,
    url: String,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
    max_bytes: Option<usize>,
) -> Result<PaprHttpResult, String> {
    let manifest = crate::papr_runtime::manifest::get_manifest(app_id)?;
    permission::check_permission(&manifest, app_id, capability)?;

    let parsed_url = parse_browser_url(&url)?;
    if !parsed_url.starts_with("https://") && !parsed_url.starts_with("http://") {
        return Err("url 必须是 http 或 https URL".to_string());
    }
    if is_private_or_internal_url(&parsed_url) {
        return Err("安全限制：不允许访问内网/本地地址".to_string());
    }
    let parsed = url::Url::parse(&parsed_url).map_err(|err| format!("URL 解析失败: {err}"))?;
    let pin = resolve_safe_socket_addr(&parsed).await?;

    let extra_headers = sanitize_http_headers(headers)?;
    if let Some(raw) = &body {
        if raw.len() > PAPR_HTTP_POST_MAX_BYTES {
            return Err(format!("请求体超过上限 {PAPR_HTTP_POST_MAX_BYTES} 字节"));
        }
    }

    let is_get = method == reqwest::Method::GET;
    let max = max_bytes
        .unwrap_or(if is_get { 50_000 } else { PAPR_HTTP_POST_MAX_BYTES })
        .clamp(1_000, MAX_PAPR_HTTP_BYTES);

    let client = build_papr_http_client(pin)?;
    let mut request = client.request(method.clone(), parsed_url);
    let has_accept = extra_headers
        .iter()
        .any(|(k, _)| k.eq_ignore_ascii_case("accept"));
    if !has_accept {
        request = request.header(
            reqwest::header::ACCEPT,
            "application/json, text/plain, text/html;q=0.9, */*;q=0.5",
        );
    }
    for (key, value) in extra_headers {
        request = request.header(&key, &value);
    }
    if matches!(
        method,
        reqwest::Method::POST | reqwest::Method::PUT | reqwest::Method::PATCH | reqwest::Method::DELETE
    ) {
        if let Some(payload) = body {
            request = request.body(payload);
        }
    }

    let response = request
        .send()
        .await
        .map_err(|err| format!("HTTP {method} 失败: {err}"))?;

    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_string());

    let html_by_header = content_type
        .as_deref()
        .map(|v| v.contains("html"))
        .unwrap_or(false);
    let read_cap = if html_by_header && is_get {
        MAX_PAPR_HTTP_BYTES
    } else {
        max
    };
    let (body_bytes, body_truncated) = read_body_capped(response, read_cap).await?;
    let (content, text_truncated) =
        decode_http_body(content_type.as_deref(), &body_bytes, max, is_get);

    Ok(PaprHttpResult {
        status: status.as_u16(),
        body: content,
        content_type,
        truncated: body_truncated || text_truncated,
    })
}

#[tauri::command]
pub async fn papr_http_get(
    app_id: String,
    url: String,
    max_bytes: Option<usize>,
) -> Result<PaprHttpResult, String> {
    papr_http_request_inner(
        &app_id,
        "http:get",
        reqwest::Method::GET,
        url,
        None,
        None,
        max_bytes,
    )
    .await
}

#[tauri::command]
pub async fn papr_http_post(
    app_id: String,
    url: String,
    body: String,
    content_type: Option<String>,
) -> Result<PaprHttpResult, String> {
    let mut headers = HashMap::new();
    headers.insert(
        "Content-Type".to_string(),
        content_type.unwrap_or_else(|| "application/json".to_string()),
    );
    papr_http_request_inner(
        &app_id,
        "http:post",
        reqwest::Method::POST,
        url,
        Some(headers),
        Some(body),
        Some(PAPR_HTTP_POST_MAX_BYTES),
    )
    .await
}

#[tauri::command]
pub async fn papr_http_request(
    app_id: String,
    method: String,
    url: String,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
    max_bytes: Option<usize>,
) -> Result<PaprHttpResult, String> {
    let parsed_method = parse_http_method(&method)?;
    papr_http_request_inner(
        &app_id,
        "http:request",
        parsed_method,
        url,
        headers,
        body,
        max_bytes,
    )
    .await
}

// ── FS commands ────────────────────────────────────────────────────────

fn ensure_app_data_dir(workspace_path: &str, app_id: &str) -> Result<PathBuf, String> {
    let dir = app_data_dir(workspace_path, app_id)?;
    fs::create_dir_all(&dir)
        .map_err(|err| format!("创建 app data 目录失败: {err}"))?;
    Ok(dir)
}

#[tauri::command]
pub fn papr_fs_read(
    app_id: String,
    path: String,
    max_bytes: Option<usize>,
    encoding: Option<String>,
) -> Result<String, String> {
    let manifest = crate::papr_runtime::manifest::get_manifest(&app_id)?;
    permission::check_permission(&manifest, &app_id, "fs:read")?;

    let ctx = crate::papr_runtime::app_context::get(&app_id)?;
    if path.contains("..") || path.contains('\\') || path.starts_with('/') || path.is_empty() {
        return Err("invalid path".to_string());
    }

    let resolved = resolve_app_path(&ctx.workspace_path, &app_id, &path)?;
    if !resolved.exists() {
        return Err(format!("file not found: {}", path));
    }

    let max = max_bytes.unwrap_or(200_000).clamp(1_000, 1_000_000);
    let as_base64 = encoding.as_deref().map(|v| v.eq_ignore_ascii_case("base64")).unwrap_or(false);
    if as_base64 {
        read_capped_base64(&resolved, max)
    } else {
        read_capped_utf8(&resolved, max)
    }
}

/// 最多读取 max 字节，并在 UTF-8 字符边界处安全截断。
/// 旧实现先全量读入内存，再用 chars().take(max) 取 max 个"字符"——
/// 多字节文本下实际返回可达 3~4 倍 max 字节，超出 byte cap。
fn read_capped_utf8(path: &std::path::Path, max: usize) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|err| format!("读取文件失败: {err}"))?;
    let mut buf = Vec::new();
    file.take(max as u64)
        .read_to_end(&mut buf)
        .map_err(|err| format!("读取文件失败: {err}"))?;

    match std::str::from_utf8(&buf) {
        Ok(text) => Ok(text.to_string()),
        // error_len() == None 表示意外 EOF：恰好截断在多字节字符中间，
        // 回退到最后一个完整字符；文件本身含非法 UTF-8 则报错（与 read_to_string 一致）
        Err(err) if err.error_len().is_none() => {
            buf.truncate(err.valid_up_to());
            String::from_utf8(buf).map_err(|err| format!("读取文件失败: {err}"))
        }
        Err(_) => Err("文件不是有效的 UTF-8 文本".to_string()),
    }
}

fn read_capped_base64(path: &std::path::Path, max: usize) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|err| format!("读取文件失败: {err}"))?;
    let mut buf = Vec::new();
    file.take(max as u64)
        .read_to_end(&mut buf)
        .map_err(|err| format!("读取文件失败: {err}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(buf))
}

fn decode_fs_content(content: &str, encoding: Option<&str>) -> Result<Vec<u8>, String> {
    if encoding.map(|v| v.eq_ignore_ascii_case("base64")).unwrap_or(false) {
        base64::engine::general_purpose::STANDARD
            .decode(content.trim())
            .map_err(|err| format!("base64 解码失败: {err}"))
    } else {
        Ok(content.as_bytes().to_vec())
    }
}

#[tauri::command]
pub fn papr_fs_write(
    app_id: String,
    path: String,
    content: String,
    encoding: Option<String>,
) -> Result<(), String> {
    let manifest = crate::papr_runtime::manifest::get_manifest(&app_id)?;
    permission::check_permission(&manifest, &app_id, "fs:write")?;

    let ctx = crate::papr_runtime::app_context::get(&app_id)?;
    if path.contains("..") || path.contains('\\') || path.starts_with('/') || path.is_empty() {
        return Err("invalid path".to_string());
    }

    if content.len() > 5_000_000 {
        return Err("文件内容超过上限 5MB".to_string());
    }

    let bytes = decode_fs_content(&content, encoding.as_deref())?;
    if bytes.len() > 5_000_000 {
        return Err("文件内容超过上限 5MB".to_string());
    }

    let _ = ensure_app_data_dir(&ctx.workspace_path, &app_id)?;
    let base = app_data_dir(&ctx.workspace_path, &app_id)?;
    let canonical_base = base.canonicalize().map_err(|_| {
        format!("app data directory does not exist: {}", base.display())
    })?;

    // 沿路径找到最深的已存在祖先并确认其位于 data/ 内（防符号链接/遍历逃逸），
    // 随后 create_dir_all 自动创建缺失的父目录——writeFile("posts/x.md") 无需先建 posts/。
    let mut probe = base.join(&path);
    let mut existing_parent: Option<PathBuf> = None;
    while let Some(parent) = probe.parent() {
        if parent.exists() {
            existing_parent = Some(parent.to_path_buf());
            break;
        }
        probe = parent.to_path_buf();
    }
    if let Some(parent) = &existing_parent {
        let canonical_parent = parent.canonicalize().map_err(|err| {
            format!("无法访问目录 {}: {err}", parent.display())
        })?;
        if !canonical_parent.starts_with(&canonical_base) {
            return Err("path traversal blocked".to_string());
        }
    }

    let resolved = base.join(&path);
    if let Some(parent) = resolved.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("创建目录失败: {err}"))?;
    }

    // 父目录校验不能覆盖"目标本身是 symlink"的逃逸：写入走拒绝符号链接的闸门
    codepapr_core::shared::write_file_rejecting_symlink(&resolved, &canonical_base, &bytes)?;

    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaprFsEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[tauri::command]
pub fn papr_fs_list(
    app_id: String,
    path: Option<String>,
) -> Result<Vec<PaprFsEntry>, String> {
    let manifest = crate::papr_runtime::manifest::get_manifest(&app_id)?;
    permission::check_permission(&manifest, &app_id, "fs:read")?;

    let ctx = crate::papr_runtime::app_context::get(&app_id)?;
    let subpath = path.unwrap_or_else(|| ".".to_string());
    if subpath.contains("..") || subpath.contains('\\') || subpath.starts_with('/') || subpath.is_empty() {
        return Err("invalid path".to_string());
    }

    let _ = ensure_app_data_dir(&ctx.workspace_path, &app_id)?;
    let target = resolve_app_path(&ctx.workspace_path, &app_id, &subpath)?;
    if !target.exists() {
        return Ok(vec![]);
    }

    let entries = fs::read_dir(&target)
        .map_err(|err| format!("读取目录失败: {err}"))?;

    let mut result = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let rel = format!("{}/{}", subpath.trim_end_matches('/'), name);
        result.push(PaprFsEntry {
            name,
            path: rel.trim_start_matches("./").to_string(),
            is_dir: entry.file_type().map(|t| t.is_dir()).unwrap_or(false),
        });
    }

    result.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(result)
}

#[tauri::command]
pub fn papr_fs_delete(
    app_id: String,
    path: String,
) -> Result<(), String> {
    let manifest = crate::papr_runtime::manifest::get_manifest(&app_id)?;
    permission::check_permission(&manifest, &app_id, "fs:write")?;

    let ctx = crate::papr_runtime::app_context::get(&app_id)?;
    if path.contains("..") || path.contains('\\') || path.starts_with('/') || path.is_empty() {
        return Err("invalid path".to_string());
    }

    let resolved = resolve_app_path(&ctx.workspace_path, &app_id, &path)?;
    if !resolved.exists() {
        return Ok(());
    }

    if resolved.is_dir() {
        fs::remove_dir_all(&resolved)
            .map_err(|err| format!("删除目录失败: {err}"))?;
    } else {
        fs::remove_file(&resolved)
            .map_err(|err| format!("删除文件失败: {err}"))?;
    }

    Ok(())
}

#[tauri::command]
pub fn papr_fs_exists(app_id: String, path: String) -> Result<bool, String> {
    let manifest = crate::papr_runtime::manifest::get_manifest(&app_id)?;
    permission::check_permission(&manifest, &app_id, "fs:read")?;

    let ctx = crate::papr_runtime::app_context::get(&app_id)?;
    if path.contains("..") || path.contains('\\') || path.starts_with('/') || path.is_empty() {
        return Err("invalid path".to_string());
    }

    match resolve_app_path(&ctx.workspace_path, &app_id, &path) {
        Ok(resolved) => Ok(resolved.exists()),
        Err(err) if err.contains("path traversal") => Err(err),
        Err(_) => Ok(false),
    }
}

// ── App lifecycle ────────────────────────────────────────────────────

#[tauri::command]
pub fn papr_delete_app(app_id: String) -> Result<(), String> {
    let ctx = crate::papr_runtime::app_context::get(&app_id)?;

    if let Ok(manifest) = crate::papr_runtime::manifest::get_manifest(&app_id) {
        if let Some(port) = manifest.port {
            let _ = stop_app_backend_processes(&ctx.workspace_path, port);
        }
    }

    let app_dir = codepapr_core::db::resolve_app_dir(&ctx.workspace_path, &app_id)?;

    if app_dir.exists() {
        fs::remove_dir_all(&app_dir)
            .map_err(|err| format!("删除 app 目录失败: {err}"))?;
    }

    // papr.db 数据（db.sqlite）位于 app 目录内，随目录一并删除，无需单独清理。

    crate::papr_runtime::app_context::unregister(&app_id);
    crate::papr_runtime::manifest::clear_manifest(&app_id);

    Ok(())
}

pub(crate) fn stop_app_backend_processes(workspace_path: &str, port: u16) -> Result<usize, String> {
    let target_url = format!("http://localhost:{}/", port);
    let target_url_no_slash = format!("http://localhost:{}", port);

    if let Ok(list) = crate::host::call_blocking(
        "shell/listBackground",
        serde_json::json!({ "workspacePath": workspace_path }),
    ) {
        let mut stopped = 0usize;
        if let Some(arr) = list.as_array() {
            for proc in arr {
                let pid = proc.get("pid").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                let url = proc.get("previewUrl").and_then(|v| v.as_str()).unwrap_or("");
                if pid > 0 && (url == target_url || url == target_url_no_slash) {
                    let _ = crate::host::call_blocking(
                        "shell/stopBackground",
                        serde_json::json!({ "pid": pid, "source": "papr-delete-app" }),
                    );
                    stopped += 1;
                }
            }
        }
        if stopped > 0 {
            return Ok(stopped);
        }
    }

    codepapr_core::shell::background::with_background_processes(|processes| {
        let target_pids: Vec<u32> = processes
            .iter()
            .filter(|(_, p)| p.workspace_path == workspace_path)
            .filter(|(_, p)| {
                if let Some(url) = &p.preview_url {
                    url == &target_url || url == &target_url_no_slash
                } else {
                    false
                }
            })
            .map(|(pid, _)| *pid)
            .collect();

        let removed: Vec<codepapr_core::shell::types::ManagedBackgroundProcess> = target_pids
            .into_iter()
            .filter_map(|pid| processes.remove(&pid))
            .collect();
        Ok(removed)
    })
    // 锁外击杀：kill + 有界等待（最多 3s+）不得持有全局注册表锁，
    // 否则慢退出进程会阻塞所有后台进程操作。
    // 进程树击杀（而非只杀直接子进程）保证 shell 包装器派生的工作进程
    // 不会变孤儿继续占端口。
    .map(|removed| {
        let mut stopped = 0usize;
        for mut process in removed {
            let still_running = match process.child.try_wait() {
                Ok(Some(_)) => false,
                Ok(None) => true,
                Err(_) => true,
            };
            if still_running {
                let _ = codepapr_core::shell::process_tree::kill_process_tree(&mut process.child);
                codepapr_core::shell::process_tree::wait_for_child_exit(
                    &mut process.child,
                    codepapr_core::shared::child_reap_timeout(),
                );
                stopped += 1;
            }
        }
        stopped
    })
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::papr_runtime::permission::PaprLocalAccess;
    use crate::papr_runtime::manifest;
    use codepapr_core::test_helpers::TestWorkspace;

    #[cfg(unix)]
    fn is_process_alive(pid: u32) -> bool {
        std::process::Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "pid="])
            .output()
            .map(|out| out.status.success() && !out.stdout.is_empty())
            .unwrap_or(false)
    }

    #[cfg(unix)]
    fn wait_until_dead(pid: u32, timeout: std::time::Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            if !is_process_alive(pid) {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        false
    }

    /// 回归（#17）：stop_app_backend_processes 必须杀整个进程树（旧实现只
    /// kill 直接子进程——sh 包装器死了，server.js 等真实工作进程变成孤儿继续
    /// 占端口），且不能无界等待（D 状态进程会让全局锁死锁）。
    #[cfg(unix)]
    #[test]
    fn stop_app_backend_processes_kills_whole_tree() {
        use codepapr_core::shell::background::background_processes;
        use codepapr_core::shell::process_tree::prepare_new_process_group;
        use codepapr_core::shell::types::ManagedBackgroundProcess;
        use std::collections::VecDeque;
        use std::process::{Command, Stdio};
        use std::sync::{Arc, Mutex};

        let ws = TestWorkspace::new("papr-stop-tree");
        let port: u16 = 48_123;

        // sh 派生两个 sleep 子进程：验证进程组击杀能连后代一起杀掉
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c")
            .arg("sleep 100 & sleep 100")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        prepare_new_process_group(&mut cmd);
        let child = cmd.spawn().expect("sh should spawn");
        let pid = child.id();

        // sh 派生子进程是异步的：轮询等待后代出现（pgrep -P 跨 macOS/Linux）
        let mut grandchildren: Vec<u32> = Vec::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while std::time::Instant::now() < deadline {
            let pgrep_output = std::process::Command::new("pgrep")
                .arg("-P")
                .arg(pid.to_string())
                .output()
                .expect("pgrep should run");
            grandchildren = String::from_utf8_lossy(&pgrep_output.stdout)
                .split_whitespace()
                .filter_map(|token| token.parse::<u32>().ok())
                .collect();
            if !grandchildren.is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(
            !grandchildren.is_empty(),
            "sh -c 'sleep 100 & sleep 100' should have spawned children"
        );

        background_processes()
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .insert(
                pid,
                ManagedBackgroundProcess {
                    child,
                    command: "sh".to_string(),
                    args: vec![],
                    workspace_path: ws.workspace_arg(),
                    started_at: 0,
                    preview_url: Some(format!("http://localhost:{port}/")),
                    log_tail: Arc::new(Mutex::new(VecDeque::new())),
                },
            );

        let stopped = stop_app_backend_processes(&ws.workspace_arg(), port)
            .expect("stop should succeed");
        assert_eq!(stopped, 1);

        // 直接子进程与全部后代都必须在有界时间内死亡（无孤儿、无死锁）
        assert!(
            wait_until_dead(pid, std::time::Duration::from_secs(5)),
            "direct child should be dead"
        );
        for grandchild in grandchildren {
            assert!(
                wait_until_dead(grandchild, std::time::Duration::from_secs(5)),
                "grandchild {grandchild} should be dead (no orphaned processes)"
            );
        }
    }

    fn register_test_app(workspace: &str, app_id: &str, extra_perms: &[&str]) {
        crate::papr_runtime::app_context::register(app_id, workspace);
        let mut perms = vec!["fs:read".to_string(), "fs:write".to_string()];
        for p in extra_perms {
            perms.push(p.to_string());
        }
        let m = manifest::PaprManifest {
            spec: "papr/0.1".into(),
            name: "TestApp".into(),
            version: None,
            entry: None,
            icon: None,
            kind: None,
            surface: None,
            lifecycle: None,
            permissions: Some(perms),
            agents: None,
            command: None,
            args: None,
            port: None,
            level: None,
            // 两轴模型：papr.db/papr.fs 永远可用；local=write 覆盖 agent 写项目场景。
            local: Some(PaprLocalAccess::Write),
            network: None,
        };
        manifest::store_manifest(app_id, m);
    }

    fn unregister_test_app(app_id: &str) {
        crate::papr_runtime::app_context::unregister(app_id);
        manifest::clear_manifest(app_id);
    }

    #[test]
    fn fs_write_and_read_roundtrip() {
        let ws = TestWorkspace::new("papr-fs-rw");
        // 用进程内唯一的 app id：permission 模块的测试会为 "test-app" 写
        // app_overrides（内存态），共用同一 id 会被并行测试竞态误伤。
        register_test_app(&ws.workspace_arg(), "rw-app", &[]);

        papr_fs_write("rw-app".into(), "hello.txt".into(), "Hello World".into(), None).unwrap();
        let content = papr_fs_read("rw-app".into(), "hello.txt".into(), None, None).unwrap();
        assert_eq!(content, "Hello World");

        unregister_test_app("rw-app");
    }

    #[test]
    fn fs_write_auto_creates_subdirectories() {
        let ws = TestWorkspace::new("papr-fs-nested");
        register_test_app(&ws.workspace_arg(), "nested-app", &[]);

        // 写嵌套路径：父目录不存在时应自动创建（博客 posts/ 分目录场景）
        papr_fs_write("nested-app".into(), "posts/first.md".into(), "# Hello".into(), None).unwrap();
        papr_fs_write("nested-app".into(), "posts/archive/old.md".into(), "# Old".into(), None).unwrap();

        assert!(ws
            .file_path(".CodePapr/apps/nested-app/data/posts/first.md")
            .exists());
        assert!(ws
            .file_path(".CodePapr/apps/nested-app/data/posts/archive/old.md")
            .exists());
        let content = papr_fs_read("nested-app".into(), "posts/archive/old.md".into(), None, None).unwrap();
        assert_eq!(content, "# Old");

        // list 能列出新建的嵌套目录
        let entries = papr_fs_list("nested-app".into(), Some("posts".into())).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"first.md"));
        assert!(names.contains(&"archive"));

        unregister_test_app("nested-app");
    }

    #[test]
    fn fs_write_rejects_escape_paths() {
        let ws = TestWorkspace::new("papr-fs-escape");
        register_test_app(&ws.workspace_arg(), "escape-app", &[]);

        // 绝对路径与 .. 逃逸必须被拦截（不能写出 data/）
        assert!(papr_fs_write("escape-app".into(), "/tmp/evil.txt".into(), "x".into(), None).is_err());
        assert!(papr_fs_write("escape-app".into(), "../evil.txt".into(), "x".into(), None).is_err());
        assert!(papr_fs_write("escape-app".into(), "a\\..\\evil.txt".into(), "x".into(), None).is_err());
        assert!(!ws.file_path(".CodePapr/apps/escape-app/data/../evil.txt").exists());
        assert!(!ws.file_path("/tmp/evil.txt").exists());

        unregister_test_app("escape-app");
    }

    #[test]
    fn fs_path_traversal_blocked() {
        let ws = TestWorkspace::new("papr-fs-traversal");
        register_test_app(&ws.workspace_arg(), "traversal-app", &[]);

        // read/list/delete 与 write 统一校验：.. / 反斜杠 / 绝对路径 / 空路径
        // 一律拒绝（write 的既有契约，回归 #19 的一致性修复）。
        for path in ["../secret.txt", "a\\..\\evil.txt", "/tmp/evil.txt", ""] {
            let result = papr_fs_read("traversal-app".into(), path.to_string(), None, None);
            assert!(result.is_err(), "read 应拒绝路径: {:?}", path);
            let result = papr_fs_delete("traversal-app".into(), path.to_string());
            assert!(result.is_err(), "delete 应拒绝路径: {:?}", path);
        }
        for path in ["../secret", "a\\..\\evil", "/tmp/evil", ""] {
            let result = papr_fs_list("traversal-app".into(), Some(path.to_string()));
            assert!(result.is_err(), "list 应拒绝路径: {:?}", path);
        }

        unregister_test_app("traversal-app");
    }

    #[test]
    fn fs_read_truncates_by_bytes_not_chars() {
        let ws = TestWorkspace::new("papr-fs-mb-trunc");
        register_test_app(&ws.workspace_arg(), "mb-app", &[]);

        // 500 个 CJK 字符 = 1500 字节；旧实现 take(1000 个字符) 会返回 3000 字节
        let cjk: String = "中".repeat(500);
        papr_fs_write("mb-app".into(), "cjk.txt".into(), cjk, None).unwrap();

        let content = papr_fs_read("mb-app".into(), "cjk.txt".into(), Some(1_000), None).unwrap();
        assert!(content.len() <= 1_000, "按字节上限截断，实际 {} 字节", content.len());
        assert_eq!(content.len(), 999); // 3 字节/字符，边界回退到完整字符
        assert_eq!(content.chars().count(), 333);

        unregister_test_app("mb-app");
    }

    #[test]
    fn read_capped_utf8_handles_split_char_and_invalid_bytes() {
        let ws = TestWorkspace::new("papr-fs-capped");

        // "ab中" = [61 62 E4 B8 AD]，cap=4 恰好切在"中"中间 → 保留 "ab"
        let path = ws.file_path("split.txt");
        std::fs::write(&path, "ab中").unwrap();
        assert_eq!(read_capped_utf8(&path, 4).unwrap(), "ab");
        assert_eq!(read_capped_utf8(&path, 100).unwrap(), "ab中");

        // 文件本身含非法 UTF-8 → 报错（与 read_to_string 行为一致）
        let bad = ws.file_path("bad.txt");
        std::fs::write(&bad, [0x61, 0xFF, 0x62]).unwrap();
        assert!(read_capped_utf8(&bad, 100).is_err());
    }

    #[test]
    fn fs_delete_removes_file() {
        let ws = TestWorkspace::new("papr-fs-delete");
        register_test_app(&ws.workspace_arg(), "delete-app", &[]);

        papr_fs_write("delete-app".into(), "temp.txt".into(), "data".into(), None).unwrap();
        assert!(papr_fs_read("delete-app".into(), "temp.txt".into(), None, None).is_ok());

        papr_fs_delete("delete-app".into(), "temp.txt".into()).unwrap();
        assert!(papr_fs_read("delete-app".into(), "temp.txt".into(), None, None).is_err());

        unregister_test_app("delete-app");
    }

    #[test]
    fn fs_list_returns_files() {
        let ws = TestWorkspace::new("papr-fs-list");
        register_test_app(&ws.workspace_arg(), "list-app", &[]);

        papr_fs_write("list-app".into(), "a.txt".into(), "a".into(), None).unwrap();
        papr_fs_write("list-app".into(), "b.txt".into(), "b".into(), None).unwrap();

        let entries = papr_fs_list("list-app".into(), None).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"a.txt"));
        assert!(names.contains(&"b.txt"));

        unregister_test_app("list-app");
    }

    #[test]
    fn fs_read_nonexistent_file_errors() {
        let ws = TestWorkspace::new("papr-fs-missing");
        register_test_app(&ws.workspace_arg(), "missing-app", &[]);

        let result = papr_fs_read("missing-app".into(), "nope.txt".into(), None, None);
        assert!(result.is_err());

        unregister_test_app("missing-app");
    }

    #[test]
    fn fs_write_requires_local_write_axis() {
        let ws = TestWorkspace::new("papr-fs-perm");
        crate::papr_runtime::app_context::register("noperm-app", &ws.workspace_arg());

        let m = manifest::PaprManifest {
            spec: "papr/0.1".into(),
            name: "NoPerm".into(),
            version: None,
            entry: None,
            icon: None,
            kind: None,
            surface: None,
            lifecycle: None,
            permissions: Some(vec!["storage:read".to_string()]),
            agents: None,
            command: None,
            args: None,
            port: None,
            level: None,
            local: None,
            network: None,
        };

        // 两轴模型（#48）：local 轴未声明 → 默认 none，papr.fs 写被拒绝
        // （旧实现 storage/fs 无条件放行，local 轴完全不参与）。
        let result = papr_fs_write("noperm-app".into(), "f.txt".into(), "data".into(), None);
        assert!(
            result.is_err(),
            "local=none 的 app 不得写入 papr.fs: {result:?}"
        );

        // 声明 local=write 后写入放行
        let m2 = manifest::PaprManifest {
            local: Some(PaprLocalAccess::Write),
            ..m.clone()
        };
        manifest::store_manifest("noperm-app", m);
        manifest::store_manifest("noperm-app", m2);
        let result = papr_fs_write("noperm-app".into(), "f.txt".into(), "data".into(), None);
        assert!(result.is_ok(), "local=write 应允许 papr.fs 写入: {result:?}");

        crate::papr_runtime::app_context::unregister("noperm-app");
        manifest::clear_manifest("noperm-app");
    }

    #[test]
    fn papr_delete_app_removes_directory_and_storage() {
        let ws = TestWorkspace::new("papr-delete-app");
        register_test_app(&ws.workspace_arg(), "del-app", &["storage:read", "storage:write"]);

        let app_dir = ws.file_path(".CodePapr/apps/del-app");
        fs::create_dir_all(&app_dir).unwrap();
        fs::write(app_dir.join("index.html"), b"<html></html>").unwrap();

        papr_fs_write("del-app".into(), "settings.json".into(), r#"{"theme":"dark"}"#.into(), None).unwrap();
        codepapr_core::db::papr_storage_set(&ws.workspace_arg(), "del-app", "k", "v").unwrap();
        assert!(app_dir.join("db.sqlite").exists());

        papr_delete_app("del-app".into()).unwrap();

        // app 目录连同其中的 db.sqlite 一起被删除
        assert!(!app_dir.exists());
    }

    #[test]
    fn ssrf_internal_targets_are_blocked() {
        let blocked = [
            "http://127.0.0.1/",
            "http://127.1/",                 // short IPv4 form
            "http://2130706433/",            // decimal IPv4 (== 127.0.0.1)
            "http://0x7f.0.0.1/",            // hex octet
            "http://0.0.0.0/",
            "http://0/",
            "http://10.0.0.5/",
            "http://172.16.0.1/",
            "http://192.168.1.1/",
            "http://169.254.169.254/",       // cloud metadata
            "http://100.64.0.1/",            // CGNAT
            "http://localhost/",
            "http://foo.localhost/",
            "http://app.local/",
            "http://metadata.google.internal/",
            "http://[::1]/",
            "http://[::ffff:127.0.0.1]/",    // IPv6-mapped IPv4
            "http://[::127.0.0.1]/",         // IPv4-compatible IPv6（RFC 4291 §2.5.5.1）
            "http://[::192.168.1.1]/",       // IPv4-compatible 内网
            "http://[fe80::1]/",
            "http://[fd00::1]/",
        ];
        for url in blocked {
            assert!(is_private_or_internal_url(url), "should block {url}");
        }
    }

    #[test]
    fn ssrf_public_targets_are_allowed() {
        let allowed = [
            "https://example.com/",
            "https://8.8.8.8/",
            "https://1.1.1.1/",
            "https://93.184.216.34/",
            "http://[2606:4700:4700::1111]/",
        ];
        for url in allowed {
            assert!(!is_private_or_internal_url(url), "should allow {url}");
        }
    }

    fn drain_chunks(chunks: &[&[u8]], cap: usize) -> (Vec<u8>, bool) {
        let mut buffer: Vec<u8> = Vec::new();
        let mut truncated = false;
        for chunk in chunks {
            if append_capped(&mut buffer, chunk, cap) {
                truncated = true;
                break;
            }
        }
        (buffer, truncated)
    }

    #[test]
    fn capped_read_keeps_small_bodies_intact() {
        let (body, truncated) = drain_chunks(&[b"hello ", b"world"], 1_000);
        assert_eq!(body, b"hello world");
        assert!(!truncated);
    }

    #[test]
    fn capped_read_stops_mid_chunk_at_limit() {
        // 回归：旧实现 bytes() 全量读取后才截断；现在达到上限立即停止
        let (body, truncated) = drain_chunks(&[b"abcdef", b"ghijkl", b"mnop"], 8);
        assert_eq!(body, b"abcdefgh");
        assert!(truncated);
    }

    #[test]
    fn capped_read_exact_fit_is_not_truncated() {
        let (body, truncated) = drain_chunks(&[b"abcd", b"efgh"], 8);
        assert_eq!(body, b"abcdefgh");
        assert!(!truncated);
    }

    #[test]
    fn capped_read_marks_truncated_when_more_data_follows_exact_fit() {
        let (body, truncated) = drain_chunks(&[b"abcd", b"efgh", b"extra"], 8);
        assert_eq!(body, b"abcdefgh");
        assert!(truncated);
    }

    #[test]
    fn capped_read_memory_bounded_against_huge_response() {
        // 模拟 1000 个 64KB 块（约 64MB 响应）：缓冲区不得超过上限
        let chunk = vec![b'x'; 65_536];
        let chunks: Vec<&[u8]> = vec![chunk.as_slice(); 1000];
        let (body, truncated) = drain_chunks(&chunks, MAX_PAPR_HTTP_BYTES);
        assert!(body.len() <= MAX_PAPR_HTTP_BYTES);
        assert!(truncated);
    }

    #[test]
    fn sanitize_http_headers_allowlist() {
        let mut ok = HashMap::new();
        ok.insert("Authorization".into(), "Bearer t".into());
        ok.insert("X-Custom".into(), "1".into());
        ok.insert("Content-Type".into(), "application/json".into());
        assert_eq!(sanitize_http_headers(Some(ok)).unwrap().len(), 3);

        let mut blocked = HashMap::new();
        blocked.insert("Cookie".into(), "a=b".into());
        assert!(sanitize_http_headers(Some(blocked)).unwrap_err().contains("不允许"));

        let mut host = HashMap::new();
        host.insert("Host".into(), "evil.test".into());
        assert!(sanitize_http_headers(Some(host)).is_err());
    }

    #[test]
    fn decode_http_body_keeps_json_whitespace() {
        let json = "{\n  \"ok\": true\n}";
        let (body, truncated) = decode_http_body(Some("application/json"), json.as_bytes(), 10_000, true);
        assert!(!truncated);
        assert_eq!(body, json);
        assert!(body.contains('\n'));
    }

    #[test]
    fn fs_base64_roundtrip_and_exists() {
        let ws = TestWorkspace::new("papr-fs-b64");
        register_test_app(&ws.workspace_arg(), "b64-app", &[]);

        let raw = vec![0u8, 1, 2, 255, 128];
        let encoded = base64::engine::general_purpose::STANDARD.encode(&raw);
        papr_fs_write("b64-app".into(), "blob.bin".into(), encoded, Some("base64".into())).unwrap();
        let back = papr_fs_read("b64-app".into(), "blob.bin".into(), None, Some("base64".into())).unwrap();
        let decoded = base64::engine::general_purpose::STANDARD.decode(back).unwrap();
        assert_eq!(decoded, raw);

        assert!(papr_fs_exists("b64-app".into(), "blob.bin".into()).unwrap());
        assert!(!papr_fs_exists("b64-app".into(), "missing.bin".into()).unwrap());
        assert!(papr_fs_exists("b64-app".into(), "../evil".into()).is_err());

        unregister_test_app("b64-app");
    }
}
