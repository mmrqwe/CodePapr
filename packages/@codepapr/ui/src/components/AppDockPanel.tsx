import { useEffect, useMemo } from 'react';
import { useAppRuntimeStore } from '../store/appRuntimeStore';
import { getTranslation } from '../utils/i18n';
import type { Lang } from '../utils/i18n';

interface AppDockPanelProps {
  lang?: Lang;
}

function AppIcon({ icon }: { icon?: string }) {
  if (icon && icon.trim().length > 0) {
    const trimmed = icon.trim();
    if (trimmed.length <= 2) {
      return <span className="text-[13px] leading-none">{trimmed}</span>;
    }
    return <span className="text-[11px] leading-none">{trimmed.slice(0, 1)}</span>;
  }
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5">
      <path
        d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v7A1.5 1.5 0 0 1 11.5 13h-7A1.5 1.5 0 0 1 3 11.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M6 8h4M8 6v4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export function AppDockPanel({ lang }: AppDockPanelProps) {
  const t = getTranslation(lang);
  const apps = useAppRuntimeStore((state) => state.apps);
  const activeAppId = useAppRuntimeStore((state) => state.activeAppId);
  const selectApp = useAppRuntimeStore((state) => state.selectApp);
  const closeApp = useAppRuntimeStore((state) => state.closeApp);
  const reloadActiveApp = useAppRuntimeStore((state) => state.reloadActiveApp);

  const activeApp = useMemo(
    () => apps.find((app) => app.appId === activeAppId) ?? null,
    [apps, activeAppId]
  );

  useEffect(() => {
    if (!activeApp && apps.length > 0) {
      selectApp(apps[apps.length - 1].appId);
    }
  }, [activeApp, apps, selectApp]);

  if (apps.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <svg viewBox="0 0 48 48" aria-hidden="true" className="mb-3 h-10 w-10 text-slate-700">
          <rect x="6" y="10" width="36" height="28" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 18h36" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="10" cy="14" r="1" fill="currentColor" />
          <circle cx="14" cy="14" r="1" fill="currentColor" />
          <path d="M18 28l4 4 8-8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
        <div className="text-xs font-semibold text-slate-400">{t.appDockEmptyTitle}</div>
        <p className="mt-1.5 max-w-[260px] text-[11px] leading-relaxed text-slate-600">
          {t.appDockEmptyDesc}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1.5 border-b border-[#2a2d3a] px-2 py-1.5 overflow-x-auto scrollbar-thin">
        {apps.map((app) => {
          const isActive = app.appId === activeAppId;
          return (
            <div
              key={app.appId}
              className={`group flex min-w-0 flex-shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 transition-colors ${
                isActive
                  ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-100'
                  : 'border-[#2a2d3a] text-slate-400 hover:border-indigo-500/30 hover:text-slate-200'
              }`}
            >
              <button
                type="button"
                onClick={() => selectApp(app.appId)}
                title={app.title}
                className="flex min-w-0 items-center gap-1.5 text-left"
              >
                <span className={`flex h-4 w-4 flex-shrink-0 items-center justify-center ${isActive ? 'text-indigo-200' : 'text-slate-500'}`}>
                  <AppIcon icon={app.icon} />
                </span>
                <span className="max-w-[140px] truncate text-[11px] font-medium">{app.title}</span>
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  closeApp(app.appId);
                }}
                title={t.appDockCloseApp}
                className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-slate-500 transition-colors hover:bg-red-500/20 hover:text-red-300"
              >
                <svg viewBox="0 0 12 12" aria-hidden="true" className="h-2.5 w-2.5">
                  <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>

      {activeApp && (
        <>
          <div className="flex items-center justify-between gap-2 border-b border-[#2a2d3a] px-3 py-1.5">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[11px] font-medium text-slate-300">{activeApp.title}</div>
              <div className="mt-0.5 truncate text-[10px] text-slate-600">
                {t.appDockFilePath}: {activeApp.filePath}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-slate-600">
                {t.appDockUpdatedAt}: {new Date(activeApp.updatedAt).toLocaleTimeString()}
              </span>
              <button
                type="button"
                onClick={reloadActiveApp}
                title={t.appDockReload}
                className="flex h-6 items-center rounded-md border border-[#2a2d3a] px-2 text-[10px] font-medium text-slate-400 transition-colors hover:border-indigo-500/50 hover:text-slate-100"
              >
                <svg viewBox="0 0 12 12" aria-hidden="true" className="mr-1 h-3 w-3">
                  <path
                    d="M10 6a4 4 0 1 1-1.2-2.85M10 2v2.5H7.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                {t.appDockReload}
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden bg-white">
            <iframe
              key={`${activeApp.appId}-${activeApp.updatedAt}`}
              srcDoc={activeApp.html}
              title={activeApp.title}
              sandbox="allow-scripts allow-popups allow-forms allow-modals"
              className="h-full w-full border-0 bg-white"
            />
          </div>
        </>
      )}
    </div>
  );
}
