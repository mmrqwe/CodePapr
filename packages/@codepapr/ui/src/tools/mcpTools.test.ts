import { ToolRegistry } from '@codepapr/core';
import type { IToolDefinition } from '@codepapr/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearMcpToolDefinitionCache,
  loadMcpToolDefinitions,
  registerMcpTools,
} from '../tools/mcpTools';
import {
  createDefaultMcpSettings,
  normalizeMcpSettings,
  type McpServerConfig,
  type McpSettings,
} from '../utils/mcpTypes';

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

let storedItems: Record<string, string> = {};

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: vi.fn((key: string) => storedItems[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      storedItems[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete storedItems[key];
    }),
    clear: vi.fn(() => {
      storedItems = {};
    }),
  },
  writable: true,
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

const SAMPLE_TOOLS_RESULT = {
  tools: [
    {
      serverId: 'search',
      serverName: 'Search MCP',
      toolName: 'duckduckgo_search',
      displayName: 'mcp__search__duckduckgo_search',
      description: 'Searches the web via DuckDuckGo',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query' } },
        required: ['query'],
      },
    },
  ],
  errors: [],
};

const SAMPLE_CALL_RESULT = {
  serverId: 'search',
  toolName: 'duckduckgo_search',
  result: { results: [{ title: 'Example', url: 'https://example.com', snippet: '...' }] },
};

const ENABLED_SETTINGS = norm({
  enabled: true,
  exposeTools: true,
  servers: [{ id: 'search', enabled: true, category: 'search' }],
});

beforeEach(() => {
  invokeMock.mockReset();
  clearMcpToolDefinitionCache();
  (localStorage.clear as ReturnType<typeof vi.fn>).mockClear();
  (localStorage.getItem as ReturnType<typeof vi.fn>).mockReset();
  (localStorage.setItem as ReturnType<typeof vi.fn>).mockReset();
  (localStorage.removeItem as ReturnType<typeof vi.fn>).mockReset();
  storedItems = {};
});

describe('loadMcpToolDefinitions', () => {
  it('returns empty arrays when MCP is disabled', async () => {
    const disabled = createDefaultMcpSettings();
    const result = await loadMcpToolDefinitions(disabled);
    expect(result.definitions).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('fetches tools from the backend and returns IToolDefinitions', async () => {
    invokeMock.mockResolvedValueOnce(SAMPLE_TOOLS_RESULT);
    const result = await loadMcpToolDefinitions(ENABLED_SETTINGS);
    expect(result.definitions).toHaveLength(1);
    expect(result.definitions[0].name).toBe('mcp__search__duckduckgo_search');
    expect(result.errors).toEqual([]);
    expect(invokeMock).toHaveBeenCalledWith(
      'mcp_list_tools',
      expect.objectContaining({ refresh: false }),
    );
  });

  it('caches tools and returns cached data on the next call', async () => {
    invokeMock.mockResolvedValueOnce(SAMPLE_TOOLS_RESULT);
    await loadMcpToolDefinitions(ENABLED_SETTINGS);

    invokeMock.mockClear();
    const cached = await loadMcpToolDefinitions(ENABLED_SETTINGS);
    expect(cached.definitions).toHaveLength(1);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('skips cache when refresh is true', async () => {
    invokeMock.mockResolvedValueOnce(SAMPLE_TOOLS_RESULT);
    await loadMcpToolDefinitions(ENABLED_SETTINGS);

    invokeMock.mockClear();
    invokeMock.mockResolvedValueOnce({ ...SAMPLE_TOOLS_RESULT, tools: [] });
    const refreshed = await loadMcpToolDefinitions(ENABLED_SETTINGS, { refresh: true });
    expect(refreshed.definitions).toEqual([]);
    expect(invokeMock).toHaveBeenCalled();
  });
});

describe('registerMcpTools', () => {
  it('does nothing when MCP is disabled', () => {
    const registry = new ToolRegistry();
    const definitions: IToolDefinition[] = [
      {
        name: 'mcp__search__duckduckgo_search',
        description: 'test',
        parameters: { type: 'object', properties: {} },
      },
    ];
    registerMcpTools(registry, createDefaultMcpSettings(), definitions);
    expect(registry.getAll()).toHaveLength(0);
  });

  it('registers tools and executes them through the backend', async () => {
    invokeMock.mockResolvedValueOnce(SAMPLE_CALL_RESULT);

    const definitions: IToolDefinition[] = [
      {
        name: 'mcp__search__duckduckgo_search',
        description: 'MCP search',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ];

    const registry = new ToolRegistry();
    registerMcpTools(registry, ENABLED_SETTINGS, definitions);
    registry.freeze();

    const allTools = registry.getAll();
    expect(allTools).toHaveLength(1);
    expect(allTools[0].name).toBe('mcp__search__duckduckgo_search');

    const result = await registry.execute('mcp__search__duckduckgo_search', { query: 'hello' });
    expect(result).toEqual(SAMPLE_CALL_RESULT);
    expect(invokeMock).toHaveBeenCalledWith(
      'mcp_call_tool',
      expect.objectContaining({
        serverId: 'search',
        toolName: 'duckduckgo_search',
        arguments: { query: 'hello' },
      }),
    );
  });

  it('throws when the MCP tool name is invalid', async () => {
    const definitions: IToolDefinition[] = [
      {
        name: 'not_a_mcp_tool',
        description: 'bad',
        parameters: { type: 'object', properties: {} },
      },
    ];

    const registry = new ToolRegistry();
    registerMcpTools(registry, ENABLED_SETTINGS, definitions);
    await expect(
      registry.execute('not_a_mcp_tool', {}),
    ).rejects.toThrow('Invalid MCP tool name');
  });
});

describe('clearMcpToolDefinitionCache', () => {
  it('removes in-memory and localStorage cache', async () => {
    invokeMock.mockResolvedValueOnce(SAMPLE_TOOLS_RESULT);
    await loadMcpToolDefinitions(ENABLED_SETTINGS);

    clearMcpToolDefinitionCache();

    invokeMock.mockClear();
    invokeMock.mockResolvedValueOnce(SAMPLE_TOOLS_RESULT);
    await loadMcpToolDefinitions(ENABLED_SETTINGS);
    expect(invokeMock).toHaveBeenCalled();
  });
});
