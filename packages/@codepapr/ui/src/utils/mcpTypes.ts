import type { IToolDefinition } from '@codepapr/types';

export type McpTransportType = 'stdio' | 'sse' | 'streamable-http';
export type McpServerCategory = 'search' | 'database' | 'custom';
export type McpPermissionMode = 'read-only' | 'read-write' | 'dangerous';

export interface McpServerConfig {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  category: McpServerCategory;
  transport: McpTransportType;
  command: string;
  args: string;
  url: string;
  env: string;
  headers: string;
  allowedTools: string;
  deniedTools: string;
  forceMutating: string;
  forceReadonly: string;
  permissionMode: McpPermissionMode;
  requireConfirmation: boolean;
  timeoutSeconds: number;
}

export interface McpSettings {
  enabled: boolean;
  exposeTools: boolean;
  resultMaxBytes: number;
  servers: McpServerConfig[];
}

export interface McpToolInfo {
  serverId: string;
  serverName: string;
  toolName: string;
  displayName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpListToolsResult {
  tools: McpToolInfo[];
  errors: Array<{ serverId: string; message: string }>;
}

export interface McpCallToolResult {
  serverId: string;
  toolName: string;
  result: unknown;
}

export interface McpServerStatus {
  serverId: string;
  serverName: string;
  enabled: boolean;
  connected: boolean;
  transport: string;
  permissionMode: string;
}

export interface McpTestServerResult {
  serverId: string;
  serverName: string;
  success: boolean;
  toolCount: number;
  filteredCount: number;
  message: string;
}

export const MCP_TOOL_PREFIX = 'mcp__';

/** 稳定短哈希（FNV-1a，base36）：用于给"有损消毒"的 MCP 工具名追加唯一后缀。
 *  旧实现直接替换非法字符——foo.bar 与 foo_bar 都变成 foo_bar，工具注册时
 *  碰撞抛错、整批中断；加上源自原始名的确定性后缀后，不同原始名必得不同
 *  注册名（调用仍通过 toolNameMap 映射回原始名）。 */
function shortStableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function sanitizeMcpToolPart(value: string): string {
  const trimmed = value.trim();
  const sanitized = trimmed.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!sanitized) return 'tool';
  // 消毒前后一致 = 无损，名字保持稳定（常见名 duckduckgo_search 不变）。
  // 有损（含 . / : 空格等）则追加原始名哈希后缀，杜绝 foo.bar 与 foo_bar 碰撞。
  return sanitized === trimmed ? sanitized : `${sanitized}_${shortStableHash(trimmed)}`;
}

