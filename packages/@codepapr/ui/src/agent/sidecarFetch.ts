/** Mirror Tauri http plugin denials so sidecar native fetch is not an open proxy. */
export function isDeniedFetchUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return true;
  }
  const host = parsed.hostname.replace(/^\[|]$/g, '').toLowerCase();
  if (host === '0.0.0.0' || host.startsWith('0.')) {
    return true;
  }
  if (host.startsWith('169.254.')) {
    return true;
  }
  if (host.startsWith('fe80:')) {
    return true;
  }
  return false;
}

export function createSidecarFetch(baseFetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (isDeniedFetchUrl(url)) {
      return Promise.reject(new Error(`Blocked fetch to ${url}`));
    }
    return baseFetch(input, init);
  };
}
