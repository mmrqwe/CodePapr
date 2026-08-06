use std::time::Duration;

use scraper::{Html, Selector};

use crate::web::client::{
    apply_browser_headers, rate_limit_domain, retry_with_backoff, DDG_MIN_REQUEST_INTERVAL_MS,
    SEARCH_RETRY_MAX,
};
use crate::web::text::normalize_search_text;

use super::{push_unique_search_result, WebSearchEntry};

pub(crate) fn collect_brave_results(
    client: &reqwest::blocking::Client,
    query: &str,
    max_results: usize,
) -> Result<Vec<WebSearchEntry>, String> {
    let mut search_url = reqwest::Url::parse("https://search.brave.com/search")
        .map_err(|err| format!("Brave 搜索 URL 构造失败: {err}"))?;
    {
        let mut pairs = search_url.query_pairs_mut();
        pairs.append_pair("q", query);
        pairs.append_pair("source", "web");
    }

    let response = retry_with_backoff(
        || {
            rate_limit_domain(
                "search.brave.com",
                Duration::from_millis(DDG_MIN_REQUEST_INTERVAL_MS),
            );
            apply_browser_headers(
                client.get(search_url.clone()),
                Some("https://search.brave.com/"),
            )
            .send()
            .map_err(|err| format!("Brave 搜索失败: {err}"))
        },
        SEARCH_RETRY_MAX,
    )?;
    let status = response.status();
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status == reqwest::StatusCode::FORBIDDEN
    {
        return Err(format!("Brave 搜索被限流: HTTP {status}"));
    }
    if !status.is_success() {
        return Err(format!("Brave 搜索失败: HTTP {status}"));
    }

    let html = response
        .text()
        .map_err(|err| format!("读取 Brave 搜索结果失败: {err}"))?;
    parse_brave_html(&html, max_results)
}

pub(crate) fn parse_brave_html(html: &str, max_results: usize) -> Result<Vec<WebSearchEntry>, String> {
    let document = Html::parse_document(html);
    let results_root_sel =
        Selector::parse("div#results").map_err(|_| "Brave 页面解析失败".to_string())?;
    if document.select(&results_root_sel).next().is_none() {
        return Err("Brave 搜索被风控拦截（无结果容器）".to_string());
    }

    let snippet_sel = Selector::parse("div.snippet[data-type=\"web\"]")
        .map_err(|_| "Brave 页面解析失败".to_string())?;
    let title_sel =
        Selector::parse("div.title").map_err(|_| "Brave 页面解析失败".to_string())?;
    let link_sel = Selector::parse("a[href]").map_err(|_| "Brave 页面解析失败".to_string())?;
    let snippet_text_sel = Selector::parse("div.generic-snippet div.content")
        .map_err(|_| "Brave 页面解析失败".to_string())?;

    let mut results = Vec::new();
    for item in document.select(&snippet_sel) {
        if results.len() >= max_results {
            break;
        }

        // 结果链接是包含 div.title 的那个 a；避免依赖父节点遍历（scraper 未公开）
        let Some((href, title)) = item.select(&link_sel).find_map(|link| {
            let title_el = link.select(&title_sel).next()?;
            let href = link.value().attr("href")?;
            Some((
                href.to_string(),
                normalize_search_text(&title_el.text().collect::<String>()),
            ))
        }) else {
            continue;
        };
        if title.is_empty() || !href.starts_with("http") {
            continue;
        }

        let snippet = item
            .select(&snippet_text_sel)
            .next()
            .map(|el| normalize_search_text(&el.text().collect::<String>()))
            .unwrap_or_default();

        push_unique_search_result(
            &mut results,
            WebSearchEntry {
                title,
                url: href,
                snippet,
            },
        );
    }

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> &'static str {
        r#"<html><body><div id="results">
<div class="snippet svelte" data-pos="0" data-type="web">
  <div class="result-wrapper">
    <a href="https://tauri.app/" class="l1">
      <div class="site-name-content"><div class="desktop-small-semibold">Tauri</div></div>
      <div class="title search-snippet-title">Tauri 2.0 | Tauri</div>
    </a>
    <div class="generic-snippet"><div class="content">Build smaller, faster desktop apps.</div></div>
  </div>
</div>
<div class="snippet svelte" data-pos="1" data-type="web">
  <a href="https://github.com/tauri-apps/tauri"><div class="title">GitHub - tauri-apps/tauri</div></a>
  <div class="generic-snippet"><div class="content">Open source toolkit.</div></div>
</div>
<div class="snippet svelte" data-pos="2" data-type="video">
  <a href="https://video.example.com/v"><div class="title">Video result</div></a>
</div>
</div></body></html>"#
    }

    #[test]
    fn parse_brave_html_extracts_web_results_only() {
        let results = parse_brave_html(fixture(), 10).expect("parse should succeed");
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "Tauri 2.0 | Tauri");
        assert_eq!(results[0].url, "https://tauri.app/");
        assert_eq!(results[0].snippet, "Build smaller, faster desktop apps.");
        assert_eq!(results[1].title, "GitHub - tauri-apps/tauri");
        assert_eq!(results[1].url, "https://github.com/tauri-apps/tauri");
    }

    #[test]
    fn parse_brave_html_rejects_challenge_page() {
        let challenge = "<html><body><script>challenge</script></body></html>";
        let error = parse_brave_html(challenge, 10).expect_err("challenge page should fail");
        assert!(error.contains("风控"));
    }

    #[test]
    fn parse_brave_html_respects_max_results() {
        let results = parse_brave_html(fixture(), 1).expect("parse should succeed");
        assert_eq!(results.len(), 1);
    }
}
