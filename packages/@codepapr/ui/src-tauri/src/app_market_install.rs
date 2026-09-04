use std::{fs, path::{Path, PathBuf}};

use serde::Deserialize;

use crate::papr_runtime;

fn is_valid_app_id(app_id: &str) -> bool {
    !app_id.is_empty()
        && app_id.len() <= 128
        && app_id != "."
        && app_id != ".."
        && !app_id.contains("..")
        && !app_id.contains('/')
        && !app_id.contains('\\')
}

fn is_unservable_app_file(file_path: &str) -> bool {
    let lower = file_path.to_ascii_lowercase();
    lower.ends_with(".sqlite") || lower.ends_with(".sqlite-wal") || lower.ends_with(".sqlite-shm")
}

fn global_apps_dir() -> Result<PathBuf, String> {
    codepapr_core::db::global_apps_dir()
}

#[derive(Debug, Deserialize)]
pub struct AppInstallFileItem {
    pub relative_path: String,
    pub content: String,
}

#[tauri::command]
pub fn papr_install_app_files(
    workspace_path: Option<String>,
    scope: String,
    app_id: String,
    files: Vec<AppInstallFileItem>,
) -> Result<String, String> {
    // D-1：安装入口收紧 kebab-case（与 TS app_render/app_publish 同一正则）。
    // appId 是 URL host：大写会被引擎小写化（装完即 404），空格/点生成畸形 origin。
    if !crate::app_runtime::is_valid_app_id_strict(&app_id) {
        return Err(format!(
            "非法的应用 id '{app_id}'：必须是 kebab-case（小写字母/数字/连字符，以字母或数字开头，最长 63 字符）"
        ));
    }

    let target_dir = if scope == "global" {
        global_apps_dir()?.join(&app_id)
    } else {
        let ws = workspace_path
            .filter(|w| !w.is_empty())
            .ok_or_else(|| "workspace_path is required for workspace scope".to_string())?;
        let canonical_ws = codepapr_core::shared::canonical_workspace(&ws)?;
        canonical_ws.join(".CodePapr").join("apps").join(&app_id)
    };

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string());
    let parent = target_dir
        .parent()
        .ok_or_else(|| "无法确定应用目录父路径".to_string())?;
    fs::create_dir_all(parent).map_err(|err| format!("创建应用根目录失败: {err}"))?;

    // 先写临时目录、成功后原子替换：中途失败（磁盘满/占用）不留半安装态，
    // 覆盖安装也不会残留上一版已删除的文件（旧文件随替换整体消失）。
    let staging = parent.join(format!(".papr-install-{app_id}-{stamp}"));
    let result = install_into_staging(&staging, &target_dir, &files)
        .and_then(|()| swap_staging(&staging, &target_dir));
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result?;
    Ok(target_dir.to_string_lossy().into_owned())
}

fn install_into_staging(
    staging: &Path,
    target_dir: &Path,
    files: &[AppInstallFileItem],
) -> Result<(), String> {
    fs::create_dir_all(staging).map_err(|err| format!("创建临时安装目录失败: {err}"))?;
    let canonical_base = staging
        .canonicalize()
        .map_err(|err| format!("获取临时安装目录规范路径失败: {err}"))?;

    for file in files {
        let rel = file.relative_path.trim_start_matches('/');
        if rel.is_empty()
            || rel.contains("..")
            || rel.contains('\\')
            || rel == "__papr_sdk.js"
            || rel.ends_with("/__papr_sdk.js")
            || is_unservable_app_file(rel)
        {
            continue;
        }
        let dest = staging.join(rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|err| format!("创建子目录失败: {err}"))?;
            let canonical_parent = parent
                .canonicalize()
                .map_err(|err| format!("校验子目录失败: {err}"))?;
            if !canonical_parent.starts_with(&canonical_base) {
                return Err("path traversal blocked in installation".to_string());
            }
        }
        fs::write(&dest, file.content.as_bytes())
            .map_err(|err| format!("写入文件 {} 失败: {err}", dest.display()))?;
    }

    if !staging.join("manifest.json").is_file() {
        return Err("安装包缺少 manifest.json，已中止".to_string());
    }

    // 保留旧安装的用户数据（db.sqlite* 与 data/）——卸载 remove_data=false
    // 保留它们，覆盖安装同样不能丢。
    if target_dir.is_dir() {
        if let Ok(entries) = fs::read_dir(target_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let lower = name.to_ascii_lowercase();
                let keep = lower == "data"
                    || lower == "db.sqlite"
                    || lower.starts_with("db.sqlite-");
                if !keep {
                    continue;
                }
                let from = entry.path();
                let to = staging.join(&name);
                // 先尽力清掉 staging 里的同名残留（正常不存在），再 move。
                // 不能用 remove_dir_all(...).and_then(rename)：不存在时
                // remove_dir_all 返回 Err 会短路掉 rename。
                if from.is_dir() {
                    let _ = fs::remove_dir_all(&to);
                } else {
                    let _ = fs::remove_file(&to);
                }
                let _ = fs::rename(&from, &to);
            }
        }
    }
    Ok(())
}

