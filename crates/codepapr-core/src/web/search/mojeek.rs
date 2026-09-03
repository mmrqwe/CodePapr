use std::time::Duration;

use scraper::{Html, Selector};

use crate::web::client::{
    apply_browser_headers, rate_limit_domain, retry_with_backoff, DDG_MIN_REQUEST_INTERVAL_MS,
    SEARCH_RETRY_MAX,
};
use crate::web::text::normalize_search_text;

use super::{push_unique_search_result, WebSearchEntry};

pub(crate) fn collect_mojeek_results(
    client: &reqwest::blocking::Client,
    query: &str,
    max_results: usize,
) -> Result<Vec<WebSearchEntry>, String> {
    let mut search_url = reqwest::Url::parse("https://www.mojeek.com/search")
        .map_err(|err| format!("Mojeek 搜索 URL 构造失败: {err}"))?;
    search_url
        .query_pairs_mut()
        .append_pair("q", query)
        .append_pair("fmt", "html");

    let response = retry_with_backoff(
        || {
            rate_limit_domain(
                "www.mojeek.com",
                Duration::from_millis(DDG_MIN_REQUEST_INTERVAL_MS),
            );
            apply_browser_headers(
                client.get(search_url.clone()),
                Some("https://www.mojeek.com/"),
            )
            .send()
            .map_err(|err| format!("Mojeek 搜索失败: {err}"))
        },
        SEARCH_RETRY_MAX,
    )?;
    if !response.status().is_success() {
        return Err(format!("Mojeek 搜索失败: HTTP {}", response.status()));
    }

    let html = response
        .text()
        .map_err(|err| format!("读取 Mojeek 搜索结果失败: {err}"))?;
    let document = Html::parse_document(&html);
    let result_sel = Selector::parse("ul.results-standard li, ul.results li")
        .map_err(|_| "Mojeek 页面解析失败".to_string())?;
    let title_sel =
        Selector::parse("a.title, h2 a").map_err(|_| "Mojeek 页面解析失败".to_string())?;
    let snippet_sel =
        Selector::parse("p.s, p.result-snippet").map_err(|_| "Mojeek 页面解析失败".to_string())?;

    let mut results = Vec::new();
    for item in document.select(&result_sel) {
        if results.len() >= max_results {
            break;
        }
        let Some(title_el) = item.select(&title_sel).next() else {
            continue;
        };
        let title = normalize_search_text(&title_el.text().collect::<String>());
        let url = title_el.value().attr("href").unwrap_or("").to_string();
        if title.is_empty() || url.is_empty() || !url.starts_with("http") {
            continue;
        }
        let snippet = item
            .select(&snippet_sel)
            .next()
            .map(|el| normalize_search_text(&el.text().collect::<String>()))
            .unwrap_or_default();
        push_unique_search_result(
            &mut results,
            WebSearchEntry {
                title,
                url,
                snippet,
            },
        );
    }
    Ok(results)
}
