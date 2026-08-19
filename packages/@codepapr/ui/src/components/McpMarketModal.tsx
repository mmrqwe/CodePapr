import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useAgentStore } from '../store/agentStore';
import {
  fetchMarketServers,
  filterListings,
  formatTransportHeaders,
  type FetchMarketOptions,
} from '../tools/mcpMarketApi';
import {
  type MarketMCPListing,
  type RegistryEnvVar,
} from '../utils/mcpMarketTypes';
import {
  normalizeMcpServer,
  sanitizeMcpToolPart,
  type McpServerConfig,
} from '../utils/mcpTypes';
import { previewMcpServer, disconnectMcpServer, type McpPreviewResult } from '../tools/mcpTools';
import type { Lang } from '../utils/i18n';

function copy(lang: Lang | undefined) {
  if (lang === 'en') {
    return {
      title: 'MCP Market',
      search: 'Search servers...',
      transport: 'Transport',
      runtime: 'Runtime',
      category: 'Category',
      all: 'All',
      install: 'Install',
      installing: 'Installing...',
      installed: 'Installed',
      loadMore: 'Load More',
      loading: 'Loading servers...',
      empty: 'No servers found.',
      error: 'Failed to load servers.',
      retry: 'Retry',
      close: 'Close',
      detail: 'Details',
      envVars: 'Environment Variables',
      required: 'Required',
      optional: 'Optional',
      secret: 'Secret',
      packages: 'Packages',
      repository: 'Repository',
      website: 'Website',
      back: 'Back to results',
      byCount: 'uses',
      verifiedBadge: 'Verified',
      installedBadge: 'Installed',
      addToMyServers: 'Add to My Servers',
      added: 'Server added to MCP settings',
      serverAdded: 'added to your MCP servers. Configure it in MCP Settings.',
      howToUse: 'How to use',
      guideRemoteReady1: 'Click "Add to My Servers" below — the server is auto-enabled.',
      guideRemoteReady2: 'Send any message in chat — tools load automatically.',
      guideRemoteReady3: 'The agent will offer to call MCP tools when relevant.',
      guideRemoteAuth1: 'Click "Add to My Servers" below.',
      guideRemoteAuth2: 'Open MCP Settings → select this server.',
      guideRemoteAuth3: 'Fill in required environment variables (marked Required).',
      guideRemoteAuth4: 'Enable the server checkbox → click Save.',
      guideRemoteAuth5: 'Send any message in chat — tools load automatically.',
      guideStdio1: 'Click "Add to My Servers" below.',
      guideStdio2: 'Open MCP Settings → select this server.',
      guideStdio3: 'Ensure the command is correct (for example npx -y @package/name).',
      guideStdio4: 'Fill in required environment variables if any.',
      guideStdio5: 'Enable the server checkbox → click Save.',
      guideStdio6: 'Send any message in chat — tools load automatically.',
      previewChecking: 'Checking availability...',
      previewAvailable: 'Available — {count} tools',
      previewAuthRequired: 'Requires authentication — not usable without credentials',
      previewFailed: 'Connection failed',
      authInstallWarning: 'This server requires authentication. Installing it will fail at tool discovery unless you provide credentials in MCP Settings.',
      manualConfigFallback: 'This server requires manual configuration after adding.',
      installEnabledToast: '✓ {name} installed and enabled. Send a message to use its tools.',
      installDisabledToast: '✓ {name} installed. Open MCP Settings → enable the server → send a message.',
      alreadyInstalledToast: 'Already installed — a server matching "{name}" already exists.',
      uninstall: 'Remove',
      uninstalling: 'Removing...',
      uninstalledToast: 'Removed {name}',
      remote: 'Remote',
      remoteLabel: 'remote',
      categorySearch: 'Search',
      categoryDatabase: 'Database',
      categoryCustom: 'Custom',
      defaultLabel: 'Default',
    };
  }
  if (lang === 'zh-TW') {
    return {
      title: 'MCP 市場',
      search: '搜尋服務...',
      transport: '傳輸',
      runtime: '執行環境',
      category: '分類',
      all: '全部',
      install: '安裝',
      installing: '安裝中...',
      installed: '已安裝',
      loadMore: '載入更多',
      loading: '載入中...',
      empty: '沒有找到服務。',
      error: '載入失敗。',
      retry: '重試',
      close: '關閉',
      detail: '詳情',
      envVars: '環境變數',
      required: '必須',
      optional: '可選',
      secret: '密鑰',
      packages: '套件',
      repository: '倉庫',
      website: '網站',
      back: '返回結果',
      byCount: '次使用',
      verifiedBadge: '已驗證',
      installedBadge: '已安裝',
      addToMyServers: '加入我的服務',
      added: '已加入 MCP 設定',
      serverAdded: '已加入你的 MCP 服務。在 MCP 設定中進行配置。',
      howToUse: '使用方式',
      guideRemoteReady1: '點擊下方「加入我的服務」——伺服器會自動啟用。',
      guideRemoteReady2: '在對話中發送任意訊息——工具會自動載入。',
      guideRemoteReady3: '相關時 Agent 會提議呼叫 MCP 工具。',
      guideRemoteAuth1: '點擊下方「加入我的服務」。',
      guideRemoteAuth2: '開啟 MCP 設定 → 選取此服務。',
      guideRemoteAuth3: '填寫必填環境變數（標示為必須）。',
      guideRemoteAuth4: '勾選啟用 → 點擊保存。',
      guideRemoteAuth5: '在對話中發送任意訊息——工具會自動載入。',
      guideStdio1: '點擊下方「加入我的服務」。',
      guideStdio2: '開啟 MCP 設定 → 選取此服務。',
      guideStdio3: '確認命令正確（例如 npx -y @package/name）。',
      guideStdio4: '如有必填環境變數請填寫。',
      guideStdio5: '勾選啟用 → 點擊保存。',
      guideStdio6: '在對話中發送任意訊息——工具會自動載入。',
      previewChecking: '正在檢查可用性...',
      previewAvailable: '可用 — {count} 個工具',
      previewAuthRequired: '需要驗證——沒有憑證無法使用',
      previewFailed: '連線失敗',
      authInstallWarning: '此服務需要驗證。除非你在 MCP 設定中提供憑證，否則安裝後工具發現會失敗。',
      manualConfigFallback: '此服務加入後需要手動配置。',
      installEnabledToast: '{name} 已安裝並啟用。發送訊息即可使用其工具。',
      installDisabledToast: '{name} 已安裝。請開啟 MCP 設定 → 啟用服務 → 再發送訊息。',
      alreadyInstalledToast: '已安裝——列表中已存在同名服務「{name}」。',
      uninstall: '移除',
      uninstalling: '移除中...',
      uninstalledToast: '已移除 {name}',
      remote: '遠端',
      categorySearch: '搜尋',
      categoryDatabase: '資料庫',
      categoryCustom: '自訂',
      remoteLabel: '遠端',
      defaultLabel: '預設',
    };
  }
  return {
    title: 'MCP 市场',
    search: '搜索服务...',
    transport: '传输',
    runtime: '运行环境',
    category: '分类',
    all: '全部',
    install: '安装',
    installing: '安装中...',
    installed: '已安装',
    loadMore: '加载更多',
    loading: '加载中...',
    empty: '没有找到服务。',
    error: '加载失败。',
    retry: '重试',
    close: '关闭',
    detail: '详情',
    envVars: '环境变量',
    required: '必须',
    optional: '可选',
    secret: '密钥',
    packages: '包',
    repository: '仓库',
    website: '网站',
    back: '返回结果',
    byCount: '次使用',
    verifiedBadge: '已验证',
    installedBadge: '已安装',
    addToMyServers: '加入我的服务',
    added: '已加入 MCP 设置',
    serverAdded: '已加入你的 MCP 服务。在 MCP 设置中进行配置。',
    howToUse: '使用方式',
    guideRemoteReady1: '点击下方「加入我的服务」——服务器会自动启用。',
    guideRemoteReady2: '在对话中发送任意消息——工具会自动加载。',
    guideRemoteReady3: '相关时 Agent 会提议调用 MCP 工具。',
    guideRemoteAuth1: '点击下方「加入我的服务」。',
    guideRemoteAuth2: '打开 MCP 设置 → 选择此服务。',
    guideRemoteAuth3: '填写必填环境变量（标示为必须）。',
    guideRemoteAuth4: '勾选启用 → 点击保存。',
    guideRemoteAuth5: '在对话中发送任意消息——工具会自动加载。',
    guideStdio1: '点击下方「加入我的服务」。',
    guideStdio2: '打开 MCP 设置 → 选择此服务。',
    guideStdio3: '确认命令正确（例如 npx -y @package/name）。',
    guideStdio4: '如有必填环境变量请填写。',
    guideStdio5: '勾选启用 → 点击保存。',
    guideStdio6: '在对话中发送任意消息——工具会自动加载。',
    previewChecking: '正在检查可用性...',
    previewAvailable: '可用 — {count} 个工具',
    previewAuthRequired: '需要验证——没有凭据无法使用',
    previewFailed: '连接失败',
    authInstallWarning: '此服务需要验证。除非你在 MCP 设置中提供凭据，否则安装后工具发现会失败。',
    manualConfigFallback: '此服务加入后需要手动配置。',
    installEnabledToast: '{name} 已安装并启用。发送消息即可使用其工具。',
    installDisabledToast: '{name} 已安装。请打开 MCP 设置 → 启用服务 → 再发送消息。',
    alreadyInstalledToast: '已安装——列表中已存在同名服务「{name}」。',
    uninstall: '移除',
    uninstalling: '移除中...',
    uninstalledToast: '已移除 {name}',
    remote: '远程',
    categorySearch: '搜索',
    categoryDatabase: '数据库',
    categoryCustom: '自定义',
    remoteLabel: '远程',
    defaultLabel: '默认',
  };
}

