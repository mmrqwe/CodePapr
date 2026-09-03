use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;

use crate::shared::{
    canonical_workspace, normalize_relative_path, parse_browser_url, relative_string,
};
use crate::web::client::{retry_with_backoff, ssrf_safe_blocking_get, SEARCH_RETRY_MAX};
use crate::web::text::{collapse_whitespace, html_to_text, truncate_text_to_bytes};
use crate::workspace_fs::read::decode_text_bytes;

pub(crate) const MAX_DOWNLOAD_BYTES: usize = 25_000_000;
pub(crate) const MAX_WEB_FETCH_BYTES: usize = 2_000_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadFileResult {
    pub(crate) url: String,
    pub(crate) path: String,
    pub(crate) bytes: usize,
    pub(crate) file_name: String,
    pub(crate) content_type: Option<String>,
    /// 目标路径原本已有文件（被本次下载覆盖）
    pub(crate) overwritten: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebFetchUrlResult {
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

/// 从 Content-Type 头提取 charset 标签（如 `text/html; charset=GBK`）。
pub(crate) fn charset_from_content_type(content_type: &str) -> Option<String> {
    let lower = content_type.to_lowercase();
    let index = lower.find("charset=")?;
    let rest = &content_type[index + "charset=".len()..];
    let value: String = rest
        .chars()
        .skip_while(|ch| ch.is_whitespace() || *ch == '"' || *ch == '\'')
        .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .collect();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

/// 从 HTML 头部（前 2KB）的 `<meta charset>` / `<meta http-equiv>` 提取 charset。
pub(crate) fn charset_from_meta(head: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(head).to_lowercase();
    let index = text.find("charset=")?;
    let rest = &text[index + "charset=".len()..];
    let value: String = rest
        .chars()
        .skip_while(|ch| ch.is_whitespace() || *ch == '"' || *ch == '\'')
        .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .collect();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn decode_with_label(body: &[u8], label: &str) -> Option<String> {
    let encoding = encoding_rs::Encoding::for_label(label.as_bytes())?;
    if encoding == encoding_rs::UTF_8 {
        return None; // 交由统一的 UTF-8/兜底路径处理
    }
    let (decoded, _, _) = encoding.decode(body);
    Some(decoded.into_owned())
}

/// 网页正文解码：Content-Type charset → meta charset → BOM/UTF-16 启发式 →
/// 严格 UTF-8 → GB18030 兜底（与文件读取同一套探测逻辑）。
pub(crate) fn decode_web_body(body: &[u8], content_type: Option<&str>) -> String {
    if let Some(label) = content_type.and_then(charset_from_content_type) {
        if let Some(decoded) = decode_with_label(body, &label) {
            return decoded;
        }
    }
    let head_len = body.len().min(2048);
    if let Some(label) = charset_from_meta(&body[..head_len]) {
        if let Some(decoded) = decode_with_label(body, &label) {
            return decoded;
        }
    }
    decode_text_bytes(body.to_vec()).unwrap_or_else(|_| String::from_utf8_lossy(body).into_owned())
}

pub async fn fetch_web_url(
    url: String,
    max_bytes: Option<usize>,
) -> Result<WebFetchUrlResult, String> {
    tokio::task::spawn_blocking(move || fetch_web_url_impl(url, max_bytes))
        .await
        .map_err(|e| format!("读取网页失败: {e}"))?
}

pub(crate) fn fetch_web_url_impl(
    url: String,
    max_bytes: Option<usize>,
) -> Result<WebFetchUrlResult, String> {
        let parsed_url = parse_browser_url(&url)?;
        if !parsed_url.starts_with("https://") && !parsed_url.starts_with("http://") {
            return Err("url 必须是 http 或 https URL".to_string());
        }

        let max_bytes = max_bytes.unwrap_or(20_000).clamp(1_000, 100_000);
        // SSRF 防护：与 papr.http 对齐（app agent 的 webfetch 也走这里）。
        // ssrf_safe_blocking_get 对每一跳做内网校验 + DNS pin + 手动重定向跟随，
        // 防止初始 URL 合法但经 302 跳板或 DNS rebinding 访问内网/本地地址。
        let response = retry_with_backoff(
            || {
                ssrf_safe_blocking_get(&parsed_url, Duration::from_secs(20), |req| {
                    req.header(
                        reqwest::header::ACCEPT,
                        "text/plain, text/html;q=0.9, application/json;q=0.8, */*;q=0.5",
                    )
                })
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

        let raw_text = decode_web_body(&body, content_type.as_deref());
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
}

pub async fn download_web_file(
    workspace_path: String,
    url: String,
    relative_path: Option<String>,
) -> Result<DownloadFileResult, String> {
    tokio::task::spawn_blocking(move || {
        download_web_file_impl(workspace_path, url, relative_path)
    })
    .await
    .map_err(|e| format!("下载失败: {e}"))?
}

pub(crate) fn download_web_file_impl(
    workspace_path: String,
    url: String,
    relative_path: Option<String>,
) -> Result<DownloadFileResult, String> {
        let workspace = canonical_workspace(&workspace_path)?;
        let parsed_url = parse_browser_url(&url)?;
        if !parsed_url.starts_with("https://") && !parsed_url.starts_with("http://") {
            return Err("url 必须是 http 或 https URL".to_string());
        }
        // SSRF 防护：与 fetch_web_url / papr.http 同一防御等级——每一跳内网校验 +
        // DNS pin + 手动重定向跟随。旧实现既不校验目标也不校验重定向落点，
        // 可被用于读取云元数据（169.254.169.254）或本机服务响应。
        let response = ssrf_safe_blocking_get(&parsed_url, Duration::from_secs(60), |req| req)
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

        // 流式读取并硬截断：Content-Length 可能缺失（chunked）或不可信，
        // 不能先 bytes() 全量读入内存再判断大小——恶意站点可用超大 chunked
        // 响应直接打爆进程内存（与 papr_runtime::services::read_body_capped 同一思路）。
        // take(cap+1) 保证从网络读入的字节数不超过上限+1，读满即判超限。
        let mut bytes: Vec<u8> = Vec::new();
        response
            .take(MAX_DOWNLOAD_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
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

        let overwritten = target.exists();
        // 父目录校验不能覆盖"目标本身是 symlink"的逃逸：写入走拒绝符号链接的闸门
        crate::shared::write_file_rejecting_symlink(&target, &workspace, &bytes)?;

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
            overwritten,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn charset_from_content_type_parses_common_forms() {
        assert_eq!(
            charset_from_content_type("text/html; charset=GBK").as_deref(),
            Some("GBK")
        );
        assert_eq!(
            charset_from_content_type("text/html; charset=\"shift_jis\"").as_deref(),
            Some("shift_jis")
        );
        assert_eq!(
            charset_from_content_type("text/html; charset=utf-8").as_deref(),
            Some("utf-8")
        );
        assert_eq!(charset_from_content_type("application/json"), None);
        assert_eq!(charset_from_content_type("text/html; charset="), None);
    }

    #[test]
    fn charset_from_meta_detects_meta_tags() {
        let html = br#"<html><head><meta charset="GB2312"></head>"#;
        assert_eq!(charset_from_meta(html).as_deref(), Some("gb2312"));

        let http_equiv = br#"<head><meta http-equiv="Content-Type" content="text/html; charset=Big5"></head>"#;
        assert_eq!(charset_from_meta(http_equiv).as_deref(), Some("big5"));

        assert_eq!(charset_from_meta(b"<html><head></head>"), None);
    }

    #[test]
    fn decode_web_body_uses_header_charset() {
        // 「你好」的 GBK 编码
        let body = b"\xC4\xE3\xBA\xC3";
        let decoded = decode_web_body(body, Some("text/html; charset=GBK"));
        assert_eq!(decoded, "你好");
    }

    #[test]
    fn decode_web_body_uses_meta_charset_without_header() {
        let mut body = Vec::new();
        body.extend_from_slice(b"<html><head><meta charset=\"GBK\"></head><body>");
        body.extend_from_slice(b"\xC4\xE3\xBA\xC3"); // 「你好」GBK
        body.extend_from_slice(b"</body></html>");
        let decoded = decode_web_body(&body, None);
        assert!(decoded.contains("你好"), "meta charset 应生效: {decoded}");
    }

    #[test]
    fn decode_web_body_falls_back_to_gb18030_for_bare_gbk() {
        let body = b"\xC4\xE3\xBA\xC3"; // 「你好」GBK，无任何声明
        let decoded = decode_web_body(body, Some("text/html"));
        assert_eq!(decoded, "你好");
    }

    #[test]
    fn decode_web_body_keeps_utf8_and_strips_bom() {
        let body = b"\xef\xbb\xbfhello utf8";
        let decoded = decode_web_body(body, Some("text/html; charset=utf-8"));
        assert_eq!(decoded, "hello utf8");
    }
}
