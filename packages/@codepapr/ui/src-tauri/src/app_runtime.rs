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
    let mut map = app_workspaces().lock().unwrap();
    map.insert(app_id.clone(), workspace_path.clone());
    papr_runtime::app_context::register(&app_id, &workspace_path);
}

#[tauri::command]
pub fn unregister_app_workspace(app_id: String) {
    let mut map = app_workspaces().lock().unwrap();
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

    if file_path.contains("..") || file_path.contains('\\') {
        return Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body("path traversal blocked".into())
            .unwrap();
    }

    if file_path == "__papr_sdk.js" {
        let sdk = papr_runtime::sdk_inject::get_sdk_js();
        return Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", "application/javascript; charset=utf-8")
            .header("Access-Control-Allow-Origin", "*")
            .header("Cache-Control", "no-cache")
            .body(sdk.as_bytes().to_vec())
            .unwrap();
    }

    let map = app_workspaces().lock().unwrap();
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

    let full_path = format!("{}/.CodePapr/apps/{}/{}", workspace, app_id, file_path);

    let content = match fs::read(&full_path) {
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
        let injected = papr_runtime::sdk_inject::inject_sdk_into_html(&html);
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
        });
    }

    apps
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

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
}
