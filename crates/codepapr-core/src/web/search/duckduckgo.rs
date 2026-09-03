use std::time::Duration;

use scraper::{Html, Selector};
use serde::Deserialize;

use crate::web::client::{
    apply_browser_headers, rate_limit_domain, retry_with_backoff, DDG_MIN_REQUEST_INTERVAL_MS,
    SEARCH_RETRY_MAX,
};
use crate::web::text::{decode_html_entities, normalize_search_text};

use super::{push_unique_search_result, WebSearchEntry};

fn resolve_duckduckgo_result_url(raw_href: &str) -> Option<String> {
    let decoded = decode_html_entities(raw_href);
    let candidate = if decoded.starts_with("//") {
        format!("https:{decoded}")
    } else {
        decoded
    };

    let Ok(parsed) = reqwest::Url::parse(&candidate) else {
        return None;
    };

    if parsed
        .host_str()
        .map(|host| host.contains("duckduckgo.com"))
        .unwrap_or(false)
        && parsed.path() == "/l/"
    {
        if let Some((_, target)) = parsed.query_pairs().find(|(key, _)| key == "uddg") {
            return Some(target.to_string());
        }
    }

    if parsed.scheme() == "http" || parsed.scheme() == "https" {
        Some(parsed.to_string())
    } else {
        None
    }
}

pub(crate) fn collect_duckduckgo_html_results(
    client: &reqwest::blocking::Client,
    query: &str,
    max_results: usize,
) -> Result<Vec<WebSearchEntry>, String> {
    let search_url = "https://html.duckduckgo.com/html/";
    let form: [(&str, &str); 4] = [("q", query), ("kl", "wt-wt"), ("kp", "-2"), ("kz", "1")];

    let response = retry_with_backoff(
        || {
            rate_limit_domain(
                "html.duckduckgo.com",
                Duration::from_millis(DDG_MIN_REQUEST_INTERVAL_MS),
            );
            apply_browser_headers(client.post(search_url), Some("https://duckduckgo.com/"))
                .form(&form)
                .send()
                .map_err(|err| format!("DuckDuckGo 搜索失败: {err}"))
        },
        SEARCH_RETRY_MAX,
    )?;
    let status = response.status();
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status == reqwest::StatusCode::FORBIDDEN
    {
        std::thread::sleep(Duration::from_secs(5));
        let retry_response = retry_with_backoff(
            || {
                rate_limit_domain(
                    "html.duckduckgo.com",
                    Duration::from_millis(DDG_MIN_REQUEST_INTERVAL_MS * 2),
                );
                apply_browser_headers(client.post(search_url), Some("https://duckduckgo.com/"))
                    .form(&form)
                    .send()
                    .map_err(|err| format!("DuckDuckGo 搜索失败: {err}"))
            },
            SEARCH_RETRY_MAX,
        )?;
        return parse_duckduckgo_html(retry_response, max_results);
    }
    if !status.is_success() {
        return Err(format!("DuckDuckGo 搜索失败: HTTP {status}"));
    }

    parse_duckduckgo_html(response, max_results)
}

pub(crate) fn collect_duckduckgo_lite_results(
    client: &reqwest::blocking::Client,
    query: &str,
    max_results: usize,
) -> Result<Vec<WebSearchEntry>, String> {
    let search_url = "https://lite.duckduckgo.com/lite/";
    let form: [(&str, &str); 2] = [("q", query), ("kl", "wt-wt")];

    let response = retry_with_backoff(
        || {
            rate_limit_domain(
                "lite.duckduckgo.com",
                Duration::from_millis(DDG_MIN_REQUEST_INTERVAL_MS),
            );
            apply_browser_headers(client.post(search_url), Some("https://duckduckgo.com/"))
                .form(&form)
                .send()
                .map_err(|err| format!("DuckDuckGo Lite 搜索失败: {err}"))
        },
        SEARCH_RETRY_MAX,
    )?;
    if !response.status().is_success() {
        return Err(format!(
            "DuckDuckGo Lite 搜索失败: HTTP {}",
            response.status()
        ));
    }
    parse_duckduckgo_lite(response, max_results)
}

fn parse_duckduckgo_lite(
    response: reqwest::blocking::Response,
    max_results: usize,
) -> Result<Vec<WebSearchEntry>, String> {
    let html = response
        .text()
        .map_err(|err| format!("读取 DuckDuckGo Lite 搜索结果失败: {err}"))?;
    parse_duckduckgo_lite_str(&html, max_results)
}

/// DDG 风控页特征：anomaly 弹窗或 challenge 表单。命中时视为失败，
/// 让调用方走兜底源，而不是拿到 0 条结果。
fn is_duckduckgo_challenge(html: &str) -> bool {
    html.contains("anomaly-modal")
        || html.contains("challenge-form")
        || html.contains("challenge-platform")
}

