import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAgentStore } from '../store/agentStore';
import { useAppRuntimeStore } from '../store/appRuntimeStore';
import { fetchMarketAppListings } from '../tools/marketAppApi';
import { installMarketApp, uninstallMarketApp } from '../tools/marketAppInstall';
import type { PaprAppListing, AppInstallScope } from '../utils/marketAppTypes';
import { isMarketUpdateAvailable, readInstalledAppVersion } from '../utils/marketAppVersion';
import type { Lang } from '../utils/i18n';
import { DangerConfirmDialog } from './DangerConfirmDialog';

interface AppMarketModalProps {
  onClose: () => void;
}

function copy(lang: Lang | undefined) {
  if (lang === 'en') {
    return {
      title: 'App & Plugin Marketplace',
      subtitle: 'Discover and install native UI micro-apps, visual canvases, and overlay plugins.',
      source: 'Source',
      appsRegistry: 'Official Apps Repository',
      searchApps: 'Search apps & plugins...',
      filterAll: 'All',
      filterPlugins: 'Plugins',
      filterApps: 'Standalone Apps',
      install: 'Install',
      installGlobal: 'Install Globally',
      installWorkspace: 'Install to Project',
      installing: 'Installing...',
      installed: 'Installed',
      installedGlobal: 'Global',
      installedWorkspace: 'Project',
      installError: 'Install failed',
      loading: 'Loading market apps...',
      empty: 'No apps or plugins found.',
      error: 'Failed to load app marketplace data.',
      retry: 'Retry',
      close: 'Close',
      detail: 'Details',
      features: 'Features',
      repository: 'Repository',
      website: 'Website',
      noWorkspace: 'Open a project workspace first to install to project.',
      noWorkspaceOpen: 'No workspace open (Global install only)',
      tags: 'Tags',
      allTags: 'All',
      back: 'Back to results',
      update: 'Update',
      updateAvailable: 'Update available',
      uninstall: 'Uninstall',
      uninstalling: 'Uninstalling...',
      openApp: 'Open',
      pinPlugin: 'Show / Pin',
      appInstalledSuccess: (title: string, scope: string) =>
        `${title} installed successfully (${scope === 'global' ? 'Global' : 'Project'})`,
      uninstallSuccess: (title: string) => `${title} uninstalled`,
      uninstallConfirm: (title: string, isPlugin?: boolean) =>
        isPlugin ? `Uninstall plugin "${title}"?` : `Uninstall "${title}"?`,
      uninstallConfirmBody: 'This permanently removes its files and local data (including papr.db). This cannot be undone.',
      uninstallConfirmCancel: 'Cancel',
      uninstallConfirmAction: 'Uninstall',
      surfaceConfig: 'Surface & Window Layout',
      permissions: 'Permissions & Security',
      networkAccess: 'Network Access',
      workspaceAccess: 'Workspace Access',
      dataStorage: 'Data Storage',
      storageDesc: 'Isolated per app and per project (SQLite papr.db)',
      enabled: 'Direct fetch/API allowed',
      disabled: 'Disabled (Sandbox)',
    };
  }
  if (lang === 'zh-TW') {
    return {
      title: '應用與外掛市場',
      subtitle: '探索並安裝原生 UI 微應用、視覺化看板與桌面浮窗外掛。',
      source: '來源',
      appsRegistry: '官方外掛庫',
      searchApps: '搜尋應用與外掛...',
      filterAll: '全部',
      filterPlugins: '外掛 (Plugins)',
      filterApps: '獨立應用 (Apps)',
      install: '安裝',
      installGlobal: '全域安裝 (所有專案)',
      installWorkspace: '專案安裝 (僅目前)',
      installing: '安裝中...',
      installed: '已安裝',
      installedGlobal: '全域',
      installedWorkspace: '專案',
      installError: '安裝失敗',
      loading: '載入應用市場中...',
      empty: '沒有找到符合的應用或外掛。',
      error: '載入失敗。',
      retry: '重試',
      close: '關閉',
      detail: '詳情',
      features: '功能',
      repository: '倉庫',
      website: '網站',
      noWorkspace: '請先開啟專案工作區再安裝到專案。',
      noWorkspaceOpen: '尚未開啟工作區（僅支援全域安裝）',
      tags: '標籤',
      allTags: '全部',
      back: '返回結果',
      update: '更新',
      updateAvailable: '有新版本',
      uninstall: '卸載',
      uninstalling: '卸載中...',
      openApp: '開啟',
      pinPlugin: '顯示 / 置頂',
      appInstalledSuccess: (title: string, scope: string) =>
        `${title} 安裝成功 (${scope === 'global' ? '全域' : '專案'})`,
      uninstallSuccess: (title: string) => `已卸載 ${title}`,
      uninstallConfirm: (title: string, isPlugin?: boolean) =>
        isPlugin ? `確定卸載外掛「${title}」？` : `確定卸載「${title}」？`,
      uninstallConfirmBody: '將永久刪除其檔案與本地資料（含 papr.db）。此操作無法撤銷。',
      uninstallConfirmCancel: '取消',
      uninstallConfirmAction: '卸載',
      surfaceConfig: '介面與佈局配置',
      permissions: '權限與安全性',
      networkAccess: '網路存取',
      workspaceAccess: '工作區檔案存取',
      dataStorage: '資料儲存',
      storageDesc: '按應用、按專案隔離儲存 (SQLite papr.db)',
      enabled: '允許直接網路連線/API',
      disabled: '已停用（沙箱防護）',
    };
  }
  return {
    title: '应用与插件市场',
    subtitle: '探索并安装原生 UI 微应用、可视化看板与桌面悬浮插件。',
    source: '来源',
    appsRegistry: '官方插件库',
    searchApps: '搜索应用与插件...',
    filterAll: '全部',
    filterPlugins: '插件 (Plugins)',
    filterApps: '独立应用 (Apps)',
    install: '安装',
    installGlobal: '全局安装 (所有项目)',
    installWorkspace: '项目安装 (仅当前)',
    installing: '安装中...',
    installed: '已安装',
    installedGlobal: '全局',
    installedWorkspace: '项目',
    installError: '安装失败',
    loading: '加载应用市场中...',
    empty: '没有找到符合的应用或插件。',
    error: '加载失败。',
    retry: '重试',
    close: '关闭',
    detail: '详情',
    features: '功能',
    repository: '仓库',
    website: '网站',
    noWorkspace: '请先打开项目工作区再安装到项目。',
    noWorkspaceOpen: '尚未打开工作区（仅支持全局安装）',
    tags: '标签',
    allTags: '全部',
    back: '返回结果',
      update: '更新',
      updateAvailable: '有新版本',
      uninstall: '卸载',
    uninstalling: '卸载中...',
    openApp: '打开',
    pinPlugin: '显示 / 置顶',
    appInstalledSuccess: (title: string, scope: string) =>
      `${title} 安装成功 (${scope === 'global' ? '全局' : '项目'})`,
    uninstallSuccess: (title: string) => `已卸载 ${title}`,
    uninstallConfirm: (title: string, isPlugin?: boolean) =>
      isPlugin ? `确定卸载插件「${title}」？` : `确定卸载「${title}」？`,
    uninstallConfirmBody: '将永久删除其文件和本地数据（含 papr.db）。此操作无法撤销。',
    uninstallConfirmCancel: '取消',
    uninstallConfirmAction: '卸载',
    surfaceConfig: '界面与布局配置',
    permissions: '权限与安全性',
    networkAccess: '网络访问',
    workspaceAccess: '工作区文件访问',
    dataStorage: '数据存储',
      storageDesc: '按应用、按项目隔离存储 (SQLite papr.db)',
    enabled: '允许直接网络请求/API',
    disabled: '已禁用（沙箱保护）',
  };
}

