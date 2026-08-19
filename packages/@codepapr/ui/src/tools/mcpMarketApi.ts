import type {
  MarketSource,
  MarketMCPListing,
  MarketPagination,
  RegistryListResponse,
  RegistryServerEntry,
  RegistryPackage,
  RegistryArgument,
  RegistryTransport,
} from '../utils/mcpMarketTypes';
import { cacheGet, cacheSet } from '../utils/cacheStorage';

const OFFICIAL_REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0.1/servers';

function cacheKey(namespace: string): string {
  return `codepapr.market.${namespace}`;
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
  const argsResult = firstPkg ? computeArgs(firstPkg) : { args: '', missingRequired: false };
  const url = transport.url ?? '';
  const unmappedRuntime = Boolean(firstPkg && !command);
  const needsManualConfig = unmappedRuntime || argsResult.missingRequired || (!firstPkg && !(firstRemote?.url));

  return {
    id: server.name.replace(/[./]/g, '_'),
    name: server.name,
    title: server.title || server.name.split('/').pop() || server.name,
    description: server.description,
    source: 'official',
    registryType: firstPkg?.registryType ?? 'npm',
    identifier: firstPkg?.identifier ?? server.name,
    runtimeHint: firstPkg?.runtimeHint ?? (isDockerPackage(firstPkg) ? 'docker' : (firstPkg ? computeCommand(firstPkg) : '')),
    transport: { ...transport, type: transport.type as 'stdio' | 'streamable-http' | 'sse' },
    envVars: firstPkg?.environmentVariables ?? [],
    packageArgs: flattenRegistryArgs(firstPkg?.packageArguments).parts,
    runtimeArgs: flattenRegistryArgs(firstPkg?.runtimeArguments).parts,
    command: command || (firstRemote ? '' : ''),
    args: argsResult.args || '',
    url,
    categories: inferCategories(server.name, server.description),
    iconUrl: server.icons?.[0]?.src ?? '',
    websiteUrl: server.websiteUrl ?? '',
    repositoryUrl: server.repository?.url ?? '',
    verified: true,
    useCount: 0,
    version: server.version,
    needsManualConfig,
    manualConfigNote: unmappedRuntime
      ? `Unsupported package type '${firstPkg?.registryType}'. Install then configure the command in MCP Settings.`
      : firstRemote?.url
        ? ''
        : 'Remote server — install then configure the URL in MCP Settings.',
  };
}

function isDockerPackage(pkg?: RegistryPackage): boolean {
  if (!pkg) return false;
  if (pkg.runtimeHint === 'docker' || pkg.registryType === 'oci') return true;
  return /^(ghcr\.io|docker\.io|quay\.io|registry\.|[\w.-]+\/[\w./-]+:[\w.-]+)/i.test(pkg.identifier);
}

function looksLikeTemplate(value: string): boolean {
  return /\{[^{}]+\}/.test(value);
}

export function flattenRegistryArgs(args?: Array<string | RegistryArgument>): {
  parts: string[];
  missingRequired: boolean;
} {
  if (!args?.length) return { parts: [], missingRequired: false };
  const parts: string[] = [];
  let missingRequired = false;
  for (const arg of args) {
    if (typeof arg === 'string') {
      if (looksLikeTemplate(arg)) {
        missingRequired = true;
        continue;
      }
      parts.push(arg);
      continue;
    }
    const value = (arg.value ?? arg.default ?? '').trim();
    if (arg.type === 'named' || arg.name) {
      if (!value || looksLikeTemplate(value)) {
        if (arg.isRequired || looksLikeTemplate(value)) missingRequired = true;
        continue;
      }
      const flag = (arg.name ?? '').trim();
      if (flag.includes('=')) {
        parts.push(flag.endsWith('=') ? `${flag}${value}` : flag);
      } else if (flag) {
        parts.push(flag, value);
      } else {
        parts.push(value);
      }
      continue;
    }
    if (!value || looksLikeTemplate(value)) {
      if (arg.isRequired || looksLikeTemplate(value)) missingRequired = true;
      continue;
    }
    parts.push(value);
  }
  return { parts, missingRequired };
}

