use serde::Deserialize;

use crate::web::client::{retry_with_backoff, SEARCH_RETRY_MAX};
use crate::web::text::normalize_search_text;

use super::{push_unique_search_result, WebSearchEntry};

#[derive(Deserialize)]
#[allow(dead_code)]
pub(crate) struct SearxngSearchResponse {
    pub(crate) results: Option<Vec<SearxngResult>>,
    pub(crate) answers: Option<Vec<String>>,
    pub(crate) suggestions: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
pub(crate) struct SearxngResult {
    pub(crate) title: String,
    pub(crate) url: String,
    pub(crate) content: Option<String>,
    pub(crate) engine: Option<String>,
    #[serde(rename = "publishedDate")]
    pub(crate) pub_date: Option<String>,
    pub(crate) category: Option<String>,
    pub(crate) img_src: Option<String>,
    pub(crate) thumbnail_src: Option<String>,
    pub(crate) resolution: Option<String>,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn collect_searxng_results(
    client: &reqwest::blocking::Client,
    base_url: &str,
    query: &str,
    max_results: usize,
    categories: &str,
    time_range: &str,
    language: &str,
    safe_search: u8,
    engines: &str,
) -> Result<(Vec<WebSearchEntry>, String, String), String> {
    let base = base_url.trim_end_matches('/');
    let mut search_url = reqwest::Url::parse(&format!("{base}/search"))
        .map_err(|err| format!("SearXNG URL 构造失败: {err}"))?;
    {
        let mut pairs = search_url.query_pairs_mut();
        pairs.append_pair("q", query);
        pairs.append_pair("format", "json");
        if !categories.is_empty() && categories != "general" {
            pairs.append_pair("categories", categories);
        }
        if !time_range.is_empty() {
            pairs.append_pair("time_range", time_range);
        }
        if !language.is_empty() {
            pairs.append_pair("language", language);
        }
        if safe_search != 1 && safe_search <= 2 {
            pairs.append_pair("safesearch", &safe_search.to_string());
        }
        if !engines.is_empty() {
            pairs.append_pair("engines", engines);
        }
    }

    let response = retry_with_backoff(
        || {
            client
                .get(search_url.clone())
                .header(reqwest::header::ACCEPT, "application/json")
                .send()
                .map_err(|err| format!("SearXNG 搜索失败: {err}"))
        },
        SEARCH_RETRY_MAX,
    )?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("SearXNG 搜索失败: HTTP {status}"));
    }

    let text = response
        .text()
        .map_err(|err| format!("读取 SearXNG 搜索结果失败: {err}"))?;
    let payload = serde_json::from_str::<SearxngSearchResponse>(&text)
        .map_err(|err| format!("解析 SearXNG 搜索结果失败: {err}"))?;

    let mut results = Vec::new();
    if let Some(items) = payload.results {
        for item in items.into_iter().take(max_results) {
            let snippet = item
                .content
                .as_deref()
                .map(normalize_search_text)
                .unwrap_or_default();
            push_unique_search_result(
                &mut results,
                WebSearchEntry {
                    title: normalize_search_text(&item.title),
                    url: item.url,
                    snippet,
                },
            );
        }
    }

    let abstract_text = payload
        .answers
        .as_ref()
        .and_then(|answers| answers.first())
        .cloned()
        .unwrap_or_default();
    let abstract_url = String::new();

    Ok((results, abstract_text, abstract_url))
}
