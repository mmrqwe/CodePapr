/** 后台进程登记的 previewUrl（camelCase）以及容错读取的 snake_case。 */
export interface PreviewUrlFields {
  previewUrl?: string | null;
  preview_url?: string | null;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** 兼容 Rust camelCase 与旧前端误读的 snake_case。 */
export function processPreviewUrl(proc: PreviewUrlFields): string | undefined {
  return proc.previewUrl ?? proc.preview_url ?? undefined;
}

/**
 * 判断 preview URL 是否指向本机 loopback 上的给定端口。
 * 忽略 path/query；localhost / 127.0.0.1 / ::1 视为同一主机。
 */
export function previewUrlMatchesPort(
  url: string | null | undefined,
  port: number | null | undefined,
): boolean {
  if (!url || port == null || !Number.isFinite(port) || port <= 0) {
    return false;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    let host = parsed.hostname.toLowerCase();
    if (host.startsWith('[') && host.endsWith(']')) {
      host = host.slice(1, -1);
    }
    if (!LOOPBACK_HOSTS.has(host)) {
      return false;
    }
    const fallback = parsed.protocol === 'https:' ? 443 : 80;
    const urlPort = parsed.port ? Number(parsed.port) : fallback;
    return urlPort === port;
  } catch {
    return false;
  }
}

export function findPreviewProcessForPort<T extends PreviewUrlFields>(
  processes: T[],
  port: number | null | undefined,
): T | undefined {
  if (port == null) return undefined;
  return processes.find((proc) => previewUrlMatchesPort(processPreviewUrl(proc), port));
}
