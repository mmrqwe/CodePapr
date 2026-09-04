import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useAgentStore } from '../store/agentStore';
import { useAppRuntimeStore } from '../store/appRuntimeStore';
import { fetchMarketAppListings } from '../tools/marketAppApi';
import { installMarketApp, uninstallMarketApp } from '../tools/marketAppInstall';
import type { PaprAppListing, AppInstallScope } from '../utils/marketAppTypes';
import { isMarketUpdateAvailable, readInstalledAppVersion } from '../utils/marketAppVersion';
import { DangerConfirmDialog } from './DangerConfirmDialog';
import { copy, listingTitle } from './AppMarketModalCopy';
import { AppListingCard, AppDetail } from './AppMarketModalViews';
import { remountDiscoveredApps } from './AppMarketModalSync';
import { filterMarketListings } from './AppMarketModalFilter';

export interface AppMarketModalProps {
  onClose: () => void;
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

  const handleInstallApp = useCallback(
    async (listing: PaprAppListing, scope: AppInstallScope) => {
      setInstallingIds((prev) => new Set(prev).add(listing.id));
      setInstallErrors((prev) => {
        const n = { ...prev };
        delete n[listing.id];
        return n;
      });

      const finish = () => {
        setInstallingIds((prev) => {
          const next = new Set(prev);
          next.delete(listing.id);
          return next;
        });
      };

      try {
        const res = await installMarketApp({
          listing,
          scope,
          workspacePath,
        });

        if (!res.ok) {
          setInstallErrors((prev) => ({ ...prev, [listing.id]: res.error || c.installError }));
          return;
        }

        showToast(c.appInstalledSuccess(listingTitle(listing, settings.lang), scope));
        if (res.warnings && res.warnings.length > 0) {
          showToast(c.partialInstallWarning(res.warnings.length));
        }
        // 无工作区也要重挂（空串 = 只扫 global）：否则 global 安装后卡片
        // 立即回显"未安装"（幽灵安装）。
        try {
          await remountDiscoveredApps(workspacePath || '', listing.id);
        } catch {
          // ignore
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setInstallErrors((prev) => ({ ...prev, [listing.id]: msg || c.installError }));
      } finally {
        finish();
      }
    },
    [workspacePath, c, showToast, settings.lang],
  );

  const handleUninstallApp = useCallback(
    (listing: PaprAppListing, scope: AppInstallScope) => {
      setPendingUninstall({ listing, scope });
    },
    [],
  );

  const confirmUninstallApp = useCallback(
    async () => {
      if (!pendingUninstall) return;
      const { listing, scope } = pendingUninstall;

      setUninstallingIds((prev) => new Set(prev).add(listing.id));
      const finish = () => {
        setUninstallingIds((prev) => {
          const next = new Set(prev);
          next.delete(listing.id);
          return next;
        });
        setPendingUninstall(null);
      };

      try {
        const res = await uninstallMarketApp({
          appId: listing.id,
          scope,
          purgeData: true,
          workspacePath,
        });

        if (!res.ok) {
          setInstallErrors((prev) => ({ ...prev, [listing.id]: res.error || c.installError }));
          setPendingUninstall(null);
          return;
        }

        showToast(c.uninstallSuccess(listingTitle(listing, settings.lang)));
        const runtime = useAppRuntimeStore.getState();
        runtime.closeApp(listing.id);
        runtime.unpinPlugin(listing.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setInstallErrors((prev) => ({ ...prev, [listing.id]: msg || c.installError }));
      } finally {
        finish();
      }
    },
    [pendingUninstall, workspacePath, c, showToast, settings.lang],
  );

  const handleOpenApp = useCallback((appId: string) => {
    const store = useAppRuntimeStore.getState();
    const app = store.apps.find((a) => a.appId === appId);
    if (!app) return;
    if (app.manifestJson) {
      try {
        const manifest = JSON.parse(app.manifestJson);
        if (manifest.kind === 'plugin') {
          store.pinPlugin(appId);
          return;
        }
      } catch {
        // ignore
      }
    }
    store.openAppModal(appId);
  }, []);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const app of appListings) {
      if (Array.isArray(app.tags)) {
        for (const tag of app.tags) set.add(tag);
      }
    }
    return Array.from(set).sort();
  }, [appListings]);

  const filteredApps = useMemo(
    () => filterMarketListings(appListings, kindFilter, selectedTag, searchQuery, settings.lang),
    [appListings, kindFilter, selectedTag, searchQuery, settings.lang],
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 backdrop-blur-sm">
      <div className="flex h-[88vh] w-[92vw] max-w-5xl flex-col overflow-hidden rounded-2xl border border-line bg-base shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-purple-500/10 text-xl text-purple-400">
              ▦
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-fg">{c.title}</h2>
                <span className="rounded-md border border-line bg-raised px-2 py-0.5 text-[10px] text-fg-muted">
                  {c.appsRegistry}
                </span>
              </div>
              <p className="text-xs text-fg-muted">{c.subtitle}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line p-2 text-fg-muted transition-colors hover:border-line-strong hover:bg-raised hover:text-fg"
          >
            ✕
          </button>
        </div>

        {/* Filter Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-raised/20 px-6 py-3">
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg border border-line bg-base p-0.5">
              <button
                type="button"
                onClick={() => setKindFilter('all')}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  kindFilter === 'all'
                    ? 'bg-purple-500/20 text-purple-200'
                    : 'text-fg-muted hover:text-fg'
                }`}
              >
                {c.filterAll}
              </button>
              <button
                type="button"
                onClick={() => setKindFilter('plugin')}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  kindFilter === 'plugin'
                    ? 'bg-purple-500/20 text-purple-200'
                    : 'text-fg-muted hover:text-fg'
                }`}
              >
                📌 {c.filterPlugins}
              </button>
              <button
                type="button"
                onClick={() => setKindFilter('app')}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  kindFilter === 'app'
                    ? 'bg-purple-500/20 text-purple-200'
                    : 'text-fg-muted hover:text-fg'
                }`}
              >
                🖥️ {c.filterApps}
              </button>
            </div>

            {allTags.length > 0 && (
              <select
                value={selectedTag || ''}
                onChange={(e) => setSelectedTag(e.target.value || null)}
                className="rounded-lg border border-line bg-base px-2.5 py-1.5 text-xs text-fg outline-none focus:border-purple-500/50"
              >
                <option value="">{c.allTags} ({c.tags})</option>
                {allTags.map((tag) => (
                  <option key={tag} value={tag}>
                    {tag}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="flex min-w-[240px] flex-1 max-w-sm items-center rounded-lg border border-line bg-base px-3 py-1.5 focus-within:border-purple-500/50">
            <span className="mr-2 text-xs text-fg-muted">🔍</span>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={c.searchApps}
              className="w-full bg-transparent text-xs text-fg outline-none placeholder:text-fg-muted"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="text-xs text-fg-muted hover:text-fg"
              >
                ×
              </button>
            )}
          </div>
        </div>

        {/* Content Area */}
        <div className="relative flex min-h-0 flex-1">
          {isLoading ? (
            <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">
              {c.loading}
            </div>
          ) : error ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="text-sm text-danger">{error}</p>
              <button
                type="button"
                onClick={handleRetry}
                className="rounded-lg bg-purple-500/20 px-4 py-2 text-xs font-semibold text-purple-200 hover:bg-purple-500/35"
              >
                {c.retry}
              </button>
            </div>
          ) : filteredApps.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">
              {c.empty}
            </div>
          ) : (
            <div
              className={`grid min-h-0 flex-1 gap-4 overflow-y-auto p-6 ${
                selectedApp
                  ? 'grid-cols-1 md:grid-cols-2'
                  : 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3'
              }`}
            >
              {filteredApps.map((app) => (
                <AppListingCard
                  key={app.id}
                  listing={app}
                  installedScope={getInstalledAppScope(app.id)}
                  hasUpdate={getHasUpdate(app)}
                  isInstalling={installingIds.has(app.id)}
                  isUninstalling={uninstallingIds.has(app.id)}
                  installError={installErrors[app.id]}
                  onSelect={(item) => setSelectedApp(item)}
                  onInstall={handleInstallApp}
                  onUninstall={handleUninstallApp}
                  onOpenApp={handleOpenApp}
                  workspaceOpen={!!workspacePath}
                  c={c}
                  lang={settings.lang}
                />
              ))}
            </div>
          )}

          {/* Right Detail Pane */}
          {selectedApp && (
            <div className="w-full border-l border-line bg-base md:w-[380px] lg:w-[420px]">
              <AppDetail
                listing={selectedApp}
                installedScope={getInstalledAppScope(selectedApp.id)}
                hasUpdate={getHasUpdate(selectedApp)}
                isInstalling={installingIds.has(selectedApp.id)}
                isUninstalling={uninstallingIds.has(selectedApp.id)}
                onInstall={handleInstallApp}
                onUninstall={handleUninstallApp}
                onOpenApp={handleOpenApp}
                workspaceOpen={!!workspacePath}
                onClose={() => setSelectedApp(null)}
                c={c}
                lang={settings.lang}
              />
            </div>
          )}
        </div>

        {/* Toast Notification */}
        {toastMessage && (
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 rounded-xl border border-line bg-raised px-4 py-2.5 text-xs font-medium text-fg shadow-2xl">
            {toastMessage}
          </div>
        )}
      </div>
      {pendingUninstall && (
        <DangerConfirmDialog
          title={c.uninstallConfirm(
            listingTitle(pendingUninstall.listing, settings.lang),
            pendingUninstall.listing.kind === 'plugin',
          )}
          warning={c.uninstallConfirmBody}
          confirmLabel={c.uninstallConfirmAction}
          cancelLabel={c.uninstallConfirmCancel}
          executing={uninstallingIds.has(pendingUninstall.listing.id)}
          executingLabel={c.uninstalling}
          onConfirm={() => { void confirmUninstallApp(); }}
          onCancel={() => {
            if (!uninstallingIds.has(pendingUninstall.listing.id)) setPendingUninstall(null);
          }}
        />
      )}
    </div>
  );
}
