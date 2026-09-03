//! 聊天引用图片的持久化。
//!
//! 用户消息的图片 base64 体积大（单张最高约 8MB），直接进 DB 会让
//! project.sqlite 膨胀、全量读写变慢。因此发送时写为 `.CodePapr/chat-images/`
//! 下的文件，消息只持久化路径引用（messages.extras.imagePaths），前端加载
//! 消息后调用 load_chat_images 回填预览。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine;
use serde::Serialize;

use crate::shared::{canonical_workspace, path_is_same_or_child, run_blocking_workspace_task};

const PROJECT_STORAGE_DIR: &str = ".CodePapr";
const CHAT_IMAGES_DIR: &str = "chat-images";
/// 单张图片落盘上限（原始字节）。前端附件上限为 8MB，此处留余量。
const MAX_CHAT_IMAGE_BYTES: usize = 16_000_000;
/// 单次批量读取路径上限：防止超大数组触发无界扫描。
const MAX_BATCH_PATHS: usize = 128;
/// 文件名冲突时的最大重试次数（名字含纳秒时间戳+计数，冲突极罕见）。
const MAX_NAME_RETRIES: usize = 8;

static FILENAME_COUNTER: AtomicU64 = AtomicU64::new(0);

fn media_type_to_extension(media_type: &str) -> Option<&'static str> {
    match media_type {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        "image/bmp" => Some("bmp"),
        "image/svg+xml" => Some("svg"),
        _ => None,
    }
}

fn extension_to_media_type(extension: &str) -> Option<&'static str> {
    match extension {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "bmp" => Some("image/bmp"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    }
}

fn chat_images_dir(workspace: &Path) -> PathBuf {
    workspace.join(PROJECT_STORAGE_DIR).join(CHAT_IMAGES_DIR)
}

/// 相对工作区的规范化引用形式（落库用），与 save/load 两侧保持一致。
fn relative_image_path(file_name: &str) -> String {
    format!("{PROJECT_STORAGE_DIR}/{CHAT_IMAGES_DIR}/{file_name}")
}

