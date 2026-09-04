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
/// 运行时实际监听端口（占用时可能与 manifest 声明不同）。协议注入 __PAPR_BACKEND_URL 读这里。
static APP_BACKEND_PORTS: OnceLock<Mutex<HashMap<String, u16>>> = OnceLock::new();

fn app_workspaces() -> &'static Mutex<HashMap<String, String>> {
    APP_WORKSPACES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn app_backend_ports() -> &'static Mutex<HashMap<String, u16>> {
    APP_BACKEND_PORTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn runtime_backend_port(app_id: &str, fallback: Option<u16>) -> Option<u16> {
    app_backend_ports()
        .lock()
        .ok()
        .and_then(|m| m.get(app_id).copied())
        .or(fallback)
}

/// 运行时注册的 app 后端端口（可能与 manifest 声明不同）。供市场卸载按端口兜底停进程。
pub(crate) fn registered_backend_port(app_id: &str) -> Option<u16> {
    app_backend_ports()
        .lock()
        .ok()
        .and_then(|m| m.get(app_id).copied())
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

/// app_id 会被拼进文件服务路径（.CodePapr/apps/<app_id>/...)：拒绝一切
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

fn global_apps_dir() -> Result<std::path::PathBuf, String> {
    codepapr_core::db::global_apps_dir()
}

#[tauri::command]
pub fn register_app_workspace(
    app_id: String,
    workspace_path: String,
    manifest_json: Option<String>,
) -> Result<(), String> {
    if !is_valid_app_id(&app_id) {
        return Err(format!("invalid app id: {app_id}"));
    }
    // 注册时同步刷新 manifest 缓存：否则新建/修改后的 app 要等到下一次
    // scan_workspace_apps 才有缓存，期间协议层 CSP fail-open、papr.db/fs
    // 全部报 "manifest not loaded"。
    if let Some(json) = &manifest_json {
        let manifest: papr_runtime::manifest::PaprManifest =
            serde_json::from_str(json).map_err(|err| format!("解析 manifest 失败: {err}"))?;
        if manifest.spec != "papr/0.1" {
            return Err(format!("不支持的 manifest spec '{}'", manifest.spec));
        }
        papr_runtime::manifest::store_manifest(&app_id, manifest);
    }
    let mut map = app_workspaces().lock().unwrap_or_else(|e| e.into_inner());
    map.insert(app_id.clone(), workspace_path.clone());
    papr_runtime::app_context::register(&app_id, &workspace_path);
    Ok(())
}

#[tauri::command]
pub fn unregister_app_workspace(app_id: String) {
    let mut map = app_workspaces().lock().unwrap_or_else(|e| e.into_inner());
    map.remove(&app_id);
    papr_runtime::app_context::unregister(&app_id);
    papr_runtime::manifest::clear_manifest(&app_id);
}

#[tauri::command]
pub fn register_app_backend_port(app_id: String, port: u16) {
    if !is_valid_app_id(&app_id) {
        return;
    }
    if let Ok(mut map) = app_backend_ports().lock() {
        map.insert(app_id, port);
    }
}

#[tauri::command]
pub fn unregister_app_backend_port(app_id: String) {
    if let Ok(mut map) = app_backend_ports().lock() {
        map.remove(&app_id);
    }
}

/// 声明端口空闲则原样返回；被占则在附近找空闲端口（偏好 +1..+32，再 1024–65535）。
#[tauri::command]
pub fn allocate_app_port(preferred: u16) -> Result<u16, String> {
    let preferred = preferred.clamp(1024, 65535);
    if !port_has_listener(("127.0.0.1", preferred)) && !port_has_listener(("::1", preferred)) {
        return Ok(preferred);
    }
    for offset in 1u16..=32 {
        let Some(candidate) = preferred.checked_add(offset) else {
            break;
        };
        if !port_has_listener(("127.0.0.1", candidate)) && !port_has_listener(("::1", candidate)) {
            return Ok(candidate);
        }
    }
    for candidate in 1024u16..=65535 {
        if candidate == preferred {
            continue;
        }
        if !port_has_listener(("127.0.0.1", candidate)) && !port_has_listener(("::1", candidate)) {
            return Ok(candidate);
        }
    }
    Err("没有可用的本地端口".to_string())
}

/// 应用目录里静态前端源码的最新 mtime（毫秒）。
/// 覆盖拆开的 css/js（不再只盯 index.html / app.css / app.js）。
/// AppModal 和插件 overlay 用来在磁盘被改写后自动 reload。
#[tauri::command]
pub fn app_frontend_mtime(workspace_path: String, app_id: String) -> Result<u64, String> {
    if !is_valid_app_id(&app_id) {
        return Err("invalid app id".to_string());
    }
    // 走 resolve_app_dir：global 应用（~/.codepapr/apps/<id>）也要能算出 mtime，
    // 否则热重载轮询对 global 应用恒为 0、永不触发。
    let app_dir = match codepapr_core::db::resolve_app_dir(&workspace_path, &app_id) {
        Ok(dir) => dir,
        Err(_) => return Ok(0),
    };
    let mut latest: u64 = 0;
    collect_frontend_mtime(&app_dir, &mut latest);
    Ok(latest)
}

fn collect_frontend_mtime(dir: &std::path::Path, latest: &mut u64) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name_str = entry.file_name().to_string_lossy().into_owned();
        if skip_app_export_entry(&name_str) || is_unservable_app_file(&name_str) {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_dir() {
            collect_frontend_mtime(&path, latest);
            continue;
        }
        if let Ok(modified) = meta.modified() {
            if let Ok(dur) = modified.duration_since(std::time::UNIX_EPOCH) {
                *latest = (*latest).max(dur.as_millis() as u64);
            }
        }
    }
}