function listingTitle(listing: PaprAppListing, lang: Lang | undefined): string {
  if (lang === 'en' && listing.titleEn) return listing.titleEn;
  return listing.title || listing.name;
}

function listingDescription(listing: PaprAppListing, lang: Lang | undefined): string {
  if (lang === 'en' && listing.descriptionEn) return listing.descriptionEn;
  return listing.description;
}

function AppListingCard({
  listing,
  installedScope,
  hasUpdate,
  isInstalling,
  isUninstalling,
  installError,
  onSelect,
  onInstall,
  onUninstall,
  onOpenApp,
  workspaceOpen,
  c,
  lang,
}: {
  listing: PaprAppListing;
  installedScope?: 'global' | 'workspace' | null;
  hasUpdate?: boolean;
  isInstalling: boolean;
  isUninstalling: boolean;
  installError?: string;
  onSelect: (listing: PaprAppListing) => void;
  onInstall: (listing: PaprAppListing, scope: AppInstallScope) => void;
  onUninstall: (listing: PaprAppListing, scope: AppInstallScope) => void;
  onOpenApp?: (appId: string) => void;
  workspaceOpen: boolean;
  c: ReturnType<typeof copy>;
  lang: Lang | undefined;
}) {
  const title = listingTitle(listing, lang);
  const description = listingDescription(listing, lang);
  return (
    <button
      type="button"
      onClick={() => onSelect(listing)}
      className="group relative flex flex-col gap-3 rounded-2xl border border-line bg-base p-4 text-left transition-all hover:border-purple-500/40 hover:bg-raised/20"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-raised text-2xl shadow-sm">
          {listing.icon || (listing.kind === 'plugin' ? '📌' : '🖥️')}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="truncate text-sm font-semibold text-fg">{title}</h3>
            <span className="flex-shrink-0 rounded-full border border-line bg-raised px-1.5 py-0.5 text-[9px] font-medium text-fg-muted">
              {listing.kind === 'plugin' ? 'Plugin' : 'App'}
            </span>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-fg-muted">v{listing.version} · {listing.author || 'Official'}</p>
        </div>
        {installedScope && (
          <span className="flex-shrink-0 rounded-full border border-info-bg bg-info-bg px-2 py-0.5 text-[9px] font-medium text-info">
            {hasUpdate ? c.updateAvailable : installedScope === 'global' ? c.installedGlobal : c.installedWorkspace}
          </span>
        )}
      </div>

      <p className="line-clamp-2 text-xs leading-relaxed text-fg-dim">{description}</p>

      {listing.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {listing.tags.map((tag) => (
            <span key={tag} className="rounded-md border border-line bg-raised px-1.5 py-0.5 text-[9px] text-fg-muted">
              {tag}
            </span>
          ))}
        </div>
      )}

      <div className="mt-auto flex items-center justify-between border-t border-line pt-2.5">
        <div className="flex items-center gap-1.5">
          {installedScope && onOpenApp && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenApp(listing.id);
              }}
              className="rounded-lg border border-line px-2.5 py-1 text-[10px] font-medium text-fg hover:bg-raised"
            >
              {listing.kind === 'plugin' ? c.pinPlugin : c.openApp}
            </button>
          )}
        </div>

        {isUninstalling ? (
          <span className="rounded-lg bg-danger-bg px-3 py-1.5 text-[10px] font-semibold text-danger">{c.uninstalling}</span>
        ) : isInstalling ? (
          <span className="rounded-lg bg-purple-500/20 px-3 py-1.5 text-[10px] font-semibold text-purple-200">{c.installing}</span>
        ) : installedScope ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onInstall(listing, installedScope);
              }}
              className={`rounded-lg px-3 py-1.5 text-[10px] font-semibold transition-colors ${
                hasUpdate
                  ? 'bg-purple-500/35 text-purple-50 hover:bg-purple-500/50'
                  : 'bg-purple-500/20 text-purple-100 hover:bg-purple-500/35'
              }`}
            >
              {hasUpdate ? c.updateAvailable : c.update}
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onUninstall(listing, installedScope);
              }}
              className="rounded-lg bg-danger-bg px-3 py-1.5 text-[10px] font-semibold text-danger transition-colors hover:bg-danger-bg"
            >
              {c.uninstall}
            </button>
          </div>
        ) : installError ? (
          <div className="flex items-center gap-2">
            <span className="max-w-[120px] truncate text-[10px] text-danger" title={installError}>
              {installError}
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onInstall(listing, 'global');
              }}
              className="shrink-0 rounded-lg bg-danger-bg px-3 py-1.5 text-[10px] font-semibold text-danger transition-colors hover:bg-danger-bg"
            >
              {c.retry}
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            {workspaceOpen ? (
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onInstall(listing, 'global');
                  }}
                  title={c.installGlobal}
                  className="rounded-lg bg-purple-500/20 px-2.5 py-1 text-[10px] font-semibold text-purple-100 transition-colors hover:bg-purple-500/35"
                >
                  🌐 {c.installedGlobal}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onInstall(listing, 'workspace');
                  }}
                  title={c.installWorkspace}
                  className="rounded-lg bg-purple-500/20 px-2.5 py-1 text-[10px] font-semibold text-purple-100 transition-colors hover:bg-purple-500/35"
                >
                  📁 {c.installedWorkspace}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onInstall(listing, 'global');
                }}
                className="rounded-lg bg-purple-500/20 px-3 py-1.5 text-[10px] font-semibold text-purple-100 transition-colors hover:bg-purple-500/35"
              >
                🌐 {c.installGlobal}
              </button>
            )}
          </div>
        )}
      </div>
    </button>
  );
}

