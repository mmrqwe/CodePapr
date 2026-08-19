import { ToolRegistry } from '@codepapr/core';
import type { IToolDefinition } from '@codepapr/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearMcpToolDefinitionCache,
  disposeMcpConfirmListener,
  initMcpConfirmListener,
  loadMcpToolDefinitions,
  registerMcpTools,
  setMcpConfirmHandler,
  type McpConfirmRequest,
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

let storedCache: Record<string, string> = {};

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

const { listenMock } = vi.hoisted(() => ({
  listenMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}));

vi.mock('../utils/cacheStorage', () => ({
  cacheGet: vi.fn(async (key: string) => {
    const raw = storedCache[key];
    return raw ? JSON.parse(raw) : null;
  }),
  cacheSet: vi.fn(async (key: string, data: unknown, _ttlMs?: number) => {
    storedCache[key] = JSON.stringify(data);
  }),
  cacheRemove: vi.fn(async (key: string) => {
    delete storedCache[key];
  }),
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

beforeEach(async () => {
  invokeMock.mockReset();
  listenMock.mockReset();
  storedCache = {};
  await clearMcpToolDefinitionCache();
});

describe('initMcpConfirmListener', () => {
  afterEach(() => {
    disposeMcpConfirmListener();
    setMcpConfirmHandler(null);
  });

  it('registers a single listener for mcp-confirm-request events', async () => {
    listenMock.mockImplementation(async () => () => undefined);
    await initMcpConfirmListener();
    await initMcpConfirmListener();

    expect(listenMock).toHaveBeenCalledTimes(1);
    expect(listenMock.mock.calls[0][0]).toBe('mcp-confirm-request');
  });

  it('shares one in-flight registration when init races (StrictMode double-mount)', async () => {
    let resolveListen: ((unlisten: () => void) => void) | undefined;
    listenMock.mockImplementation(async () => {
      return await new Promise<() => void>((resolve) => {
        resolveListen = resolve;
      });
    });

    const first = initMcpConfirmListener();
    const second = initMcpConfirmListener();
    await Promise.resolve();

    expect(listenMock).toHaveBeenCalledTimes(1);

    const unlisten = vi.fn();
    resolveListen!(unlisten);
    await first;
    await second;

    expect(listenMock).toHaveBeenCalledTimes(1);
  });

  it('swallows a late reply rejection when the backend already timed out', async () => {
    let handler: ((event: { payload: McpConfirmRequest }) => void) | undefined;
    listenMock.mockImplementation(async (_event: string, cb: typeof handler) => {
      handler = cb;
      return () => undefined;
    });
    await initMcpConfirmListener();
    setMcpConfirmHandler(async () => true);
    invokeMock.mockRejectedValueOnce(new Error('No pending confirmation with id: mcp_srv_5'));

    await expect(
      handler!({
        payload: {
          requestId: 'mcp_srv_5',
          serverId: 'srv',
          serverName: 'Filesystem MCP',
          toolName: 'write_file',
          arguments: {},
        },
      }),
    ).resolves.toBeUndefined();

    expect(invokeMock).toHaveBeenCalledWith('mcp_confirm_response', {
      requestId: 'mcp_srv_5',
      approved: true,
    });
  });

  it('replies approved=true to the backend when the handler approves', async () => {
    let handler: ((event: { payload: McpConfirmRequest }) => void) | undefined;
    listenMock.mockImplementation(async (_event: string, cb: typeof handler) => {
      handler = cb;
      return () => undefined;
    });
    await initMcpConfirmListener();
    setMcpConfirmHandler(async () => true);

    await handler!({
      payload: {
        requestId: 'mcp_srv_1',
        serverId: 'srv',
        serverName: 'Filesystem MCP',
        toolName: 'write_file',
        arguments: { path: '/tmp/x.txt' },
      },
    });

    expect(invokeMock).toHaveBeenCalledWith('mcp_confirm_response', {
      requestId: 'mcp_srv_1',
      approved: true,
    });
  });

  it('replies approved=false when the handler denies', async () => {
    let handler: ((event: { payload: McpConfirmRequest }) => void) | undefined;
    listenMock.mockImplementation(async (_event: string, cb: typeof handler) => {
      handler = cb;
      return () => undefined;
    });
    await initMcpConfirmListener();
    setMcpConfirmHandler(async () => false);

    await handler!({
      payload: {
        requestId: 'mcp_srv_2',
        serverId: 'srv',
        serverName: 'Filesystem MCP',
        toolName: 'delete_file',
        arguments: { path: '/tmp/x.txt' },
      },
    });

    expect(invokeMock).toHaveBeenCalledWith('mcp_confirm_response', {
      requestId: 'mcp_srv_2',
      approved: false,
    });
  });

  it('replies approved=false when no handler is set (fail closed)', async () => {
    let handler: ((event: { payload: McpConfirmRequest }) => void) | undefined;
    listenMock.mockImplementation(async (_event: string, cb: typeof handler) => {
      handler = cb;
      return () => undefined;
    });
    await initMcpConfirmListener();

    await handler!({
      payload: {
        requestId: 'mcp_srv_3',
        serverId: 'srv',
        serverName: 'Filesystem MCP',
        toolName: 'write_file',
        arguments: {},
      },
    });

    expect(invokeMock).toHaveBeenCalledWith('mcp_confirm_response', {
      requestId: 'mcp_srv_3',
      approved: false,
    });
  });

  it('replies approved=false when the handler throws', async () => {
    let handler: ((event: { payload: McpConfirmRequest }) => void) | undefined;
    listenMock.mockImplementation(async (_event: string, cb: typeof handler) => {
      handler = cb;
      return () => undefined;
    });
    await initMcpConfirmListener();
    setMcpConfirmHandler(async () => {
      throw new Error('dialog crashed');
    });

    await handler!({
      payload: {
        requestId: 'mcp_srv_4',
        serverId: 'srv',
        serverName: 'Filesystem MCP',
        toolName: 'write_file',
        arguments: {},
      },
    });

    expect(invokeMock).toHaveBeenCalledWith('mcp_confirm_response', {
      requestId: 'mcp_srv_4',
      approved: false,
    });
  });
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
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(
      'mcp_update_settings',
      expect.objectContaining({
        settings: expect.objectContaining({ enabled: true, exposeTools: true }),
      }),
    );
    expect(invokeMock.mock.calls.some(([command]) => command === 'mcp_list_tools')).toBe(false);
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
        settings: expect.objectContaining({
          enabled: true,
          exposeTools: true,
        }),
      }),
    );
  });

  it('passes settings on call_tool after a tool-definition cache hit', async () => {
    invokeMock.mockResolvedValueOnce(SAMPLE_TOOLS_RESULT);
    const first = await loadMcpToolDefinitions(ENABLED_SETTINGS);

    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    const cached = await loadMcpToolDefinitions(ENABLED_SETTINGS);
    expect(cached.definitions).toHaveLength(1);
    expect(invokeMock.mock.calls.some(([command]) => command === 'mcp_list_tools')).toBe(false);

    invokeMock.mockReset();
    invokeMock.mockResolvedValueOnce(SAMPLE_CALL_RESULT);
    const registry = new ToolRegistry();
    registerMcpTools(registry, ENABLED_SETTINGS, cached.definitions, first.toolMappings);
    registry.freeze();

    await registry.execute('mcp__search__duckduckgo_search', { query: 'hello' });
    expect(invokeMock).toHaveBeenCalledWith(
      'mcp_call_tool',
      expect.objectContaining({
        serverId: 'search',
        toolName: 'duckduckgo_search',
        settings: expect.objectContaining({ enabled: true }),
      }),
    );
  });

  it('extracts images from MCP tool result content', async () => {
    invokeMock.mockResolvedValueOnce({
      serverId: 'image_server',
      toolName: 'generate_image',
      result: {
        content: [
          { type: 'text', text: 'Generated image:' },
          { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' },
        ],
        isError: false,
      },
    });

    const definitions: IToolDefinition[] = [
      {
        name: 'mcp__image_server__generate_image',
        description: 'Generate image',
        parameters: { type: 'object', properties: {} },
      },
    ];

    const registry = new ToolRegistry();
    registerMcpTools(registry, ENABLED_SETTINGS, definitions);
    registry.freeze();

    const result = (await registry.execute('mcp__image_server__generate_image', {})) as {
      serverId: string;
      toolName: string;
      __images?: Array<{ mediaType: string; data: string }>;
    };

    expect(result.serverId).toBe('image_server');
    expect(result.__images).toEqual([
      { mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' },
    ]);
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
  it('removes in-memory and persisted cache', async () => {
    invokeMock.mockResolvedValueOnce(SAMPLE_TOOLS_RESULT);
    await loadMcpToolDefinitions(ENABLED_SETTINGS);

    await clearMcpToolDefinitionCache();

    invokeMock.mockClear();
    invokeMock.mockResolvedValueOnce(SAMPLE_TOOLS_RESULT);
    await loadMcpToolDefinitions(ENABLED_SETTINGS);
    expect(invokeMock).toHaveBeenCalled();
  });
});
