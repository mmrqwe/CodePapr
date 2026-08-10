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

/// SSRF 安全 GET（阻塞版，供 spawn_blocking 内使用）：
/// 1. 每一跳都校验目标 URL 不是内网/本地地址（is_private_or_internal_url）；
/// 2. 域名主机先 DNS 解析并逐地址校验为公网后 pin 到客户端（防 rebinding）；
/// 3. 客户端禁用自动重定向（Policy::none），手动跟随重定向并对每一跳重复 1/2——
///    防止公网 URL 302 跳板到 127.0.0.1 / 169.254.169.254 等内部地址。
/// 与 papr.http（build_papr_http_client + resolve_safe_socket_addr）同一防御等级。
pub(crate) fn ssrf_safe_blocking_get(
    start_url: &str,
    timeout: Duration,
    apply_headers: impl Fn(reqwest::blocking::RequestBuilder) -> reqwest::blocking::RequestBuilder,
) -> Result<reqwest::blocking::Response, String> {
    const MAX_SAFE_REDIRECTS: usize = 10;
    let mut current = start_url.to_string();
    for _ in 0..=MAX_SAFE_REDIRECTS {
        if crate::papr_runtime::services::is_private_or_internal_url(&current) {
            return Err("安全限制：不允许访问内网/本地地址".to_string());
        }
        let parsed =
            reqwest::Url::parse(&current).map_err(|err| format!("URL 解析失败: {err}"))?;
        let pin = crate::papr_runtime::services::resolve_safe_socket_addr_blocking(&parsed)?;
        let mut builder = reqwest::blocking::Client::builder()
            .user_agent(SCRAPER_USER_AGENT)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(timeout);
        if let Some((domain, addr)) = pin {
            builder = builder.resolve(&domain, addr);
        }
        let client = builder
            .build()
            .map_err(|err| format!("初始化网页客户端失败: {err}"))?;
        let response = apply_headers(client.get(parsed.clone()))
            .send()
            .map_err(|err| format!("请求失败: {err}"))?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "重定向响应缺少 Location 头".to_string())?;
            current = parsed
                .join(location)
                .map_err(|err| format!("重定向目标 URL 不合法: {err}"))?
                .to_string();
            continue;
        }
        return Ok(response);
    }
    Err(format!("重定向次数超过上限 {MAX_SAFE_REDIRECTS}"))
}

/// HTTP client for papr app `papr.http` calls. Redirects are disabled so a
/// public URL cannot 302-bounce into an internal/loopback address (SSRF), and
/// no cookie store is used so apps do not share host cookies. When `pin` is
/// provided the domain is pinned to a pre-vetted socket address, closing the
/// DNS-rebinding TOCTOU window between validation and connect.
///
/// 异步客户端：papr_http_get/post 是 async tauri command，绝不能用 blocking
/// 客户端（会阻塞 tokio worker 线程）。
pub(crate) fn build_papr_http_client(
    pin: Option<(String, std::net::SocketAddr)>,
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
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

/// 限流同一域名的连续请求。map 中存放的是该域名"下一次允许发起请求的时刻"：
/// 先在锁内为自己预留一个时间槽并立即释放锁，再在锁外 sleep 到槽位时刻。
/// 这样不同域名互不阻塞，同时同域名的并发请求各自占据递增的槽位，
/// 仍严格保持 min_interval 间隔（若放锁后直接 sleep 再回写时间戳，
/// 并发请求会同时醒来、同时发起请求，破坏间隔约束）。
pub(crate) fn rate_limit_domain(domain: &str, min_interval: Duration) {
    let map = RATE_LIMIT_LAST_REQUEST.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(mut lock) = map.lock() {
        let now = Instant::now();
        let next_slot = lock
            .get(domain)
            .map(|next_allowed| (*next_allowed + min_interval).max(now))
            .unwrap_or(now);
        lock.insert(domain.to_string(), next_slot);
        drop(lock);
        if next_slot > now {
            std::thread::sleep(next_slot - now);
        }
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

/// 缓存 key 由调用方预构建，必须包含所有影响结果的参数
/// （scope/query/max_results/categories/time_range/language/safe_search/engines），
/// 否则用户改参数后仍会命中旧缓存。
pub(crate) fn get_cached_search(cache_key: &str) -> Option<WebSearchResponse> {
    let cache = SEARCH_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()?;
    cache
        .get(cache_key)
        .filter(|entry| entry.0.elapsed() < Duration::from_secs(SEARCH_CACHE_TTL_SECS))
        .map(|entry| entry.1.clone())
}

pub(crate) fn cache_search_response(cache_key: &str, response: &WebSearchResponse) {
    // 空结果不缓存：一次失败不应污染后续 TTL 内的相同查询
    if response.results.is_empty() && response.abstract_text.trim().is_empty() {
        return;
    }
    if let Ok(mut cache) = SEARCH_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        cache.insert(cache_key.to_string(), (Instant::now(), response.clone()));
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
        cache_search_response("builtin\u{1f}empty-cache-probe", &empty);
        assert!(get_cached_search("builtin\u{1f}empty-cache-probe").is_none());

        let abstract_only = response(Vec::new(), "instant answer");
        cache_search_response("builtin\u{1f}abstract-cache-probe", &abstract_only);
        assert!(get_cached_search("builtin\u{1f}abstract-cache-probe").is_some());
    }

    #[test]
    fn cache_key_is_scoped_by_source_config() {
        let with_results = response(vec![entry("https://a.com")], "");
        cache_search_response("searxng:https://s.example\u{1f}scoped-probe", &with_results);
        assert!(get_cached_search("searxng:https://s.example\u{1f}scoped-probe").is_some());
        assert!(get_cached_search("builtin\u{1f}scoped-probe").is_none());
    }

    #[test]
    fn source_cooldown_tracks_failures() {
        mark_source_failed("unit-test-source");
        assert!(is_source_cooling_down("unit-test-source"));
        mark_source_ok("unit-test-source");
        assert!(!is_source_cooling_down("unit-test-source"));
    }
}
