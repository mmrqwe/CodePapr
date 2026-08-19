import { errorMessage } from '@codepapr/common';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAgentStore } from '../store/agentStore';
import {
  clearMcpToolDefinitionCache,
  disconnectAllMcpServers,
  disconnectMcpServer,
  listMcpServerStatus,
  loadMcpToolDefinitions,
  testMcpServer,
} from '../tools/mcpTools';
import {
  createBlankMcpServer,
  normalizeMcpSettings,
  type McpServerConfig,
  type McpServerStatus,
  type McpSettings,
} from '../utils/mcpTypes';
import type { Lang } from '../utils/i18n';

function copy(lang: Lang | undefined) {
  if (lang === 'en') {
    return {
      title: 'MCP Host',
      desc: 'Let the agent call external MCP servers through the Rust rmcp client/host.',
      global: 'Global',
      enabled: 'Enable MCP',
      expose: 'Expose MCP tools to agent',
      resultLimit: 'Result limit bytes',
      presets: 'Presets',
      servers: 'Servers',
      add: 'Add custom server',
      test: 'Refresh tools',
      testing: 'Refreshing...',
      save: 'Save',
      cancel: 'Cancel',
      command: 'Command',
      args: 'Arguments',
      url: 'URL',
      env: 'Environment',
      headers: 'Headers',
      allowed: 'Allowed tools',
      denied: 'Denied tools',
      timeout: 'Timeout seconds',
      transport: 'Transport',
      permission: 'Permission',
      confirmation: 'Confirm risky calls',
      remove: 'Remove',
      search: 'Search',
      database: 'Database',
      custom: 'Custom',
      readOnly: 'Read-only',
      readWrite: 'Read-write',
      dangerous: 'Dangerous',
      discovered: 'Discovered tools',
      errors: 'Errors',
      status: 'Status',
      refreshStatus: 'Refresh status',
      mcpGloballyDisabled: 'MCP is globally disabled — no servers were contacted. Enable MCP (and "Expose MCP tools") first.',
      disconnect: 'Disconnect all',
      connected: 'Connected',
      disconnected: 'Disconnected',
      enabledServers: 'Enabled servers',
      empty: 'Enable at least one server, then discover tools.',
      searchHint: 'No API key needed. Uses DuckDuckGo HTML scraping with rate limiting. Best for quick web searches.',
      dbHint: 'Read-only by default. Write operations are denylisted. Change permission to read-write to allow queries, inserts, and updates.',
      customHint: 'stdio: command + args. sse / streamable-http: URL + headers.',
      testServer: 'Test',
      testingServer: 'Testing...',
      disconnectServer: 'Disconnect',
      confirmationLabel: 'Confirm risky calls',
      confirmationHint: 'When enabled, a confirmation dialog will appear before executing tools on this server.',
      permissionHint: 'Read-only blocks tool names starting with create/insert/update/delete/drop/etc. Read-write and Dangerous behave the same. Use Allowed/Denied tools below for precise control.',
      dangerousNote: 'Dangerous and Read-write behave identically; this label is informational only.',
      forceMutating: 'Force mutating',
      forceReadonly: 'Force read-only',
      forceMutatingHint: 'Comma-separated patterns. These tools are always treated as mutating (blocked in read-only mode).',
      forceReadonlyHint: 'Comma-separated patterns. These tools are always treated as read-only (allowed even in read-only mode).',
    };
  }
  if (lang === 'zh-TW') {
    return {
      title: 'MCP Host',
      desc: '讓 Agent 透過 Rust rmcp Client/Host 呼叫外部 MCP 服務。',
      global: '全域',
      enabled: '啟用 MCP',
      expose: '向 Agent 暴露 MCP 工具',
      resultLimit: '結果上限 bytes',
      presets: '預設服務',
      servers: '服務',
      add: '新增自訂服務',
      test: '刷新工具',
      testing: '刷新中...',
      save: '保存',
      cancel: '取消',
      command: '命令',
      args: '參數',
      url: 'URL',
      env: '環境變數',
      headers: 'Headers',
      allowed: '允許工具',
      denied: '拒絕工具',
      timeout: '超時秒數',
      transport: '傳輸',
      permission: '權限',
      confirmation: '高風險呼叫確認',
      remove: '刪除',
      search: '搜尋',
      database: '資料庫',
      custom: '自訂',
      readOnly: '唯讀',
      readWrite: '讀寫',
      dangerous: '危險',
      discovered: '已發現工具',
      errors: '錯誤',
      status: '狀態',
      refreshStatus: '刷新狀態',
      mcpGloballyDisabled: 'MCP 已全域關閉，未連接任何伺服器。請先啟用 MCP（及「向 Agent 暴露 MCP 工具」）。',
      disconnect: '斷開全部',
      connected: '已連接',
      disconnected: '未連接',
      enabledServers: '已啟用服務',
      empty: '先啟用至少一個服務，然後發現工具。',
      searchHint: '無需 API Key。使用 DuckDuckGo HTML 抓取，有請求頻率限制。適合快速網頁搜尋。',
      dbHint: '預設唯讀。寫入操作已列入拒絕列表。如需查詢、插入和更新，請將權限改為讀寫。',
      customHint: 'stdio：命令 + 參數。sse / streamable-http：URL + headers。',
      testServer: '測試',
      testingServer: '測試中...',
      disconnectServer: '斷開',
      confirmationLabel: '高風險呼叫確認',
      confirmationHint: '啟用後，執行此服務的工具前將彈出確認對話框。',
      permissionHint: '唯讀模式僅攔截以 create/insert/update/delete/drop 等前綴開頭的工具名。讀寫與危險模式行為完全一致。如需精確控制，請使用下方允許/拒絕工具列表。',
      dangerousNote: '危險與讀寫模式行為完全一致，此標籤僅為提示作用。',
      forceMutating: '強制視為寫入',
      forceReadonly: '強制視為唯讀',
      forceMutatingHint: '逗號分隔，支持 * 通配。這些工具始終被視為寫入操作（唯讀模式下被攔截）。',
      forceReadonlyHint: '逗號分隔，支持 * 通配。這些工具始終被視為唯讀操作（唯讀模式下允許執行）。',
    };
  }
  return {
    title: 'MCP Host',
    desc: '让 Agent 通过 Rust rmcp Client/Host 调用外部 MCP 服务。',
    global: '全局',
    enabled: '启用 MCP',
    expose: '向 Agent 暴露 MCP 工具',
    resultLimit: '结果上限 bytes',
    presets: '预设服务',
    servers: '服务',
    add: '新增自定义服务',
    test: '刷新工具',
    testing: '刷新中...',
    save: '保存',
    cancel: '取消',
    command: '命令',
    args: '参数',
    url: 'URL',
    env: '环境变量',
    headers: 'Headers',
    allowed: '允许工具',
    denied: '拒绝工具',
    timeout: '超时秒数',
    transport: '传输',
    permission: '权限',
confirmation: '高风险调用确认',
      remove: '删除',
      search: '搜索',
      database: '数据库',
      custom: '自定义',
      readOnly: '只读',
      readWrite: '读写',
      dangerous: '危险',
      discovered: '已发现工具',
      errors: '错误',
      status: '状态',
      refreshStatus: '刷新状态',
      mcpGloballyDisabled: 'MCP 已全局关闭，未连接任何服务器。请先启用 MCP（及「向 Agent 暴露 MCP 工具」）。',
      disconnect: '断开全部',
      connected: '已连接',
      disconnected: '未连接',
      enabledServers: '已启用服务',
      empty: '先启用至少一个服务，然后发现工具。',
      searchHint: '无需 API Key。使用 DuckDuckGo HTML 抓取，有请求频率限制。适合快速网页搜索。',
      dbHint: '默认只读。写入操作已列入拒绝列表。如需查询、插入和更新，请将权限改为读写。',
      customHint: 'stdio：命令 + 参数。sse / streamable-http：URL + headers。',
      testServer: '测试',
      testingServer: '测试中...',
      disconnectServer: '断开',
      confirmationLabel: '高风险调用确认',
      confirmationHint: '启用后，执行此服务的工具前将弹出确认对话框。',
      permissionHint: '只读模式仅拦截以 create/insert/update/delete/drop 等前缀开头的工具名。读写与危险模式行为完全一致。如需精确控制，请使用下方允许/拒绝工具列表。',
      dangerousNote: '危险与读写模式行为完全一致，此标签仅作提示之用。',
      forceMutating: '强制视为写入',
      forceReadonly: '强制视为只读',
      forceMutatingHint: '逗号分隔，支持 * 通配。这些工具始终被视为写入操作（只读模式下被拦截）。',
      forceReadonlyHint: '逗号分隔，支持 * 通配。这些工具始终被视为只读操作（只读模式下允许执行）。',
  };
}

