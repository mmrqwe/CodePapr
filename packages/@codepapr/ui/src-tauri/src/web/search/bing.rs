use std::time::Duration;

use serde::Deserialize;

use crate::web::client::{
    apply_browser_headers, rate_limit_domain, retry_with_backoff, DDG_MIN_REQUEST_INTERVAL_MS,
    SEARCH_RETRY_MAX,
};
use crate::web::text::normalize_search_text;

use super::{push_unique_search_result, WebSearchEntry, BING_SEARCH_ENDPOINT};

#[derive(Deserialize)]
pub(crate) struct BingWebSearchResponse {
    #[serde(rename = "webPages")]
    pub(crate) web_pages: Option<BingWebPages>,
}

#[derive(Deserialize)]
pub(crate) struct BingWebPages {
    pub(crate) value: Vec<BingWebResult>,
}

#[derive(Deserialize)]
pub(crate) struct BingWebResult {
    pub(crate) name: String,
    pub(crate) url: String,
    pub(crate) snippet: String,
}

/// Bing 入口：有 API key 走官方 API，否则走免 key 的 RSS 端点。
pub(crate) fn collect_bing_results(
    client: &reqwest::blocking::Client,
    query: &str,
    max_results: usize,
) -> Result<Vec<WebSearchEntry>, String> {
    let api_key = std::env::var("CODEPAPR_BING_API_KEY")
        .ok()
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty());

    match api_key {
        Some(key) => collect_bing_api_results(client, &key, query, max_results),
        None => collect_bing_rss_results(client, query, max_results),
    }
}

fn collect_bing_api_results(
    client: &reqwest::blocking::Client,
    api_key: &str,
    query: &str,
    max_results: usize,
) -> Result<Vec<WebSearchEntry>, String> {
    let count = max_results.min(10);
    let mut search_url = reqwest::Url::parse(BING_SEARCH_ENDPOINT)
        .map_err(|err| format!("Bing 搜索 URL 构造失败: {err}"))?;
    search_url.query_pairs_mut().append_pair("q", query);
    search_url
        .query_pairs_mut()
        .append_pair("count", &count.to_string());
    search_url.query_pairs_mut().append_pair("mkt", "zh-CN");

    let response = retry_with_backoff(
        || {
            client
                .get(search_url.clone())
                .header("Ocp-Apim-Subscription-Key", api_key)
                .header(reqwest::header::ACCEPT, "application/json")
                .send()
                .map_err(|err| format!("Bing 搜索失败: {err}"))
        },
        SEARCH_RETRY_MAX,
    )?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Bing 搜索失败: HTTP {status}"));
    }

    let text = response
        .text()
        .map_err(|err| format!("读取 Bing 搜索结果失败: {err}"))?;
    let payload = serde_json::from_str::<BingWebSearchResponse>(&text)
        .map_err(|err| format!("解析 Bing 搜索结果失败: {err}"))?;

    let mut results = Vec::new();
    if let Some(web_pages) = payload.web_pages {
        for item in web_pages.value.into_iter().take(max_results) {
            push_unique_search_result(
                &mut results,
                WebSearchEntry {
                    title: item.name,
                    url: item.url,
                    snippet: item.snippet,
                },
            );
        }
    }
    Ok(results)
}

/// 免 key 的 Bing RSS 端点（bing.com/search?format=rss）。
pub(crate) fn collect_bing_rss_results(
    client: &reqwest::blocking::Client,
    query: &str,
    max_results: usize,
) -> Result<Vec<WebSearchEntry>, String> {
    let mut search_url = reqwest::Url::parse("https://www.bing.com/search")
        .map_err(|err| format!("Bing RSS URL 构造失败: {err}"))?;
    {
        let mut pairs = search_url.query_pairs_mut();
        pairs.append_pair("q", query);
        pairs.append_pair("format", "rss");
        pairs.append_pair("count", &max_results.min(10).to_string());
    }

    let response = retry_with_backoff(
        || {
            rate_limit_domain(
                "www.bing.com",
                Duration::from_millis(DDG_MIN_REQUEST_INTERVAL_MS),
            );
            apply_browser_headers(client.get(search_url.clone()), Some("https://www.bing.com/"))
                .header(
                    reqwest::header::ACCEPT,
                    "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
                )
                .send()
                .map_err(|err| format!("Bing RSS 搜索失败: {err}"))
        },
        SEARCH_RETRY_MAX,
    )?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Bing RSS 搜索失败: HTTP {status}"));
    }

    let text = response
        .text()
        .map_err(|err| format!("读取 Bing RSS 结果失败: {err}"))?;
    let results = parse_bing_rss(&text, max_results);
    if results.is_empty() {
        return Err("Bing RSS 未返回结果".to_string());
    }
    Ok(results)
}

/// 手工解析 RSS：提取 <item> 中的 title/link/description。
/// 不引入 XML 解析器——Bing RSS 结构稳定且内容已被实体转义。
pub(crate) fn parse_bing_rss(xml: &str, max_results: usize) -> Vec<WebSearchEntry> {
    let mut results = Vec::new();
    let lower = xml.to_lowercase();
    let mut cursor = 0usize;

    while results.len() < max_results {
        let Some(start_rel) = lower[cursor..].find("<item>") else {
            break;
        };
        let start = cursor + start_rel + "<item>".len();
        let Some(end_rel) = lower[start..].find("</item>") else {
            break;
        };
        let end = start + end_rel;
        cursor = end + "</item>".len();

        let item = &xml[start..end];
        let title = extract_rss_field(item, "title");
        let link = extract_rss_field(item, "link");
        let description = extract_rss_field(item, "description");

        if title.is_empty() || link.is_empty() {
            continue;
        }
        push_unique_search_result(
            &mut results,
            WebSearchEntry {
                title: normalize_search_text(&title),
                url: link.trim().to_string(),
                snippet: normalize_search_text(&description),
            },
        );
    }

    results
}

fn extract_rss_field(item: &str, tag: &str) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let lower = item.to_lowercase();
    let Some(start_rel) = lower.find(&open) else {
        return String::new();
    };
    let start = start_rel + open.len();
    let Some(end_rel) = lower[start..].find(&close) else {
        return String::new();
    };
    item[start..start + end_rel].trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_bing_rss_extracts_items_and_unescapes_entities() {
        let xml = r#"<?xml version="1.0" encoding="utf-8" ?><rss version="2.0"><channel>
<title>Bing: query</title>
<item><title>First &amp; result</title><link>https://example.com/a</link><description>Desc &amp; one</description><pubDate>x</pubDate></item>
<item><title><![CDATA[Second result]]></title><link>https://example.com/b</link><description>Desc two</description></item>
<item><title>No link</title><description>missing link field</description></item>
</channel></rss>"#;

        let results = parse_bing_rss(xml, 10);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "First & result");
        assert_eq!(results[0].url, "https://example.com/a");
        assert_eq!(results[0].snippet, "Desc & one");
        assert_eq!(results[1].title, "Second result");
        assert_eq!(results[1].url, "https://example.com/b");
    }

    #[test]
    fn parse_bing_rss_respects_max_results() {
        let xml = (0..5)
            .map(|i| {
                format!(
                    "<item><title>t{i}</title><link>https://example.com/{i}</link><description>d</description></item>"
                )
            })
            .collect::<String>();

        let results = parse_bing_rss(&format!("<rss>{xml}</rss>"), 3);
        assert_eq!(results.len(), 3);
    }
}
