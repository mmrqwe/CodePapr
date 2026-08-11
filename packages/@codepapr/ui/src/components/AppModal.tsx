import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useAppRuntimeStore } from '../store/appRuntimeStore';
import { getTranslation } from '../utils/i18n';
import type { Lang } from '../utils/i18n';
import type { PaprManifest } from '@codepapr/types';
import { usePaprBridge } from '../papr/usePaprBridge';

interface AppModalProps {
  lang?: Lang;
  isDark: boolean;
}

export function AppModal({ lang, isDark }: AppModalProps) {
  const t = getTranslation(lang);
  const openedAppId = useAppRuntimeStore((state) => state.openedAppId);
  const openedApp = useAppRuntimeStore((state) =>
    state.openedAppId ? state.apps.find((app) => app.appId === state.openedAppId) ?? null : null
  );
  const closeAppModal = useAppRuntimeStore((state) => state.closeAppModal);
  const reloadApp = useAppRuntimeStore((state) => state.reloadApp);
  const [error, setError] = useState('');
  const [showDetails, setShowDetails] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const loadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 超时回调读 ref 而非 state：旧实现闭包捕获了 effect 运行时（切换前的）
  // loaded 值，从已加载 app 切到失败 app 时 10s 后 `if (!loaded)` 恒 false，
  // 白屏且无任何错误提示。
  const loadedRef = useRef(false);

  const handleIframeLoad = useCallback(() => {
    loadedRef.current = true;
    if (loadTimerRef.current) {
      clearTimeout(loadTimerRef.current);
      loadTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    loadedRef.current = false;
    setError('');
    loadTimerRef.current = setTimeout(() => {
      if (!loadedRef.current) {
        setError(t.appModalLoadFailed);
      }
    }, 10_000);
    return () => {
      if (loadTimerRef.current) {
        clearTimeout(loadTimerRef.current);
        loadTimerRef.current = null;
      }
    };
  }, [openedAppId, openedApp?.updatedAt]);

  const manifest: PaprManifest | null = useMemo(() => {
    if (!openedApp?.manifestJson) return null;
    try {
      return JSON.parse(openedApp.manifestJson) as PaprManifest;
    } catch {
      return null;
    }
  }, [openedApp?.manifestJson]);

  const { postTheme } = usePaprBridge({
    iframeRef,
    appId: openedApp?.appId ?? '',
    manifest,
    dark: isDark,
  });

  if (!openedApp) {
    return null;
  }

  const iframeSrc = `codepapr-app://${openedApp.appId}/index.html`;

  const hasMeta = (manifest?.permissions && manifest.permissions.length > 0)
    || (manifest?.agents && manifest.agents.length > 0);

  return (
    <div className="flex h-full w-full flex-col bg-[#0f1117]">
      <div className="flex shrink-0 items-center gap-2 border-b border-[#2a2d3a] px-3 py-2">
        <button
          type="button"
          onClick={closeAppModal}
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
          onClick={() => { setError(''); reloadApp(openedApp.appId); }}
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
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
          className="h-full w-full border-0"
          onLoad={() => {
            handleIframeLoad();
            postTheme(isDark);
          }}
          onError={() => setError(t.appModalLoadFailed)}
        />
      </div>
    </div>
  );
}
