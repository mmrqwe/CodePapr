use std::net::ToSocketAddrs;
use std::time::Duration;

use serde::Deserialize;

use crate::web::client::{retry_with_backoff, SCRAPER_USER_AGENT, SEARCH_RETRY_MAX};
use crate::web::text::normalize_search_text;

use super::{push_unique_search_result, WebSearchEntry};

/// SearXNG base URL 安全校验（SSRF 纵深防御）。
///
/// SearXNG 为用户自托管搜索引擎，部署在回环/局域网私有地址是合法常见场景，
/// 不能像 fetch_web_url 那样一刀切禁止全部内网地址；但必须阻止：
/// 1. 非 http(s) scheme（file://、gopher:// 等）；
/// 2. 指向云元数据/link-local 目标（169.254.169.254、fe80::/10 等）——
///    不存在合法的 SearXNG 部署形态，却是 SSRF 最高价值目标；
///    域名主机同样做 DNS 解析逐地址校验，防止用域名指向元数据地址。
/// 3. 重定向跳板：请求侧使用禁用自动重定向的专用客户端（见 collect_searxng_results），
///    30x 响应直接报错，防止被引导至任意内部地址。
fn validate_searxng_base_url(base_url: &str) -> Result<(), String> {
    let parsed =
        url::Url::parse(base_url).map_err(|err| format!("SearXNG 地址不合法: {err}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!(
            "SearXNG 地址仅支持 http/https，收到 {}",
            parsed.scheme()
        ));
    }
    let host = match parsed.host() {
        Some(url::Host::Domain(domain)) => domain.to_string(),
        Some(url::Host::Ipv4(ip)) => {
            if ip.is_link_local() || ip.is_unspecified() {
                return Err(format!("安全限制：SearXNG 地址不允许指向 {ip}"));
            }
            return Ok(());
        }
        Some(url::Host::Ipv6(ip)) => {
            if is_link_local_ipv6(ip) {
                return Err(format!("安全限制：SearXNG 地址不允许指向 {ip}"));
            }
            return Ok(());
        }
        None => return Err("SearXNG 地址缺少主机".to_string()),
    };
    let port = parsed.port_or_known_default().unwrap_or(80);
    let addrs: Vec<std::net::SocketAddr> = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|err| format!("SearXNG 地址 DNS 解析失败 {host}: {err}"))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("SearXNG 地址 DNS 解析无结果: {host}"));
    }
    for addr in &addrs {
        let blocked = match addr.ip() {
            std::net::IpAddr::V4(v4) => v4.is_link_local() || v4.is_unspecified(),
            std::net::IpAddr::V6(v6) => is_link_local_ipv6(v6),
        };
        if blocked {
            return Err(format!(
                "安全限制：SearXNG 地址 {host} 解析到受限地址 {}",
                addr.ip()
            ));
        }
    }
    Ok(())
}

/// link-local（fe80::/10）或未指定地址。回环/ULA 属于自托管合法部署地址，不在此列。
fn is_link_local_ipv6(ip: std::net::Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return mapped.is_link_local() || mapped.is_unspecified();
    }
    ip.is_unspecified() || (ip.segments()[0] & 0xffc0) == 0xfe80
}

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
    base_url: &str,
    query: &str,
    max_results: usize,
    categories: &str,
    time_range: &str,
    language: &str,
    safe_search: u8,
    engines: &str,
) -> Result<(Vec<WebSearchEntry>, String, String), String> {
    validate_searxng_base_url(base_url)?;
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

    // 专用客户端：禁用自动重定向（Policy::none），防止 SearXNG 地址 30x 跳板到
    // 任意内部地址（SSRF）。JSON API 正常不需要重定向；出现 30x 直接报错降级。
    // 不复用 build_web_client()（其允许 10 次重定向且带共享 cookie store）。
    let client = reqwest::blocking::Client::builder()
        .user_agent(SCRAPER_USER_AGENT)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|err| format!("初始化 SearXNG 客户端失败: {err}"))?;
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
    if status.is_redirection() {
        return Err("SearXNG 搜索失败: 响应为重定向，出于安全限制不跟随".to_string());
    }
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
