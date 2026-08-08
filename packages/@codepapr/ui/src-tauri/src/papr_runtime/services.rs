use std::fs;
use std::net::ToSocketAddrs;
use std::path::PathBuf;

use serde::Serialize;

use crate::papr_runtime::permission;
use crate::shared::{canonical_workspace, parse_browser_url};
use crate::web::client::build_papr_http_client;
use crate::web::text::{collapse_whitespace, html_to_text, truncate_text_to_bytes};

const MAX_PAPR_HTTP_BYTES: usize = 500_000;

fn is_internal_ipv4(ip: std::net::Ipv4Addr) -> bool {
    let octets = ip.octets();
    ip.is_loopback()           // 127.0.0.0/8
        || ip.is_private()     // 10/8, 172.16/12, 192.168/16
        || ip.is_link_local()  // 169.254/16 (incl. cloud metadata 169.254.169.254)
        || ip.is_unspecified() // 0.0.0.0
        || octets[0] == 0      // 0.0.0.0/8 "this" network
        || (octets[0] == 100 && (64..=127).contains(&octets[1])) // CGNAT 100.64/10
}

fn is_internal_ipv6(ip: std::net::Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return is_internal_ipv4(mapped); // ::ffff:127.0.0.1 etc.
    }
    if ip.is_loopback() || ip.is_unspecified() {
        return true; // ::1, ::
    }
    let first = ip.segments()[0];
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
fn resolve_safe_socket_addr(
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

#[tauri::command]
pub async fn papr_http_get(
    app_id: String,
    url: String,
    max_bytes: Option<usize>,
) -> Result<PaprHttpResult, String> {
    let manifest = crate::papr_runtime::manifest::get_manifest(&app_id)?;
    permission::check_permission(&manifest, &app_id, "http:get")?;

    let parsed_url = parse_browser_url(&url)?;
    if !parsed_url.starts_with("https://") && !parsed_url.starts_with("http://") {
        return Err("url 必须是 http 或 https URL".to_string());
    }
    if is_private_or_internal_url(&parsed_url) {
        return Err("安全限制：不允许访问内网/本地地址".to_string());
    }
    let parsed = url::Url::parse(&parsed_url).map_err(|err| format!("URL 解析失败: {err}"))?;
    let pin = resolve_safe_socket_addr(&parsed)?;

    let max = max_bytes.unwrap_or(50_000).clamp(1_000, MAX_PAPR_HTTP_BYTES);
    let client = build_papr_http_client(pin)?;
    let response = client
        .get(parsed_url)
        .header(reqwest::header::ACCEPT, "application/json, text/plain, text/html;q=0.9, */*;q=0.5")
        .send()
        .map_err(|err| format!("HTTP GET 失败: {err}"))?;

    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_string());

    let body_bytes = response
        .bytes()
        .map_err(|err| format!("读取响应失败: {err}"))?;
    let body_str = String::from_utf8_lossy(&body_bytes).into_owned();

    let is_html = content_type
        .as_deref()
        .map(|v| v.contains("html") || body_str.contains("<html"))
        .unwrap_or(false);

    let text = if is_html {
        html_to_text(&body_str)
    } else {
        collapse_whitespace(&body_str)
    };

    let (content, truncated) = truncate_text_to_bytes(text, max);

    Ok(PaprHttpResult {
        status: status.as_u16(),
        body: content,
        content_type,
        truncated,
    })
}