function getServerHint(server: McpServerConfig, c: ReturnType<typeof copy>): string {
  if (server.description) return server.description;
  if (server.category === 'search') return c.searchHint;
  if (server.category === 'database') return c.dbHint;
  return c.customHint;
}

function panelClass(active: boolean): string {
  return `rounded-2xl border px-4 py-4 transition-colors ${
    active ? 'border-info-bg bg-info-bg' : 'border-line bg-base'
  }`;
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.15em] text-fg-muted">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[10px] leading-relaxed text-fg-dim">{hint}</p>}
    </div>
  );
}

function updateServer(servers: McpServerConfig[], id: string, patch: Partial<McpServerConfig>): McpServerConfig[] {
  return servers.map((server) => (server.id === id ? { ...server, ...patch } : server));
}

export function McpSettingsModal({ onClose, onOpenMarket }: { onClose: () => void; onOpenMarket?: () => void }) {
  const { settings, setSettings } = useAgentStore();
  const c = copy(settings.lang);
  const [local, setLocal] = useState<McpSettings>(() => normalizeMcpSettings(settings.mcp));
  const [activeId, setActiveId] = useState(local.servers[0]?.id ?? '');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [tools, setTools] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [serverStatus, setServerStatus] = useState<McpServerStatus[]>([]);
  const [busyServerId, setBusyServerId] = useState<string | null>(null);

  useEffect(() => {
    const next = normalizeMcpSettings(settings.mcp);
    setLocal(next);
    setActiveId((current) => current || next.servers[0]?.id || '');
  }, [settings.mcp]);

  const activeServer = useMemo(
    () => local.servers.find((server) => server.id === activeId) ?? local.servers[0],
    [activeId, local.servers],
  );
  const enabledCount = local.servers.filter((server) => server.enabled).length;
  const connectedCount = serverStatus.filter((server) => server.connected).length;
  const activeStatus = activeServer
    ? serverStatus.find((server) => server.serverId === activeServer.id)
    : undefined;

  const update = (patch: Partial<McpSettings>) => {
    setLocal((current) => normalizeMcpSettings({ ...current, ...patch }));
  };

  const patchServer = (id: string, patch: Partial<McpServerConfig>) => {
    setLocal((current) => normalizeMcpSettings({ ...current, servers: updateServer(current.servers, id, patch) }));
    if (patch.enabled === false) {
      void disconnectMcpServer(local, id).then(() => refreshStatus()).catch((err) => appendError(errorMessage(err)));
    }
  };

  const addServer = () => {
    const server = createBlankMcpServer();
    setLocal((current) => normalizeMcpSettings({ ...current, servers: [...current.servers, server] }));
    setActiveId(server.id);
  };

  const removeServer = (id: string) => {
    void disconnectMcpServer(local, id).catch(() => undefined);
    const nextServers = local.servers.filter((server) => server.id !== id);
    setLocal((current) => normalizeMcpSettings({ ...current, servers: nextServers }));
    setActiveId(nextServers[0]?.id ?? '');
  };

  // #18：错误去重追加——旧实现重复失败时同一错误无限堆叠，
  // 错误面板被重复条目塞满。
  const appendError = (message: string) => {
    setErrors((current) => (current.includes(message) ? current : [...current, message]));
  };

  const refreshStatus = async () => {
    try {
      setServerStatus(await listMcpServerStatus(local));
    } catch (err) {
      appendError(errorMessage(err));
    }
  };

  const disconnectAll = async () => {
    try {
      const closed = await disconnectAllMcpServers();
      setMessage(`Disconnected ${closed} MCP servers`);
      await refreshStatus();
    } catch (err) {
      appendError(errorMessage(err));
    }
  };

  const handleTestServer = async (serverId: string) => {
    setBusyServerId(serverId);
    setStatus('loading');
    setMessage('');
    try {
      const result = await testMcpServer(local, serverId);
      if (result.success) {
        setStatus('success');
        setMessage(`✓ ${result.serverName}: ${result.message}`);
      } else {
        setStatus('error');
        setMessage(`✗ ${result.serverName}: ${result.message}`);
      }
      await refreshStatus();
    } catch (err) {
      setStatus('error');
      setMessage(errorMessage(err));
    } finally {
      setBusyServerId(null);
    }
  };

  const handleDisconnectServer = async (serverId: string) => {
    setBusyServerId(serverId);
    try {
      const closed = await disconnectMcpServer(local, serverId);
      setMessage(closed > 0 ? `Disconnected '${serverId}'` : `'${serverId}' was not connected`);
      await refreshStatus();
    } catch (err) {
      appendError(errorMessage(err));
    } finally {
      setBusyServerId(null);
    }
  };

  const discoverTools = async (serverIdFilter?: string) => {
    // #17：MCP 全局关闭时不得显示误导性的 "0 tools · cache refreshed"——
    // 旧实现 listMcpTools 在禁用时直接返回空结果，用户误以为服务器没有工具
    // （实际根本没去连接）。
    if (!local.enabled || !local.exposeTools) {
      setStatus('idle');
      setTools([]);
      setErrors([]);
      setMessage(c.mcpGloballyDisabled);
      return;
    }
    setStatus('loading');
    setMessage('');
    setErrors([]);
    try {
      await clearMcpToolDefinitionCache();
      const result = await loadMcpToolDefinitions(local, { refresh: true });
      const allTexts = result.definitions.map((definition) => `${definition.name} — ${definition.description}`);
      if (serverIdFilter) {
        const allowed = new Set((result.toolMappings ?? [])
          .filter((m) => m.serverId === serverIdFilter)
          .map((m) => m.displayName));
        setTools(allTexts.filter((text) => allowed.has(text.split(' — ')[0])));
      } else {
        setTools(allTexts);
      }
      setErrors(result.errors.map((error) => `${error.serverId}: ${error.message}`));
      setStatus('success');
      setMessage(`${result.definitions.length} tools · cache refreshed`);
      await refreshStatus();
    } catch (err) {
      setStatus('error');
      setMessage(errorMessage(err));
    }
  };

  useEffect(() => {
    void refreshStatus();
  }, []);

  const save = () => {
    setSettings({ mcp: local });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex select-none items-center justify-center bg-overlay p-4 backdrop-blur-sm animate-fade-in">
      <div className="flex h-[92vh] w-[min(96vw,1280px)] flex-col overflow-hidden rounded-3xl border border-line bg-raised shadow-2xl">
        <div className="flex items-start justify-between border-b border-line px-7 py-5">
          <div>
            <div className="flex items-center gap-2">
              <span className="rounded-lg border border-info-bg bg-info-bg px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-info">rmcp</span>
              <h2 className="text-lg font-semibold text-fg">{c.title}</h2>
            </div>
            <p className="mt-1 text-sm text-fg-muted">{c.desc}</p>
          </div>
          <button onClick={onClose} title={c.cancel} className="text-2xl leading-none text-fg-muted hover:text-fg-soft">×</button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[340px_minmax(0,1fr)] overflow-hidden">
          <aside className="min-h-0 overflow-y-auto border-r border-line bg-base p-4">
            <div className={panelClass(local.enabled)}>
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">{c.global}</h3>
              <label className="mb-3 flex cursor-pointer items-start gap-3">
                <input type="checkbox" checked={local.enabled} onChange={(event) => update({ enabled: event.target.checked })} className="mt-0.5 h-5 w-5 rounded accent-info" />
                <span className="text-sm font-medium text-fg">{c.enabled}</span>
              </label>
              <label className="mb-4 flex cursor-pointer items-start gap-3">
                <input type="checkbox" checked={local.exposeTools} onChange={(event) => update({ exposeTools: event.target.checked })} className="mt-0.5 h-5 w-5 rounded accent-info" />
                <span className="text-sm font-medium text-fg">{c.expose}</span>
              </label>
              <Field label={c.resultLimit}>
                <input
                  type="number"
                  value={local.resultMaxBytes}
                  onChange={(event) => update({ resultMaxBytes: Number(event.target.value) })}
                  className="w-full rounded-xl border border-line bg-base px-3 py-2 text-sm text-fg focus:border-info focus:outline-none"
                />
              </Field>
              <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-xl border border-line bg-base px-3 py-2">
                  <div className="text-fg-muted">{c.enabledServers}</div>
                  <div className="mt-1 font-semibold text-fg">{enabledCount}</div>
                </div>
                <div className="rounded-xl border border-line bg-base px-3 py-2">
                  <div className="text-fg-muted">{c.connected}</div>
                  <div className="mt-1 font-semibold text-info">{connectedCount}</div>
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <button onClick={refreshStatus} className="flex-1 rounded-lg border border-line px-2.5 py-1.5 text-[10px] font-medium text-fg-soft hover:border-info-bg hover:text-info">{c.refreshStatus}</button>
                <button onClick={disconnectAll} className="flex-1 rounded-lg border border-danger-bg px-2.5 py-1.5 text-[10px] font-medium text-danger hover:bg-danger-bg">{c.disconnect}</button>
              </div>
            </div>

            <div className="mt-4 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">{c.servers}</h3>
              <div className="flex items-center gap-2">
                {onOpenMarket && (
                  <button onClick={onOpenMarket} className="rounded-lg border border-purple-500/30 px-2.5 py-1.5 text-[10px] font-medium text-purple-200 hover:bg-purple-500/10">Browse Market</button>
                )}
                <button onClick={addServer} className="rounded-lg border border-info-bg px-2.5 py-1.5 text-[10px] font-medium text-info hover:bg-info-bg">{c.add}</button>
              </div>
            </div>

            <div className="mt-3 space-y-2">
              {local.servers.map((server) => (
                <button
                  key={server.id}
                  type="button"
                  onClick={() => setActiveId(server.id)}
                  className={`w-full rounded-xl border px-3 py-3 text-left transition-colors ${
                    activeServer?.id === server.id
                      ? 'border-info-bg bg-info-bg text-fg'
                      : 'border-line bg-base text-fg-muted hover:border-line-strong hover:text-fg'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-semibold">{server.name}</span>
                    <span className={`h-2.5 w-2.5 rounded-full ${server.enabled ? 'bg-ok' : 'bg-slate-600'}`} />
                  </div>
                  <div className="mt-1 text-[10px] uppercase tracking-[0.14em] text-fg-dim">{server.category} · {server.transport}</div>
                </button>
              ))}
            </div>
          </aside>

          <main className="min-h-0 overflow-y-auto p-6">
            {activeServer ? (
              <div className="space-y-5">
                <div className="rounded-2xl border border-line bg-base px-5 py-5">
                  <div className="mb-5 flex items-start justify-between gap-4">
                    <label className="flex cursor-pointer items-start gap-3">
                      <input type="checkbox" checked={activeServer.enabled} onChange={(event) => patchServer(activeServer.id, { enabled: event.target.checked })} className="mt-0.5 h-5 w-5 rounded accent-info" />
                      <div>
                        <div className="flex items-center gap-2">
                          <div className="text-sm font-semibold text-fg">{activeServer.name}</div>
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${activeStatus?.connected ? 'bg-ok-bg text-ok' : 'bg-slate-700/50 text-fg-muted'}`}>
                            {activeStatus?.connected ? c.connected : c.disconnected}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-fg-muted">{getServerHint(activeServer, c)}</p>
                      </div>
                    </label>
                    <button onClick={() => removeServer(activeServer.id)} className="rounded-lg border border-danger-bg px-3 py-2 text-xs text-danger hover:bg-danger-bg">{c.remove}</button>
                  </div>

                  <div className="mb-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => handleTestServer(activeServer.id)}
                      disabled={!activeServer.enabled || busyServerId === activeServer.id}
                      className="rounded-lg border border-info-bg bg-info-bg px-3 py-1.5 text-xs font-medium text-info transition-colors hover:bg-info-bg disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {busyServerId === activeServer.id ? c.testingServer : c.testServer}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDisconnectServer(activeServer.id)}
                      disabled={!activeStatus?.connected || busyServerId === activeServer.id}
                      className="rounded-lg border border-warn-bg bg-warn-bg px-3 py-1.5 text-xs font-medium text-warn transition-colors hover:bg-warn-bg disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {c.disconnectServer}
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <Field label="ID">
                      <input value={activeServer.id} disabled className="w-full rounded-xl border border-line bg-base px-3 py-2 text-sm text-fg-muted" />
                    </Field>
                    <Field label="Name">
                      <input value={activeServer.name} onChange={(event) => patchServer(activeServer.id, { name: event.target.value })} className="w-full rounded-xl border border-line bg-base px-3 py-2 text-sm text-fg focus:border-info focus:outline-none" />
                    </Field>
                    <Field label={c.transport}>
                      <select value={activeServer.transport} onChange={(event) => patchServer(activeServer.id, { transport: event.target.value as McpServerConfig['transport'] })} className="w-full rounded-xl border border-line bg-base px-3 py-2 text-sm text-fg focus:border-info focus:outline-none">
                        <option value="stdio">stdio</option>
                        <option value="sse">sse</option>
                        <option value="streamable-http">streamable-http</option>
                      </select>
                    </Field>
                    <Field label="Category">
                      <select value={activeServer.category} onChange={(event) => patchServer(activeServer.id, { category: event.target.value as McpServerConfig['category'] })} className="w-full rounded-xl border border-line bg-base px-3 py-2 text-sm text-fg focus:border-info focus:outline-none">
                        <option value="search">{c.search}</option>
                        <option value="database">{c.database}</option>
                        <option value="custom">{c.custom}</option>
                      </select>
                    </Field>
                  </div>
                </div>

                <div className="rounded-2xl border border-line bg-base px-5 py-5">
                  {activeServer.transport === 'stdio' ? (
                    <>
                      <div className="grid grid-cols-2 gap-4">
                        <Field label={c.command}>
                          <input value={activeServer.command} onChange={(event) => patchServer(activeServer.id, { command: event.target.value })} placeholder="npx / uvx / python" className="w-full rounded-xl border border-line bg-base px-3 py-2 text-sm text-fg focus:border-info focus:outline-none" />
                        </Field>
                        <Field label={c.timeout}>
                          <input type="number" value={activeServer.timeoutSeconds} onChange={(event) => patchServer(activeServer.id, { timeoutSeconds: Number(event.target.value) })} className="w-full rounded-xl border border-line bg-base px-3 py-2 text-sm text-fg focus:border-info focus:outline-none" />
                        </Field>
                      </div>
                      <div className="mt-4">
                        <Field label={c.args}>
                          <input value={activeServer.args} onChange={(event) => patchServer(activeServer.id, { args: event.target.value })} className="w-full rounded-xl border border-line bg-base px-3 py-2 text-sm text-fg focus:border-info focus:outline-none" />
                        </Field>
                      </div>
                      <div className="mt-4">
                        <Field label={c.env} hint="KEY=value，每行一个。不会进入模型上下文。">
                          <textarea value={activeServer.env} onChange={(event) => patchServer(activeServer.id, { env: event.target.value })} rows={4} className="w-full resize-none rounded-xl border border-line bg-base px-3 py-2 font-mono text-xs text-fg focus:border-info focus:outline-none" />
                        </Field>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 gap-4">
                        <Field label={c.url} hint={activeServer.transport === 'sse' ? 'SSE endpoint URL' : 'Streamable HTTP endpoint URL'}>
                          <input value={activeServer.url} onChange={(event) => patchServer(activeServer.id, { url: event.target.value })} placeholder="https://example.com/mcp" className="w-full rounded-xl border border-line bg-base px-3 py-2 text-sm text-fg focus:border-info focus:outline-none" />
                        </Field>
                        <Field label={c.timeout}>
                          <input type="number" value={activeServer.timeoutSeconds} onChange={(event) => patchServer(activeServer.id, { timeoutSeconds: Number(event.target.value) })} className="w-full rounded-xl border border-line bg-base px-3 py-2 text-sm text-fg focus:border-info focus:outline-none" />
                        </Field>
                      </div>
                      <div className="mt-4">
                        <Field label={c.headers} hint="Header-Name: value，每行一个。用于 HTTP/SSE 认证。">
                          <textarea value={activeServer.headers} onChange={(event) => patchServer(activeServer.id, { headers: event.target.value })} rows={4} placeholder={'Authorization: Bearer token\nX-API-Key: key'} className="w-full resize-none rounded-xl border border-line bg-base px-3 py-2 font-mono text-xs text-fg focus:border-info focus:outline-none" />
                        </Field>
                      </div>
                    </>
                  )}
                </div>

                <div className="rounded-2xl border border-line bg-base px-5 py-5">
                  <div className="grid grid-cols-2 gap-4">
                    <Field label={c.allowed} hint="逗号分隔，支持 * 通配；留空表示全部允许。">
                      <input value={activeServer.allowedTools} onChange={(event) => patchServer(activeServer.id, { allowedTools: event.target.value })} placeholder="query,search*,list*" className="w-full rounded-xl border border-line bg-base px-3 py-2 text-sm text-fg focus:border-info focus:outline-none" />
                    </Field>
                    <Field label={c.denied} hint="逗号分隔，拒绝规则优先。">
                      <input value={activeServer.deniedTools} onChange={(event) => patchServer(activeServer.id, { deniedTools: event.target.value })} placeholder="delete*,drop*,truncate*" className="w-full rounded-xl border border-line bg-base px-3 py-2 text-sm text-fg focus:border-info focus:outline-none" />
                    </Field>
                    <Field label={c.forceMutating} hint={c.forceMutatingHint}>
                      <input value={activeServer.forceMutating} onChange={(event) => patchServer(activeServer.id, { forceMutating: event.target.value })} placeholder="do_delete,execute*" className="w-full rounded-xl border border-line bg-base px-3 py-2 text-sm text-fg focus:border-info focus:outline-none" />
                    </Field>
                    <Field label={c.forceReadonly} hint={c.forceReadonlyHint}>
                      <input value={activeServer.forceReadonly} onChange={(event) => patchServer(activeServer.id, { forceReadonly: event.target.value })} placeholder="create_report*,run_query" className="w-full rounded-xl border border-line bg-base px-3 py-2 text-sm text-fg focus:border-info focus:outline-none" />
                    </Field>
                    <Field label={c.permission} hint={c.permissionHint}>
                      <select value={activeServer.permissionMode} onChange={(event) => patchServer(activeServer.id, { permissionMode: event.target.value as McpServerConfig['permissionMode'] })} className="w-full rounded-xl border border-line bg-base px-3 py-2 text-sm text-fg focus:border-info focus:outline-none">
                        <option value="read-only">{c.readOnly}</option>
                        <option value="read-write">{c.readWrite}</option>
                        <option value="dangerous">{c.dangerous}</option>
                      </select>
                      {activeServer.permissionMode === 'dangerous' && (
                        <p className="mt-1 text-[10px] leading-relaxed text-warn">{c.dangerousNote}</p>
                      )}
                    </Field>
                    <label
                      className="mt-6 flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-base px-3 py-2"
                    >
                      <input
                        type="checkbox"
                        checked={activeServer.requireConfirmation}
                        onChange={(event) => patchServer(activeServer.id, { requireConfirmation: event.target.checked })}
                        className="mt-0.5 h-5 w-5 rounded accent-info"
                      />
                      <div>
                        <span className="text-sm text-fg">{c.confirmationLabel}</span>
                        <p className="mt-0.5 text-[10px] leading-relaxed text-fg-dim">{c.confirmationHint}</p>
                      </div>
                    </label>
                  </div>
                </div>

                <div className="rounded-2xl border border-line bg-base px-5 py-5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-fg">{c.discovered}</h3>
                      <p className="mt-1 text-xs text-fg-muted">{message || c.empty}</p>
                    </div>
                    <button onClick={() => discoverTools(activeServer?.id)} disabled={status === 'loading'} className="rounded-xl border border-info-bg bg-info-bg px-4 py-2 text-xs font-semibold text-info transition-colors hover:bg-info-bg disabled:cursor-not-allowed disabled:opacity-60">
                      {status === 'loading' ? c.testing : c.test}
                    </button>
                  </div>
                  {(tools.length > 0 || errors.length > 0) && (
                    <div className="mt-4 grid grid-cols-2 gap-4">
                      <div className="max-h-52 overflow-y-auto rounded-xl border border-line bg-base p-3">
                        {tools.map((tool) => <div key={tool} className="mb-2 break-all text-xs leading-relaxed text-fg-soft">{tool}</div>)}
                      </div>
                      <div className="max-h-52 overflow-y-auto rounded-xl border border-line bg-base p-3">
                        <div className="mb-2 text-xs font-semibold text-fg-muted">{c.errors}</div>
                        {errors.length === 0 ? <div className="text-xs text-ok">OK</div> : errors.map((error) => <div key={error} className="mb-2 break-all text-xs leading-relaxed text-danger">{error}</div>)}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </main>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-line px-7 py-4">
          <button onClick={onClose} className="rounded-xl border border-line px-4 py-2 text-sm text-fg-muted hover:text-fg">{c.cancel}</button>
          <button onClick={save} className="rounded-xl border border-info-bg bg-info-bg px-4 py-2 text-sm font-semibold text-info hover:bg-info-bg">{c.save}</button>
        </div>
      </div>
    </div>
  );
}
