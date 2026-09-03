use std::net::ToSocketAddrs;

pub fn is_internal_ipv4(ip: std::net::Ipv4Addr) -> bool {
    let octets = ip.octets();
    ip.is_loopback()           // 127.0.0.0/8
        || ip.is_private()     // 10/8, 172.16/12, 192.168/16
        || ip.is_link_local()  // 169.254/16 (incl. cloud metadata 169.254.169.254)
        || ip.is_unspecified() // 0.0.0.0
        || octets[0] == 0      // 0.0.0.0/8 "this" network
        || (octets[0] == 100 && (64..=127).contains(&octets[1])) // CGNAT 100.64/10
}

pub fn is_internal_ipv6(ip: std::net::Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return is_internal_ipv4(mapped); // ::ffff:127.0.0.1 etc.
    }
    if ip.is_loopback() || ip.is_unspecified() {
        return true; // ::1, ::
    }
    let segments = ip.segments();
    if segments[0] == 0
        && segments[1] == 0
        && segments[2] == 0
        && segments[3] == 0
        && segments[4] == 0
    {
        let v4 = std::net::Ipv4Addr::new(
            (segments[5] >> 8) as u8,
            (segments[5] & 0xff) as u8,
            (segments[6] >> 8) as u8,
            (segments[6] & 0xff) as u8,
        );
        if is_internal_ipv4(v4) {
            return true;
        }
    }
    let first = segments[0];
    (first & 0xfe00) == 0xfc00 // fc00::/7 unique-local (fd00::/8 too)
        || (first & 0xffc0) == 0xfe80 // fe80::/10 link-local
}

pub fn is_internal_domain(host: &str) -> bool {
    let h = host.to_lowercase();
    h == "localhost"
        || h.ends_with(".localhost")
        || h.ends_with(".local")
        || h.ends_with(".internal")
}

pub fn is_private_or_internal_url(url: &str) -> bool {
    match url::Url::parse(url) {
        Ok(parsed) => match parsed.host() {
            Some(url::Host::Ipv4(ip)) => is_internal_ipv4(ip),
            Some(url::Host::Ipv6(ip)) => is_internal_ipv6(ip),
            Some(url::Host::Domain(domain)) => is_internal_domain(domain),
            None => true,
        },
        Err(_) => true,
    }
}

pub async fn resolve_safe_socket_addr(
    parsed: &url::Url,
) -> Result<Option<(String, std::net::SocketAddr)>, String> {
    let host = match parsed.host() {
        Some(url::Host::Domain(domain)) => domain.to_string(),
        Some(_) => return Ok(None),
        None => return Err("URL 缺少主机".to_string()),
    };
    let port = parsed.port_or_known_default().unwrap_or(443);
    let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|err| format!("DNS 解析失败 {host}: {err}"))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("DNS 解析无结果: {host}"));
    }
    for addr in &addrs {
        let internal = match addr.ip() {
            std::net::IpAddr::V4(v4) => is_internal_ipv4(v4),
            std::net::IpAddr::V6(v6) => is_internal_ipv6(v6),
        };
        if internal {
            return Err(format!("安全限制：{host} 解析到内网/本地地址 {}", addr.ip()));
        }
    }
    Ok(Some((host, addrs[0])))
}

pub fn resolve_safe_socket_addr_blocking(
    parsed: &url::Url,
) -> Result<Option<(String, std::net::SocketAddr)>, String> {
    let host = match parsed.host() {
        Some(url::Host::Domain(domain)) => domain.to_string(),
        Some(_) => return Ok(None),
        None => return Err("URL 缺少主机".to_string()),
    };
    let port = parsed.port_or_known_default().unwrap_or(443);
    let host_port = format!("{host}:{port}");
    let addrs: Vec<std::net::SocketAddr> = host_port
        .to_socket_addrs()
        .map_err(|err| format!("DNS 解析失败 {host}: {err}"))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("DNS 解析无结果: {host}"));
    }
    for addr in &addrs {
        let internal = match addr.ip() {
            std::net::IpAddr::V4(v4) => is_internal_ipv4(v4),
            std::net::IpAddr::V6(v6) => is_internal_ipv6(v6),
        };
        if internal {
            return Err(format!("安全限制：{host} 解析到内网/本地地址 {}", addr.ip()));
        }
    }
    Ok(Some((host, addrs[0])))
}