fn app_dir_path(workspace_path: &str, app_id: &str) -> Result<std::path::PathBuf, String> {
    if !is_valid_app_id(app_id) {
        return Err("invalid app id".to_string());
    }
    // 与协议/存储同一解析（workspace manifest 优先 → global → 回退 workspace），
    // 快照/导出/依赖安装不再对 global 应用错位成 <ws>/.CodePapr/apps/<id>。
    codepapr_core::db::resolve_app_dir(workspace_path, app_id)
}

fn skip_app_export_entry(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == "node_modules"
        || lower == ".versions"
        || lower == "data"
        || lower == "db.sqlite"
        || lower.starts_with("db.sqlite-")
}

/// 有 package.json 且尚未安装依赖时，在 app 目录跑 `npm install`。
/// `allow_network`（缺省 true 保持兼容）来自 app 生效档的 network 轴：
/// 声明离线（network:false）的 app 依赖未装时直接报错，而不是静默联网拉包。
#[tauri::command]
pub fn install_app_npm_deps(
    workspace_path: String,
    app_id: String,
    allow_network: Option<bool>,
) -> Result<String, String> {
    use codepapr_core::shared::expanded_path;
    use codepapr_core::shell::sandbox::{sandboxed_command, SandboxAccess};
    use std::io::Read;
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    let allow_network = allow_network.unwrap_or(true);
    let app_dir = app_dir_path(&workspace_path, &app_id)?;
    if !app_dir.join("package.json").is_file() {
        return Ok("skipped: no package.json".to_string());
    }
    if app_dir.join("node_modules").is_dir() {
        return Ok("skipped: node_modules exists".to_string());
    }
    if !allow_network {
        return Err(
            "该应用声明离线（network: false）且尚未安装依赖：请在应用权限设置中放开网络后重试"
                .to_string(),
        );
    }

    // 沙箱根：workspace 应用用工作区；global 应用（~/.codepapr/apps/<id>）在
    // 工作区之外，非 macOS 的 sandboxed_command 要求 cwd 位于沙箱根内，
    // 因此退化为以 app 目录自身为根（npm install 的写权限本就只应在 app 目录，
    // 也不能取 apps 父目录——那会放行所有其它 global 应用目录）。
    let workspace = match codepapr_core::shared::canonical_workspace(&workspace_path) {
        Ok(ws) if app_dir.starts_with(&ws) => ws,
        _ => app_dir.clone(),
    };
    let workspace = std::fs::canonicalize(&workspace).unwrap_or(workspace);
    let access = SandboxAccess {
        network: allow_network,
        workspace_write: false,
        allow_bind: true,
        allow_codepapr_apps: false,
    };
    let args = vec!["install".to_string(), "--no-fund".to_string(), "--no-audit".to_string()];
    let mut cmd = sandboxed_command("npm", &args, &workspace, Some(access), &app_dir)?;
    cmd.env("PATH", expanded_path())
        .current_dir(&app_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let mut child = cmd
        .spawn()
        .map_err(|err| format!("启动 npm install 失败: {err}"))?;
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut out = String::new();
                let mut err = String::new();
                if let Some(ref mut s) = stdout {
                    let mut buf = Vec::new();
                    let _ = s.read_to_end(&mut buf);
                    out = String::from_utf8_lossy(&buf).into_owned();
                }
                if let Some(ref mut s) = stderr {
                    let mut buf = Vec::new();
                    let _ = s.read_to_end(&mut buf);
                    err = String::from_utf8_lossy(&buf).into_owned();
                }
                if status.success() {
                    return Ok(out);
                }
                return Err(format!(
                    "npm install 失败（{}）\n{}\n{}",
                    status, out, err
                ));
            }
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("npm install 超时（120s）".to_string());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(err) => return Err(format!("等待 npm install 失败: {err}")),
        }
    }
}

