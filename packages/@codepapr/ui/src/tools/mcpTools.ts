import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { ToolRegistry } from '@codepapr/core';
import type { IToolDefinition } from '@codepapr/types';
import {
  buildMcpToolName,
  createMcpSettingsCacheKey,
  mcpToolInfoToDefinition,
  parseMcpToolName,
  parseMcpEnv,
  parseMcpHeaders,
  splitMcpArgs,
  type McpCallToolResult,
  type McpListToolsResult,
  type McpToolInfo,
  type McpServerConfig,
  type McpServerStatus,
  type McpSettings,
  type McpTestServerResult,
} from '../utils/mcpTypes';
import { cacheGet, cacheSet, cacheRemove } from '../utils/cacheStorage';

export interface McpConfirmRequest {
  requestId: string;
  serverId: string;
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export type McpConfirmHandler = (request: McpConfirmRequest) => Promise<boolean>;

let confirmHandler: McpConfirmHandler | null = null;
let confirmUnlisten: UnlistenFn | null = null;

export function setMcpConfirmHandler(handler: McpConfirmHandler | null): void {
  confirmHandler = handler;
}

export async function initMcpConfirmListener(): Promise<void> {
  if (confirmUnlisten) return;
  confirmUnlisten = await listen<McpConfirmRequest>('mcp-confirm-request', async (event) => {
    const request = event.payload;
    let approved = false;
    if (confirmHandler) {
      try {
        approved = await confirmHandler(request);
      } catch {
        approved = false;
      }
    }
    await invoke('mcp_confirm_response', { requestId: request.requestId, approved });
  });
}

export function disposeMcpConfirmListener(): void {
  if (confirmUnlisten) {
    confirmUnlisten();
    confirmUnlisten = null;
  }
}

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
  forceMutating: string[];
  forceReadonly: string[];
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

const MCP_TOOL_CACHE_KEY = 'codepapr.mcp.toolCache.v1';
const MCP_TOOL_NAME_MAP_KEY = 'codepapr.mcp.toolNameMap.v1';
let memoryToolCache: McpToolCacheEntry | null = null;

/** Bidirectional mapping: displayName -> { serverId, toolName }.
 *  Persisted to cacheStorage so it survives page refresh. */
const toolNameMap = new Map<string, { serverId: string; toolName: string }>();
let toolNameMapLoaded = false;

async function ensureToolNameMapLoaded(): Promise<void> {
  if (toolNameMapLoaded) return;
  toolNameMapLoaded = true;
  const stored = await cacheGet<Array<[string, { serverId: string; toolName: string }]>>(MCP_TOOL_NAME_MAP_KEY);
  if (Array.isArray(stored)) {
    for (const [key, value] of stored) {
      if (!toolNameMap.has(key)) {
        toolNameMap.set(key, value);
      }
    }
  }
}

async function persistToolNameMap(): Promise<void> {
  const entries = Array.from(toolNameMap.entries());
  await cacheSet(MCP_TOOL_NAME_MAP_KEY, entries);
}

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
    headers: parseMcpHeaders(server.headers),
    allowedTools: splitPatterns(server.allowedTools),
    deniedTools: splitPatterns(server.deniedTools),
    forceMutating: splitPatterns(server.forceMutating),
    forceReadonly: splitPatterns(server.forceReadonly),
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

async function readPersistedToolCache(): Promise<McpToolCacheEntry | null> {
  if (memoryToolCache && !isCacheExpired(memoryToolCache)) {
    return memoryToolCache;
  }
  const cached = await cacheGet<McpToolCacheEntry>(MCP_TOOL_CACHE_KEY);
  if (!cached || typeof cached.cacheKey !== 'string' || !Array.isArray(cached.tools)) return null;
  if (isCacheExpired(cached)) {
    await cacheRemove(MCP_TOOL_CACHE_KEY);
    return null;
  }
  memoryToolCache = cached;
  return cached;
}

async function writeStoredToolCache(entry: McpToolCacheEntry): Promise<void> {
  memoryToolCache = entry;
  await cacheSet(MCP_TOOL_CACHE_KEY, entry, MCP_TOOL_CACHE_TTL_MS);
}

export async function clearMcpToolDefinitionCache(): Promise<void> {
  memoryToolCache = null;
  await cacheRemove(MCP_TOOL_CACHE_KEY);
  await cacheRemove(MCP_TOOL_NAME_MAP_KEY);
}

async function listMcpTools(settings: McpSettings, refresh = false): Promise<McpListToolsResult> {
  if (!settings.enabled || !settings.exposeTools) {
    return { tools: [], errors: [] };
  }

  const cacheKey = createMcpSettingsCacheKey(settings);
  if (!refresh) {
    const cached = await readPersistedToolCache();
    if (cached?.cacheKey === cacheKey) {
      return { tools: cached.tools, errors: cached.errors };
    }
  }

  const result = await invoke<McpListToolsResult>('mcp_list_tools', {
    settings: toNativeSettings(settings),
    refresh,
  });
  const now = Date.now();
  await writeStoredToolCache({ cacheKey, tools: result.tools, errors: result.errors, updatedAt: now, expiresAt: now + MCP_TOOL_CACHE_TTL_MS });
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

export async function mcpHealthCheck(): Promise<string[]> {
  return await invoke<string[]>('mcp_health_check');
}

let healthCheckTimer: ReturnType<typeof setInterval> | null = null;

export function startMcpHealthCheck(intervalMs = 30_000, onPruned?: (serverIds: string[]) => void): void {
  stopMcpHealthCheck();
  healthCheckTimer = setInterval(async () => {
    try {
      const pruned = await mcpHealthCheck();
      if (pruned.length > 0 && onPruned) {
        onPruned(pruned);
      }
    } catch {
      // best-effort
    }
  }, intervalMs);
}

export function stopMcpHealthCheck(): void {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
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
  await invalidateServerToolCache(serverId);
  return await invoke<number>('mcp_disconnect_server', {
    settings: toNativeSettings(settings),
    serverId,
  });
}

async function invalidateServerToolCache(serverId: string): Promise<void> {
  const cached = await readPersistedToolCache();
  if (!cached) return;
  const remainingTools = cached.tools.filter((t) => t.serverId !== serverId);
  const remainingErrors = cached.errors.filter((e) => e.serverId !== serverId);
  if (remainingTools.length === cached.tools.length && remainingErrors.length === cached.errors.length) return;
  const now = Date.now();
  await writeStoredToolCache({
    cacheKey: cached.cacheKey,
    tools: remainingTools,
    errors: remainingErrors,
    updatedAt: now,
    expiresAt: cached.expiresAt,
  });
  for (const [displayName, mapping] of toolNameMap) {
    if (mapping.serverId === serverId) {
      toolNameMap.delete(displayName);
    }
  }
  await persistToolNameMap();
}

async function resolveOriginalToolName(displayName: string): Promise<{ serverId: string; toolName: string } | null> {
  await ensureToolNameMapLoaded();

  const mapped = toolNameMap.get(displayName);
  if (mapped) return mapped;

  const parsed = parseMcpToolName(displayName);
  if (!parsed) return null;
  return { serverId: parsed.serverId, toolName: parsed.sanitizedToolName };
}

async function callMcpTool(settings: McpSettings, displayName: string, args: Record<string, unknown>): Promise<McpCallToolResult> {
  const resolved = await resolveOriginalToolName(displayName);
  if (!resolved) {
    throw new Error(`Invalid MCP tool name: ${displayName}`);
  }

  await validateToolArguments(displayName, args);

  return await invoke<McpCallToolResult>('mcp_call_tool', {
    serverId: resolved.serverId,
    toolName: resolved.toolName,
    arguments: args,
  });
}

async function validateToolArguments(displayName: string, args: Record<string, unknown>): Promise<void> {
  const cached = await readPersistedToolCache();
  if (!cached) return;
  const tool = cached.tools.find((t) => buildMcpToolName(t.serverId, t.toolName) === displayName);
  if (!tool?.inputSchema) return;

  const schema = tool.inputSchema as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const properties = (schema.properties && typeof schema.properties === 'object')
    ? (schema.properties as Record<string, Record<string, unknown>>)
    : {};

  const missing = required.filter((key) => args[key] === undefined || args[key] === null);
  if (missing.length > 0) {
    throw new Error(`MCP tool '${displayName}' missing required arguments: ${missing.join(', ')}`);
  }

  for (const [key, value] of Object.entries(args)) {
    const propSchema = properties[key];
    if (!propSchema || value === undefined || value === null) continue;
    const expectedType = propSchema.type as string | undefined;
    if (!expectedType) continue;
    const actualType = Array.isArray(value) ? 'array' : typeof value;
    const typeMap: Record<string, string> = { string: 'string', number: 'number', boolean: 'boolean', object: 'object', array: 'array' };
    if (typeMap[expectedType] && actualType !== typeMap[expectedType]) {
      throw new Error(`MCP tool '${displayName}' argument '${key}' expects type '${expectedType}' but got '${actualType}'`);
    }
  }
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

  const activeServerIds = new Set(settings.servers.filter((s) => s.enabled).map((s) => s.id));
  for (const [displayName, mapping] of toolNameMap) {
    if (!activeServerIds.has(mapping.serverId)) {
      toolNameMap.delete(displayName);
    }
  }

  if (toolMappings && toolMappings.length > 0) {
    for (const mapping of toolMappings) {
      toolNameMap.set(mapping.displayName, { serverId: mapping.serverId, toolName: mapping.toolName });
    }
    void persistToolNameMap();
  }

  toolNameMapLoaded = true;

  for (const definition of definitions) {
    try {
      registry.register(definition, async (args) => {
        return await callMcpTool(settings, definition.name, args);
      });
    } catch {
      // 单个工具注册失败（如重名）不能中断整批注册——旧实现直接抛出，
      // 一个碰撞工具导致其余全部 MCP 工具不可用。跳过并继续。
      console.warn(`[CodePapr] MCP 工具注册失败，跳过: ${definition.name}`);
    }
  }
}