#[tauri::command]
pub async fn papr_http_post(
    app_id: String,
    url: String,
    body: String,
    content_type: Option<String>,
) -> Result<PaprHttpResult, String> {
    let manifest = crate::papr_runtime::manifest::get_manifest(&app_id)?;
    permission::check_permission(&manifest, &app_id, "http:post")?;

    let parsed_url = parse_browser_url(&url)?;
    if !parsed_url.starts_with("https://") && !parsed_url.starts_with("http://") {
        return Err("url 必须是 http 或 https URL".to_string());
    }
    if is_private_or_internal_url(&parsed_url) {
        return Err("安全限制：不允许访问内网/本地地址".to_string());
    }
    let parsed = url::Url::parse(&parsed_url).map_err(|err| format!("URL 解析失败: {err}"))?;
    let pin = resolve_safe_socket_addr(&parsed)?;

    let ct = content_type.unwrap_or_else(|| "application/json".to_string());
    let client = build_papr_http_client(pin)?;
    let response = client
        .post(parsed_url)
        .header(reqwest::header::CONTENT_TYPE, &ct)
        .body(body)
        .send()
        .map_err(|err| format!("HTTP POST 失败: {err}"))?;

    let status = response.status();
    let resp_content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_string());

    let body_bytes = response
        .bytes()
        .map_err(|err| format!("读取响应失败: {err}"))?;
    let body_str = String::from_utf8_lossy(&body_bytes).into_owned();
    let text = collapse_whitespace(&body_str);
    let (content, truncated) = truncate_text_to_bytes(text, 100_000);

    Ok(PaprHttpResult {
        status: status.as_u16(),
        body: content,
        content_type: resp_content_type,
        truncated,
    })
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
) -> Result<String, String> {
    let manifest = crate::papr_runtime::manifest::get_manifest(&app_id)?;
    permission::check_permission(&manifest, &app_id, "fs:read")?;

    let ctx = crate::papr_runtime::app_context::get(&app_id)?;
    if path.contains("..") || path.contains('\\') {
        return Err("path traversal blocked".to_string());
    }

    let resolved = resolve_app_path(&ctx.workspace_path, &app_id, &path)?;
    if !resolved.exists() {
        return Err(format!("file not found: {}", path));
    }

    let max = max_bytes.unwrap_or(200_000).clamp(1_000, 1_000_000);
    let content = fs::read_to_string(&resolved)
        .map_err(|err| format!("读取文件失败: {err}"))?;

    if content.len() > max {
        let truncated: String = content.chars().take(max).collect();
        return Ok(truncated);
    }

    Ok(content)
}