fn copy_app_tree(src: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|err| format!("创建快照目录失败: {err}"))?;
    let entries = fs::read_dir(src).map_err(|err| format!("读取 app 目录失败: {err}"))?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if skip_app_export_entry(&name_str) {
            continue;
        }
        let from = entry.path();
        let to = dest.join(&name);
        let meta = entry.metadata().map_err(|err| format!("读取文件元数据失败: {err}"))?;
        if meta.is_dir() {
            copy_app_tree(&from, &to)?;
        } else {
            fs::copy(&from, &to).map_err(|err| format!("复制 {} 失败: {err}", name_str))?;
        }
    }
    Ok(())
}

fn prune_app_versions(versions_dir: &std::path::Path, keep: usize) {
    let Ok(entries) = fs::read_dir(versions_dir) else {
        return;
    };
    let mut dirs: Vec<_> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .collect();
    dirs.sort_by_key(|e| e.file_name());
    let extra = dirs.len().saturating_sub(keep);
    for entry in dirs.into_iter().take(extra) {
        let _ = fs::remove_dir_all(entry.path());
    }
}

/// 覆盖生成前把当前 app 目录快照到 `.versions/<timestamp>/`（排除 db / node_modules）。
#[tauri::command]
pub fn papr_snapshot_app(workspace_path: String, app_id: String) -> Result<Option<String>, String> {
    let app_dir = app_dir_path(&workspace_path, &app_id)?;
    if !app_dir.join("index.html").is_file() && !app_dir.join("manifest.json").is_file() {
        return Ok(None);
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string());
    let versions = app_dir.join(".versions");
    let dest = versions.join(&stamp);
    copy_app_tree(&app_dir, &dest)?;
    prune_app_versions(&versions, 5);
    Ok(Some(dest.to_string_lossy().into_owned()))
}

