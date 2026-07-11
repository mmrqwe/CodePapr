use serde::Deserialize;

use crate::web::client::{retry_with_backoff, SEARCH_RETRY_MAX};

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

pub(crate) fn collect_bing_results(
    client: &reqwest::blocking::Client,
    query: &str,
    max_results: usize,
) -> Result<Vec<WebSearchEntry>, String> {
    let api_key = match std::env::var("CODEPAPR_BING_API_KEY") {
        Ok(key) if !key.trim().is_empty() => key,
        _ => return Ok(Vec::new()),
    };

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
                .header("Ocp-Apim-Subscription-Key", &api_key)
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
