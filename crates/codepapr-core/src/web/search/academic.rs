use std::sync::OnceLock;

use regex::Regex;
use serde::Deserialize;

use crate::web::client::retry_with_backoff;
use crate::web::text::normalize_search_text;

use super::{
    push_unique_search_result, WebSearchEntry, ARXIV_API_ENDPOINT, OPENALEX_API_ENDPOINT,
};

#[derive(Deserialize)]
pub(crate) struct WikipediaSearchResponse {
    pub(crate) query: Option<WikipediaQueryContainer>,
}

#[derive(Deserialize)]
pub(crate) struct WikipediaQueryContainer {
    pub(crate) search: Option<Vec<WikipediaSearchItem>>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
pub(crate) struct WikipediaSearchItem {
    pub(crate) title: String,
    pub(crate) snippet: String,
    pub(crate) pageid: u64,
    #[serde(default)]
    pub(crate) wordcount: u64,
}

#[derive(Deserialize)]
pub(crate) struct OpenAlexSearchResponse {
    pub(crate) results: Option<Vec<OpenAlexWork>>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
pub(crate) struct OpenAlexWork {
    pub(crate) title: String,
    pub(crate) id: String,
    pub(crate) doi: Option<String>,
}

/// 按语言版本检索 Wikipedia（W3）：中文查询走 zh.wikipedia.org，避免英文百科噪声。
/// `language` 取 "zh" / "en"（其余值按 en 处理）。
pub(crate) fn collect_wikipedia_results(
    client: &reqwest::blocking::Client,
    query: &str,
    max_results: usize,
    language: &str,
) -> Result<Vec<WebSearchEntry>, String> {
    let subdomain = if language.starts_with("zh") { "zh" } else { "en" };
    let api_endpoint = format!("https://{subdomain}.wikipedia.org/w/api.php");
    let mut search_url = reqwest::Url::parse(&api_endpoint)
        .map_err(|err| format!("Wikipedia URL 构造失败: {err}"))?;
    {
        let mut pairs = search_url.query_pairs_mut();
        pairs.append_pair("action", "query");
        pairs.append_pair("list", "search");
        pairs.append_pair("srsearch", query);
        pairs.append_pair("format", "json");
        pairs.append_pair("srlimit", &max_results.min(10).to_string());
    }

    let response = retry_with_backoff(
        || {
            client
                .get(search_url.clone())
                .header(reqwest::header::ACCEPT, "application/json")
                .header(
                    reqwest::header::USER_AGENT,
                    "CodePapr/0.1 (https://github.com; research bot; contact@example.com)",
                )
                .send()
                .map_err(|err| format!("Wikipedia 搜索失败: {err}"))
        },
        crate::web::client::SEARCH_RETRY_MAX,
    )?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Wikipedia 搜索失败: HTTP {status}"));
    }

    let text = response
        .text()
        .map_err(|err| format!("读取 Wikipedia 搜索结果失败: {err}"))?;
    let payload = serde_json::from_str::<WikipediaSearchResponse>(&text)
        .map_err(|err| format!("解析 Wikipedia 搜索结果失败: {err}"))?;

    let mut results = Vec::new();
    if let Some(query_container) = payload.query {
        if let Some(items) = query_container.search {
            for item in items.into_iter().take(max_results) {
                let url = format!(
                    "https://{subdomain}.wikipedia.org/wiki/{}",
                    item.title.replace(' ', "_")
                );
                push_unique_search_result(
                    &mut results,
                    WebSearchEntry {
                        title: item.title,
                        url,
                        snippet: normalize_search_text(&item.snippet),
                    },
                );
            }
        }
    }
    Ok(results)
}

/// Field-extraction regexes for arXiv Atom entries. Compiled once, reused
/// across every search; the patterns are static strings so construction
/// cannot fail.
static ARXIV_FIELD_REGEXES: OnceLock<[Regex; 3]> = OnceLock::new();

fn arxiv_field_regexes() -> &'static [Regex; 3] {
    ARXIV_FIELD_REGEXES.get_or_init(|| {
        [
            Regex::new(r"<title[^>]*>([\s\S]*?)</title>").expect("valid arxiv title regex"),
            Regex::new(r"<summary[^>]*>([\s\S]*?)</summary>").expect("valid arxiv summary regex"),
            Regex::new(r"<id[^>]*>([\s\S]*?)</id>").expect("valid arxiv id regex"),
        ]
    })
}

