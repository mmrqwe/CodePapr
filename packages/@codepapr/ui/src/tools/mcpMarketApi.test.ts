import { describe, expect, it, vi, afterEach } from 'vitest';

vi.mock('../utils/cacheStorage', () => ({
  cacheGet: vi.fn(async () => null),
  cacheSet: vi.fn(async () => undefined),
  cacheRemove: vi.fn(async () => undefined),
}));

import {
  inferCategories,
  computeCommand,
  computeArgs,
  flattenRegistryArgs,
  formatTransportHeaders,
  fetchMarketServers,
} from './mcpMarketApi';
import type { RegistryPackage } from '../utils/mcpMarketTypes';

describe('inferCategories', () => {
  it('does not treat generic HTTP/URL remotes as search', () => {
    expect(inferCategories('docs.example/mcp', 'HTTP API for product docs and URLs')).toEqual(['custom']);
    expect(inferCategories('link.shortener/mcp', 'Shorten a web URL and fetch the page')).toEqual(['custom']);
    expect(inferCategories('browser.tools/mcp', 'Browser automation and scrape helpers')).toEqual(['custom']);
  });

  it('classifies explicit web-search products as search', () => {
    expect(inferCategories('io.github.duckduckgo/mcp', 'DuckDuckGo HTML search')).toContain('search');
    expect(inferCategories('com.tavily/search', 'Tavily web search API')).toContain('search');
    expect(inferCategories('exa.ai/mcp', 'Exa neural search engine')).toContain('search');
  });

  it('still infers database from SQL-family wording', () => {
    expect(inferCategories('io.github.postgres/mcp', 'Query a Postgres database')).toContain('database');
    expect(inferCategories('io.github.postgres/mcp', 'Query a Postgres database')).not.toContain('search');
  });
});

describe('package install mapping', () => {
  it('maps oci images to docker run -i --rm', () => {
    const pkg = {
      registryType: 'oci',
      identifier: 'ghcr.io/gavinlucas/docker-mcp-server:1.8.1',
      transport: { type: 'stdio' },
    } as RegistryPackage;
    expect(computeCommand(pkg)).toBe('docker');
    expect(computeArgs(pkg).args).toBe('run -i --rm ghcr.io/gavinlucas/docker-mcp-server:1.8.1');
  });

  it('flattens named/positional packageArguments instead of [object Object]', () => {
    const flattened = flattenRegistryArgs([
      { type: 'named', name: '--port', value: '8080' },
      { type: 'positional', value: './data' },
    ]);
    expect(flattened.parts).toEqual(['--port', '8080', './data']);
    expect(flattened.missingRequired).toBe(false);
  });

  it('marks templated arguments as needing manual config', () => {
    const flattened = flattenRegistryArgs([{ type: 'positional', value: '{db_path}', isRequired: true }]);
    expect(flattened.parts).toEqual([]);
    expect(flattened.missingRequired).toBe(true);
  });

  it('formats remote headers as settings lines', () => {
    expect(formatTransportHeaders([
      { name: 'Authorization', default: 'Bearer tok' },
      { name: 'X-Empty', default: '' },
    ])).toBe('Authorization: Bearer tok');
  });
});

describe('fetchMarketServers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('throws instead of returning an empty list on HTTP errors', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchMarketServers()).rejects.toThrow('HTTP 503');
    expect(fetchMock).toHaveBeenCalled();
    const url = String(fetchMock.mock.calls[0]?.[0] ?? '');
    expect(url).toContain('version=latest');
    expect(url).not.toContain('isLatest');
  });

  it('sends search= to the official registry', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchMarketServers({ search: 'github' })).rejects.toThrow('HTTP 503');
    const url = String(fetchMock.mock.calls[0]?.[0] ?? '');
    expect(url).toContain('search=github');
    expect(url).toContain('version=latest');
  });
});
