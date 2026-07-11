import { describe, expect, it } from 'vitest';
import {
  buildMcpToolName,
  createBlankMcpServer,
  createDefaultMcpSettings,
  createMcpSettingsCacheKey,
  hasEnabledMcpSearch,
  mcpToolInfoToDefinition,
  normalizeMcpServer,
  normalizeMcpSettings,
  parseMcpEnv,
  parseMcpToolName,
  sanitizeMcpToolPart,
  splitMcpArgs,
  type McpServerConfig,
  type McpSettings,
} from './mcpTypes';

type PartialTestServer = Partial<McpServerConfig>;

interface PartialTestSettings {
  enabled?: boolean;
  exposeTools?: boolean;
  resultMaxBytes?: number;
  servers?: PartialTestServer[];
}

function norm(input: PartialTestSettings): McpSettings {
  return normalizeMcpSettings(input as Partial<McpSettings>);
}

describe('sanitizeMcpToolPart', () => {
  it('returns the input as-is when it only contains safe chars', () => {
    expect(sanitizeMcpToolPart('search')).toBe('search');
  });

  it('replaces spaces and special chars with underscores', () => {
    expect(sanitizeMcpToolPart('my tool')).toBe('my_tool');
  });

  it('strips leading/trailing underscores', () => {
    expect(sanitizeMcpToolPart('%$^unsafe^%$')).toBe('unsafe');
  });

  it("falls back to 'tool' for empty or all-special input", () => {
    expect(sanitizeMcpToolPart('')).toBe('tool');
    expect(sanitizeMcpToolPart('!@#')).toBe('tool');
  });

  it('preserves hyphens', () => {
    expect(sanitizeMcpToolPart('postgres-db')).toBe('postgres-db');
  });
});

describe('buildMcpToolName / parseMcpToolName', () => {
  it('round-trips a typical tool name', () => {
    const name = buildMcpToolName('search', 'duckduckgo_search');
    const parsed = parseMcpToolName(name);
    expect(parsed).not.toBeNull();
    expect(parsed!.serverId).toBe('search');
    expect(parsed!.sanitizedToolName).toBe('duckduckgo_search');
  });

  it('handles server ids with underscores and hyphens', () => {
    const name = buildMcpToolName('my-server', 'some_tool');
    expect(name).toMatch(/^mcp__my-server__some_tool$/);
  });

  it('returns null for names without the prefix', () => {
    expect(parseMcpToolName('web_search')).toBeNull();
  });

  it('returns null for malformed names', () => {
    expect(parseMcpToolName('mcp__')).toBeNull();
    expect(parseMcpToolName('mcp__search')).toBeNull();
    expect(parseMcpToolName('mcp__search__')).toBeNull();
  });
});

describe('hasEnabledMcpSearch', () => {
  it('returns false when MCP is disabled', () => {
    expect(hasEnabledMcpSearch(createDefaultMcpSettings())).toBe(false);
  });

  it('returns false when exposeTools is off', () => {
    const settings = norm({
      enabled: true,
      exposeTools: false,
      servers: [
        { id: 'search', enabled: true, category: 'search' },
      ],
    });
    expect(hasEnabledMcpSearch(settings)).toBe(false);
  });

  it('returns false when no search-category server is enabled', () => {
    const settings = norm({
      enabled: true,
      exposeTools: true,
      servers: [
        { id: 'search', enabled: false, category: 'search' },
        { id: 'postgres', enabled: true, category: 'database' },
      ],
    });
    expect(hasEnabledMcpSearch(settings)).toBe(false);
  });

  it('returns true when at least one search server is enabled', () => {
    const settings = norm({
      enabled: true,
      exposeTools: true,
      servers: [
        { id: 'search', enabled: true, category: 'search' },
      ],
    });
    expect(hasEnabledMcpSearch(settings)).toBe(true);
  });
});