pub(crate) fn collect_arxiv_results(
    client: &reqwest::blocking::Client,
    query: &str,
    max_results: usize,
) -> Result<Vec<WebSearchEntry>, String> {
    let max_results = max_results.min(10);
    let mut search_url = reqwest::Url::parse(ARXIV_API_ENDPOINT)
        .map_err(|err| format!("arXiv URL 构造失败: {err}"))?;
    {
        let mut pairs = search_url.query_pairs_mut();
        pairs.append_pair("search_query", &format!("all:{}", query));
        pairs.append_pair("max_results", &max_results.to_string());
    }

    let response = retry_with_backoff(
        || {
            client
                .get(search_url.clone())
                .header(reqwest::header::ACCEPT, "application/atom+xml")
                .send()
                .map_err(|err| format!("arXiv 搜索失败: {err}"))
        },
        1,
    )?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("arXiv 搜索失败: HTTP {status}"));
    }

    let body = response
        .text()
        .map_err(|err| format!("读取 arXiv 搜索结果失败: {err}"))?;

    let entry_re =
        Regex::new(r"<entry>[\s\S]*?</entry>").map_err(|_| "arXiv 解析正则构造失败".to_string())?;
    let [title_re, summary_re, id_re] = arxiv_field_regexes();

    let mut results = Vec::new();
    for entry in entry_re.find_iter(&body) {
        if results.len() >= max_results {
            break;
        }
        let entry_text = entry.as_str();

        let title = title_re
            .captures(entry_text)
            .and_then(|caps| caps.get(1))
            .map(|m| normalize_search_text(m.as_str().trim()))
            .unwrap_or_default();
        let id_url = id_re
            .captures(entry_text)
            .and_then(|caps| caps.get(1))
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();

        if title.starts_with("ArXiv Query:") || title.is_empty() {
            continue;
        }

        let raw_summary = summary_re
            .captures(entry_text)
            .and_then(|caps| caps.get(1))
            .map(|m| normalize_search_text(m.as_str().trim()))
            .unwrap_or_default();

        if !id_url.is_empty() {
            push_unique_search_result(
                &mut results,
                WebSearchEntry {
                    title,
                    url: id_url,
                    snippet: raw_summary,
                },
            );
        }
    }
    Ok(results)
}

pub(crate) fn collect_openalex_results(
    client: &reqwest::blocking::Client,
    query: &str,
    max_results: usize,
) -> Result<Vec<WebSearchEntry>, String> {
    let max_results = max_results.min(10);
    let mut search_url = reqwest::Url::parse(OPENALEX_API_ENDPOINT)
        .map_err(|err| format!("OpenAlex URL 构造失败: {err}"))?;
    {
        let mut pairs = search_url.query_pairs_mut();
        pairs.append_pair("search", query);
        pairs.append_pair("per_page", &max_results.to_string());
    }

    let response = retry_with_backoff(
        || {
            client
                .get(search_url.clone())
                .header(reqwest::header::ACCEPT, "application/json")
                .header(reqwest::header::USER_AGENT, "mailto:dev@codepapr.dev")
                .send()
                .map_err(|err| format!("OpenAlex 搜索失败: {err}"))
        },
        1,
    )?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("OpenAlex 搜索失败: HTTP {status}"));
    }

    let text = response
        .text()
        .map_err(|err| format!("读取 OpenAlex 搜索结果失败: {err}"))?;
    let payload = serde_json::from_str::<OpenAlexSearchResponse>(&text)
        .map_err(|err| format!("解析 OpenAlex 搜索结果失败: {err}"))?;

    let mut results = Vec::new();
    if let Some(items) = payload.results {
        for item in items.into_iter().take(max_results) {
            let url = item
                .doi
                .as_ref()
                .filter(|d| !d.is_empty())
                .map(|d| {
                    if d.starts_with("https://") || d.starts_with("http://") {
                        d.clone()
                    } else {
                        format!("https://doi.org/{}", d)
                    }
                })
                .unwrap_or_else(|| item.id.clone());
            push_unique_search_result(
                &mut results,
                WebSearchEntry {
                    title: normalize_search_text(&item.title),
                    url,
                    snippet: String::new(),
                },
            );
        }
    }
    Ok(results)
}