#[tauri::command]
pub fn papr_fs_write(
    app_id: String,
    path: String,
    content: String,
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

    fs::write(&resolved, content)
        .map_err(|err| format!("写入文件失败: {err}"))?;

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
    if subpath.contains("..") || subpath.contains('\\') {
        return Err("path traversal blocked".to_string());
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
    if path.contains("..") || path.contains('\\') || path.is_empty() {
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

// ── App lifecycle ────────────────────────────────────────────────────

#[tauri::command]
pub fn papr_delete_app(app_id: String) -> Result<(), String> {
    let ctx = crate::papr_runtime::app_context::get(&app_id)?;

    if let Ok(manifest) = crate::papr_runtime::manifest::get_manifest(&app_id) {
        if let Some(port) = manifest.port {
            let _ = stop_app_backend_processes(&ctx.workspace_path, port);
        }
    }

    let workspace = crate::shared::canonical_workspace(&ctx.workspace_path)?;
    let app_dir = workspace
        .join(".CodePapr")
        .join("apps")
        .join(&app_id);

    if app_dir.exists() {
        fs::remove_dir_all(&app_dir)
            .map_err(|err| format!("删除 app 目录失败: {err}"))?;
    }

    // papr.db 数据（db.sqlite）位于 app 目录内，随目录一并删除，无需单独清理。

    crate::papr_runtime::app_context::unregister(&app_id);
    crate::papr_runtime::manifest::clear_manifest(&app_id);

    Ok(())
}

fn stop_app_backend_processes(workspace_path: &str, port: u16) -> Result<usize, String> {
    let target_url = format!("http://localhost:{}/", port);
    let target_url_no_slash = format!("http://localhost:{}", port);

    crate::shell::background::with_background_processes(|processes| {
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

        let mut stopped = 0usize;
        for pid in target_pids {
            if let Some(mut process) = processes.remove(&pid) {
                let still_running = match process.child.try_wait() {
                    Ok(Some(_)) => false,
                    Ok(None) => true,
                    Err(_) => true,
                };
                if still_running {
                    let _ = process.child.kill();
                    let _ = process.child.wait();
                    stopped += 1;
                }
            }
        }
        Ok(stopped)
    })
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::papr_runtime::manifest;
    use crate::test_helpers::TestWorkspace;

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
            permissions: Some(perms),
            agents: None,
            command: None,
            args: None,
            port: None,
            level: None,
            local: None,
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
        register_test_app(&ws.workspace_arg(), "test-app", &[]);

        papr_fs_write("test-app".into(), "hello.txt".into(), "Hello World".into()).unwrap();
        let content = papr_fs_read("test-app".into(), "hello.txt".into(), None).unwrap();
        assert_eq!(content, "Hello World");

        unregister_test_app("test-app");
    }

    #[test]
    fn fs_write_auto_creates_subdirectories() {
        let ws = TestWorkspace::new("papr-fs-nested");
        register_test_app(&ws.workspace_arg(), "nested-app", &[]);

        // 写嵌套路径：父目录不存在时应自动创建（博客 posts/ 分目录场景）
        papr_fs_write("nested-app".into(), "posts/first.md".into(), "# Hello".into()).unwrap();
        papr_fs_write("nested-app".into(), "posts/archive/old.md".into(), "# Old".into()).unwrap();

        assert!(ws
            .file_path(".CodePapr/apps/nested-app/data/posts/first.md")
            .exists());
        assert!(ws
            .file_path(".CodePapr/apps/nested-app/data/posts/archive/old.md")
            .exists());
        let content = papr_fs_read("nested-app".into(), "posts/archive/old.md".into(), None).unwrap();
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
        assert!(papr_fs_write("escape-app".into(), "/tmp/evil.txt".into(), "x".into()).is_err());
        assert!(papr_fs_write("escape-app".into(), "../evil.txt".into(), "x".into()).is_err());
        assert!(papr_fs_write("escape-app".into(), "a\\..\\evil.txt".into(), "x".into()).is_err());
        assert!(!ws.file_path(".CodePapr/apps/escape-app/data/../evil.txt").exists());
        assert!(!ws.file_path("/tmp/evil.txt").exists());

        unregister_test_app("escape-app");
    }

    #[test]
    fn fs_path_traversal_blocked() {
        let ws = TestWorkspace::new("papr-fs-traversal");
        register_test_app(&ws.workspace_arg(), "traversal-app", &[]);

        let result = papr_fs_read("traversal-app".into(), "../secret.txt".into(), None);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("traversal"));

        unregister_test_app("traversal-app");
    }

    #[test]
    fn fs_delete_removes_file() {
        let ws = TestWorkspace::new("papr-fs-delete");
        register_test_app(&ws.workspace_arg(), "delete-app", &[]);

        papr_fs_write("delete-app".into(), "temp.txt".into(), "data".into()).unwrap();
        assert!(papr_fs_read("delete-app".into(), "temp.txt".into(), None).is_ok());

        papr_fs_delete("delete-app".into(), "temp.txt".into()).unwrap();
        assert!(papr_fs_read("delete-app".into(), "temp.txt".into(), None).is_err());

        unregister_test_app("delete-app");
    }

    #[test]
    fn fs_list_returns_files() {
        let ws = TestWorkspace::new("papr-fs-list");
        register_test_app(&ws.workspace_arg(), "list-app", &[]);

        papr_fs_write("list-app".into(), "a.txt".into(), "a".into()).unwrap();
        papr_fs_write("list-app".into(), "b.txt".into(), "b".into()).unwrap();

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

        let result = papr_fs_read("missing-app".into(), "nope.txt".into(), None);
        assert!(result.is_err());

        unregister_test_app("missing-app");
    }

    #[test]
    fn fs_permission_denied_without_grant() {
        let ws = TestWorkspace::new("papr-fs-perm");
        crate::papr_runtime::app_context::register("noperm-app", &ws.workspace_arg());

        let m = manifest::PaprManifest {
            spec: "papr/0.1".into(),
            name: "NoPerm".into(),
            version: None,
            entry: None,
            permissions: Some(vec!["storage:read".to_string()]),
            agents: None,
            command: None,
            args: None,
            port: None,
            level: None,
            local: None,
            network: None,
        };
        manifest::store_manifest("noperm-app", m);

        // 两轴模型：papr.fs 是 app 自有沙箱，永远可用，无需声明任何权限
        let result = papr_fs_write("noperm-app".into(), "f.txt".into(), "data".into());
        assert!(result.is_ok());

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

        papr_fs_write("del-app".into(), "settings.json".into(), r#"{"theme":"dark"}"#.into()).unwrap();
        crate::db::papr_storage_set(&ws.workspace_arg(), "del-app", "k", "v").unwrap();
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
}
