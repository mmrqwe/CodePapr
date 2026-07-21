import { useState, useMemo, useCallback, useRef } from 'react';
import { useAppRuntimeStore } from '../store/appRuntimeStore';
import { invoke } from '@tauri-apps/api/core';
import { getTranslation } from '../utils/i18n';
import type { Lang } from '../utils/i18n';
import type { PaprManifest } from '@codepapr/types';
import { usePaprBridge } from '../papr/usePaprBridge';

interface AppModalProps {
  lang?: Lang;
}

export function AppModal({ lang }: AppModalProps) {
  const t = getTranslation(lang);
  const openedAppId = useAppRuntimeStore((state) => state.openedAppId);
  const apps = useAppRuntimeStore((state) => state.apps);
  const closeAppModal = useAppRuntimeStore((state) => state.closeAppModal);
  const setAppStopped = useAppRuntimeStore((state) => state.setAppStopped);
  const reloadActiveApp = useAppRuntimeStore((state) => state.reloadActiveApp);
  const [error, setError] = useState('');
  const [showDetails, setShowDetails] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const openedApp = useMemo(
    () => apps.find((app) => app.appId === openedAppId) ?? null,
    [apps, openedAppId]
  );

  const manifest: PaprManifest | null = useMemo(() => {
    if (!openedApp?.manifestJson) return null;
    try {
      return JSON.parse(openedApp.manifestJson) as PaprManifest;
    } catch {
      return null;
    }
  }, [openedApp?.manifestJson]);

  usePaprBridge({
    iframeRef,
    appId: openedApp?.appId ?? '',
    manifest,
  });

  const handleCloseAndStop = useCallback(async () => {
    if (openedApp?.pid) {
      try { await invoke('stop_background_process', { pid: openedApp.pid }); } catch { /* best-effort */ }
      setAppStopped(openedApp.appId);
    } else {
      closeAppModal();
    }
  }, [openedApp, closeAppModal, setAppStopped]);

  if (!openedApp) {
    return null;
  }

  const iframeSrc = openedApp.url
    ? openedApp.url
    : `codepapr-app://localhost/${openedApp.appId}/index.html`;

  const hasMeta = (manifest?.permissions && manifest.permissions.length > 0)
    || (manifest?.agents && manifest.agents.length > 0);

  return (
    <div className="flex h-full w-full flex-col bg-[#0f1117]">
      <div className="flex shrink-0 items-center gap-2 border-b border-[#2a2d3a] px-3 py-2">
        <button
          type="button"
          onClick={openedApp.pid ? handleCloseAndStop : closeAppModal}
          title={t.appModalClose}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-slate-400 transition-colors hover:bg-[#1a1d28] hover:text-slate-200"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">          <path d="M19 12H5M12 19l-7-7 7-7"/></svg>
          {t.appModalClose}
        </button>

        <div className="min-w-0 flex-1">
          <span className="truncate text-xs font-semibold text-slate-200">{openedApp.title}</span>
        </div>

        {hasMeta && (
          <button
            type="button"
            onClick={() => setShowDetails(!showDetails)}
            title="Details"
            className={`shrink-0 rounded px-1.5 py-1 text-[10px] transition-colors ${
              showDetails
                ? 'bg-indigo-500/15 text-indigo-300'
                : 'text-slate-600 hover:text-slate-400'
            }`}
          >
            {showDetails ? '▾' : '▸'} Info
          </button>
        )}

        <button
          type="button"
          onClick={() => { setError(''); reloadActiveApp(); }}
          className="shrink-0 rounded px-1.5 py-1 text-[10px] text-slate-500 transition-colors hover:text-slate-300"
          title={t.appModalReload}
        >
          ⟳ {t.appModalReload}
        </button>
      </div>

      {error && (
        <div className="mx-3 mt-2 shrink-0 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-200">
          {error}
        </div>
      )}

      {showDetails && manifest && (
        <div className="shrink-0 border-b border-[#2a2d3a] px-3 py-1.5">
          {manifest.permissions && manifest.permissions.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 mb-1">
              {manifest.permissions.map((p) => (
                <span key={p} className="rounded bg-indigo-500/10 px-1.5 py-0.5 text-[9px] text-indigo-300 font-mono">
                  {p}
                </span>
              ))}
            </div>
          )}
          {manifest.agents && manifest.agents.length > 0 && (
            <div className="flex flex-col gap-0.5">
              {manifest.agents.map((a) => (
                <div key={a.name} className="text-[10px] text-slate-500">
                  {'🤖'} {a.name}{a.model ? ` (${a.model})` : ''}
                  {a.tools && a.tools.length > 0 && ` · tools: ${a.tools.join(', ')}`}
                  {a.maxToolRounds && ` · maxRounds: ${a.maxToolRounds}`}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {showDetails && !hasMeta && (
        <div className="shrink-0 border-b border-[#2a2d3a] px-3 py-1.5 text-[10px] text-slate-600">
          No permissions or agents declared
        </div>
      )}

      <div className="min-h-0 flex-1 bg-white">
        <iframe
          ref={iframeRef}
          key={`${openedApp.appId}-${openedApp.updatedAt}`}
          src={iframeSrc}
          title={openedApp.title}
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-modals"
          className="h-full w-full border-0"
          onError={() => setError(t.appModalLoadFailed)}
        />
      </div>
    </div>
  );
}
