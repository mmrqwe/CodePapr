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
/// macOS/Linux 优先 lsof；Windows / 无 lsof 时回落 netstat，不能只靠 lsof。
#[tauri::command]
pub fn check_port_owner(port: u16) -> Vec<u32> {
    let mut pids = check_port_owner_lsof(port);
    if pids.is_empty() {
        pids = check_port_owner_netstat(port);
    }
    pids.sort_unstable();
    pids.dedup();
    pids
}

fn check_port_owner_lsof(port: u16) -> Vec<u32> {
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

fn check_port_owner_netstat(port: u16) -> Vec<u32> {
    let output = if cfg!(windows) {
        std::process::Command::new("netstat")
            .args(["-ano", "-p", "TCP"])
            .output()
    } else {
        std::process::Command::new("netstat")
            .args(["-anv", "-p", "tcp"])
            .output()
            .or_else(|_| {
                std::process::Command::new("netstat")
                    .args(["-tlnp"])
                    .output()
            })
    };
    match output {
        Ok(out) if out.status.success() => {
            parse_netstat_listen_pids(&String::from_utf8_lossy(&out.stdout), port)
        }
        _ => Vec::new(),
    }
}

fn parse_netstat_listen_pids(stdout: &str, port: u16) -> Vec<u32> {
    let needle = format!(":{port}");
    let mut pids = Vec::new();
    for line in stdout.lines() {
        let upper = line.to_ascii_uppercase();
        if !upper.contains("LISTEN") {
            continue;
        }
        if !port_token_in_netstat_line(line, &needle) {
            continue;
        }
        if let Some(pid) = line
            .split_whitespace()
            .last()
            .and_then(|tok| tok.split('/').next())
            .and_then(|tok| tok.parse::<u32>().ok())
        {
            pids.push(pid);
        }
    }
    pids
}

fn port_token_in_netstat_line(line: &str, needle: &str) -> bool {
    line.split_whitespace().any(|tok| {
        let hostport = tok.split('%').next().unwrap_or(tok);
        hostport.ends_with(needle) || hostport.contains(&format!("{needle}["))
    })
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
    #[cfg(unix)]
    {
        return listeners.iter().any(|listener| {
            // SAFETY: listener 是 lsof/netstat 返回的真实进程 pid；getpgid 接受任意 pid
            let pgid = unsafe { libc::getpgid(*listener as libc::pid_t) };
            pgid == pid as libc::pid_t || *listener == pid
        });
    }
    #[cfg(not(unix))]
    {
        listeners.contains(&pid)
    }
}

/// 端口监听地址（lsof NAME 列解析出的 host 部分，如 "127.0.0.1"、"*"、
/// "::1"）。沙箱 SBPL 无法限制 bind 地址（`(local ip ...)` 过滤器在本平台
/// 对 bind 无效），回环约束必须在 app_start 启动期强制：`*` 或非回环地址
/// 说明后端把服务暴露到了局域网，启动必须失败并给出明确提示。
#[tauri::command]
pub fn check_port_bind_address(port: u16) -> Vec<String> {
    let lsof = std::process::Command::new("lsof")
        .args(["-nP", "-i", &format!(":{port}"), "-sTCP:LISTEN"])
        .output();
    if let Ok(out) = lsof {
        if out.status.success() {
            let hosts = parse_lsof_bind_hosts(&String::from_utf8_lossy(&out.stdout));
            if !hosts.is_empty() {
                return hosts;
            }
        }
    }
    parse_netstat_bind_hosts(
        &{
            let output = if cfg!(windows) {
                std::process::Command::new("netstat")
                    .args(["-ano", "-p", "TCP"])
                    .output()
            } else {
                std::process::Command::new("netstat")
                    .args(["-an", "-p", "tcp"])
                    .output()
            };
            match output {
                Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).into_owned(),
                _ => String::new(),
            }
        },
        port,
    )
}

fn parse_netstat_bind_hosts(stdout: &str, port: u16) -> Vec<String> {
    let needle = format!(":{port}");
    let mut hosts = Vec::new();
    for line in stdout.lines() {
        let upper = line.to_ascii_uppercase();
        if !upper.contains("LISTEN") {
            continue;
        }
        let Some(addr) = line.split_whitespace().nth(1) else {
            continue;
        };
        if !port_token_in_netstat_line(addr, &needle) && !addr.ends_with(&needle) {
            continue;
        }
        let host = addr
            .rsplit_once(':')
            .map(|(h, _)| h.trim_matches(|c| c == '[' || c == ']'))
            .unwrap_or(addr);
        let normalized = if host == "0.0.0.0" || host == "*" || host == "::" {
            "*".to_string()
        } else {
            host.to_string()
        };
        if !hosts.contains(&normalized) {
            hosts.push(normalized);
        }
    }
    hosts
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

    let workspace_app = format!("{}/.CodePapr/apps/{}", workspace, app_id);
    let app_base = if std::path::Path::new(&workspace_app).is_dir() {
        workspace_app
    } else if let Ok(global_dir) = global_apps_dir() {
        let global_app = global_dir.join(app_id);
        if global_app.is_dir() {
            global_app.to_string_lossy().into_owned()
        } else {
            return resp(StatusCode::NOT_FOUND, "app not found".to_string());
        }
    } else {
        return resp(StatusCode::NOT_FOUND, "app not found".to_string());
    };
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
            if let Some(port) = runtime_backend_port(app_id, manifest.port) {
                pre_scripts.push_str(&format!(
                    "<script>window.__PAPR_BACKEND_URL='http://127.0.0.1:{}';</script>\n",
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
/// - script-src 始终放行 https:（CDN 图表库），connect-src 关闭时无法回传数据；
/// - frame-src / blob: 放行同源、自身后端与 blob URL，供 `<a download>` 与隐藏 iframe 下载。