describe('createMcpSettingsCacheKey', () => {
  it('produces different keys for different settings', () => {
    const left = norm({
      enabled: true,
      servers: [{ id: 'search', enabled: true, category: 'search' }],
    });
    const right = norm({
      enabled: false,
      servers: [{ id: 'search', enabled: false, category: 'search' }],
    });
    expect(createMcpSettingsCacheKey(left)).not.toBe(createMcpSettingsCacheKey(right));
  });

  it('only includes enabled servers in the key', () => {
    const left = norm({
      enabled: true,
      servers: [
        { id: 'search', enabled: true, category: 'search' },
        { id: 'postgres', enabled: false, category: 'database' },
      ],
    });
    const right = norm({
      enabled: true,
      servers: [
        { id: 'search', enabled: true, category: 'search' },
        { id: 'sqlite', enabled: false, category: 'database' },
      ],
    });
    expect(createMcpSettingsCacheKey(left)).toBe(createMcpSettingsCacheKey(right));
  });
});

describe('mcpToolInfoToDefinition', () => {
  it('converts an MCP tool into a CodePapr IToolDefinition', () => {
    const definition = mcpToolInfoToDefinition({
      serverId: 'search',
      serverName: 'Search MCP',
      toolName: 'brave_web_search',
      displayName: '',
      description: 'Searches the web',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search term' },
        },
        required: ['query'],
      },
    });
    expect(definition.name).toBe('mcp__search__brave_web_search');
    expect(definition.description).toContain('[MCP:Search MCP]');
    expect(definition.description).toContain('Searches the web');
    expect(definition.parameters.type).toBe('object');
    expect(definition.parameters.required).toEqual(['query']);
  });

  it('handles empty input schema', () => {
    const definition = mcpToolInfoToDefinition({
      serverId: 'postgres',
      serverName: 'PG',
      toolName: 'query',
      displayName: '',
      description: '',
      inputSchema: {},
    });
    expect(definition.parameters.type).toBe('object');
    expect(definition.parameters.properties).toEqual({});
    expect(definition.parameters.required).toBeUndefined();
  });
});

