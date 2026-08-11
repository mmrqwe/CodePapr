/**
 * 全局 fetch 的目标守卫：Tauri 侧用 @tauri-apps/plugin-http 覆盖全局 fetch
 * （绕过浏览器 CORS），capabilities 又放行 http://** —— 直达链路本地/云元数据
 * 地址会带来 SSRF 类风险（169.254.169.254 等）。
 *
 * 策略（与功能兼容）：
 * - 阻止：链路本地 169.254/16、0.0.0.0/8、fe80::/10，以及 IPv4-mapped/
 *   compatible 形式的同类（::ffff:169.254.169.254、::169.254.169.254）。
 * - 放行：回环 127.0.0.0/8、::1（app 后端、本地 LLM 端点）；私网
 *   10/8、172.16/12、192.168/16（LAN LLM 端点是合法用途）。
 * - 域名不做同步解析检查（DNS 重绑定风险与本守卫范围外）。
 */

function ipv4Octets(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => {
    const n = Number(p);
    return Number.isInteger(n) && n >= 0 && n <= 255 ? n : -1;
  });
  if (octets.some((o) => o < 0)) return null;
  return octets;
}

function isLinkLocalOrMetadataV4(host: string): boolean {
  const octets = ipv4Octets(host);
  if (!octets) return false;
  const [a, b] = octets;
  // 169.254/16（含云元数据 169.254.169.254）与 0.0.0.0/8 "this" network
  // （连接 0.0.0.0 在平台层无意义，按 SSRF 常规一并拦截）
  return (a === 169 && b === 254) || a === 0;
}

/** 解析 IPv4-mapped（::ffff:a.b.c.d / ::ffff:xxxx:xxxx）与 IPv4-compatible
 * （::a.b.c.d / ::xxxx:xxxx）形式。注意 WHATWG URL 会把点分形式规范化成
 * 十六进制组（[::ffff:169.254.169.254] → hostname [::ffff:a9fe:a9fe]），
 * 两种形态都必须覆盖。 */
function embeddedV4(host: string): string | null {
  const hexGroups = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (hexGroups) {
    const hi = parseInt(hexGroups[1]!, 16);
    const lo = parseInt(hexGroups[2]!, 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host);
  if (mapped) return mapped[1]!;
  const compatible = /^::(\d+\.\d+\.\d+\.\d+)$/i.exec(host);
  if (compatible) return compatible[1]!;
  return null;
}

export function isBlockedFetchTarget(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  // URL.hostname 对 IPv6 字面量保留方括号（[fe80::1]），先剥离
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (host.includes(':')) {
    // IPv6 字面量
    const embedded = embeddedV4(host);
    if (embedded) {
      return isLinkLocalOrMetadataV4(embedded);
    }
    // fe80::/10 链路本地（fe80-febf 开头）
    return /^fe[89ab][0-9a-f]/.test(host);
  }
  return isLinkLocalOrMetadataV4(host);
}
