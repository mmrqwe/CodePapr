import type { PaprAppListing, PaprMarketRegistry } from '../utils/marketAppTypes';
import { cacheGet, cacheSet } from '../utils/cacheStorage';

export const OFFICIAL_APPS_REGISTRY_URL =
  'https://raw.githubusercontent.com/mmrqwe/codepapr-apps/main/registry.json';
export const OFFICIAL_APPS_RAW_BASE =
  'https://raw.githubusercontent.com/mmrqwe/codepapr-apps/main';

const CACHE_KEY = 'market_apps_registry_v1';
const CACHE_TTL_MS = 10 * 60 * 1_000; // 10 minutes

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export async function fetchMarketAppRegistry(options?: {
  forceRefresh?: boolean;
}): Promise<PaprMarketRegistry> {
  if (!options?.forceRefresh) {
    const cached = await cacheGet<PaprMarketRegistry>(CACHE_KEY);
    if (cached?.apps && Array.isArray(cached.apps)) {
      return cached;
    }
  }

  const registry = await fetchJson<PaprMarketRegistry>(OFFICIAL_APPS_REGISTRY_URL);
  await cacheSet(CACHE_KEY, registry, CACHE_TTL_MS);
  return registry;
}

/** D-3：registry 是不可信外部数据。一条脏条目（缺 tags/id/directory、kind
 *  非法）不能让市场弹窗整体白屏（视图中 `listing.tags.length` 等直接解引用）。
 *  必填字段校验 + 可选字段归一（tags → []、kind → 'app'），非法条目过滤并告警。 */
function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isStringRecord(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every((v) => typeof v === 'string')
  );
}

function sanitizeRegistryEntry(entry: unknown, index: number): PaprAppListing | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    console.warn(`[market] registry 条目 #${index} 不是对象，已跳过`);
    return null;
  }
  const e = entry as Record<string, unknown>;
  const required = ['id', 'version', 'directory'] as const;
  for (const key of required) {
    if (typeof e[key] !== 'string' || !(e[key] as string).trim()) {
      console.warn(`[market] registry 条目 #${index}（id=${String(e.id ?? '?')}）缺必填字段 ${key}，已跳过`);
      return null;
    }
  }
  if (e.kind !== undefined && e.kind !== 'app' && e.kind !== 'plugin') {
    console.warn(`[market] registry 条目 "${String(e.id)}" kind 非法（${String(e.kind)}），已跳过`);
    return null;
  }
  if (e.tags !== undefined && !isStringArray(e.tags)) {
    console.warn(`[market] registry 条目 "${String(e.id)}" tags 非字符串数组，已跳过`);
    return null;
  }
  if (e.files !== undefined && !isStringArray(e.files)) {
    console.warn(`[market] registry 条目 "${String(e.id)}" files 非字符串数组，已跳过`);
    return null;
  }
  if (e.sha256 !== undefined && !isStringRecord(e.sha256)) {
    console.warn(`[market] registry 条目 "${String(e.id)}" sha256 非字符串映射，已跳过`);
    return null;
  }
  return {
    ...(e as Omit<PaprAppListing, 'id' | 'version' | 'directory'>),
    id: e.id as string,
    version: e.version as string,
    directory: e.directory as string,
    kind: (e.kind as PaprAppListing['kind'] | undefined) ?? 'app',
    tags: (e.tags as string[] | undefined) ?? [],
  };
}

export async function fetchMarketAppListings(options?: {
  forceRefresh?: boolean;
}): Promise<PaprAppListing[]> {
  const registry = await fetchMarketAppRegistry(options);
  const raw = Array.isArray(registry.apps) ? registry.apps : [];
  const listings: PaprAppListing[] = [];
  raw.forEach((entry, index) => {
    const clean = sanitizeRegistryEntry(entry, index);
    if (clean) listings.push(clean);
  });
  return listings;
}
