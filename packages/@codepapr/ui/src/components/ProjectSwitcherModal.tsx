import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { useAgentStore, WorkspaceEntry } from '../store/agentStore';
import { normalizeSettings } from '../store/internals/settingsNormalizer';
import { getTranslation } from '../utils/i18n';
import { toast } from '../store/toastStore';

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
      // N12：打开失败（路径失效/被移动等）不再静默——当前工作区保持原样
      // （openWorkspace 先加载后切换），明确提示用户该条目可能已失效。
      const detail = e instanceof Error ? e.message : String(e);
      const message =
        settings.lang === 'en'
          ? `Failed to open project: ${detail}. The current workspace was kept.`
          : settings.lang === 'zh-TW'
            ? `開啟專案失敗：${detail}。目前的工作區已保留。`
            : `打开项目失败：${detail}。当前工作区已保留。`;
      toast.error(message);
    }
  };

  const handleRemove = async (path: string) => {
    const next = settings.recentWorkspaces.filter((e) => e.path !== path);
    // 先 await 在 Rust 侧原子落库（与 setSettings 的异步保存解耦）：
    // 移除后立刻退出也不会在下次启动时"复活"。
    await invoke('set_recent_workspaces', { workspacesJson: JSON.stringify(next) }).catch(() => undefined);
    // preserveAgent：置顶/移除属于纯 UI 变更，不打断进行中的 agent 回合。
    setSettings(normalizeSettings({ ...settings, recentWorkspaces: next }), { preserveAgent: true });
  };

  const handleTogglePin = async (path: string) => {
    const next = settings.recentWorkspaces.map((e) =>
      e.path === path ? { ...e, pinned: !e.pinned } : e,
    );
    await invoke('set_recent_workspaces', { workspacesJson: JSON.stringify(next) }).catch(() => undefined);
    setSettings(normalizeSettings({ ...settings, recentWorkspaces: next }), { preserveAgent: true });
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
          // N12：与最近项目入口同口径——明确提示，当前工作区保持原样。
          const detail = e instanceof Error ? e.message : String(e);
          toast.error(
            settings.lang === 'en'
              ? `Failed to open project: ${detail}.`
              : settings.lang === 'zh-TW'
                ? `開啟專案失敗：${detail}。`
                : `打开项目失败：${detail}。`
          );
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
    <div className="fixed inset-0 z-50 flex select-none items-center justify-center bg-overlay backdrop-blur-sm animate-fade-in">
      <div className="flex w-[min(92vw,520px)] flex-col overflow-hidden rounded-3xl border border-line bg-raised shadow-2xl">
        <div className="flex items-start justify-between border-b border-line px-7 py-5">
          <div>
            <h2 className="text-lg font-semibold text-fg">{t.recentProjects}</h2>
            <p className="mt-1 text-sm text-fg-muted">{t.recentProjectsDesc}</p>
          </div>
          <button
            onClick={onClose}
            title={t.cancel}
            className="text-2xl leading-none text-fg-muted hover:text-fg-soft"
          >
            ×
          </button>
        </div>

        <div className="max-h-[56vh] overflow-y-auto overscroll-contain scrollbar-thin scrollbar-stable px-5 py-4">
          {sorted.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-sm text-fg-muted">{t.noRecentProjects}</p>
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
                        ? 'border border-accent-soft bg-accent-soft'
                        : 'border border-transparent hover:bg-base'
                      }`}
                  >
                    <button
                      onClick={() => void handleOpenWorkspace(entry.path)}
                      className="flex-1 min-w-0 text-left"
                    >
                      <div className="flex items-center gap-2">
                        <span className={`text-sm font-medium truncate ${isActive ? 'text-accent-text' : 'text-fg'}`}>
                          {entry.name}
                        </span>
                        {entry.pinned && (
                          <span className="flex-shrink-0 text-[10px] leading-none text-warn">◆</span>
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-fg-dim">{entry.path}</p>
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
                            ? 'text-warn hover:bg-warn-bg'
                            : 'text-fg-dim hover:text-fg-soft hover:bg-control'
                        }`}
                      >
                        {entry.pinned ? '◆' : '◇'}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleRemove(entry.path); }}
                        title={t.removeFromList}
                        className="rounded-lg p-1.5 text-xs text-fg-dim hover:text-danger hover:bg-danger-bg transition-colors"
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

        <div className="space-y-2 border-t border-line bg-base px-6 py-4">
          <button
            onClick={handleCloseWorkspace}
            disabled={!workspacePath}
            title={t.closeProjectTip}
            className="w-full rounded-xl border border-line px-4 py-2.5 text-sm font-medium text-fg-soft transition-colors hover:border-line-strong hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t.closeProject}
          </button>
          <button
            onClick={() => void handleChooseFolder()}
            className="w-full rounded-xl border border-dashed border-accent-soft px-4 py-2.5 text-sm font-medium text-accent-text transition-colors hover:border-accent hover:bg-accent-soft"
          >
            {t.openOtherFolder}
          </button>
        </div>
      </div>
    </div>
  );
}
