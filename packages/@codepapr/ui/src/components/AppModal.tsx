import { useState, useMemo } from 'react';
import { useAppRuntimeStore } from '../store/appRuntimeStore';
import { getTranslation } from '../utils/i18n';
import type { Lang } from '../utils/i18n';

interface AppModalProps {
  lang?: Lang;
}

export function AppModal({ lang }: AppModalProps) {
  const t = getTranslation(lang);
  const openedAppId = useAppRuntimeStore((state) => state.openedAppId);
  const apps = useAppRuntimeStore((state) => state.apps);
  const closeAppModal = useAppRuntimeStore((state) => state.closeAppModal);
  const reloadActiveApp = useAppRuntimeStore((state) => state.reloadActiveApp);
  const [error, setError] = useState('');

  const openedApp = useMemo(
    () => apps.find((app) => app.appId === openedAppId) ?? null,
    [apps, openedAppId]
  );

  if (!openedApp) {
    return null;
  }

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-[#07090d]/70 p-6 backdrop-blur-sm">
      <div className="flex h-full max-h-[88vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-[#2a2d3a] bg-[#0f1117] shadow-[0_24px_90px_rgba(0,0,0,0.45)]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#2a2d3a] px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm">
                {openedApp.icon && openedApp.icon.trim().length > 0 ? openedApp.icon.trim().slice(0, 2) : '🖥️'}
              </span>
              <div className="truncate text-xs font-semibold text-slate-200">{openedApp.title}</div>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-500">
              <span>{t.appModalFilePath}: {openedApp.filePath}</span>
              <span>{t.appModalUpdatedAt}: {new Date(openedApp.updatedAt).toLocaleTimeString()}</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setError('');
                reloadActiveApp();
              }}
              className="rounded-md border border-[#2a2d3a] px-2 py-1 text-[10px] font-medium text-slate-300 transition-colors hover:border-indigo-500/50 hover:text-white"
            >
              {t.appModalReload}
            </button>
            <button
              type="button"
              onClick={closeAppModal}
              className="rounded-md border border-red-500/30 px-2 py-1 text-[10px] font-medium text-red-200 transition-colors hover:border-red-400/60 hover:text-red-100"
            >
              {t.appModalClose}
            </button>
          </div>
        </div>

        {error && (
          <div className="mx-4 mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
            {error}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-hidden bg-white">
          <iframe
            key={`${openedApp.appId}-${openedApp.updatedAt}`}
            src={`codepapr-app://localhost/${openedApp.appId}/index.html`}
            title={openedApp.title}
            sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-modals"
            className="h-full w-full border-0 bg-white"
            onError={() => setError(t.appModalLoadFailed)}
          />
        </div>
      </div>
    </div>
  );
}
