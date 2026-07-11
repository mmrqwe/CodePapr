use std::fs;
use std::path::PathBuf;

use serde::Serialize;

use crate::shared::{
    canonical_workspace, normalize_relative_path, parse_browser_url, relative_string,
};
use crate::web::client::{build_web_client, retry_with_backoff, SEARCH_RETRY_MAX};
use crate::web::text::{collapse_whitespace, html_to_text, truncate_text_to_bytes};

pub(crate) const MAX_DOWNLOAD_BYTES: usize = 25_000_000;
pub(crate) const MAX_WEB_FETCH_BYTES: usize = 2_000_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadFileResult {
    pub(crate) url: String,
    pub(crate) path: String,
    pub(crate) bytes: usize,
    pub(crate) file_name: String,
    pub(crate) content_type: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WebFetchUrlResult {
    pub(crate) url: String,
    pub(crate) status: u16,
    pub(crate) content: String,
    pub(crate) truncated: bool,
    pub(crate) content_type: Option<String>,
}

fn download_target_file_name(url: &reqwest::Url) -> String {
    url.path_segments()
        .and_then(|mut segments| segments.next_back())
        .filter(|segment| !segment.trim().is_empty())
        .map(|segment| segment.to_string())
        .unwrap_or_else(|| "download.bin".to_string())
}

#[tauri::command]
pub(crate) async fn fetch_web_url(
    url: String,
    max_bytes: Option<usize>,
) -> Result<WebFetchUrlResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let parsed_url = parse_browser_url(&url)?;
        if !parsed_url.starts_with("https://") && !parsed_url.starts_with("http://") {
            return Err("url 必须是 http 或 https URL".to_string());
        }

        let max_bytes = max_bytes.unwrap_or(20_000).clamp(1_000, 100_000);
        let client = build_web_client()?;
        let response = retry_with_backoff(
            || {
                client
                    .get(parsed_url.clone())
                    .header(
                        reqwest::header::ACCEPT,
                        "text/plain, text/html;q=0.9, application/json;q=0.8, */*;q=0.5",
                    )
                    .send()
                    .map_err(|err| format!("读取网页失败: {err}"))
            },
            SEARCH_RETRY_MAX,
        )?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("读取网页失败: HTTP {status}"));
        }

        let final_url = response.url().to_string();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.to_string());

        if let Some(length) = response.content_length() {
            if length > MAX_WEB_FETCH_BYTES as u64 {
                return Err(format!("网页内容超过上限 {MAX_WEB_FETCH_BYTES} bytes"));
            }
        }

        let body = response
            .bytes()
            .map_err(|err| format!("读取网页内容失败: {err}"))?;
        if body.len() > MAX_WEB_FETCH_BYTES {
            return Err(format!("网页内容超过上限 {MAX_WEB_FETCH_BYTES} bytes"));
        }

        let raw_text = String::from_utf8_lossy(&body).into_owned();
        let normalized = if content_type
            .as_deref()
            .map(|value| {
                value.contains("html") || raw_text.contains("<html") || raw_text.contains("<body")
            })
            .unwrap_or(false)
        {
            html_to_text(&raw_text)
        } else {
            collapse_whitespace(&raw_text)
        };
        let (content, truncated) = truncate_text_to_bytes(normalized, max_bytes);

        Ok(WebFetchUrlResult {
            url: final_url,
            status: status.as_u16(),
            content,
            truncated,
            content_type,
        })
    })
    .await
    .map_err(|e| format!("读取网页失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn download_web_file(
    workspace_path: String,
    url: String,
    relative_path: Option<String>,
) -> Result<DownloadFileResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = canonical_workspace(&workspace_path)?;
        let parsed_url = reqwest::Url::parse(&parse_browser_url(&url)?)
            .map_err(|err| format!("URL 解析失败: {err}"))?;
        let client = reqwest::blocking::Client::builder()
            .user_agent("CodePapr/0.1")
            .redirect(reqwest::redirect::Policy::limited(10))
            .build()
            .map_err(|err| format!("初始化下载客户端失败: {err}"))?;

        let response = client
            .get(parsed_url)
            .send()
            .map_err(|err| format!("下载失败: {err}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("下载失败: HTTP {}", status));
        }

        let final_url = response.url().clone();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.to_string());

        if let Some(length) = response.content_length() {
            if length > MAX_DOWNLOAD_BYTES as u64 {
                return Err(format!("下载文件超过上限 {MAX_DOWNLOAD_BYTES} bytes"));
            }
        }

        let bytes = response
            .bytes()
            .map_err(|err| format!("读取下载内容失败: {err}"))?;
        if bytes.len() > MAX_DOWNLOAD_BYTES {
            return Err(format!("下载文件超过上限 {MAX_DOWNLOAD_BYTES} bytes"));
        }

        let normalized_path = if let Some(path) = relative_path {
            normalize_relative_path(Some(&path))?
        } else {
            PathBuf::from(".CodePapr/downloads").join(download_target_file_name(&final_url))
        };
        if normalized_path.as_os_str().is_empty() {
            return Err("relativePath 不能为空".to_string());
        }

        let target = workspace.join(&normalized_path);
        let parent = target
            .parent()
            .ok_or_else(|| "无法确定下载目录".to_string())?;
        fs::create_dir_all(parent).map_err(|err| format!("创建下载目录失败: {err}"))?;
        let canonical_parent =
            fs::canonicalize(parent).map_err(|err| format!("无法访问下载目录: {err}"))?;
        if !canonical_parent.starts_with(&workspace) {
            return Err("拒绝写入项目文件夹之外的路径".to_string());
        }

        fs::write(&target, &bytes).map_err(|err| format!("写入下载文件失败: {err}"))?;

        Ok(DownloadFileResult {
            url: final_url.to_string(),
            path: relative_string(&workspace, &target),
            bytes: bytes.len(),
            file_name: target
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("download.bin")
                .to_string(),
            content_type,
        })
    })
    .await
    .map_err(|e| format!("下载失败: {e}"))?
}
