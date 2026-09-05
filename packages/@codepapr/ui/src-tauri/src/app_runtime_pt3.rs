/// 按两轴权限构建 app 文档的 CSP：
/// - 网络关：只允许同源 + 自身后端端口（无后端则纯同源），img/form 全禁外发；
/// - 网络开：额外放行 https/wss/ws 与 https 图片/表单；
/// - script-src 始终放行 https:（CDN 图表库），connect-src 关闭时无法回传数据；
/// - frame-src / blob: 放行同源、自身后端与 blob URL，供 `<a download>` 与隐藏 iframe 下载。
pub(crate) fn build_app_csp(
    access: crate::papr_runtime::permission::PaprAccess,
    port: Option<u16>,
) -> String {
    let mut connect: Vec<String> = vec!["'self'".to_string()];
    let mut frame: Vec<String> = vec!["'self'".to_string(), "blob:".to_string()];
    let mut img: Vec<String> = vec!["'self'".to_string(), "data:".to_string(), "blob:".to_string()];
    let mut form: Vec<String> = vec!["'none'".to_string()];
    if let Some(p) = port {
        let localhost = format!("http://localhost:{p}");
        let loopback = format!("http://127.0.0.1:{p}");
        connect.push(localhost.clone());
        connect.push(loopback.clone());
        frame.push(localhost);
        frame.push(loopback);
    }
    if access.network {
        connect.push("https:".to_string());
        connect.push("http:".to_string());
        connect.push("wss:".to_string());
        connect.push("ws:".to_string());
        img.push("https:".to_string());
        form.push("https:".to_string());
    }
    let script_src = if access.network {
        "'self' https: 'unsafe-inline' 'wasm-unsafe-eval'"
    } else {
        "'self' 'unsafe-inline' 'wasm-unsafe-eval'"
    };
    let style_src = if access.network {
        "'self' 'unsafe-inline' https:"
    } else {
        "'self' 'unsafe-inline'"
    };
    let font_src = if access.network {
        "'self' data: https:"
    } else {
        "'self' data:"
    };
    format!(
        "default-src 'none'; script-src {script_src}; \
         style-src {style_src}; img-src {}; \
         font-src {font_src}; media-src 'self' data: blob:; worker-src 'self' blob:; \
         frame-src {}; connect-src {}; form-action {}",
        img.join(" "),
        frame.join(" "),
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
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

fn scan_apps_in_dir(apps_dir: &std::path::Path, scope: &str) -> Vec<DiscoveredApp> {
    if !apps_dir.is_dir() {
        return vec![];
    }
    let entries = match fs::read_dir(apps_dir) {
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
        if !is_valid_app_id(&app_id) {
            continue;
        }
        let (manifest, manifest_raw) = match papr_runtime::manifest::load_manifest_with_raw(apps_dir, &app_id) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let entry_file = manifest.entry.as_deref().unwrap_or("index.html");
        let index_path = path.join(entry_file);
        if !index_path.is_file() {
            continue;
        }
        // 透传磁盘原文：serde 结构体会剥离未声明字段（inbox 曾因此丢失），
        // 前端「已启用插件」目录与 app_publish 频道校验都依赖完整 manifest。
        let manifest_json = Some(manifest_raw);
        papr_runtime::manifest::store_manifest(&app_id, manifest.clone());
        apps.push(DiscoveredApp {
            app_id,
            title: manifest.name,
            html: String::new(),
            manifest_json,
            command: manifest.command,
            args: manifest.args,
            port: manifest.port,
            icon: manifest.icon,
            scope: Some(scope.to_string()),
        });
    }
    apps
}

#[tauri::command]
pub fn scan_workspace_apps(workspace_path: String) -> Vec<DiscoveredApp> {
    let mut app_map: std::collections::HashMap<String, DiscoveredApp> = std::collections::HashMap::new();
    if let Ok(global_dir) = global_apps_dir() {
        for app in scan_apps_in_dir(&global_dir, "global") {
            app_map.insert(app.app_id.clone(), app);
        }
    }
    if !workspace_path.is_empty() {
        let ws_apps_dir = std::path::PathBuf::from(&workspace_path).join(".CodePapr/apps");
        for app in scan_apps_in_dir(&ws_apps_dir, "workspace") {
            app_map.insert(app.app_id.clone(), app);
        }
    }
    let mut result: Vec<DiscoveredApp> = app_map.into_values().collect();
    result.sort_by(|a, b| a.app_id.cmp(&b.app_id));
    result
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

    fn unique_tmp(label: &str) -> std::path::PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("papr-{label}-{}-{unique}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn d2_protocol_serves_without_wildcard_cors() {
        // 错误路径（resp() 构造）
        let unregistered = serve_app_uri("codepapr-app://d2-app/index.html");
        assert_eq!(unregistered.status(), StatusCode::NOT_FOUND);
        assert!(unregistered
            .headers()
            .get("Access-Control-Allow-Origin")
            .is_none());
        let traversal = serve_app_uri("codepapr-app://d2-app/sub/../../x.html");
        assert_eq!(traversal.status(), StatusCode::FORBIDDEN);
        assert!(traversal
            .headers()
            .get("Access-Control-Allow-Origin")
            .is_none());

        // 200 成功路径：同源 iframe 自己加载资源不需要 ACAO
        let tmp = unique_tmp("d2-cors");
        let app_dir = tmp.join(".CodePapr").join("apps").join("d2-app");
        fs::create_dir_all(&app_dir).unwrap();
        fs::write(
            app_dir.join("manifest.json"),
            r#"{"spec":"papr/0.1","name":"D2","local":"none","network":false}"#,
        )
        .unwrap();
        fs::write(app_dir.join("index.html"), "<html>ok</html>").unwrap();
        register_app_workspace(
            "d2-app".into(),
            tmp.to_string_lossy().to_string(),
            Some(r#"{"spec":"papr/0.1","name":"D2","local":"none","network":false}"#.into()),
        )
        .expect("register");
        let ok = serve_app_uri("codepapr-app://d2-app/index.html");
        assert_eq!(ok.status(), StatusCode::OK);
        assert!(ok.headers().get("Access-Control-Allow-Origin").is_none());
        // app 的私有 db.sqlite 依旧不可 serve（防线不变）
        fs::write(app_dir.join("db.sqlite"), b"x").unwrap();
        assert_eq!(
            serve_app_uri("codepapr-app://d2-app/db.sqlite").status(),
            StatusCode::NOT_FOUND
        );
        unregister_app_workspace("d2-app".into());
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn app_id_kebab_gate_d1() {
        assert!(is_valid_app_id_strict("my-app1"));
        assert!(is_valid_app_id_strict(&"a".repeat(63)));
        // 大写会被 URL host 引擎小写化；空格/点/前导连字符产生畸形 origin
        assert!(!is_valid_app_id_strict("MyApp"));
        assert!(!is_valid_app_id_strict("my app"));
        assert!(!is_valid_app_id_strict("my.app"));
        assert!(!is_valid_app_id_strict("-lead"));
        assert!(!is_valid_app_id_strict(""));
        assert!(!is_valid_app_id_strict(&"a".repeat(64)));
    }

    #[test]
    fn register_rejects_new_non_kebab_allows_legacy_dir_d1() {
        let tmp = unique_tmp("reg-kebab");
        let ws = tmp.to_string_lossy().to_string();

        // 新装非 kebab id：拒绝
        let err = register_app_workspace("My App".into(), ws.clone(), None).unwrap_err();
        assert!(err.contains("kebab-case"), "unexpected: {err}");

        // 存量豁免：盘上已有 manifest 的非规范 id 可恢复注册（老用户不失效）
        let legacy_dir = tmp.join(".CodePapr").join("apps").join("MyLegacy");
        fs::create_dir_all(&legacy_dir).unwrap();
        fs::write(
            legacy_dir.join("manifest.json"),
            r#"{"spec":"papr/0.1","name":"My Legacy"}"#,
        )
        .unwrap();
        register_app_workspace("MyLegacy".into(), ws.clone(), None)
            .expect("legacy non-kebab dir must stay registrable");
        unregister_app_workspace("MyLegacy".into());

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn register_with_manifest_json_populates_cache() {
        let tmp = std::env::temp_dir().join(format!("papr-regmanifest-{}", std::process::id()));
        fs::create_dir_all(&tmp).unwrap();

        // 带合法 manifest_json：注册即写缓存（app_render 后首开不再 "manifest not loaded"）。
        let manifest = r#"{"spec":"papr/0.1","name":"RegApp","local":"read","network":false}"#;
        register_app_workspace(
            "reg-manifest-app".into(),
            tmp.to_string_lossy().to_string(),
            Some(manifest.into()),
        )
        .expect("register should succeed");
        let cached = papr_runtime::manifest::get_manifest("reg-manifest-app").expect("manifest cached");
        assert_eq!(cached.name, "RegApp");
        assert_eq!(cached.local, Some(papr_runtime::permission::PaprLocalAccess::Read));

        // 非法 spec 拒绝且不动缓存。
        let bad = register_app_workspace(
            "reg-manifest-app".into(),
            tmp.to_string_lossy().to_string(),
            Some(r#"{"spec":"bad/1.0","name":"X"}"#.into()),
        );
        assert!(bad.is_err());
        assert_eq!(
            papr_runtime::manifest::get_manifest("reg-manifest-app").unwrap().name,
            "RegApp"
        );

        // 不带 manifest_json：保持旧行为（只注册 workspace 映射）。
        register_app_workspace("reg-nomanifest-app".into(), tmp.to_string_lossy().to_string(), None)
            .expect("register without manifest ok");
        assert!(papr_runtime::manifest::get_manifest("reg-nomanifest-app").is_err());

        unregister_app_workspace("reg-manifest-app".into());
        unregister_app_workspace("reg-nomanifest-app".into());
        fs::remove_dir_all(&tmp).ok();
    }

    fn workspace_scan(workspace: impl Into<String>) -> Vec<DiscoveredApp> {
        scan_workspace_apps(workspace.into())
            .into_iter()
            .filter(|app| app.scope.as_deref() == Some("workspace"))
            .collect()
    }

    #[test]
    fn scan_discovers_app_with_valid_manifest() {
        let tmp = std::env::temp_dir().join(format!("papr-scan-{}", std::process::id()));
        let apps_dir = tmp.join(".CodePapr/apps/valid-app");
        fs::create_dir_all(&apps_dir).unwrap();

        let manifest = r#"{"spec":"papr/0.1","name":"ValidApp","version":"1.0","permissions":["storage:read"]}"#;
        fs::write(apps_dir.join("manifest.json"), manifest).unwrap();
        fs::write(apps_dir.join("index.html"), "<html><title>Test</title></html>").unwrap();

        let result = workspace_scan(tmp.to_string_lossy().to_string());
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].app_id, "valid-app");
        assert_eq!(result[0].title, "ValidApp");
        assert!(result[0].manifest_json.is_some());
        assert_eq!(result[0].icon.as_deref(), None);

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn scan_reads_icon_from_manifest() {
        let tmp = std::env::temp_dir().join(format!("papr-scan-icon-{}", std::process::id()));
        let apps_dir = tmp.join(".CodePapr/apps/icon-app");
        fs::create_dir_all(&apps_dir).unwrap();

        let manifest = r#"{"spec":"papr/0.1","name":"IconApp","icon":"📊"}"#;
        fs::write(apps_dir.join("manifest.json"), manifest).unwrap();
        fs::write(apps_dir.join("index.html"), "<html></html>").unwrap();

        let result = workspace_scan(tmp.to_string_lossy().to_string());
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].icon.as_deref(), Some("📊"));

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn scan_manifest_json_preserves_inbox_and_unknown_fields() {
        // 回归：scan 曾把 manifest 过一遍 Rust 结构体重序列化，serde 丢弃未知字段
        // （inbox），导致前端「已启用插件」目录与 app_publish 频道校验全部失明。
        // 现在必须透传磁盘原文。
        let tmp = std::env::temp_dir().join(format!("papr-scan-inbox-{}", std::process::id()));
        let apps_dir = tmp.join(".CodePapr/apps/kanban");
        fs::create_dir_all(&apps_dir).unwrap();

        let manifest = r#"{"spec":"papr/0.1","name":"看板","kind":"plugin","description":"极简看板","lifecycle":{"show":"onDemand"},"inbox":{"board":{"description":"推送看板","example":{"op":"replace"}}}}"#;
        fs::write(apps_dir.join("manifest.json"), manifest).unwrap();
        fs::write(apps_dir.join("index.html"), "<html></html>").unwrap();

        let result = workspace_scan(tmp.to_string_lossy().to_string());
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0].manifest_json.as_deref(),
            Some(manifest),
            "scan 必须原样透传 manifest.json"
        );

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn scan_skips_dir_without_manifest() {
        let tmp = std::env::temp_dir().join(format!("papr-scan-nomanifest-{}", std::process::id()));
        let apps_dir = tmp.join(".CodePapr/apps/no-manifest-app");
        fs::create_dir_all(&apps_dir).unwrap();
        fs::write(apps_dir.join("index.html"), "<html></html>").unwrap();

        let result = workspace_scan(tmp.to_string_lossy().to_string());
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

        let result = workspace_scan(tmp.to_string_lossy().to_string());
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

        let result = workspace_scan(tmp.to_string_lossy().to_string());
        assert_eq!(result.len(), 1);
        let app = &result[0];
        assert_eq!(app.app_id, "full-app");
        assert_eq!(app.title, "Full App");
        assert!(app.html.is_empty());
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
        assert!(csp.contains("frame-src 'self' blob:;"), "got: {csp}");
        assert!(csp.contains("form-action 'none'"), "got: {csp}");
        assert!(!csp.contains("wss:"), "got: {csp}");
        // connect/img/form 不允许 https；离线也不放行 CDN script-src https:
        assert!(!csp.contains("connect-src 'self' https:"), "got: {csp}");
        assert!(!csp.contains("img-src 'self' data: https:"), "got: {csp}");
        assert!(!csp.contains("script-src 'self' https:"), "got: {csp}");
        assert!(csp.contains("script-src 'self' 'unsafe-inline'"), "got: {csp}");
    }

    #[test]
    fn csp_allows_own_backend_port_when_network_off() {
        use crate::papr_runtime::permission::{PaprAccess, PaprLocalAccess};
        let access = PaprAccess { local: PaprLocalAccess::Read, network: false };
        let csp = build_app_csp(access, Some(3456));
        assert!(csp.contains("http://localhost:3456"), "got: {csp}");
        assert!(csp.contains("http://127.0.0.1:3456"), "got: {csp}");
        assert!(csp.contains("frame-src 'self' blob: http://localhost:3456"), "got: {csp}");
        assert!(!csp.contains("wss:"), "got: {csp}");
    }

    #[test]
    fn csp_opens_public_network_when_network_on() {
        use crate::papr_runtime::permission::{PaprAccess, PaprLocalAccess};
        let access = PaprAccess { local: PaprLocalAccess::Read, network: true };
        let csp = build_app_csp(access, None);
        assert!(csp.contains("connect-src 'self' https: http: wss: ws:"), "got: {csp}");
        assert!(csp.contains("form-action 'none' https:"), "got: {csp}");
        assert!(csp.contains("img-src 'self' data: blob: https:"), "got: {csp}");
        assert!(csp.contains("frame-src 'self' blob:"), "got: {csp}");
        assert!(csp.contains("script-src 'self' https:"), "got: {csp}");
    }

    #[test]
    fn frontend_mtime_includes_nested_css_and_js() {
        let tmp = std::env::temp_dir().join(format!("papr-mtime-{}", std::process::id()));
        let app = tmp.join(".CodePapr/apps/ticker");
        fs::create_dir_all(app.join("js")).unwrap();
        fs::create_dir_all(app.join("css")).unwrap();
        fs::create_dir_all(app.join("node_modules/pkg")).unwrap();
        fs::write(app.join("css/theme.css"), "body{}").unwrap();
        fs::write(app.join("js/main.js"), "console.log(1)").unwrap();
        fs::write(app.join("node_modules/pkg/index.js"), "ignored").unwrap();
        let mtime = app_frontend_mtime(tmp.to_string_lossy().into(), "ticker".into()).unwrap();
        assert!(mtime > 0, "nested css/js must contribute to frontend mtime");

        let empty = tmp.join(".CodePapr/apps/empty-plugin");
        fs::create_dir_all(empty.join("node_modules/pkg")).unwrap();
        fs::write(empty.join("node_modules/pkg/index.js"), "ignored").unwrap();
        let skipped = app_frontend_mtime(tmp.to_string_lossy().into(), "empty-plugin".into()).unwrap();
        assert_eq!(skipped, 0, "node_modules must not trigger frontend reload");
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn skip_export_entries_exclude_runtime_payload() {
        assert!(skip_app_export_entry("node_modules"));
        assert!(skip_app_export_entry(".versions"));
        assert!(skip_app_export_entry("data"));
        assert!(skip_app_export_entry("db.sqlite"));
        assert!(skip_app_export_entry("db.sqlite-wal"));
        assert!(!skip_app_export_entry("index.html"));
        assert!(!skip_app_export_entry("server.js"));
        assert!(!skip_app_export_entry("package.json"));
    }

    #[test]
    fn netstat_listen_pid_parsing() {
        let win = "  TCP    127.0.0.1:3456         0.0.0.0:0              LISTENING       4242\r\n\
              TCP    0.0.0.0:13456          0.0.0.0:0              LISTENING       99\r\n";
        assert_eq!(parse_netstat_listen_pids(win, 3456), vec![4242]);
        let linux = "tcp  0  0 127.0.0.1:8080  0.0.0.0:*  LISTEN  1001/node\n";
        assert_eq!(parse_netstat_listen_pids(linux, 8080), vec![1001]);
    }

    #[test]
    fn allocate_prefers_free_declared_port() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let busy = listener.local_addr().unwrap().port();
        let allocated = allocate_app_port(busy).expect("should find a free port");
        assert_ne!(allocated, busy);
        drop(listener);
        let same = allocate_app_port(busy).expect("freed port should be reusable");
        assert_eq!(same, busy);
    }

    #[test]
    fn snapshot_and_export_skip_sqlite_and_node_modules() {
        let tmp = std::env::temp_dir().join(format!("papr-snap-{}", std::process::id()));
        let app = tmp.join(".CodePapr/apps/snap-app");
        fs::create_dir_all(app.join("node_modules/pkg")).unwrap();
        fs::write(app.join("index.html"), "<html>v1</html>").unwrap();
        fs::write(app.join("manifest.json"), "{\"name\":\"snap\"}").unwrap();
        fs::write(app.join("db.sqlite"), "secret").unwrap();
        fs::write(app.join("node_modules/pkg/index.js"), "x").unwrap();

        let snap = papr_snapshot_app(tmp.to_string_lossy().into(), "snap-app".into())
            .unwrap()
            .expect("snapshot path");
        let snap_path = std::path::PathBuf::from(&snap);
        assert!(snap_path.join("index.html").is_file());
        assert!(!snap_path.join("db.sqlite").exists());
        assert!(!snap_path.join("node_modules").exists());

        let zip_path = tmp.join("snap-app.zip");
        papr_export_app(
            tmp.to_string_lossy().into(),
            "snap-app".into(),
            zip_path.to_string_lossy().into(),
        )
        .unwrap();
        assert!(zip_path.is_file());
        let bytes = fs::read(&zip_path).unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(names.iter().any(|n| n == "index.html" || n.ends_with("/index.html")));
        assert!(names.iter().all(|n| !n.contains("db.sqlite") && !n.contains("node_modules")));

        fs::remove_dir_all(&tmp).ok();
    }
}
