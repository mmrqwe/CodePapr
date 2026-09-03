import type { Lang } from '../utils/i18n';
import type { PaprAppListing, AppInstallScope } from '../utils/marketAppTypes';
import { listingTitle, listingDescription, type MarketCopy } from './AppMarketModalCopy';

export function AppListingCard({
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
  c: MarketCopy;
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

export function AppDetail({
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
  c: MarketCopy;
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