export function formatTransportHeaders(headers?: RegistryTransport['headers']): string {
  if (!headers) return '';
  if (Array.isArray(headers)) {
    return headers
      .map((item) => {
        const value = (item.value ?? item.default ?? '').trim();
        if (!item.name || !value || looksLikeTemplate(value)) return '';
        return `${item.name}: ${value}`;
      })
      .filter(Boolean)
      .join('\n');
  }
  return Object.entries(headers)
    .filter(([key, value]) => key.trim() && String(value).trim())
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

export function computeCommand(pkg?: RegistryPackage): string {
  if (!pkg) return 'npx';
  if (isDockerPackage(pkg)) return 'docker';
  const hint = pkg.runtimeHint;
  if (hint === 'uvx') return 'uvx';
  if (hint === 'dnx') return 'dnx';
  if (pkg.registryType === 'pypi') return 'uvx';
  if (pkg.registryType === 'nuget') return 'dnx';
  if (pkg.registryType === 'npm' || hint === 'npx' || !pkg.registryType) return 'npx';
  return '';
}

export function computeArgs(pkg?: RegistryPackage): { args: string; missingRequired: boolean } {
  if (!pkg) return { args: '', missingRequired: false };
  const runtime = flattenRegistryArgs(pkg.runtimeArguments);
  const pack = flattenRegistryArgs(pkg.packageArguments);
  const missingRequired = runtime.missingRequired || pack.missingRequired;
  const parts: string[] = [];
  if (isDockerPackage(pkg)) {
    const rest = runtime.parts[0] === 'run' ? runtime.parts.slice(1) : runtime.parts;
    parts.push('run');
    if (!rest.includes('-i') && !rest.includes('--interactive')) parts.push('-i');
    if (!rest.includes('--rm')) parts.push('--rm');
    parts.push(...rest);
    parts.push(pkg.identifier);
    parts.push(...pack.parts);
  } else if (pkg.runtimeHint === 'uvx' || pkg.registryType === 'pypi') {
    parts.push(...runtime.parts);
    parts.push(pkg.identifier);
    parts.push(...pack.parts);
  } else if (computeCommand(pkg) === 'npx') {
    parts.push('-y');
    parts.push(...runtime.parts);
    parts.push(pkg.identifier);
    parts.push(...pack.parts);
  } else {
    parts.push(...runtime.parts);
    if (pkg.identifier) parts.push(pkg.identifier);
    parts.push(...pack.parts);
  }
  return { args: parts.join(' '), missingRequired };
}

function inferCategories(name: string, description: string): ('search' | 'database' | 'custom')[] {
  const categories: ('search' | 'database' | 'custom')[] = [];
  const text = `${name} ${description}`.toLowerCase();

  // 只认明确的网页搜索产品，避免 "HTTP"/"URL"/"web" 把普通远程 MCP
  // 标成 search，进而 hasEnabledMcpSearch 关掉内置 websearch。
  if (/\b(web[-_ ]?search|duckduckgo?|tavily|exa|serp|brave[-_ ]?search|search[-_ ]?(engine|api))\b/.test(text)) {
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

export async function fetchOfficialRegistry(cursor?: string, search?: string): Promise<{
  listings: MarketMCPListing[];
  pagination: MarketPagination;
}> {
  const params = new URLSearchParams({ limit: '50', version: 'latest' });
  if (cursor) params.set('cursor', cursor);
  const query = search?.trim();
  if (query) params.set('search', query);
  const url = `${OFFICIAL_REGISTRY_URL}?${params.toString()}`;

  const ck = `official_latest_${query || 'all'}_${cursor || 'page1'}`;
  const cached = await cacheGet<Awaited<ReturnType<typeof fetchOfficialRegistry>>>(cacheKey(ck));
  if (cached) return cached;

  const data = await fetchJson<RegistryListResponse>(url);
  const listings = (data.servers || [])
    .map((entry) => {
      try {
        return mapOfficialRegistry(entry);
      } catch {
        return null;
      }
    })
    .filter((item): item is MarketMCPListing => item !== null);
  const result = {
    listings,
    pagination: {
      nextCursor: data.metadata?.nextCursor,
      currentPage: 1,
      hasMore: !!data.metadata?.nextCursor,
    },
  };

  await cacheSet(cacheKey(ck), result, 30 * 60 * 1000);
  return result;
}

export interface FetchMarketOptions {
  source?: MarketSource;
  cursor?: string;
  pageSize?: number;
  search?: string;
}

export async function fetchMarketServers(options: FetchMarketOptions = {}): Promise<{
  listings: MarketMCPListing[];
  pagination: MarketPagination;
}> {
  const o = await fetchOfficialRegistry(options.cursor, options.search);
  return {
    listings: dedupListings(o.listings),
    pagination: o.pagination,
  };
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
  inferCategories,
};
