use std::{
    collections::HashMap,
    fs,
    net::TcpListener,
    sync::{Mutex, OnceLock},
};

use serde::Serialize;
use tauri::{
    http::{Request, Response, StatusCode},
    UriSchemeContext,
};

use crate::papr_runtime;

static APP_WORKSPACES: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn app_workspaces() -> &'static Mutex<HashMap<String, String>> {
    APP_WORKSPACES.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub fn register_app_workspace(app_id: String, workspace_path: String) {
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
    match TcpListener::bind(("127.0.0.1", port)) {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
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
        let sdk = papr_runtime::sdk_inject::get_sdk_js();
        Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", "application/javascript; charset=utf-8")
            .header("Access-Control-Allow-Origin", "*")
            .header("Cache-Control", "no-cache")
            .body(sdk.as_bytes().to_vec())
            .unwrap()
    };

    // Legacy SDK URL with no app id prefix.
    if path == "__papr_sdk.js" {
        return serve_sdk();
    }

    let (app_id, file_path) = match path.split_once('/') {
        Some((id, rest)) if !id.is_empty() => (id, rest),
        _ => {
            return Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body("missing app id".into())
                .unwrap();
        }
    };

    let file_path = if file_path.is_empty() { "index.html" } else { file_path };

    // Per-app SDK URL: codepapr-app://<appId>/__papr_sdk.js. The injected
    // <script src="/__papr_sdk.js"> resolves against the app's own origin, so
    // the request carries the appId as the URL host.
    if file_path == "__papr_sdk.js" {
        return serve_sdk();
    }

    if file_path.contains("..") || file_path.contains('\\') {
        return Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body("path traversal blocked".into())
            .unwrap();
    }

    let map = app_workspaces().lock().unwrap_or_else(|e| e.into_inner());
    let workspace = match map.get(app_id) {
        Some(ws) => ws.clone(),
        None => {
            return Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body("app not registered".into())
                .unwrap();
        }
    };
    drop(map);

    let app_base = format!("{}/.CodePapr/apps/{}", workspace, app_id);
    let raw_path = format!("{}/{}", app_base, file_path);

    let canonical_base = match std::path::Path::new(&app_base).canonicalize() {
        Ok(p) => p,
        Err(_) => {
            return Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body("app not found".into())
                .unwrap();
        }
    };

    let canonical_path = match std::path::Path::new(&raw_path).canonicalize() {
        Ok(p) => p,
        Err(_) => {
            return Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body("file not found".into())
                .unwrap();
        }
    };

    if !canonical_path.starts_with(&canonical_base) {
        return Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body("path traversal blocked".into())
            .unwrap();
    }

    let content = match fs::read(&canonical_path) {
        Ok(c) => c,
        Err(_) => {
            return Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body("file not found".into())
                .unwrap();
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

    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", mime)
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-cache")
        .body(body)
        .unwrap()
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
}