interface McpMarketModalProps {
  onClose: () => void;
}

function useInstalledServerIds(): Set<string> {
  const mcp = useAgentStore((s) => s.settings.mcp);
  return useMemo(() => {
    const ids = new Set<string>();
    for (const server of mcp.servers) {
      // N20：安装时 normalizeMcpServer 用 sanitizeMcpToolPart 消毒 id——
      // 判定"已安装"必须用同一消毒函数，否则含特殊字符的服务（@scope/name
      // 等）永远对不上号、始终显示未安装。
      ids.add(server.id);
      ids.add(sanitizeMcpToolPart(server.id).toLowerCase());
      if (server.name) {
        ids.add(sanitizeMcpToolPart(server.name).toLowerCase());
      }
    }
    return ids;
  }, [mcp.servers]);
}

/** 与 useInstalledServerIds 同口径的列表项判定。 */
export function isListingInstalled(installedIds: Set<string>, listing: MarketMCPListing): boolean {
  if (listing.id && installedIds.has(listing.id)) return true;
  if (listing.id && installedIds.has(sanitizeMcpToolPart(listing.id).toLowerCase())) return true;
  return installedIds.has(sanitizeMcpToolPart(listing.name).toLowerCase());
}

export function findInstalledServer(
  servers: McpServerConfig[],
  listing: MarketMCPListing,
): McpServerConfig | undefined {
  return servers.find((server) => {
    const ids = new Set<string>([
      server.id,
      sanitizeMcpToolPart(server.id).toLowerCase(),
    ]);
    if (server.name) ids.add(sanitizeMcpToolPart(server.name).toLowerCase());
    return isListingInstalled(ids, listing);
  });
}

