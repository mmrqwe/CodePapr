use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::web::search::WebSearchResponse;

pub(crate) const SCRAPER_USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
pub(crate) const SEARCH_CACHE_TTL_SECS: u64 = 300;
pub(crate) const SEARCH_RETRY_MAX: u32 = 2;
pub(crate) const DDG_MIN_REQUEST_INTERVAL_MS: u64 = 1500;

pub(crate) static SEARCH_CACHE: OnceLock<Mutex<HashMap<String, (Instant, WebSearchResponse)>>> =
    OnceLock::new();
pub(crate) static RATE_LIMIT_LAST_REQUEST: OnceLock<Mutex<HashMap<String, Instant>>> =
    OnceLock::new();

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

fn search_cache_key(query: &str) -> String {
    query.trim().to_lowercase()
}

pub(crate) fn get_cached_search(query: &str) -> Option<WebSearchResponse> {
    let cache = SEARCH_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()?;
    cache
        .get(&search_cache_key(query))
        .filter(|entry| entry.0.elapsed() < Duration::from_secs(SEARCH_CACHE_TTL_SECS))
        .map(|entry| entry.1.clone())
}

pub(crate) fn cache_search_response(query: &str, response: &WebSearchResponse) {
    if let Ok(mut cache) = SEARCH_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        cache.insert(search_cache_key(query), (Instant::now(), response.clone()));
    }
}
