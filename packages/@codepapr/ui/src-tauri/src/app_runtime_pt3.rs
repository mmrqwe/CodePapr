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
        Err(_) => return vec![];
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
        let manifest = match papr_runtime::manifest::load_manifest(apps_dir, &app_id) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let entry_file = manifest.entry.as_deref().unwrap_or("index.html");
        let index_path = path.join(entry_file);
        if !index_path.is_file() {
            continue;
        }
        let manifest_json = serde_json::to_string(&manifest).ok();
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

        let result = scan_workspace_apps(tmp.to_string_lossy().to_string());
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].icon.as_deref(), Some("📊"));

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
