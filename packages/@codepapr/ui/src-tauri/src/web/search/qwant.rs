use std::time::Duration;

use scraper::{Html, Selector};

use crate::web::client::{
    apply_browser_headers, rate_limit_domain, retry_with_backoff, DDG_MIN_REQUEST_INTERVAL_MS,
    SEARCH_RETRY_MAX,
};
use crate::web::text::normalize_search_text;

use super::{push_unique_search_result, WebSearchEntry};

pub(crate) fn collect_qwant_lite_results(
    client: &reqwest::blocking::Client,
    query: &str,
    max_results: usize,
) -> Result<Vec<WebSearchEntry>, String> {
    let mut search_url = reqwest::Url::parse("https://lite.qwant.com/")
        .map_err(|err| format!("Qwant 搜索 URL 构造失败: {err}"))?;
    search_url.query_pairs_mut().append_pair("q", query);

    let response = retry_with_backoff(
        || {
            rate_limit_domain(
                "lite.qwant.com",
                Duration::from_millis(DDG_MIN_REQUEST_INTERVAL_MS),
            );
            apply_browser_headers(
                client.get(search_url.clone()),
                Some("https://www.qwant.com/"),
            )
            .send()
            .map_err(|err| format!("Qwant Lite 搜索失败: {err}"))
        },
        SEARCH_RETRY_MAX,
    )?;
    if !response.status().is_success() {
        return Err(format!("Qwant Lite 搜索失败: HTTP {}", response.status()));
    }

    let html = response
        .text()
        .map_err(|err| format!("读取 Qwant Lite 搜索结果失败: {err}"))?;
    let document = Html::parse_document(&html);
    let result_sel = Selector::parse("article.web.result, div.result")
        .map_err(|_| "Qwant 页面解析失败".to_string())?;
    let title_sel = Selector::parse("a.result--title, h2 a, p.title a")
        .map_err(|_| "Qwant 页面解析失败".to_string())?;
    let snippet_sel = Selector::parse("p.result--desc, p.description, p.desc")
        .map_err(|_| "Qwant 页面解析失败".to_string())?;

    let mut results = Vec::new();
    for item in document.select(&result_sel) {
        if results.len() >= max_results {
            break;
        }
        let Some(title_el) = item.select(&title_sel).next() else {
            continue;
        };
        let title = normalize_search_text(&title_el.text().collect::<String>());
        let raw_href = title_el.value().attr("href").unwrap_or("").to_string();
        let url = resolve_qwant_lite_url(&raw_href);
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

fn resolve_qwant_lite_url(href: &str) -> String {
    if let Ok(parsed) = reqwest::Url::parse(href) {
        for (key, value) in parsed.query_pairs() {
            if key == "u" || key == "uddg" {
                return value.into_owned();
            }
        }
        return parsed.to_string();
    }
    if href.starts_with("/redirect") {
        if let Ok(full) = reqwest::Url::parse(&format!("https://lite.qwant.com{href}")) {
            for (key, value) in full.query_pairs() {
                if key == "u" || key == "uddg" {
                    return value.into_owned();
                }
            }
        }
    }
    href.to_string()
}
