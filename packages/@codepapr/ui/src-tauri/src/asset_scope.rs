#![forbid(unsafe_code)]

//! asset 协议的运行时授权。
//!
//! `tauri.conf.json` 的 `assetProtocol.scope` 为空（不放行任何路径）；
//! 工作区打开时由前端调用本命令授予该工作区的读取权限。
//!
//! 安全边界说明：scope 只随工作区增补、不在切换时撤销——asset 协议仅出现在
//! CSP `img-src`（无法执行脚本），增补的最大影响是已打开过的工作区仍可被
//! 读图；相比旧配置放行整个文件系统（`/**`），注入面从"全盘任意文件"收缩到
//! "用户实际打开过的工作区目录"。禁止把 `$HOME` 等目录外路径作为工作区授权：
//! 父目录授权会连带暴露其下全部子树（含 `$HOME` 本身）。

use crate::shared::canonical_workspace;
use tauri::Manager;

/// 工作区授权的最低路径深度：拒绝 `/`、`/Users` 这类父目录被当作工作区传入，
/// 否则 `allow_directory(recursive=true)` 会把整个用户目录暴露给 webview。
const MIN_GRANT_COMPONENTS: usize = 3;

#[tauri::command]
pub(crate) fn grant_workspace_asset_scope<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    workspace_path: String,
) -> Result<(), String> {
    let trimmed = workspace_path.trim();
    if trimmed.is_empty() {
        return Err("工作区路径为空".to_string());
    }

    // canonicalize 兼做存在性校验：不存在的路径没有可读内容，也不应进授权表。
    let canonical = canonical_workspace(trimmed)?;
    if canonical.components().count() < MIN_GRANT_COMPONENTS {
        return Err("工作区路径深度不足，拒绝授权".to_string());
    }

    // Manager::asset_protocol_scope 返回与已注册 asset 协议处理器共享的
    // Scope（内部 Arc 集合），运行时授权立即生效。
    let scope = app.asset_protocol_scope();
    scope
        .allow_directory(&canonical, true)
        .map_err(|e| format!("授权工作区资源访问失败: {e}"))?;

    // 聊天图片落在 <workspace>/.CodePapr/chat-images/：默认匹配规则要求
    // 点开头路径组件在模式中必须是字面量（** 不匹配点开头组件），因此
    // 工作区通配授权覆盖不到该子树，需要显式授权（目录尚不存在时亦有效：
    // push_pattern 对不存在的路径回退为父目录规范化）。
    let chat_images = canonical.join(".CodePapr").join("chat-images");
    scope
        .allow_directory(&chat_images, true)
        .map_err(|e| format!("授权聊天图片目录失败: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::MIN_GRANT_COMPONENTS;
    use std::path::Path;

    #[test]
    fn min_depth_rejects_root_level_paths() {
        assert!(Path::new("/").components().count() < MIN_GRANT_COMPONENTS);
        assert!(Path::new("/Users").components().count() < MIN_GRANT_COMPONENTS);
        assert!(Path::new("/Users/me").components().count() >= MIN_GRANT_COMPONENTS);
    }
}