fn unique_file_name(extension: &str) -> String {
    let counter = FILENAME_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}-{counter:x}.{extension}")
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SaveChatImageResult {
    /// 工作区相对路径（.CodePapr/chat-images/<name>），持久化进 messages.extras。
    pub(crate) path: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatImageEntry {
    pub(crate) path: String,
    pub(crate) media_type: String,
    pub(crate) data: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LoadChatImagesResult {
    /// 成功读到的图片；缺失/非法/超限的路径不出现在结果中，
    /// 前端按剩余内容展示（图片位缺失，不影响其它消息）。
    pub(crate) images: Vec<ChatImageEntry>,
}

pub async fn save_chat_image(
    workspace_path: String,
    media_type: String,
    data_base64: String,
) -> Result<SaveChatImageResult, String> {
    run_blocking_workspace_task(move || save_chat_image_impl(workspace_path, media_type, data_base64))
        .await
}

pub(crate) fn save_chat_image_impl(
    workspace_path: String,
    media_type: String,
    data_base64: String,
) -> Result<SaveChatImageResult, String> {
    let extension = media_type_to_extension(&media_type)
        .ok_or_else(|| format!("不支持的图片类型: {media_type}"))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|err| format!("图片数据不是合法 base64: {err}"))?;
    if bytes.is_empty() {
        return Err("图片数据不能为空".to_string());
    }
    if bytes.len() > MAX_CHAT_IMAGE_BYTES {
        return Err(format!(
            "图片过大（{} bytes），超过上限 {} bytes",
            bytes.len(),
            MAX_CHAT_IMAGE_BYTES
        ));
    }

    let workspace = canonical_workspace(&workspace_path)?;
    let dir = chat_images_dir(&workspace);
    fs::create_dir_all(&dir).map_err(|err| format!("创建聊天图片目录失败: {err}"))?;

    // O_EXCL create_new + O_NOFOLLOW（write_tmp_file_exclusive）：文件名不可
    // 预测且拒绝符号链接，不会写穿到其它文件；冲突（AlreadyExists）时换名重试。
    let mut last_err = String::new();
    for _ in 0..MAX_NAME_RETRIES {
        let name = unique_file_name(extension);
        let target = dir.join(&name);
        match super::write::write_tmp_file_exclusive(&target, &bytes) {
            Ok(()) => {
                return Ok(SaveChatImageResult {
                    path: relative_image_path(&name),
                });
            }
            Err(err) => last_err = err,
        }
    }
    Err(format!("保存图片失败: {last_err}"))
}

pub async fn load_chat_images(
    workspace_path: String,
    paths: Vec<String>,
) -> Result<LoadChatImagesResult, String> {
    run_blocking_workspace_task(move || load_chat_images_impl(workspace_path, paths)).await
}

pub(crate) fn load_chat_images_impl(
    workspace_path: String,
    paths: Vec<String>,
) -> Result<LoadChatImagesResult, String> {
    if paths.len() > MAX_BATCH_PATHS {
        return Err(format!("单次读取路径过多（上限 {MAX_BATCH_PATHS}）"));
    }
    let workspace = canonical_workspace(&workspace_path)?;
    let base_dir = chat_images_dir(&workspace);

    let mut images = Vec::new();
    for raw in paths {
        let name = raw.trim();
        // 只接受 chat-images 目录下的直接文件名：拒绝绝对路径、目录分隔符、
        // 穿越（..）。兼容存量的 ".CodePapr/chat-images/" 与裸 "chat-images/" 前缀。
        let file_name = name
            .strip_prefix(&format!("{PROJECT_STORAGE_DIR}/{CHAT_IMAGES_DIR}/"))
            .or_else(|| name.strip_prefix(&format!("{CHAT_IMAGES_DIR}/")))
            .filter(|candidate| {
                !candidate.is_empty()
                    && !candidate.contains('/')
                    && !candidate.contains('\\')
                    && !candidate.contains("..")
            });
        let Some(file_name) = file_name else { continue };

        let extension = Path::new(file_name)
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase());
        let Some(media_type) = extension.as_deref().and_then(extension_to_media_type) else {
            continue;
        };

        let target = base_dir.join(file_name);
        // 拒绝符号链接，且规范化后必须仍在工作区内（纵深防御）。
        let Ok(meta) = fs::symlink_metadata(&target) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.len() as usize > MAX_CHAT_IMAGE_BYTES {
            continue;
        }
        let Ok(canonical) = fs::canonicalize(&target) else {
            continue;
        };
        if !path_is_same_or_child(&canonical, &workspace) {
            continue;
        }
        let Ok(data) = fs::read(&target) else {
            continue;
        };

        images.push(ChatImageEntry {
            path: relative_image_path(file_name),
            media_type: media_type.to_string(),
            data: base64::engine::general_purpose::STANDARD.encode(&data),
        });
    }

    Ok(LoadChatImagesResult { images })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers::TestWorkspace;

    fn png_base64(payload: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(payload)
    }

    #[test]
    fn save_and_load_chat_image_roundtrip() {
        let workspace = TestWorkspace::new("chat-image-roundtrip");
        let ws = workspace.workspace_arg();
        let data = png_base64(b"fake-png-bytes");

        let saved = save_chat_image_impl(ws.clone(), "image/png".to_string(), data.clone())
            .expect("save should succeed");
        assert!(saved.path.starts_with(".CodePapr/chat-images/"));
        assert!(workspace
            .file_path(&saved.path)
            .exists());

        let loaded = load_chat_images_impl(ws, vec![saved.path.clone()]).expect("load");
        assert_eq!(loaded.images.len(), 1);
        assert_eq!(loaded.images[0].path, saved.path);
        assert_eq!(loaded.images[0].media_type, "image/png");
        assert_eq!(loaded.images[0].data, data);
    }

    #[test]
    fn save_chat_image_rejects_unknown_media_type_and_empty_data() {
        let workspace = TestWorkspace::new("chat-image-reject");
        let ws = workspace.workspace_arg();

        let err = save_chat_image_impl(
            ws.clone(),
            "application/pdf".to_string(),
            png_base64(b"x"),
        )
        .expect_err("unknown media type must fail");
        assert!(err.contains("不支持的图片类型"), "got: {err}");

        let err = save_chat_image_impl(ws, "image/png".to_string(), String::new())
            .expect_err("empty data must fail");
        assert!(err.contains("为空") || err.contains("base64"), "got: {err}");
    }

    #[test]
    fn load_chat_images_skips_traversal_and_unknown_paths() {
        let workspace = TestWorkspace::new("chat-image-traversal");
        let ws = workspace.workspace_arg();
        let data = png_base64(b"legit");
        let saved = save_chat_image_impl(ws.clone(), "image/png".to_string(), data)
            .expect("save should succeed");

        let loaded = load_chat_images_impl(
            ws,
            vec![
                saved.path.clone(),
                "../evil.png".to_string(),
                "../../etc/passwd".to_string(),
                ".CodePapr/chat-images/../secret.png".to_string(),
                "/etc/passwd".to_string(),
                ".CodePapr/chat-images/missing.png".to_string(),
            ],
        )
        .expect("load should succeed with skips");
        assert_eq!(loaded.images.len(), 1);
        assert_eq!(loaded.images[0].path, saved.path);
    }

    #[test]
    fn load_chat_images_enforces_batch_limit() {
        let workspace = TestWorkspace::new("chat-image-batch");
        let ws = workspace.workspace_arg();
        let paths: Vec<String> = (0..MAX_BATCH_PATHS + 1)
            .map(|i| format!(".CodePapr/chat-images/f{i}.png"))
            .collect();
        let err = load_chat_images_impl(ws, paths).expect_err("batch limit must fail");
        assert!(err.contains("过多"), "got: {err}");
    }
}