export function listingToServerConfig(listing: MarketMCPListing): McpServerConfig {
  // N20：id 消毒统一交给 normalizeMcpServer（sanitizeMcpToolPart + lowercase），
  // 与已安装判定同源，杜绝特殊字符服务安装后仍显示"未安装"。
  const baseId = listing.id || listing.name;

  const envLines: string[] = [];
  for (const ev of listing.envVars) {
    if (ev.default !== undefined && ev.default !== '') {
      envLines.push(`${ev.name}=${ev.default}`);
    } else if (ev.isRequired) {
      envLines.push(`${ev.name}=YOUR_${ev.name.toUpperCase()}_HERE`);
    }
  }

  const desc = listing.needsManualConfig
    ? `${listing.description}\n\n⚠ ${listing.manualConfigNote}`
    : listing.description;

  const hasCommand = !!(listing.command && listing.command.trim());
  const hasUrl = !!(listing.url && listing.url.trim());
  const derivedTransport = listing.transport?.type === 'sse' || listing.transport?.type === 'streamable-http'
    ? listing.transport.type
    : 'stdio';

  // For manual-config servers with no command and no URL, use streamable-http as
  // placeholder to avoid "stdio command is required" on Test. User changes it in MCP Settings.
  const transport = listing.needsManualConfig && !hasCommand && !hasUrl
    ? 'streamable-http'
    : derivedTransport;

  const isRemote = transport === 'streamable-http' || transport === 'sse';
  const hasRequiredEnv = envLines.some((l) => l.includes('YOUR_') && l.includes('_HERE'));
  const needsAuth = listing.envVars.some((ev) => ev.isRequired && (ev.isSecret || /key|token|secret|password|auth/i.test(ev.name)));
  const isSearch = listing.categories.includes('search');

  return normalizeMcpServer({
    id: baseId,
    name: listing.title || listing.name.split('/').pop() || listing.name,
    description: desc,
    // 搜索类不自动 enable：hasEnabledMcpSearch 会关掉内置 websearch。
    enabled: isRemote && !hasRequiredEnv && !needsAuth && !isSearch,
    category: listing.categories[0] || 'custom',
    transport,
    command: listing.command || '',
    args: listing.args || '',
    url: listing.url || '',
    env: envLines.join('\n'),
    headers: formatTransportHeaders(listing.transport?.headers),
    // 空 = 发现全部工具；read-only 仍拦截变更。不要用 *，那会被当成显式放行写工具。
    allowedTools: '',
    deniedTools: '',
    permissionMode: 'read-only',
    timeoutSeconds: 60,
  });
}

function TransportIcon({ type }: { type: string }) {
  if (type === 'stdio') {
    return (
      <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </svg>
    );
  }
  if (type === 'sse' || type === 'streamable-http') {
    return (
      <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
    );
  }
  return null;
}

