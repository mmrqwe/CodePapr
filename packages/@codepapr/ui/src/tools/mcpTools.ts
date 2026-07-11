import { invoke } from '@tauri-apps/api/core';
import { ToolRegistry } from '@codepapr/core';
import type { IToolDefinition } from '@codepapr/types';
import {
  createMcpSettingsCacheKey,
  mcpToolInfoToDefinition,
  parseMcpToolName,
  parseMcpEnv,
  splitMcpArgs,
  type McpCallToolResult,
  type McpListToolsResult,
  type McpToolInfo,
  type McpServerConfig,
  type McpServerStatus,
  type McpSettings,
  type McpTestServerResult,
} from '../utils/mcpTypes';

interface NativeMcpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  category: string;
  transport: string;
  command: string;
  args: string[];
  url: string;
  env: Record<string, string>;
  headers: Record<string, string>;
  allowedTools: string[];
  deniedTools: string[];
  permissionMode: string;
  requireConfirmation: boolean;
  timeoutSeconds: number;
}

interface NativeMcpSettings {
  enabled: boolean;
  exposeTools: boolean;
  resultMaxBytes: number;
  servers: NativeMcpServerConfig[];
}

const MCP_TOOL_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface McpToolCacheEntry {
  cacheKey: string;
  tools: McpToolInfo[];
  errors: McpListToolsResult['errors'];
  updatedAt: number;
  expiresAt: number;
}

const MCP_TOOL_CACHE_STORAGE_KEY = 'codepapr.mcp.toolCache.v1';
let memoryToolCache: McpToolCacheEntry | null = null;

/** In-memory bidirectional mapping: displayName -> { serverId, toolName }.
 *  This acts as a fallback when the cache is cleared and the original toolName
 *  may have been mangled by sanitization. */
const toolNameMap = new Map<string, { serverId: string; toolName: string }>();

function isCacheExpired(entry: McpToolCacheEntry): boolean {
  return Date.now() >= entry.expiresAt;
}