fn zip_app_tree(
    zip: &mut zip::ZipWriter<std::fs::File>,
    dir: &std::path::Path,
    prefix: &str,
) -> Result<(), String> {
    use std::io::Write;
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let entries = fs::read_dir(dir).map_err(|err| format!("读取 app 目录失败: {err}"))?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if skip_app_export_entry(&name_str) {
            continue;
        }
        let from = entry.path();
        let zip_path = if prefix.is_empty() {
            name_str.to_string()
        } else {
            format!("{prefix}/{name_str}")
        };
        let meta = entry.metadata().map_err(|err| format!("读取文件元数据失败: {err}"))?;
        if meta.is_dir() {
            zip_app_tree(zip, &from, &zip_path)?;
        } else {
            let bytes = fs::read(&from).map_err(|err| format!("读取 {zip_path} 失败: {err}"))?;
            zip.start_file(&zip_path, options)
                .map_err(|err| format!("写入 zip 条目失败: {err}"))?;
            zip.write_all(&bytes)
                .map_err(|err| format!("写入 zip 内容失败: {err}"))?;
        }
    }
    Ok(())
}

/// 导出 app 为 zip（排除 db.sqlite* / node_modules / .versions / data）。
#[tauri::command]
pub fn papr_export_app(
    workspace_path: String,
    app_id: String,
    dest_zip: String,
) -> Result<(), String> {
    let app_dir = app_dir_path(&workspace_path, &app_id)?;
    if !app_dir.is_dir() {
        return Err(format!("应用目录不存在: {}", app_dir.display()));
    }
    let dest = std::path::PathBuf::from(&dest_zip);
    if dest.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("zip")) != Some(true)
    {
        return Err("导出路径必须以 .zip 结尾".to_string());
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("创建导出目录失败: {err}"))?;
    }
    let file = fs::File::create(&dest).map_err(|err| format!("创建 zip 失败: {err}"))?;
    let mut zip = zip::ZipWriter::new(file);
    zip_app_tree(&mut zip, &app_dir, "")?;
    zip.finish()
        .map_err(|err| format!("完成 zip 失败: {err}"))?;
    Ok(())
}

#[tauri::command]
pub fn check_port_available(port: u16) -> Result<bool, String> {
    // IPv4/IPv6 都探测：node 可能监听 :: 双栈，也可能只监听其一。
    let occupied = port_has_listener(("127.0.0.1", port)) || port_has_listener(("::1", port));
    Ok(!occupied)
}

#[cfg(test)]
mod install_npm_deps_tests {
    // 注意：pt1/pt2/pt3 经 include! 拼成同一模块，tests 名已被 pt3 占用
    use super::*;

    fn test_workspace_app(
        tag: &str,
        app_id: &str,
        with_node_modules: bool,
    ) -> (std::path::PathBuf, std::path::PathBuf) {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let workspace = std::env::temp_dir().join(format!(
            "codepapr-npm-deps-{tag}-{app_id}-{}-{unique}",
            std::process::id()
        ));
        let app_dir = workspace.join(".CodePapr").join("apps").join(app_id);
        fs::create_dir_all(&app_dir).unwrap();
        fs::write(app_dir.join("manifest.json"), "{\"id\":\"demo\"}").unwrap();
        fs::write(app_dir.join("package.json"), "{\"name\":\"demo\"}").unwrap();
        if with_node_modules {
            fs::create_dir_all(app_dir.join("node_modules")).unwrap();
        }
        (workspace, app_dir)
    }

    #[test]
    fn install_app_npm_deps_offline_app_without_node_modules_errors() {
        let (workspace, app_dir) = test_workspace_app("deny", "demo", false);
        let err = install_app_npm_deps(
            workspace.display().to_string(),
            "demo".to_string(),
            Some(false),
        )
        .expect_err("network:false 且依赖未装时必须拒绝");
        assert!(err.contains("离线"), "unexpected error: {err}");
        // 拒绝路径绝不能真的跑 npm
        assert!(!app_dir.join("node_modules").exists());
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn install_app_npm_deps_offline_app_skips_when_node_modules_exists() {
        let (workspace, _app_dir) = test_workspace_app("skip", "demo", true);
        let out = install_app_npm_deps(
            workspace.display().to_string(),
            "demo".to_string(),
            Some(false),
        )
        .expect("node_modules 已存在时离线 app 应正常跳过");
        assert!(out.contains("skipped"), "unexpected output: {out}");
        let _ = fs::remove_dir_all(workspace);
    }
}