function ListingCard({
  listing,
  isInstalled,
  isInstalling,
  onInstall,
  onSelect,
  c,
}: {
  listing: MarketMCPListing;
  isInstalled: boolean;
  isInstalling: boolean;
  onInstall: (listing: MarketMCPListing) => void;
  onSelect: (listing: MarketMCPListing) => void;
  c: ReturnType<typeof copy>;
}) {
  const initial = (listing.title || listing.name).charAt(0).toUpperCase();
  const isRemote = listing.transport.type === 'streamable-http' || listing.transport.type === 'sse';
  const hostname = isRemote && listing.url ? (() => { try { return new URL(listing.url).hostname; } catch { return ''; } })() : '';
  const cardGlow = 'hover:border-info-bg';

  return (
    <button
      type="button"
      onClick={() => onSelect(listing)}
      className={`group relative flex flex-col gap-3 rounded-2xl border border-line bg-base p-4 text-left transition-all ${cardGlow} hover:bg-base`}
    >
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-raised text-sm font-bold text-fg-soft">
          {listing.iconUrl ? (
            <img src={listing.iconUrl} alt="" className="h-8 w-8 rounded-lg object-contain" />
          ) : (
            initial
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-fg">{listing.title}</h3>
          <p className="mt-0.5 truncate text-[11px] text-fg-muted">
            {hostname || listing.name}
          </p>
        </div>
        {listing.verified && (
          <svg className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-info" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
          </svg>
        )}
      </div>

      <p className="line-clamp-3 text-xs leading-relaxed text-fg-muted">{listing.description}</p>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${
          isRemote
            ? 'border-ok-bg bg-ok-bg text-ok'
            : 'border-line text-fg-muted'
        }`}>
          <TransportIcon type={listing.transport.type} />
          {isRemote ? c.remote : listing.transport.type}
        </span>
        {hostname && (
          <span className="inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[10px] text-fg-muted">
            {hostname}
          </span>
        )}
        {listing.categories.slice(0, 2).map((cat) => (
          <span key={cat} className="inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[10px] text-fg-muted">
            {cat}
          </span>
        ))}
      </div>

      <div className="mt-auto flex items-center justify-between border-t border-line pt-2.5">
        {listing.useCount > 0 && (
          <span className="text-[10px] text-fg-dim">{listing.useCount.toLocaleString()} {c.byCount}</span>
        )}
        {listing.useCount <= 0 && <span />}
        {isInstalled ? (
          <span className="rounded-lg bg-ok-bg px-3 py-1.5 text-[10px] font-semibold text-ok">{c.installedBadge}</span>
        ) : isInstalling ? (
          <span className="rounded-lg bg-slate-500/20 px-3 py-1.5 text-[10px] font-semibold text-fg-soft">
            <svg className="mr-1 inline h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <circle cx="12" cy="12" r="10" opacity="0.25" />
              <path d="M22 12a10 10 0 0 0-10-10" opacity="0.9" />
            </svg>
            {c.installing}
          </span>
        ) : (
          <span
            role="button"
            onClick={(e) => {
              e.stopPropagation();
              onInstall(listing);
            }}
            className="rounded-lg bg-info-bg px-3 py-1.5 text-[10px] font-semibold text-info transition-colors hover:bg-info-bg"
          >
            {c.install}
          </span>
        )}
      </div>
    </button>
  );
}

function ListingDetail({
  listing,
  isInstalled,
  isInstalling,
  isUninstalling,
  onInstall,
  onUninstall,
  onClose,
  onCloseModal,
  c,
}: {
  listing: MarketMCPListing;
  isInstalled: boolean;
  isInstalling: boolean;
  isUninstalling: boolean;
  onInstall: (listing: MarketMCPListing) => void;
  onUninstall: (listing: MarketMCPListing) => void;
  onClose: () => void;
  onCloseModal: () => void;
  c: ReturnType<typeof copy>;
}) {
  const isRemote = listing.transport.type === 'streamable-http' || listing.transport.type === 'sse';
  const hostname = isRemote && listing.url ? (() => { try { return new URL(listing.url).hostname; } catch { return ''; } })() : '';

  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewResult, setPreviewResult] = useState<McpPreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const handlePreview = useCallback(async () => {
    if (!listing.url || !listing.transport) return;
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewResult(null);
    try {
      const result = await previewMcpServer(listing.url, listing.transport.type, 30);
      setPreviewResult(result);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewLoading(false);
    }
  }, [listing.url, listing.transport]);

  useEffect(() => {
    if (isRemote && listing.url) {
      void handlePreview();
    }
  }, [listing.id, isRemote, listing.url, handlePreview]);

  const isAuthRequired = previewError && /auth required|unauthorized|401/i.test(previewError);
  const previewDone = !previewLoading && (previewResult || previewError);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-line px-6 py-4">
        <button
          type="button"
          onClick={onClose}
          className="flex items-center gap-2 text-xs text-fg-muted transition-colors hover:text-fg"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          {c.back}
        </button>
        <button onClick={onCloseModal} title={c.close} className="text-2xl leading-none text-fg-muted hover:text-fg-soft">×</button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="flex items-start gap-4">
          <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-2xl bg-raised text-xl font-bold text-fg-soft">
            {listing.iconUrl ? (
              <img src={listing.iconUrl} alt="" className="h-12 w-12 rounded-xl object-contain" />
            ) : (
              (listing.title || listing.name).charAt(0).toUpperCase()
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold text-fg">{listing.title}</h2>
            <p className="mt-0.5 text-xs text-fg-muted">{listing.name}</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="rounded-md border border-line px-2 py-0.5 text-[10px] text-fg-muted">
                v{listing.version}
              </span>
              <span className="rounded-md border border-line px-2 py-0.5 text-[10px] text-fg-muted">
                {listing.registryType}
              </span>
              <span className="rounded-md border border-line px-2 py-0.5 text-[10px] text-fg-muted">
                {listing.runtimeHint}
              </span>
            </div>
          </div>
        </div>

        <p className="mt-5 text-sm leading-relaxed text-fg-soft">{listing.description}</p>

        {isRemote && (
          <div className="mt-4">
            {/* Status badge */}
            {previewLoading && (
              <div className="inline-flex items-center gap-2 rounded-lg border border-slate-600 bg-slate-800/50 px-3 py-1.5 text-[11px] text-fg-soft">
                <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <circle cx="12" cy="12" r="10" opacity="0.25" />
                  <path d="M22 12a10 10 0 0 0-10-10" opacity="0.9" />
                </svg>
                {c.previewChecking}
              </div>
            )}
            {previewDone && previewResult && (
              <div className="inline-flex items-center gap-2 rounded-lg border border-ok-bg bg-ok-bg px-3 py-1.5 text-[11px] font-medium text-ok">
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                </svg>
                {c.previewAvailable.replace('{count}', String(previewResult.toolCount))}
              </div>
            )}
            {previewDone && isAuthRequired && (
              <div className="inline-flex items-center gap-2 rounded-lg border border-danger-bg bg-danger-bg px-3 py-1.5 text-[11px] font-medium text-danger">
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="11" width="18" height="11" rx="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                {c.previewAuthRequired}
              </div>
            )}
            {previewDone && previewError && !isAuthRequired && (
              <div className="inline-flex items-center gap-2 rounded-lg border border-warn-bg bg-warn-bg px-3 py-1.5 text-[11px] font-medium text-warn">
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 8v4M12 16h.01" />
                </svg>
                {c.previewFailed}
              </div>
            )}

            {/* Retry button for failed previews */}
            {previewDone && previewError && (
              <button
                type="button"
                onClick={handlePreview}
                className="ml-2 text-[10px] text-fg-muted underline transition-colors hover:text-fg-soft"
              >
                {c.retry}
              </button>
            )}

            {/* Tool list */}
            {previewResult && previewResult.tools.length > 0 && (
              <div className="mt-3 rounded-xl border border-line bg-base">
                <div className="max-h-[240px] overflow-y-auto p-2">
                  {previewResult.tools.map((tool) => (
                    <div key={tool.name} className="rounded-lg px-3 py-2 transition-colors hover:bg-base">
                      <code className="text-xs font-semibold text-info">{tool.name}</code>
                      {tool.description && (
                        <p className="mt-0.5 text-[11px] leading-relaxed text-fg-muted">{tool.description}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Links */}
        {(listing.websiteUrl || listing.repositoryUrl) && (
          <div className="mt-4 flex flex-wrap gap-2">
            {listing.websiteUrl && (
              <a
                href={listing.websiteUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border border-info-bg bg-info-bg px-3 py-1.5 text-[11px] font-medium text-info transition-colors hover:bg-info-bg"
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                </svg>
                {c.website}
              </a>
            )}
            {listing.repositoryUrl && (
              <a
                href={listing.repositoryUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-base px-3 py-1.5 text-[11px] font-medium text-fg-soft transition-colors hover:border-line-strong hover:text-fg"
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
                </svg>
                {c.repository}
              </a>
            )}
          </div>
        )}

        {/* Configuration Guide */}
        <div className="mt-4 rounded-xl border border-line bg-base p-4">
          <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-fg-muted">{c.howToUse}</h4>
          {isRemote && !listing.envVars.some(e => e.isRequired) ? (
            <ol className="space-y-1.5 text-[11px] leading-relaxed text-fg-muted">
              <li><span className="text-info">1.</span> {c.guideRemoteReady1}</li>
              <li><span className="text-info">2.</span> {c.guideRemoteReady2}</li>
              <li><span className="text-info">3.</span> {c.guideRemoteReady3}</li>
            </ol>
          ) : isRemote && listing.envVars.some(e => e.isRequired) ? (
            <ol className="space-y-1.5 text-[11px] leading-relaxed text-fg-muted">
              <li><span className="text-info">1.</span> {c.guideRemoteAuth1}</li>
              <li><span className="text-info">2.</span> {c.guideRemoteAuth2}</li>
              <li><span className="text-info">3.</span> {c.guideRemoteAuth3}</li>
              <li><span className="text-info">4.</span> {c.guideRemoteAuth4}</li>
              <li><span className="text-info">5.</span> {c.guideRemoteAuth5}</li>
            </ol>
          ) : (
            <ol className="space-y-1.5 text-[11px] leading-relaxed text-fg-muted">
              <li><span className="text-info">1.</span> {c.guideStdio1}</li>
              <li><span className="text-info">2.</span> {c.guideStdio2}</li>
              <li><span className="text-info">3.</span> {c.guideStdio3}</li>
              <li><span className="text-info">4.</span> {c.guideStdio4}</li>
              <li><span className="text-info">5.</span> {c.guideStdio5}</li>
              <li><span className="text-info">6.</span> {c.guideStdio6}</li>
            </ol>
          )}
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div className="rounded-2xl border border-line bg-base p-4">
            <h4 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fg-muted">{c.transport}</h4>
            <p className={`mt-1 text-sm font-medium ${isRemote ? 'text-ok' : 'text-fg'}`}>
              {listing.transport.type}
              {isRemote && <span className="ml-1.5 text-[10px] font-normal text-ok">{c.remoteLabel}</span>}
            </p>
            {hostname && (
              <p className="mt-1 truncate text-[11px] text-fg-muted">{listing.url}</p>
            )}
          </div>
          <div className="rounded-2xl border border-line bg-base p-4">
            <h4 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fg-muted">{c.category}</h4>
            <p className="mt-1 text-sm text-fg">{listing.categories.join(', ')}</p>
          </div>
        </div>

        {listing.envVars.length > 0 && (
          <div className="mt-4">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">{c.envVars}</h3>
            <div className="space-y-2">
              {listing.envVars.map((ev: RegistryEnvVar) => (
                <div key={ev.name} className="rounded-xl border border-line bg-base px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <code className="text-sm font-medium text-fg">{ev.name}</code>
                    {ev.isRequired ? (
                      <span className="rounded border border-danger-bg bg-danger-bg px-1.5 py-0.5 text-[9px] font-semibold text-danger">{c.required}</span>
                    ) : (
                      <span className="rounded border border-line px-1.5 py-0.5 text-[9px] text-fg-muted">{c.optional}</span>
                    )}
                    {ev.isSecret && (
                      <span className="rounded border border-warn-bg bg-warn-bg px-1.5 py-0.5 text-[9px] font-semibold text-warn">{c.secret}</span>
                    )}
                  </div>
                  {ev.description && <p className="mt-1 text-[11px] text-fg-muted">{ev.description}</p>}
                  {ev.default !== undefined && ev.default !== '' && (
                    <p className="mt-1 text-[10px] text-fg-dim">
                      {c.defaultLabel}: <code className="text-fg-muted">{ev.default}</code>
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {listing.command && (
          <div className="mt-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">{c.packages}</h3>
            <div className="rounded-xl border border-line bg-base px-3 py-2.5">
              <code className="text-xs text-fg">
                {listing.command} {listing.args}
              </code>
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-line px-6 py-4">
        {listing.needsManualConfig && (
          <div className="mb-3 rounded-xl border border-warn-bg bg-warn-bg px-3 py-2 text-[11px] leading-relaxed text-warn">
            {listing.manualConfigNote || c.manualConfigFallback}
          </div>
        )}
        {isRemote && previewDone && isAuthRequired && !isInstalled && (
          <div className="mb-3 rounded-xl border border-danger-bg bg-danger-bg px-3 py-2 text-[11px] leading-relaxed text-danger">
            ⚠ {c.authInstallWarning}
          </div>
        )}
        {isInstalled ? (
          <div className="flex gap-2">
            <span className="inline-flex flex-1 items-center justify-center rounded-xl bg-ok-bg py-3 text-sm font-semibold text-ok">
              <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
              </svg>
              {c.installedBadge}
            </span>
            <button
              type="button"
              onClick={() => onUninstall(listing)}
              disabled={isUninstalling}
              className="rounded-xl border border-danger-bg px-4 py-3 text-sm font-semibold text-danger transition-colors hover:bg-danger-bg disabled:opacity-50"
            >
              {isUninstalling ? c.uninstalling : c.uninstall}
            </button>
          </div>
        ) : isInstalling ? (
          <span className="inline-flex w-full items-center justify-center rounded-xl bg-slate-500/15 py-3 text-sm font-semibold text-fg-soft">
            <svg className="mr-2 h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <circle cx="12" cy="12" r="10" opacity="0.25" />
              <path d="M22 12a10 10 0 0 0-10-10" opacity="0.9" />
            </svg>
            {c.installing}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => onInstall(listing)}
            className="flex w-full items-center justify-center rounded-xl border border-info-bg bg-info-bg py-3 text-sm font-semibold text-info transition-colors hover:bg-info-bg"
          >
            {c.addToMyServers}
          </button>
        )}
      </div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="rounded-2xl border border-line bg-base p-4">
      <div className="flex items-start gap-3">
        <div className="h-10 w-10 flex-shrink-0 animate-pulse rounded-xl bg-raised" />
        <div className="flex-1 space-y-2">
          <div className="h-4 w-2/3 animate-pulse rounded bg-raised" />
          <div className="h-3 w-1/3 animate-pulse rounded bg-raised" />
        </div>
      </div>
      <div className="mt-3 space-y-1.5">
        <div className="h-3 w-full animate-pulse rounded bg-raised" />
        <div className="h-3 w-4/5 animate-pulse rounded bg-raised" />
      </div>
      <div className="mt-3 flex gap-1.5">
        <div className="h-5 w-16 animate-pulse rounded-md bg-raised" />
        <div className="h-5 w-12 animate-pulse rounded-md bg-raised" />
      </div>
    </div>
  );
}

export function McpMarketModal({ onClose }: McpMarketModalProps) {
  const settings = useAgentStore((s) => s.settings);
  const setSettings = useAgentStore((s) => s.setSettings);
  const c = copy(settings.lang);
  const installedIds = useInstalledServerIds();

  const [listings, setListings] = useState<MarketMCPListing[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [transportFilter, setTransportFilter] = useState('');
  const [runtimeFilter, setRuntimeFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [officialCursor, setOfficialCursor] = useState<string | undefined>();
  const [hasMoreOfficial, setHasMoreOfficial] = useState(false);
  const [selectedListing, setSelectedListing] = useState<MarketMCPListing | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 与 SkillMarketModal 一致的 toast 统一入口：旧实现裸 setTimeout 无卸载清理，
  // 且连续安装时旧定时器会提前清掉新 toast。
  const showToast = useCallback((message: string) => {
    setToastMessage(message);
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = setTimeout(() => {
      toastTimerRef.current = null;
      setToastMessage(null);
    }, 6_000);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  const loadServers = useCallback(async (options: FetchMarketOptions = {}) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await fetchMarketServers({
        cursor: options.cursor,
        search: options.search,
      });
      setListings((prev) => (options.cursor ? [...prev, ...result.listings] : result.listings));
      setOfficialCursor(result.pagination.nextCursor);
      setHasMoreOfficial(result.pagination.hasMore);
    } catch (err: unknown) {
      if (!options.cursor) setListings([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const query = searchQuery.trim();
    const delay = query ? 350 : 0;
    const handle = window.setTimeout(() => {
      setListings([]);
      setOfficialCursor(undefined);
      setHasMoreOfficial(false);
      setSelectedListing(null);
      void loadServers({ search: query || undefined });
    }, delay);
    return () => window.clearTimeout(handle);
  }, [searchQuery, loadServers]);

  const handleLoadMore = useCallback(() => {
    if (hasMoreOfficial) {
      void loadServers({
        cursor: officialCursor,
        search: searchQuery.trim() || undefined,
      });
    }
  }, [hasMoreOfficial, officialCursor, loadServers, searchQuery]);

  const filteredListings = useMemo(() => {
    return filterListings(listings, {
      transport: transportFilter,
      runtime: runtimeFilter,
      category: categoryFilter,
    });
  }, [listings, transportFilter, runtimeFilter, categoryFilter]);

  const [installingId, setInstallingId] = useState<string | null>(null);
  const [uninstallingId, setUninstallingId] = useState<string | null>(null);

  const handleInstall = useCallback(async (listing: MarketMCPListing) => {
    setInstallingId(listing.id);
    try {
      const config = listingToServerConfig(listing);

      const mcp = settings.mcp;
      const exists = mcp.servers.find(
        (s) => s.id === config.id || s.name.toLowerCase() === config.name.toLowerCase(),
      );
      if (!exists) {
        const newServers = [...mcp.servers, config];
        // Auto-enable global MCP when installing a server
        setSettings({
          ...settings,
          mcp: { ...mcp, servers: newServers, enabled: true, exposeTools: true },
        });
        if (config.enabled) {
          showToast(c.installEnabledToast.replace('{name}', listing.title));
        } else {
          showToast(c.installDisabledToast.replace('{name}', listing.title));
        }
      } else {
        showToast(c.alreadyInstalledToast.replace('{name}', exists.name));
      }
    } finally {
      setInstallingId(null);
    }
  }, [settings, setSettings, c, showToast]);

  const handleUninstall = useCallback(async (listing: MarketMCPListing) => {
    const match = findInstalledServer(settings.mcp.servers, listing);
    if (!match) return;
    setUninstallingId(listing.id);
    try {
      await disconnectMcpServer(settings.mcp, match.id);
      setSettings({
        ...settings,
        mcp: {
          ...settings.mcp,
          servers: settings.mcp.servers.filter((server) => server.id !== match.id),
        },
      });
      showToast(c.uninstalledToast.replace('{name}', listing.title));
    } finally {
      setUninstallingId(null);
    }
  }, [settings, setSettings, c, showToast]);

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
  }, []);

  const hasMore = hasMoreOfficial;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-overlay backdrop-blur-sm">
      <div className="flex h-[90vh] w-[min(96vw,1100px)] flex-col rounded-3xl border border-line bg-raised shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-fg">{c.title}</h2>
          </div>
          <button onClick={onClose} title={c.close} className="text-2xl leading-none text-fg-muted hover:text-fg-soft">×</button>
        </div>

        {/* Search + Filters */}
        <div className="border-b border-line px-6 py-3">
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <path d="M21 21l-4.35-4.35" />
              </svg>
              <input
                ref={searchRef}
                type="text"
                value={searchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder={c.search}
                className="w-full rounded-xl border border-line bg-base py-2 pl-9 pr-3 text-sm text-fg placeholder-slate-600 focus:border-info focus:outline-none"
              />
            </div>
            <select
              value={transportFilter}
              onChange={(e) => setTransportFilter(e.target.value)}
              className="rounded-xl border border-line bg-base px-3 py-2 text-xs text-fg-soft focus:border-info focus:outline-none"
            >
              <option value="">{c.transport}: {c.all}</option>
              <option value="stdio">stdio</option>
              <option value="sse">SSE</option>
              <option value="streamable-http">Streamable HTTP</option>
            </select>
            <select
              value={runtimeFilter}
              onChange={(e) => setRuntimeFilter(e.target.value)}
              className="rounded-xl border border-line bg-base px-3 py-2 text-xs text-fg-soft focus:border-info focus:outline-none"
            >
              <option value="">{c.runtime}: {c.all}</option>
              <option value="npx">npx</option>
              <option value="uvx">uvx</option>
              <option value="docker">docker</option>
            </select>
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="rounded-xl border border-line bg-base px-3 py-2 text-xs text-fg-soft focus:border-info focus:outline-none"
            >
              <option value="">{c.category}: {c.all}</option>
              <option value="search">{c.categorySearch}</option>
              <option value="database">{c.categoryDatabase}</option>
              <option value="custom">{c.categoryCustom}</option>
            </select>
          </div>
        </div>

        {/* Content: Grid + Detail (slide-out) */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {/* Main grid */}
          <div className={`h-full overflow-y-auto px-6 py-5 transition-all ${selectedListing ? 'pr-[420px]' : ''}`}>
            {isLoading && listings.length === 0 && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {Array.from({ length: 12 }).map((_, i) => (
                  <SkeletonCard key={i} />
                ))}
              </div>
            )}

            {error && listings.length === 0 && (
              <div className="flex h-64 flex-col items-center justify-center gap-4">
                <p className="text-sm text-danger">{c.error}</p>
                <p className="text-xs text-fg-dim">{error}</p>
                <button
                  type="button"
                  onClick={() => loadServers()}
                  className="rounded-xl border border-danger-bg px-4 py-2 text-xs font-medium text-danger transition-colors hover:bg-danger-bg"
                >
                  {c.retry}
                </button>
              </div>
            )}

            {!isLoading && !error && filteredListings.length === 0 && listings.length > 0 && (
              <div className="flex h-64 items-center justify-center">
                <p className="text-sm text-fg-muted">{c.empty}</p>
              </div>
            )}

            {!isLoading && !error && filteredListings.length === 0 && listings.length === 0 && (
              <div className="flex h-64 items-center justify-center">
                <p className="text-sm text-fg-muted">{c.empty}</p>
              </div>
            )}

            {filteredListings.length > 0 && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {filteredListings.map((listing) => (
                  <ListingCard
                    key={listing.id}
                    listing={listing}
                    isInstalled={isListingInstalled(installedIds, listing)}
                    isInstalling={installingId === listing.id}
                    onInstall={handleInstall}
                    onSelect={setSelectedListing}
                    c={c}
                  />
                ))}
              </div>
            )}

            {hasMore && filteredListings.length > 0 && (
              <div className="mt-5 flex justify-center pb-4">
                <button
                  type="button"
                  onClick={handleLoadMore}
                  disabled={isLoading}
                  className="rounded-xl border border-line px-6 py-2.5 text-xs font-medium text-fg-muted transition-colors hover:border-info-bg hover:text-info disabled:opacity-50"
                >
                  {isLoading ? c.loading : c.loadMore}
                </button>
              </div>
            )}
          </div>

          {/* Detail slide-out panel */}
          {selectedListing && (
            <div className="absolute right-0 top-0 h-full w-[400px] border-l border-line bg-base">
              <ListingDetail
                listing={selectedListing}
                isInstalled={isListingInstalled(installedIds, selectedListing)}
                isInstalling={installingId === selectedListing.id}
                isUninstalling={uninstallingId === selectedListing.id}
                onInstall={handleInstall}
                onUninstall={handleUninstall}
                onClose={() => setSelectedListing(null)}
                onCloseModal={onClose}
                c={c}
              />
            </div>
          )}
        </div>

        {/* Toast */}
        {toastMessage && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-2xl border border-ok-bg bg-ok-bg px-5 py-3 text-sm text-ok shadow-lg backdrop-blur">
            {toastMessage}
          </div>
        )}
      </div>
    </div>
  );
}