pub(crate) fn parse_duckduckgo_lite_str(
    html: &str,
    max_results: usize,
) -> Result<Vec<WebSearchEntry>, String> {
    if is_duckduckgo_challenge(html) {
        return Err("DuckDuckGo Lite 被风控拦截".to_string());
    }
    let document = Html::parse_document(html);
    let row_sel = Selector::parse("tr").map_err(|_| "DuckDuckGo Lite 页面解析失败".to_string())?;
    let link_sel =
        Selector::parse("a.result-link").map_err(|_| "DuckDuckGo Lite 页面解析失败".to_string())?;
    let snippet_sel = Selector::parse("td.result-snippet")
        .map_err(|_| "DuckDuckGo Lite 页面解析失败".to_string())?;

    let mut results = Vec::new();
    let mut pending_title: Option<(String, String)> = None;
    for row in document.select(&row_sel) {
        if results.len() >= max_results {
            break;
        }
        if let Some(link_el) = row.select(&link_sel).next() {
            let title = normalize_search_text(&link_el.text().collect::<String>());
            let href = link_el.value().attr("href").unwrap_or("").to_string();
            if !title.is_empty() && !href.is_empty() {
                pending_title = Some((title, href));
            }
            continue;
        }
        if let Some(snippet_el) = row.select(&snippet_sel).next() {
            if let Some((title, href)) = pending_title.take() {
                let url = resolve_duckduckgo_result_url(&href);
                let snippet = normalize_search_text(&snippet_el.text().collect::<String>());
                if let Some(url) = url {
                    push_unique_search_result(
                        &mut results,
                        WebSearchEntry {
                            title,
                            url,
                            snippet,
                        },
                    );
                }
            }
        }
    }
    if let Some((title, href)) = pending_title.take() {
        if results.len() < max_results {
            if let Some(url) = resolve_duckduckgo_result_url(&href) {
                push_unique_search_result(
                    &mut results,
                    WebSearchEntry {
                        title,
                        url,
                        snippet: String::new(),
                    },
                );
            }
        }
    }
    Ok(results)
}

fn parse_duckduckgo_html(
    response: reqwest::blocking::Response,
    max_results: usize,
) -> Result<Vec<WebSearchEntry>, String> {
    let html = response
        .text()
        .map_err(|err| format!("读取 DuckDuckGo 搜索结果失败: {err}"))?;
    parse_duckduckgo_html_str(&html, max_results)
}

pub(crate) fn parse_duckduckgo_html_str(
    html: &str,
    max_results: usize,
) -> Result<Vec<WebSearchEntry>, String> {
    if is_duckduckgo_challenge(html) {
        return Err("DuckDuckGo 被风控拦截".to_string());
    }
    let document = Html::parse_document(html);
    let result_body_sel =
        Selector::parse(".result__body").map_err(|_| "DuckDuckGo 页面解析失败".to_string())?;
    let link_sel =
        Selector::parse("a.result__a").map_err(|_| "DuckDuckGo 页面解析失败".to_string())?;
    let snippet_sel =
        Selector::parse(".result__snippet").map_err(|_| "DuckDuckGo 页面解析失败".to_string())?;

    let mut results = Vec::new();
    for body in document.select(&result_body_sel) {
        if results.len() >= max_results {
            break;
        }

        let Some(link_el) = body.select(&link_sel).next() else {
            continue;
        };
        let title = link_el.text().collect::<String>().trim().to_string();
        let title = normalize_search_text(&title);
        let href = link_el.value().attr("href").unwrap_or("");
        let url = resolve_duckduckgo_result_url(href);

        let snippet = body
            .select(&snippet_sel)
            .next()
            .map(|el| normalize_search_text(&el.text().collect::<String>()))
            .unwrap_or_default();

        if let Some(url) = url {
            push_unique_search_result(
                &mut results,
                WebSearchEntry {
                    title,
                    url,
                    snippet,
                },
            );
        }
    }

    Ok(results)
}

#[derive(Deserialize)]
pub(crate) struct DuckDuckGoInstantResponse {
    #[serde(rename = "AbstractText")]
    pub(crate) abstract_text: Option<String>,
    #[serde(rename = "AbstractURL")]
    pub(crate) abstract_url: Option<String>,
    #[serde(rename = "RelatedTopics")]
    pub(crate) related_topics: Option<serde_json::Value>,
}

