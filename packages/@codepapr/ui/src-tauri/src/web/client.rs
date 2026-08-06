use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::web::search::WebSearchResponse;

pub(crate) const SCRAPER_USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
pub(crate) const SEARCH_CACHE_TTL_SECS: u64 = 300;
pub(crate) const SEARCH_RETRY_MAX: u32 = 2;
pub(crate) const DDG_MIN_REQUEST_INTERVAL_MS: u64 = 1500;
/// 源失败后的冷却时间：期间跳过该源，避免反复撞限流/风控
pub(crate) const SOURCE_COOLDOWN_SECS: u64 = 300;

pub(crate) static SEARCH_CACHE: OnceLock<Mutex<HashMap<String, (Instant, WebSearchResponse)>>> =
    OnceLock::new();
pub(crate) static RATE_LIMIT_LAST_REQUEST: OnceLock<Mutex<HashMap<String, Instant>>> =
    OnceLock::new();
pub(crate) static SOURCE_FAILURES: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();

pub(crate) fn build_web_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(SCRAPER_USER_AGENT)
        .cookie_store(true)
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|err| format!("初始化网页客户端失败: {err}"))
}

/// HTTP client for papr app `papr.http` calls. Redirects are disabled so a
/// public URL cannot 302-bounce into an internal/loopback address (SSRF), and
/// no cookie store is used so apps do not share host cookies. When `pin` is
/// provided the domain is pinned to a pre-vetted socket address, closing the
/// DNS-rebinding TOCTOU window between validation and connect.
pub(crate) fn build_papr_http_client(
    pin: Option<(String, std::net::SocketAddr)>,
) -> Result<reqwest::blocking::Client, String> {
    let mut builder = reqwest::blocking::Client::builder()
        .user_agent(SCRAPER_USER_AGENT)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20));
    if let Some((domain, addr)) = pin {
        builder = builder.resolve(&domain, addr);
    }
    builder
        .build()
        .map_err(|err| format!("初始化 papr HTTP 客户端失败: {err}"))
}

pub(crate) fn apply_browser_headers(
    request: reqwest::blocking::RequestBuilder,
    referer: Option<&str>,
) -> reqwest::blocking::RequestBuilder {
    let mut req = request
        .header(
            reqwest::header::ACCEPT,
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
        )
        .header(reqwest::header::ACCEPT_LANGUAGE, "en-US,en;q=0.9")
        .header(reqwest::header::ACCEPT_ENCODING, "gzip, deflate, br")
        .header("DNT", "1")
        .header("Upgrade-Insecure-Requests", "1")
        .header("Sec-Fetch-Dest", "document")
        .header("Sec-Fetch-Mode", "navigate")
        .header("Sec-Fetch-User", "?1")
        .header(
            "Sec-Ch-Ua",
            "\"Chromium\";v=\"136\", \"Google Chrome\";v=\"136\", \"Not.A/Brand\";v=\"99\"",
        )
        .header("Sec-Ch-Ua-Mobile", "?0")
        .header("Sec-Ch-Ua-Platform", "\"macOS\"");
    if let Some(ref_url) = referer {
        req = req
            .header(reqwest::header::REFERER, ref_url)
            .header("Sec-Fetch-Site", "same-origin");
    } else {
        req = req.header("Sec-Fetch-Site", "none");
    }
    req
}

pub(crate) fn rate_limit_domain(domain: &str, min_interval: Duration) {
    let map = RATE_LIMIT_LAST_REQUEST.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(mut lock) = map.lock() {
        let now = Instant::now();
        if let Some(last) = lock.get(domain) {
            let elapsed = now.duration_since(*last);
            if elapsed < min_interval {
                std::thread::sleep(min_interval - elapsed);
            }
        }
        lock.insert(domain.to_string(), Instant::now());
    }
}

pub(crate) fn retry_with_backoff<T, F>(mut f: F, max_retries: u32) -> Result<T, String>
where
    F: FnMut() -> Result<T, String>,
{
    let mut last_error = String::new();
    for attempt in 0..=max_retries {
        match f() {
            Ok(result) => return Ok(result),
            Err(err) => {
                last_error = err;
                if attempt < max_retries {
                    let delay = Duration::from_millis(500 * 2u64.pow(attempt));
                    std::thread::sleep(delay);
                }
            }
        }
    }
    Err(last_error)
}

fn search_cache_key(query: &str, scope: &str) -> String {
    format!("{scope}\u{1f}{}", query.trim().to_lowercase())
}

pub(crate) fn get_cached_search(query: &str, scope: &str) -> Option<WebSearchResponse> {
    let cache = SEARCH_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()?;
    cache
        .get(&search_cache_key(query, scope))
        .filter(|entry| entry.0.elapsed() < Duration::from_secs(SEARCH_CACHE_TTL_SECS))
        .map(|entry| entry.1.clone())
}

pub(crate) fn cache_search_response(query: &str, scope: &str, response: &WebSearchResponse) {
    // 空结果不缓存：一次失败不应污染后续 TTL 内的相同查询
    if response.results.is_empty() && response.abstract_text.trim().is_empty() {
        return;
    }
    if let Ok(mut cache) = SEARCH_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        cache.insert(
            search_cache_key(query, scope),
            (Instant::now(), response.clone()),
        );
    }
}

pub(crate) fn mark_source_failed(source: &str) {
    if let Ok(mut map) = SOURCE_FAILURES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        map.insert(source.to_string(), Instant::now());
    }
}

pub(crate) fn mark_source_ok(source: &str) {
    if let Ok(mut map) = SOURCE_FAILURES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        map.remove(source);
    }
}

pub(crate) fn is_source_cooling_down(source: &str) -> bool {
    SOURCE_FAILURES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()
        .and_then(|map| map.get(source).copied())
        .map(|failed_at| failed_at.elapsed() < Duration::from_secs(SOURCE_COOLDOWN_SECS))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::web::search::WebSearchEntry;

    fn response(results: Vec<WebSearchEntry>, abstract_text: &str) -> WebSearchResponse {
        WebSearchResponse {
            query: "q".to_string(),
            abstract_text: abstract_text.to_string(),
            abstract_url: String::new(),
            results,
            degraded: false,
            note: None,
            sources: Vec::new(),
        }
    }

    fn entry(url: &str) -> WebSearchEntry {
        WebSearchEntry {
            title: "t".to_string(),
            url: url.to_string(),
            snippet: String::new(),
        }
    }

    #[test]
    fn empty_response_is_not_cached() {
        let empty = response(Vec::new(), "");
        cache_search_response("empty-cache-probe", "builtin", &empty);
        assert!(get_cached_search("empty-cache-probe", "builtin").is_none());

        let abstract_only = response(Vec::new(), "instant answer");
        cache_search_response("abstract-cache-probe", "builtin", &abstract_only);
        assert!(get_cached_search("abstract-cache-probe", "builtin").is_some());
    }

    #[test]
    fn cache_key_is_scoped_by_source_config() {
        let with_results = response(vec![entry("https://a.com")], "");
        cache_search_response("scoped-probe", "searxng:https://s.example", &with_results);
        assert!(get_cached_search("scoped-probe", "searxng:https://s.example").is_some());
        assert!(get_cached_search("scoped-probe", "builtin").is_none());
    }

    #[test]
    fn source_cooldown_tracks_failures() {
        mark_source_failed("unit-test-source");
        assert!(is_source_cooling_down("unit-test-source"));
        mark_source_ok("unit-test-source");
        assert!(!is_source_cooling_down("unit-test-source"));
    }
}
