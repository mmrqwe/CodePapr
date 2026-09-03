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

export async function fetchMarketAppListings(options?: {
  forceRefresh?: boolean;
}): Promise<PaprAppListing[]> {
  const registry = await fetchMarketAppRegistry(options);
  return registry.apps ?? [];
}
