import { open } from '@tauri-apps/plugin-dialog';
import { useAgentStore, WorkspaceEntry } from '../store/agentStore';
import { normalizeSettings } from '../store/internals/settingsNormalizer';
import { saveAppSettings } from '../utils/appSettingsStorage';
import { getTranslation } from '../utils/i18n';

function timeLabel(ms: number, t: ReturnType<typeof getTranslation>): string {
  if (!ms) {
    return '';
  }
  const diff = Date.now() - ms;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return days === 1 ? t.oneDayAgo : `${days}${t.daysAgo}`;
  }
  if (hours > 0) {
    return `${hours}${t.hoursAgo}`;
  }
  if (minutes > 0) {
    return `${minutes}${t.minutesAgo}`;
  }
  return t.justNow;
}

export function ProjectSwitcherModal({ onClose }: { onClose: () => void }) {
  const { settings, workspacePath, openWorkspace, closeWorkspace, setSettings } = useAgentStore();
  const t = getTranslation(settings.lang);

  const handleOpenWorkspace = async (path: string) => {
    onClose();
    try {
      await openWorkspace(path);
    } catch (e) {
      console.warn('Open workspace failed:', e);
    }
  };

  const handleRemove = (path: string) => {
    const next = settings.recentWorkspaces.filter((e) => e.path !== path);
    const nextSettings = normalizeSettings({ ...settings, recentWorkspaces: next });
    setSettings(nextSettings);
    void saveAppSettings(nextSettings).catch(() => undefined);
  };

  const handleTogglePin = (path: string) => {
    const next = settings.recentWorkspaces.map((e) =>
      e.path === path ? { ...e, pinned: !e.pinned } : e,
    );
    const nextSettings = normalizeSettings({ ...settings, recentWorkspaces: next });
    setSettings(nextSettings);
    void saveAppSettings(nextSettings).catch(() => undefined);
  };

  const handleChooseFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t.projectFolder,
      });
      if (typeof selected === 'string') {
        onClose();
        try {
          await openWorkspace(selected);
        } catch (e) {
          console.warn('Open workspace failed:', e);
        }
      }
    } catch {
      // User cancelled
    }
  };

  const handleCloseWorkspace = () => {
    if (!workspacePath) return;
    onClose();
    closeWorkspace();
  };

  const pinned: WorkspaceEntry[] = [];
  const unpinned: WorkspaceEntry[] = [];
  for (const entry of settings.recentWorkspaces) {
    if (entry.pinned) {
      pinned.push(entry);
    } else {
      unpinned.push(entry);
    }
  }
  unpinned.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  const sorted = [...pinned, ...unpinned];

  return (
    <div className="fixed inset-0 z-50 flex select-none items-center justify-center bg-black/70 backdrop-blur-sm animate-fade-in">
      <div className="flex w-[min(92vw,520px)] flex-col overflow-hidden rounded-3xl border border-[#2a2d3a] bg-[#1a1d27] shadow-2xl">
        <div className="flex items-start justify-between border-b border-[#2a2d3a] px-7 py-5">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">{t.recentProjects}</h2>
            <p className="mt-1 text-sm text-slate-500">{t.recentProjectsDesc}</p>
          </div>
          <button
            onClick={onClose}
            title={t.cancel}
            className="text-2xl leading-none text-slate-500 hover:text-slate-300"
          >
            ×
          </button>
        </div>

        <div className="max-h-[56vh] overflow-y-auto overscroll-contain scrollbar-thin scrollbar-stable px-5 py-4">
          {sorted.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-sm text-slate-500">{t.noRecentProjects}</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {sorted.map((entry) => {
                const isActive = entry.path === workspacePath;
                return (
                  <div
                    key={entry.path}
                    className={`group flex items-center gap-3 rounded-xl px-4 py-3 transition-colors
                      ${isActive
                        ? 'border border-indigo-500/30 bg-indigo-500/10'
                        : 'border border-transparent hover:bg-[#141720]'
                      }`}
                  >
                    <button
                      onClick={() => void handleOpenWorkspace(entry.path)}
                      className="flex-1 min-w-0 text-left"
                    >
                      <div className="flex items-center gap-2">
                        <span className={`text-sm font-medium truncate ${isActive ? 'text-indigo-200' : 'text-slate-200'}`}>
                          {entry.name}
                        </span>
                        {entry.pinned && (
                          <span className="flex-shrink-0 text-[10px] leading-none text-amber-400/70">◆</span>
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-slate-600">{entry.path}</p>
                      <p className="mt-0.5 text-[10px] text-slate-700">
                        {entry.pinned ? t.pinned : ''}
                        {entry.pinned && entry.lastOpenedAt ? ' · ' : ''}
                        {entry.lastOpenedAt ? timeLabel(entry.lastOpenedAt, t) : ''}
                      </p>
                    </button>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleTogglePin(entry.path); }}
                        title={entry.pinned ? t.unpinProject : t.pinProject}
                        className={`rounded-lg p-1.5 text-xs transition-colors ${
                          entry.pinned
                            ? 'text-amber-400 hover:bg-amber-500/10'
                            : 'text-slate-600 hover:text-slate-300 hover:bg-[#2a2d3a]'
                        }`}
                      >
                        {entry.pinned ? '◆' : '◇'}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleRemove(entry.path); }}
                        title={t.removeFromList}
                        className="rounded-lg p-1.5 text-xs text-slate-600 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="space-y-2 border-t border-[#2a2d3a] bg-[#161922] px-6 py-4">
          <button
            onClick={handleCloseWorkspace}
            disabled={!workspacePath}
            title={t.closeProjectTip}
            className="w-full rounded-xl border border-[#2a2d3a] px-4 py-2.5 text-sm font-medium text-slate-300 transition-colors hover:border-slate-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t.closeProject}
          </button>
          <button
            onClick={() => void handleChooseFolder()}
            className="w-full rounded-xl border border-dashed border-indigo-500/30 px-4 py-2.5 text-sm font-medium text-indigo-200 transition-colors hover:border-indigo-400 hover:bg-indigo-500/10"
          >
            {t.openOtherFolder}
          </button>
        </div>
      </div>
    </div>
  );
}