fn swap_staging(staging: &Path, target_dir: &Path) -> Result<(), String> {
    if target_dir.exists() {
        fs::remove_dir_all(target_dir)
            .map_err(|err| format!("替换前删除旧应用目录失败: {err}"))?;
    }
    fs::rename(staging, target_dir)
        .map_err(|err| format!("应用目录原子替换失败: {err}"))?;
    Ok(())
}

#[tauri::command]
pub fn papr_uninstall_app(
    workspace_path: Option<String>,
    scope: String,
    app_id: String,
    remove_data: bool,
) -> Result<(), String> {
    if !is_valid_app_id(&app_id) {
        return Err("invalid app id".to_string());
    }

    let target_dir = if scope == "global" {
        global_apps_dir()?.join(&app_id)
    } else {
        let ws = workspace_path
            .as_deref()
            .filter(|w| !w.is_empty())
            .ok_or_else(|| "workspace_path is required for workspace scope".to_string())?;
        let canonical_ws = codepapr_core::shared::canonical_workspace(ws)?;
        canonical_ws.join(".CodePapr").join("apps").join(&app_id)
    };

    // 卸载前先停后端（与 app_delete 同口径）：否则进程变孤儿，继续从已删除
    // 目录服务旧代码并占用端口。TS store 的 pid 停止是主路径（uninstallMarketApp），
    // 这里按端口兜底——覆盖 webview 重载后 store 丢 pid 但进程仍活的场景。
    let ws_arg = workspace_path.clone().unwrap_or_default();
    let mut ports: Vec<u16> = papr_runtime::manifest::get_manifest(&app_id)
        .ok()
        .and_then(|m| m.port)
        .into_iter()
        .collect();
    if let Some(runtime_port) = crate::app_runtime::registered_backend_port(&app_id) {
        if !ports.contains(&runtime_port) {
            ports.push(runtime_port);
        }
    }
    for port in ports {
        let _ = papr_runtime::services::stop_app_backend_processes(&ws_arg, port);
        if !ws_arg.is_empty() {
            let _ = papr_runtime::services::stop_app_backend_processes("__global__", port);
        }
    }
    let _ = crate::app_runtime::unregister_app_backend_port(app_id.clone());

    if target_dir.exists() {
        if remove_data {
            fs::remove_dir_all(&target_dir)
                .map_err(|err| format!("删除应用目录失败: {err}"))?;
        } else {
            let entries = fs::read_dir(&target_dir)
                .map_err(|err| format!("读取应用目录失败: {err}"))?;
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name == "data" || name == "db.sqlite" || name.starts_with("db.sqlite-") {
                    continue;
                }
                let p = entry.path();
                if p.is_dir() {
                    let _ = fs::remove_dir_all(&p);
                } else {
                    let _ = fs::remove_file(&p);
                }
            }
        }
    }

    // 清 APP_WORKSPACES 映射 + manifest 缓存 + app_context：旧实现只清后两者，
    // 映射泄漏导致同名重装前协议仍按旧工作区解析目录。
    let _ = crate::app_runtime::unregister_app_workspace(app_id.clone());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_ws(label: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("papr-market-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(p.join(".CodePapr/apps")).unwrap();
        p
    }

    fn item(rel: &str, content: &str) -> AppInstallFileItem {
        AppInstallFileItem {
            relative_path: rel.into(),
            content: content.into(),
        }
    }

    #[test]
    fn d1_install_rejects_non_kebab_ids_and_legacy_uninstall_still_works() {
        let ws = temp_ws("kebab");
        let wss = ws.to_string_lossy().into_owned();
        for bad in ["My App", "MyApp", "my.app", "-lead", &"a".repeat(64)] {
            let err = papr_install_app_files(
                Some(wss.clone()),
                "workspace".into(),
                bad.into(),
                vec![item("manifest.json", r#"{"spec":"papr/0.1","name":"x"}"#)],
            )
            .expect_err("非 kebab-case id 必须拒绝");
            assert!(err.contains("kebab-case"), "unexpected: {err}");
        }
        // 存量非规范目录仍可卸载（宽校验保留给 uninstall/scan）
        let legacy = ws.join(".CodePapr/apps/My Legacy");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(
            legacy.join("manifest.json"),
            r#"{"spec":"papr/0.1","name":"x"}"#,
        )
        .unwrap();
        papr_uninstall_app(Some(wss), "workspace".into(), "My Legacy".into(), true)
            .expect("legacy 目录必须可卸载");
        assert!(!legacy.exists());
        fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn install_then_update_removes_stale_files_and_keeps_data() {
        let ws = temp_ws("update");
        let target = ws.join(".CodePapr/apps/demo");
        papr_install_app_files(
            Some(ws.to_string_lossy().into_owned()),
            "workspace".into(),
            "demo".into(),
            vec![
                item("manifest.json", r#"{"spec":"papr/0.1","name":"Demo"}"#),
                item("index.html", "<html>v1</html>"),
                item("js/old-lib.js", "old"),
            ],
        )
        .expect("first install");
        assert!(target.join("index.html").is_file());

        // 模拟运行期用户数据
        fs::write(target.join("db.sqlite"), b"data").unwrap();
        fs::create_dir_all(target.join("data")).unwrap();
        fs::write(target.join("data/keep.txt"), b"k").unwrap();

        // 更新安装：新版本不再包含 js/old-lib.js
        papr_install_app_files(
            Some(ws.to_string_lossy().into_owned()),
            "workspace".into(),
            "demo".into(),
            vec![
                item("manifest.json", r#"{"spec":"papr/0.1","name":"Demo","version":"2.0"}"#),
                item("index.html", "<html>v2</html>"),
            ],
        )
        .expect("update install");
        assert!(
            !target.join("js/old-lib.js").exists(),
            "旧版残留文件应随原子替换消失"
        );
        assert_eq!(fs::read(target.join("index.html")).unwrap(), b"<html>v2</html>");
        assert!(target.join("db.sqlite").is_file(), "用户数据必须跨更新保留");
        assert!(target.join("data/keep.txt").is_file());

        fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn install_without_manifest_aborts_and_leaves_previous_install() {
        let ws = temp_ws("nomanifest");
        let target = ws.join(".CodePapr/apps/demo2");
        papr_install_app_files(
            Some(ws.to_string_lossy().into_owned()),
            "workspace".into(),
            "demo2".into(),
            vec![
                item("manifest.json", r#"{"spec":"papr/0.1","name":"D2"}"#),
                item("index.html", "<html>ok</html>"),
            ],
        )
        .expect("first install");

        let bad = papr_install_app_files(
            Some(ws.to_string_lossy().into_owned()),
            "workspace".into(),
            "demo2".into(),
            vec![item("index.html", "<html>broken</html>")],
        );
        assert!(bad.is_err(), "缺 manifest.json 必须中止");
        assert_eq!(
            fs::read(target.join("index.html")).unwrap(),
            b"<html>ok</html>",
            "失败的安装不能碰已存在目录"
        );
        // 临时目录已清理
        let parent = target.parent().unwrap();
        let leftovers: Vec<_> = fs::read_dir(parent)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(".papr-install-"))
            .collect();
        assert!(leftovers.is_empty(), "staging 残留: {leftovers:?}");

        fs::remove_dir_all(&ws).ok();
    }
}
