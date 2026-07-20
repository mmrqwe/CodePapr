use std::{
    collections::HashMap,
    fs,
    sync::{Mutex, OnceLock},
};

use tauri::{
    http::{Request, Response, ResponseBuilder, StatusCode},
    AppHandle,
};

static APP_WORKSPACES: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn app_workspaces() -> &'static Mutex<HashMap<String, String>> {
    APP_WORKSPACES.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub fn register_app_workspace(app_id: String, workspace_path: String) {
    let mut map = app_workspaces().lock().unwrap();
    map.insert(app_id, workspace_path);
}

#[tauri::command]
pub fn unregister_app_workspace(app_id: String) {
    let mut map = app_workspaces().lock().unwrap();
    map.remove(&app_id);
}

pub fn handle_app_protocol(
    _app: &AppHandle,
    request: &Request,
) -> Result<Response, Box<dyn std::error::Error>> {
    let uri = request.uri().to_string();

    let path = uri
        .strip_prefix("codepapr-app://localhost/")
        .or_else(|| uri.strip_prefix("codepapr-app://"))
        .unwrap_or(&uri);

    let (app_id, file_path) = match path.split_once('/') {
        Some((id, rest)) if !id.is_empty() => (id, rest),
        _ => {
            return ResponseBuilder::new()
                .status(StatusCode::NOT_FOUND)
                .body("missing app id".into())
                .map_err(Into::into);
        }
    };

    let file_path = if file_path.is_empty() { "index.html" } else { file_path };

    if file_path.contains("..") || file_path.contains('\\') {
        return ResponseBuilder::new()
            .status(StatusCode::FORBIDDEN)
            .body("path traversal blocked".into())
            .map_err(Into::into);
    }

    let map = app_workspaces().lock().unwrap();
    let workspace = match map.get(app_id) {
        Some(ws) => ws.clone(),
        None => {
            return ResponseBuilder::new()
                .status(StatusCode::NOT_FOUND)
                .body("app not registered".into())
                .map_err(Into::into);
        }
    };
    drop(map);

    let full_path = format!("{}/.CodePapr/apps/{}/{}", workspace, app_id, file_path);

    match fs::read(&full_path) {
        Ok(content) => {
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

            ResponseBuilder::new()
                .status(StatusCode::OK)
                .header("Content-Type", mime)
                .header("Access-Control-Allow-Origin", "*")
                .header("Cache-Control", "no-cache")
                .body(content.into())
                .map_err(Into::into)
        }
        Err(_) => ResponseBuilder::new()
            .status(StatusCode::NOT_FOUND)
            .body("file not found".into())
            .map_err(Into::into),
    }
}
