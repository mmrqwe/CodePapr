import { useAppRuntimeStore } from '../store/appRuntimeStore';
import { invoke } from '@tauri-apps/api/core';
import { getTranslation } from '../utils/i18n';
import type { Lang } from '../utils/i18n';

interface AppDockPanelProps {
  lang?: Lang;
}

export function AppDockPanel({ lang }: AppDockPanelProps) {
  const t = getTranslation(lang);
  const apps = useAppRuntimeStore((state) => state.apps);
  const openAppModal = useAppRuntimeStore((state) => state.openAppModal);
  const closeApp = useAppRuntimeStore((state) => state.closeApp);

  const handleDelete = async (appId: string) => {
    try {
      await invoke('unregister_app_workspace', { appId });
    } catch {
      // ignore unregister failures (e.g., app not registered)
    }
    closeApp(appId);
  };

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
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-thin scrollbar-stable">
        {apps.map((app) => (
          <div
            key={app.appId}
            className="flex items-center gap-3 border-b border-[#2a2d3a] px-4 py-3 transition-colors hover:bg-[#11141c]"
          >
            <div className="flex-shrink-0 text-lg leading-none">
              {app.icon && app.icon.trim().length > 0
                ? app.icon.trim().slice(0, 2)
                : '🖥️'}
            </div>

            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-semibold text-slate-200">{app.title}</div>
              <div className="mt-0.5 truncate text-[10px] text-slate-600">
                {app.filePath}
              </div>
              <div className="mt-0.5 text-[10px] text-slate-600">
                {t.appDockUpdatedAt}: {new Date(app.updatedAt).toLocaleTimeString()}
              </div>
            </div>

            <div className="flex flex-shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => openAppModal(app.appId)}
                title={t.appDockOpen}
                className="rounded-md border border-indigo-500/40 px-2.5 py-1.5 text-[10px] font-medium text-indigo-200 transition-colors hover:border-indigo-400 hover:text-white"
              >
                {t.appDockOpen}
              </button>
              <button
                type="button"
                onClick={() => handleDelete(app.appId)}
                title={t.appDockDelete}
                className="rounded-md border border-red-500/30 px-2.5 py-1.5 text-[10px] font-medium text-red-200 transition-colors hover:border-red-400/60 hover:text-red-100"
              >
                {t.appDockDelete}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