describe('splitMcpArgs', () => {
  it('splits space-delimited args', () => {
    expect(splitMcpArgs('-y duckduckgo-mcp-server')).toEqual([
      '-y',
      'duckduckgo-mcp-server',
    ]);
  });

  it('preserves quoted strings', () => {
    expect(splitMcpArgs('-y "my package" \'another arg\'')).toEqual([
      '-y',
      'my package',
      'another arg',
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(splitMcpArgs('')).toEqual([]);
  });
});

describe('parseMcpEnv', () => {
  it('parses single key=value lines', () => {
    expect(parseMcpEnv('BRAVE_API_KEY=abc123')).toEqual({ BRAVE_API_KEY: 'abc123' });
  });

  it('handles multiple lines and ignores comments', () => {
    expect(parseMcpEnv('FOO=bar\n# a comment\n  BAZ = qux  ')).toEqual({
      FOO: 'bar',
      BAZ: 'qux',
    });
  });

  it('returns empty object for empty input', () => {
    expect(parseMcpEnv('')).toEqual({});
  });
});

describe('createDefaultMcpSettings', () => {
  it('returns three preset servers', () => {
    const defaults = createDefaultMcpSettings();
    expect(defaults.servers).toHaveLength(3);
    expect(defaults.servers.map((server) => server.id)).toEqual([
      'search',
      'postgres',
      'sqlite',
    ]);
  });

  it('uses DuckDuckGo search preset with no env vars', () => {
    const search = createDefaultMcpSettings().servers.find((s) => s.id === 'search')!;
    expect(search.args).toContain('duckduckgo-mcp-server');
    expect(search.env).toBe('');
    expect(search.allowedTools).toBe('duckduckgo_web_search');
    expect(search.category).toBe('search');
  });

  it('database servers are read-only with confirmation disabled by default', () => {
    const postgres = createDefaultMcpSettings().servers.find((s) => s.id === 'postgres')!;
    expect(postgres.permissionMode).toBe('read-only');
    expect(postgres.requireConfirmation).toBe(false);
    expect(postgres.deniedTools).toContain('delete*');
  });
});

describe('normalizeMcpServer', () => {
  it('fills defaults for missing fields', () => {
    const server = normalizeMcpServer({ id: 'test' });
    expect(server.id).toBe('test');
    expect(server.name).toBe('test');
    expect(server.category).toBe('custom');
    expect(server.transport).toBe('stdio');
    expect(server.permissionMode).toBe('read-only');
    expect(server.timeoutSeconds).toBe(60);
  });

  it('preserves explicit values', () => {
    const server = normalizeMcpServer({
      id: 'my-server',
      name: 'My Server',
      category: 'search',
      transport: 'streamable-http',
      command: 'node',
      args: 'index.js',
      url: 'https://example.com',
      env: 'KEY=val',
      headers: 'Authorization: Bearer token',
      permissionMode: 'read-write',
      requireConfirmation: false,
      timeoutSeconds: 120,
    });
    expect(server.id).toBe('my-server');
    expect(server.name).toBe('My Server');
    expect(server.transport).toBe('streamable-http');
    expect(server.permissionMode).toBe('read-write');
    expect(server.requireConfirmation).toBe(false);
    expect(server.timeoutSeconds).toBe(120);
    expect(server.headers).toBe('Authorization: Bearer token');
  });

  it('accepts sse transport', () => {
    const server = normalizeMcpServer({
      id: 'sse-server',
      transport: 'sse',
      url: 'https://example.com/sse',
    });
    expect(server.transport).toBe('sse');
  });

  it('defaults headers to empty string', () => {
    const server = normalizeMcpServer({ id: 'test' });
    expect(server.headers).toBe('');
  });
});

describe('normalizeMcpSettings', () => {
  it('returns defaults when input is empty', () => {
    const result = normalizeMcpSettings();
    expect(result.enabled).toBe(false);
    expect(result.exposeTools).toBe(true);
    expect(result.servers).toHaveLength(3);
  });

  it('merges input servers with defaults by id', () => {
    const result = norm({
      enabled: true,
      servers: [{ id: 'search', enabled: true }],
    });
    expect(result.enabled).toBe(true);
    const search = result.servers.find((s) => s.id === 'search')!;
    expect(search.enabled).toBe(true);
  });

  it('clamps resultMaxBytes to valid range', () => {
    expect(normalizeMcpSettings({ resultMaxBytes: 100 }).resultMaxBytes).toBe(1_000);
    expect(normalizeMcpSettings({ resultMaxBytes: 10_000_000 }).resultMaxBytes).toBe(5_000_000);
  });

  it('auto-migrates Brave preset args to DuckDuckGo defaults', () => {
    const result = norm({
      enabled: true,
      servers: [
        {
          id: 'search',
          enabled: true,
          command: 'npx',
          args: '-y @modelcontextprotocol/server-brave-search',
          env: 'BRAVE_API_KEY=old-key',
          allowedTools: '',
          deniedTools: '',
        },
      ],
    });
    const search = result.servers.find((s) => s.id === 'search')!;
    expect(search.args).toContain('duckduckgo-mcp-server');
    expect(search.env).toBe('');
    expect(search.allowedTools).toBe('duckduckgo_web_search');
  });

  it('does not override user-customized search args', () => {
    const result = norm({
      enabled: true,
      servers: [
        {
          id: 'search',
          enabled: true,
          command: 'npx',
          args: '-y @my-org/custom-search',
          env: 'TOKEN=xyz',
          allowedTools: 'my_search',
        },
      ],
    });
    const search = result.servers.find((s) => s.id === 'search')!;
    expect(search.args).toBe('-y @my-org/custom-search');
    expect(search.env).toBe('TOKEN=xyz');
  });
});

describe('createBlankMcpServer', () => {
  it('creates a custom server with a unique id', () => {
    const server = createBlankMcpServer();
    expect(server.id).toMatch(/^custom_\d+$/);
    expect(server.name).toBe('Custom MCP');
    expect(server.category).toBe('custom');
    expect(server.transport).toBe('stdio');
    expect(server.enabled).toBe(false);
  });
});