function splitPatterns(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function toNativeServerConfig(server: McpServerConfig): NativeMcpServerConfig {
  return {
    id: server.id,
    name: server.name,
    enabled: server.enabled,
    category: server.category,
    transport: server.transport,
    command: server.command,
    args: splitMcpArgs(server.args),
    url: server.url,
    env: parseMcpEnv(server.env),
    headers: parseMcpEnv(server.headers),
    allowedTools: splitPatterns(server.allowedTools),
    deniedTools: splitPatterns(server.deniedTools),
    permissionMode: server.permissionMode,
    requireConfirmation: server.requireConfirmation,
    timeoutSeconds: server.timeoutSeconds,
  };
}

function toNativeSettings(settings: McpSettings): NativeMcpSettings {
  return {
    enabled: settings.enabled,
    exposeTools: settings.exposeTools,
    resultMaxBytes: settings.resultMaxBytes,
    servers: settings.servers.map(toNativeServerConfig),
  };
}

function readStoredToolCache(): McpToolCacheEntry | null {
  if (memoryToolCache) {
    if (isCacheExpired(memoryToolCache)) {
      memoryToolCache = null;
      return null;
    }
    return memoryToolCache;
  }
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(MCP_TOOL_CACHE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as McpToolCacheEntry;
    if (!parsed || typeof parsed.cacheKey !== 'string' || !Array.isArray(parsed.tools)) return null;
    if (isCacheExpired(parsed)) {
      localStorage.removeItem(MCP_TOOL_CACHE_STORAGE_KEY);
      return null;
    }
    memoryToolCache = parsed;
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredToolCache(entry: McpToolCacheEntry): void {
  memoryToolCache = entry;
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(MCP_TOOL_CACHE_STORAGE_KEY, JSON.stringify(entry));
  } catch {
    // Best-effort cache only.
  }
}

export function clearMcpToolDefinitionCache(): void {
  memoryToolCache = null;
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(MCP_TOOL_CACHE_STORAGE_KEY);
  } catch {
    // Best-effort cache only.
  }
}

async function listMcpTools(settings: McpSettings, refresh = false): Promise<McpListToolsResult> {
  if (!settings.enabled || !settings.exposeTools) {
    return { tools: [], errors: [] };
  }

  const cacheKey = createMcpSettingsCacheKey(settings);
  if (!refresh) {
    const cached = readStoredToolCache();
    if (cached?.cacheKey === cacheKey) {
      return { tools: cached.tools, errors: cached.errors };
    }
  }

  const result = await invoke<McpListToolsResult>('mcp_list_tools', {
    settings: toNativeSettings(settings),
    refresh,
  });
  const now = Date.now();
  writeStoredToolCache({ cacheKey, tools: result.tools, errors: result.errors, updatedAt: now, expiresAt: now + MCP_TOOL_CACHE_TTL_MS });
  return result;
}

export async function listMcpServerStatus(settings: McpSettings): Promise<McpServerStatus[]> {
  return await invoke<McpServerStatus[]>('mcp_list_status', {
    settings: toNativeSettings(settings),
  });
}

export async function disconnectAllMcpServers(): Promise<number> {
  return await invoke<number>('mcp_disconnect_all');
}

export interface McpToolPreviewItem {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpPreviewResult {
  success: boolean;
  url: string;
  serverName: string;
  toolCount: number;
  tools: McpToolPreviewItem[];
  message: string;
}

export async function previewMcpServer(
  url: string,
  transport: string,
  timeoutSeconds?: number,
): Promise<McpPreviewResult> {
  return await invoke<McpPreviewResult>('mcp_preview_server', {
    url,
    transport,
    timeoutSeconds: timeoutSeconds ?? 60,
  });
}

export async function testMcpServer(settings: McpSettings, serverId: string): Promise<McpTestServerResult> {
  const server = settings.servers.find((s) => s.id === serverId);
  if (server && !server.enabled) {
    return {
      serverId,
      serverName: server.name,
      success: false,
      toolCount: 0,
      filteredCount: 0,
      message: 'Server is disabled — enable it and configure the transport before testing.',
    };
  }
  return await invoke<McpTestServerResult>('mcp_test_server', {
    settings: toNativeSettings(settings),
    serverId,
  });
}

export async function disconnectMcpServer(settings: McpSettings, serverId: string): Promise<number> {
  // Drop frontend tool cache so the next list_tools call hits the backend.
  clearMcpToolDefinitionCache();
  return await invoke<number>('mcp_disconnect_server', {
    settings: toNativeSettings(settings),
    serverId,
  });
}

export async function clearNativeMcpToolCache(): Promise<number> {
  return await invoke<number>('mcp_clear_tool_cache');
}

function resolveOriginalToolName(displayName: string): { serverId: string; toolName: string } | null {
  // 1. Fast path: in-memory registration map (survives cache clears).
  const mapped = toolNameMap.get(displayName);
  if (mapped) return mapped;

  // 2. Fallback: try to decode from the displayName itself.
  const parsed = parseMcpToolName(displayName);
  if (!parsed) return null;
  return { serverId: parsed.serverId, toolName: parsed.sanitizedToolName };
}

async function callMcpTool(settings: McpSettings, displayName: string, args: Record<string, unknown>): Promise<McpCallToolResult> {
  const resolved = resolveOriginalToolName(displayName);
  if (!resolved) {
    throw new Error(`Invalid MCP tool name: ${displayName}`);
  }

  return await invoke<McpCallToolResult>('mcp_call_tool', {
    settings: toNativeSettings(settings),
    serverId: resolved.serverId,
    toolName: resolved.toolName,
    arguments: args,
  });
}

export async function loadMcpToolDefinitions(settings: McpSettings, options: { refresh?: boolean } = {}): Promise<{
  definitions: IToolDefinition[];
  toolMappings: Array<{ serverId: string; toolName: string; displayName: string }>;
  errors: McpListToolsResult['errors'];
}> {
  const result = await listMcpTools(settings, options.refresh === true);
  const definitions: IToolDefinition[] = [];
  const toolMappings: Array<{ serverId: string; toolName: string; displayName: string }> = [];

  for (const tool of result.tools) {
    const definition = mcpToolInfoToDefinition(tool);
    definitions.push(definition);
    toolMappings.push({
      serverId: tool.serverId,
      toolName: tool.toolName,
      displayName: definition.name,
    });
  }

  return { definitions, toolMappings, errors: result.errors };
}

export function registerMcpTools(
  registry: ToolRegistry,
  settings: McpSettings,
  definitions: IToolDefinition[],
  toolMappings?: Array<{ serverId: string; toolName: string; displayName: string }>,
): void {
  if (!settings.enabled || !settings.exposeTools) return;

  // Remove stale mappings for servers that are no longer enabled or gone.
  const activeServerIds = new Set(settings.servers.filter((s) => s.enabled).map((s) => s.id));
  for (const [displayName, mapping] of toolNameMap) {
    if (!activeServerIds.has(mapping.serverId)) {
      toolNameMap.delete(displayName);
    }
  }

  // Register displayName -> {serverId, toolName} mapping for reliable reverse lookup.
  if (toolMappings && toolMappings.length > 0) {
    for (const mapping of toolMappings) {
      toolNameMap.set(mapping.displayName, { serverId: mapping.serverId, toolName: mapping.toolName });
    }
  }

  for (const definition of definitions) {
    registry.register(definition, async (args) => {
      return await callMcpTool(settings, definition.name, args);
    });
  }
}