pub(crate) fn fetch_duckduckgo_instant(
    client: &reqwest::blocking::Client,
    query: &str,
) -> Result<DuckDuckGoInstantResponse, String> {
    let mut search_url = reqwest::Url::parse("https://api.duckduckgo.com/")
        .map_err(|err| format!("DuckDuckGo API URL 构造失败: {err}"))?;
    {
        let mut pairs = search_url.query_pairs_mut();
        pairs.append_pair("q", query);
        pairs.append_pair("format", "json");
        pairs.append_pair("no_html", "1");
        pairs.append_pair("skip_disambig", "1");
    }

    let response = retry_with_backoff(
        || {
            rate_limit_domain(
                "api.duckduckgo.com",
                Duration::from_millis(DDG_MIN_REQUEST_INTERVAL_MS),
            );
            client
                .get(search_url.clone())
                .header(reqwest::header::ACCEPT, "application/json")
                .send()
                .map_err(|err| format!("DuckDuckGo Instant 搜索失败: {err}"))
        },
        SEARCH_RETRY_MAX,
    )?;
    let status = response.status();
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status == reqwest::StatusCode::FORBIDDEN
    {
        std::thread::sleep(Duration::from_secs(5));
        let retry_response = retry_with_backoff(
            || {
                rate_limit_domain(
                    "api.duckduckgo.com",
                    Duration::from_millis(DDG_MIN_REQUEST_INTERVAL_MS * 2),
                );
                client
                    .get(search_url.clone())
                    .header(reqwest::header::ACCEPT, "application/json")
                    .send()
                    .map_err(|err| format!("DuckDuckGo Instant 搜索失败: {err}"))
            },
            1,
        )?;
        let retry_status = retry_response.status();
        if !retry_status.is_success() {
            return Err(format!("DuckDuckGo Instant 搜索失败: HTTP {retry_status}"));
        }
        return parse_duckduckgo_instant_response(retry_response);
    }
    if !status.is_success() {
        return Err(format!("DuckDuckGo Instant 搜索失败: HTTP {status}"));
    }

    parse_duckduckgo_instant_response(response)
}

fn parse_duckduckgo_instant_response(
    response: reqwest::blocking::Response,
) -> Result<DuckDuckGoInstantResponse, String> {
    let text = response
        .text()
        .map_err(|err| format!("读取 DuckDuckGo Instant 搜索结果失败: {err}"))?;

    serde_json::from_str::<DuckDuckGoInstantResponse>(&text)
        .map_err(|err| format!("解析 DuckDuckGo Instant 搜索结果失败: {err}"))
}

pub(crate) fn collect_duckduckgo_related_results(
    topics: &serde_json::Value,
    results: &mut Vec<WebSearchEntry>,
    max_results: usize,
) {
    let Some(items) = topics.as_array() else {
        return;
    };

    for item in items {
        if results.len() >= max_results {
            break;
        }

        if let (Some(text), Some(url)) = (
            item.get("Text").and_then(|value| value.as_str()),
            item.get("FirstURL").and_then(|value| value.as_str()),
        ) {
            let snippet = normalize_search_text(text);
            let title = snippet
                .split(" - ")
                .next()
                .unwrap_or(&snippet)
                .trim()
                .to_string();
            push_unique_search_result(
                results,
                WebSearchEntry {
                    title,
                    url: url.to_string(),
                    snippet,
                },
            );
        }

        if let Some(nested) = item.get("Topics") {
            collect_duckduckgo_related_results(nested, results, max_results);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_duckduckgo_html_str_extracts_results_and_resolves_redirect() {
        let html = r#"<html><body>
<div class="result__body">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=abc">Example title</a>
  <div class="result__snippet">Example snippet</div>
</div>
<div class="result__body">
  <a class="result__a" href="https://direct.example.org/x">Direct title</a>
  <div class="result__snippet">Direct snippet</div>
</div>
</body></html>"#;

        let results = parse_duckduckgo_html_str(html, 10).expect("parse should succeed");
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "Example title");
        assert_eq!(results[0].url, "https://example.com/page");
        assert_eq!(results[0].snippet, "Example snippet");
        assert_eq!(results[1].url, "https://direct.example.org/x");
    }

    #[test]
    fn parse_duckduckgo_html_str_rejects_anomaly_page() {
        let html = r#"<html><body><div id="anomaly-modal">Please verify</div></body></html>"#;
        let error = parse_duckduckgo_html_str(html, 10).expect_err("anomaly page should fail");
        assert!(error.contains("风控"));
    }

    #[test]
    fn parse_duckduckgo_lite_str_extracts_results() {
        let html = r#"<html><body><table>
<tr><td><a class="result-link" href="https://lite.example.com/a">Lite title</a></td></tr>
<tr><td class="result-snippet">Lite snippet</td></tr>
</table></body></html>"#;

        let results = parse_duckduckgo_lite_str(html, 10).expect("parse should succeed");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Lite title");
        assert_eq!(results[0].url, "https://lite.example.com/a");
        assert_eq!(results[0].snippet, "Lite snippet");
    }

    #[test]
    fn parse_duckduckgo_lite_str_rejects_challenge_page() {
        let html = "<html><body><form class=\"challenge-form\"></form></body></html>";
        assert!(parse_duckduckgo_lite_str(html, 10).is_err());
    }
}