export function buildMcpToolName(serverId: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${sanitizeMcpToolPart(serverId)}__${sanitizeMcpToolPart(toolName)}`;
}

export function parseMcpToolName(name: string): { serverId: string; sanitizedToolName: string } | null {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const splitAt = rest.indexOf('__');
  if (splitAt <= 0 || splitAt >= rest.length - 2) return null;
  return {
    serverId: rest.slice(0, splitAt),
    sanitizedToolName: rest.slice(splitAt + 2),
  };
}

export function hasEnabledMcpSearch(settings: McpSettings): boolean {
  return settings.enabled && settings.exposeTools && settings.servers.some(
    (server) => server.enabled && server.category === 'search'
  );
}

/**
 * 内置 websearch/webfetch 是否应因 MCP 搜索而隐藏（N1）。
 * 极简工具面不注册任何 MCP 工具（allowlist 是唯一能力面），「MCP 搜索接管
 * web 能力」的替代前提不成立——若照旧隐藏原生 web，极简+MCP 搜索开启会出现
 * 零搜索能力。因此 minimal 档强制保留原生 websearch/webfetch。
 */
export function mcpSearchHidesNativeWeb(
  settings: McpSettings,
  toolProfile: 'default' | 'minimal' | undefined
): boolean {
  return hasEnabledMcpSearch(settings) && toolProfile !== 'minimal';
}

export function createMcpSettingsCacheKey(settings: McpSettings): string {
  return JSON.stringify(settings.servers
    .filter((server) => server.enabled)
    .map((server) => ({ 
      id: server.id,
      name: server.name,
      enabled: server.enabled,
      category: server.category,
      transport: server.transport,
      command: server.command,
      args: server.args,
      url: server.url,
      env: server.env,
      headers: server.headers,
      allowedTools: server.allowedTools,
      deniedTools: server.deniedTools,
      forceMutating: server.forceMutating,
      forceReadonly: server.forceReadonly,
      permissionMode: server.permissionMode,
      requireConfirmation: server.requireConfirmation,
      timeoutSeconds: server.timeoutSeconds,
    })));
}

export function mcpToolInfoToDefinition(tool: McpToolInfo): IToolDefinition {
  const schema = tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : {};
  const properties =
    schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === 'string')
    : undefined;

  return {
    name: buildMcpToolName(tool.serverId, tool.toolName),
    description: `[MCP:${tool.serverName}] ${tool.description || tool.toolName}`,
    parameters: {
      type: typeof schema.type === 'string' ? schema.type : 'object',
      properties,
      ...(required && required.length > 0 ? { required } : {}),
    },
  };
}

export function splitMcpArgs(value: string): string[] {
  const matches = value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return matches.map((item) => item.replace(/^(["'])(.*)\1$/, '$2'));
}

export function parseMcpEnv(value: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const val = trimmed.slice(index + 1).trim();
    if (key) env[key] = val;
  }
  return env;
}

export function parseMcpHeaders(value: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf(':');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const val = trimmed.slice(index + 1).trim();
    if (key) headers[key] = val;
  }
  return headers;
}

export function createDefaultMcpSettings(): McpSettings {
  return {
    enabled: false,
    exposeTools: true,
    resultMaxBytes: 200_000,
    servers: [
      {
        id: 'search',
        name: 'DuckDuckGo Search MCP',
        enabled: false,
        category: 'search',
        transport: 'stdio',
        command: 'npx',
        args: '-y duckduckgo-mcp-server',
        url: '',
        env: '',
        headers: '',
        allowedTools: 'duckduckgo_web_search',
        deniedTools: '',
        forceMutating: '',
        forceReadonly: '',
        permissionMode: 'read-only',
        requireConfirmation: false,
        timeoutSeconds: 60,
      },
      {
        id: 'postgres',
        name: 'Postgres MCP',
        enabled: false,
        category: 'database',
        transport: 'stdio',
        command: 'npx',
        args: '-y @modelcontextprotocol/server-postgres postgresql://localhost:5432/postgres',
        url: '',
        env: '',
        headers: '',
        allowedTools: 'query,describe*,list*',
        deniedTools: 'delete*,drop*,truncate*,update*,insert*',
        forceMutating: '',
        forceReadonly: '',
        permissionMode: 'read-only',
        requireConfirmation: false,
        timeoutSeconds: 60,
      },
      {
        id: 'sqlite',
        name: 'SQLite MCP',
        enabled: false,
        category: 'database',
        transport: 'stdio',
        command: 'uvx',
        args: 'mcp-server-sqlite --db-path ./database.sqlite',
        url: '',
        env: '',
        headers: '',
        allowedTools: 'query,describe*,list*',
        deniedTools: 'delete*,drop*,truncate*,update*,insert*',
        forceMutating: '',
        forceReadonly: '',
        permissionMode: 'read-only',
        requireConfirmation: false,
        timeoutSeconds: 60,
      },
    ],
  };
}

const OLD_BRAVE_ARGS = '-y @modelcontextprotocol/server-brave-search';

export function normalizeMcpSettings(input?: Partial<McpSettings>): McpSettings {
  const defaults = createDefaultMcpSettings();
  const byId = new Map(defaults.servers.map((server) => [server.id, server]));
  const inputServers = Array.isArray(input?.servers) ? input.servers : [];
  const normalizedServers = inputServers.map((server) => normalizeMcpServer(server));

  for (const server of normalizedServers) {
    const existing = byId.get(server.id);
    if (existing && server.args === OLD_BRAVE_ARGS) {
      byId.set(server.id, {
        ...server,
        name: existing.name,
        args: existing.args,
        command: existing.command,
        env: existing.env,
        allowedTools: existing.allowedTools,
        deniedTools: existing.deniedTools,
      });
    } else {
      byId.set(server.id, server);
    }
  }

  return {
    enabled: input?.enabled ?? defaults.enabled,
    exposeTools: input?.exposeTools ?? defaults.exposeTools,
    resultMaxBytes:
      typeof input?.resultMaxBytes === 'number' && Number.isFinite(input.resultMaxBytes)
        ? Math.max(1_000, Math.min(5_000_000, Math.floor(input.resultMaxBytes)))
        : defaults.resultMaxBytes,
    servers: [...byId.values()],
  };
}

export function normalizeMcpServer(input: Partial<McpServerConfig>): McpServerConfig {
  const id = sanitizeMcpToolPart(input.id || input.name || `server_${Date.now()}`).toLowerCase();
  const category: McpServerCategory =
    input.category === 'search' || input.category === 'database' || input.category === 'custom'
      ? input.category
      : 'custom';
  const transport: McpTransportType =
    input.transport === 'sse' || input.transport === 'streamable-http'
      ? input.transport
      : 'stdio';
  const permissionMode: McpPermissionMode =
    input.permissionMode === 'read-write' || input.permissionMode === 'dangerous'
      ? input.permissionMode
      : 'read-only';

  return {
    id,
    name: (input.name || id).trim(),
    description: input.description || undefined,
    enabled: input.enabled ?? false,
    category,
    transport,
    command: (input.command || '').trim(),
    args: (input.args || '').trim(),
    url: (input.url || '').trim(),
    env: input.env || '',
    headers: input.headers || '',
    allowedTools: (input.allowedTools || '').trim(),
    deniedTools: (input.deniedTools || '').trim(),
    forceMutating: (input.forceMutating || '').trim(),
    forceReadonly: (input.forceReadonly || '').trim(),
    permissionMode,
    requireConfirmation: input.requireConfirmation ?? false,
    timeoutSeconds:
      typeof input.timeoutSeconds === 'number' && Number.isFinite(input.timeoutSeconds)
        ? Math.max(5, Math.min(600, Math.floor(input.timeoutSeconds)))
        : 60,
  };
}

export function createBlankMcpServer(): McpServerConfig {
  return normalizeMcpServer({
    id: `custom_${Date.now()}`,
    name: 'Custom MCP',
    enabled: false,
    category: 'custom',
    transport: 'stdio',
    command: '',
    args: '',
    env: '',
  });
}