function AppDetail({
  listing,
  installedScope,
  hasUpdate,
  isInstalling,
  isUninstalling,
  onInstall,
  onUninstall,
  onOpenApp,
  workspaceOpen,
  onClose,
  c,
  lang,
}: {
  listing: PaprAppListing;
  installedScope?: 'global' | 'workspace' | null;
  hasUpdate?: boolean;
  isInstalling: boolean;
  isUninstalling: boolean;
  onInstall: (listing: PaprAppListing, scope: AppInstallScope) => void;
  onUninstall: (listing: PaprAppListing, scope: AppInstallScope) => void;
  onOpenApp?: (appId: string) => void;
  workspaceOpen: boolean;
  onClose: () => void;
  c: ReturnType<typeof copy>;
  lang: Lang | undefined;
}) {
  const title = listingTitle(listing, lang);
  const description = listingDescription(listing, lang);
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-line px-5 py-4">
        <button
          type="button"
          onClick={onClose}
          className="flex items-center gap-1 text-xs text-fg-muted transition-colors hover:text-fg"
        >
          ← {c.back}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="text-lg leading-none text-fg-muted hover:text-fg"
        >
          ×
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl bg-raised text-2xl shadow-sm">
            {listing.icon || (listing.kind === 'plugin' ? '📌' : '🖥️')}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold text-fg">{title}</h3>
              <span className="rounded-full border border-line bg-raised px-2 py-0.5 text-[10px] text-fg-muted">
                {listing.kind === 'plugin' ? 'Plugin' : 'App'}
              </span>
            </div>
            <p className="text-xs text-fg-muted">v{listing.version} · {listing.author || 'Official'}</p>
          </div>
        </div>

        <p className="text-xs leading-relaxed text-fg-dim">{description}</p>

        {listing.surface && (
          <div className="space-y-1.5 rounded-xl border border-line bg-raised p-3 text-xs text-fg-muted">
            <div className="font-semibold text-fg">{c.surfaceConfig}</div>
            <div>Type: {listing.surface.type || 'overlay'}</div>
            {listing.surface.position && <div>Position: {listing.surface.position}</div>}
            {listing.surface.width && <div>Default Size: {listing.surface.width} × {listing.surface.height}px</div>}
          </div>
        )}

        <div className="space-y-1.5 rounded-xl border border-line bg-raised p-3 text-xs text-fg-muted">
          <div className="font-semibold text-fg">{c.permissions}</div>
          <div>{c.networkAccess}: {listing.permissions?.network ? c.enabled : c.disabled}</div>
          <div>{c.workspaceAccess}: {listing.permissions?.local || 'none'}</div>
          <div>{c.dataStorage}: {c.storageDesc}</div>
        </div>
      </div>

      <div className="border-t border-line p-5">
        {installedScope ? (
          <div className="flex gap-2">
            {onOpenApp && (
              <button
                type="button"
                onClick={() => onOpenApp(listing.id)}
                className="flex-1 rounded-xl border border-line py-3 text-sm font-semibold text-fg hover:bg-raised"
              >
                {listing.kind === 'plugin' ? c.pinPlugin : c.openApp}
              </button>
            )}
            <button
              type="button"
              disabled={isInstalling || isUninstalling}
              onClick={() => onInstall(listing, installedScope)}
              className="flex-1 rounded-xl bg-purple-500/20 py-3 text-sm font-semibold text-purple-100 transition-colors hover:bg-purple-500/35 disabled:opacity-50"
            >
              {isInstalling ? c.installing : hasUpdate ? c.updateAvailable : c.update}
            </button>
            <button
              type="button"
              disabled={isInstalling || isUninstalling}
              onClick={() => onUninstall(listing, installedScope)}
              className="flex-1 rounded-xl bg-danger-bg py-3 text-sm font-semibold text-danger transition-colors hover:bg-danger-bg disabled:opacity-50"
            >
              {isUninstalling ? c.uninstalling : c.uninstall}
            </button>
          </div>
        ) : workspaceOpen ? (
          <div className="flex gap-2">
            <button
              type="button"
              disabled={isInstalling || isUninstalling}
              onClick={() => onInstall(listing, 'global')}
              className="flex-1 rounded-xl bg-purple-500/20 py-3 text-sm font-semibold text-purple-100 transition-colors hover:bg-purple-500/35 disabled:opacity-50"
            >
              🌐 {c.installGlobal}
            </button>
            <button
              type="button"
              disabled={isInstalling || isUninstalling}
              onClick={() => onInstall(listing, 'workspace')}
              className="flex-1 rounded-xl bg-purple-500/20 py-3 text-sm font-semibold text-purple-100 transition-colors hover:bg-purple-500/35 disabled:opacity-50"
            >
              📁 {c.installWorkspace}
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={isInstalling || isUninstalling}
            onClick={() => onInstall(listing, 'global')}
            className="w-full rounded-xl bg-purple-500/20 py-3 text-sm font-semibold text-purple-100 transition-colors hover:bg-purple-500/35 disabled:opacity-50"
          >
            🌐 {isInstalling ? c.installing : c.installGlobal}
          </button>
        )}
      </div>
    </div>
  );
}

