import type {
  MarketSource,
  MarketMCPListing,
  MarketPagination,
  RegistryListResponse,
  RegistryServerEntry,
  RegistryPackage,
} from '../utils/mcpMarketTypes';

const OFFICIAL_REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0.1/servers';
const CACHE_TTL_MS = 5 * 60 * 1000;

function getCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(`codepapr.market.${key}`);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
      localStorage.removeItem(`codepapr.market.${key}`);
      return null;
    }
    return entry.data as T;
  } catch {
    return null;
  }
}

function setCache<T>(key: string, data: T): void {
  try {
    localStorage.setItem(`codepapr.market.${key}`, JSON.stringify({ ts: Date.now(), data }));
  } catch {
    // localStorage full or unavailable
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

function mapOfficialRegistry(entry: RegistryServerEntry): MarketMCPListing {
  const server = entry.server;
  const firstPkg: RegistryPackage | undefined = (server.packages && server.packages.length > 0)
    ? server.packages[0]
    : undefined;
  const firstRemote = (server.remotes && server.remotes.length > 0)
    ? server.remotes[0]
    : undefined;

  const transport = firstPkg?.transport ?? firstRemote ?? { type: 'stdio' as const };

  const command = firstPkg ? computeCommand(firstPkg) : '';
  const args = firstPkg ? computeArgs(firstPkg) : '';
  const url = transport.url ?? '';

  return {
    id: server.name.replace(/[./]/g, '_'),
    name: server.name,
    title: server.title || server.name.split('/').pop() || server.name,
    description: server.description,
    source: 'official',
    registryType: firstPkg?.registryType ?? 'npm',
    identifier: firstPkg?.identifier ?? server.name,
    runtimeHint: firstPkg?.runtimeHint ?? (firstPkg ? 'npx' : ''),
    transport: { ...transport, type: transport.type as 'stdio' | 'streamable-http' | 'sse' },
    envVars: firstPkg?.environmentVariables ?? [],
    packageArgs: firstPkg?.packageArguments ?? [],
    runtimeArgs: firstPkg?.runtimeArguments ?? [],
    command: command || (firstRemote ? '' : ''),
    args: args || '',
    url,
    categories: inferCategories(server.name, server.description),
    iconUrl: server.icons?.[0]?.src ?? '',
    websiteUrl: server.websiteUrl ?? '',
    repositoryUrl: server.repository?.url ?? '',
    verified: true,
    useCount: 0,
    version: server.version,
    needsManualConfig: !firstPkg && !(firstRemote?.url),
    manualConfigNote: firstRemote?.url ? '' : 'Remote server — install then configure the URL in MCP Settings.',
  };
}

function computeCommand(pkg?: RegistryPackage): string {
  if (!pkg) return 'npx';
  const hint = pkg.runtimeHint;
  if (hint === 'docker') return 'docker';
  if (hint === 'uvx') return 'uvx';
  if (hint === 'dnx') return 'dnx';
  if (pkg.registryType === 'pypi') return 'uvx';
  return 'npx';
}

function computeArgs(pkg?: RegistryPackage): string {
  if (!pkg) return '';
  const parts: string[] = [];
  if (pkg.runtimeHint === 'docker') {
    parts.push('run');
    parts.push(pkg.identifier);
  } else if (pkg.runtimeHint === 'uvx' || pkg.registryType === 'pypi') {
    if (pkg.packageArguments?.length) {
      parts.push(...pkg.packageArguments);
    } else {
      parts.push(pkg.identifier);
    }
  } else {
    parts.push('-y');
    parts.push(pkg.identifier);
  }
  if (pkg.packageArguments?.length && pkg.runtimeHint !== 'uvx') {
    parts.push(...pkg.packageArguments);
  }
  return parts.join(' ');
}

function inferCategories(name: string, description: string): ('search' | 'database' | 'custom')[] {
  const categories: ('search' | 'database' | 'custom')[] = [];
  const text = `${name} ${description}`.toLowerCase();

  if (/\b(search|browser|scrape|fetch|crawl|web|http|url|duckduck|spider|tavily|exa|serp|link|page\w*)\b/.test(text)) {
    categories.push('search');
  }
  if (/\b(database|sql|postgres|mysql|sqlite|mongo|redis|query|supabase|prisma|d1|turso|neon)\b/.test(text)) {
    categories.push('database');
  }

  if (categories.length === 0) {
    categories.push('custom');
  }
  return categories;
}

function dedupListings(listings: MarketMCPListing[]): MarketMCPListing[] {
  const seen = new Set<string>();
  return listings.filter((item) => {
    const key = item.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function fetchOfficialRegistry(cursor?: string): Promise<{
  listings: MarketMCPListing[];
  pagination: MarketPagination;
}> {
  const url = cursor
    ? `${OFFICIAL_REGISTRY_URL}?limit=50&cursor=${encodeURIComponent(cursor)}`
    : `${OFFICIAL_REGISTRY_URL}?limit=50`;

  const cacheKey = cursor ? `official_${cursor}` : 'official_page1';
  const cached = getCache<ReturnType<typeof fetchOfficialRegistry>>(cacheKey);
  if (cached) return cached;

  const data = await fetchJson<RegistryListResponse>(url);
  const latestOnly = (data.servers || []).filter((entry) => {
    const metas = entry._meta ? Object.values(entry._meta) : [];
    if (metas.length === 0) return true;
    return metas.some((m) => m.isLatest === true);
  });
  const listings = latestOnly.map(mapOfficialRegistry);
  const result = {
    listings,
    pagination: {
      nextCursor: data.metadata?.nextCursor,
      currentPage: 1,
      hasMore: !!data.metadata?.nextCursor,
    },
  };

  setCache(cacheKey, result);
  return result;
}

export interface FetchMarketOptions {
  source?: MarketSource;
  cursor?: string;
  pageSize?: number;
}

export async function fetchMarketServers(options: FetchMarketOptions = {}): Promise<{
  listings: MarketMCPListing[];
  pagination: MarketPagination;
}> {
  try {
    const o = await fetchOfficialRegistry(options.cursor);
    return {
      listings: dedupListings(o.listings),
      pagination: o.pagination,
    };
  } catch (err) {
    console.warn('Failed to fetch MCP registry:', err);
    return {
      listings: [],
      pagination: { currentPage: 1, hasMore: false },
    };
  }
}

export function searchListings(listings: MarketMCPListing[], query: string): MarketMCPListing[] {
  if (!query.trim()) return listings;
  const q = query.toLowerCase().trim();
  return listings.filter(
    (item) =>
      item.title.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q) ||
      item.name.toLowerCase().includes(q) ||
      item.identifier.toLowerCase().includes(q),
  );
}

export function filterListings(
  listings: MarketMCPListing[],
  filters: { transport?: string; runtime?: string; category?: string },
): MarketMCPListing[] {
  let result = listings;
  if (filters.transport) {
    result = result.filter((item) => item.transport.type === filters.transport);
  }
  if (filters.runtime) {
    result = result.filter((item) => item.runtimeHint === filters.runtime);
  }
  if (filters.category) {
    result = result.filter((item) => item.categories.includes(filters.category as 'search' | 'database' | 'custom'));
  }
  return result;
}

export {
  OFFICIAL_REGISTRY_URL,
  mapOfficialRegistry,
};
