/// Validate and normalise a browser URL (http/https only).
pub(crate) fn parse_browser_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("URL 不能为空".to_string());
    }

    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("浏览器 URL 只允许 http:// 或 https://".to_string());
    }

    Ok(trimmed.to_string())
}