export function AppMarketModal({ onClose }: AppMarketModalProps) {
  const settings = useAgentStore((s) => s.settings);
  const workspacePath = useAgentStore((s) => s.workspacePath);
  const installedApps = useAppRuntimeStore((s) => s.apps);
  const c = copy(settings.lang);

  const [appListings, setAppListings] = useState<PaprAppListing[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<'all' | 'plugin' | 'app'>('all');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [selectedApp, setSelectedApp] = useState<PaprAppListing | null>(null);

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const [installingIds, setInstallingIds] = useState<Set<string>>(new Set());
  const [uninstallingIds, setUninstallingIds] = useState<Set<string>>(new Set());
  const [installErrors, setInstallErrors] = useState<Record<string, string>>({});
  const [pendingUninstall, setPendingUninstall] = useState<{
    listing: PaprAppListing;
    scope: AppInstallScope;
  } | null>(null);

  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = setTimeout(() => {
      toastTimerRef.current = null;
      setToastMessage(null);
    }, 5000);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  const getInstalledAppScope = useCallback(
    (appId: string): 'global' | 'workspace' | null => {
      const match = installedApps.find((a) => a.appId === appId);
      if (!match) return null;
      return match.scope === 'global' ? 'global' : 'workspace';
    },
    [installedApps],
  );

  const getHasUpdate = useCallback(
    (listing: PaprAppListing): boolean => {
      const match = installedApps.find((a) => a.appId === listing.id);
      if (!match) return false;
      return isMarketUpdateAvailable(readInstalledAppVersion(match.manifestJson), listing.version);
    },
    [installedApps],
  );

  const loadData = useCallback(async (force = false) => {
    setIsLoading(true);
    setError(null);
    try {
      const results = await fetchMarketAppListings({ forceRefresh: force });
      setAppListings(results);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData(false);
  }, [loadData]);

  const handleRetry = useCallback(() => {
    void loadData(true);
  }, [loadData]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 backdrop-blur-sm">
      <div className="flex h-[88vh] w-[92vw] max-w-5xl flex-col overflow-hidden rounded-2xl border border-line bg-base shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-purple-500/10 text-xl text-purple-400">▦</div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-fg">{c.title}</h2>
                <span className="rounded-md border border-line bg-raised px-2 py-0.5 text-[10px] text-fg-muted">{c.appsRegistry}</span>
              </div>
              <p className="text-xs text-fg-muted">{c.subtitle}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg border border-line p-2 text-fg-muted transition-colors hover:border-line-strong hover:bg-raised hover:text-fg">✕</button>
        </div>
        <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">{isLoading ? c.loading : error ? error : c.empty}</div>
      </div>
    </div>
  );
}
