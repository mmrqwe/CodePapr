import { useState, useCallback, useEffect } from 'react';
import { useAppRuntimeStore, type AppInstance } from '../store/appRuntimeStore';
import { useAgentStore } from '../store/agentStore';
import { usePermissionStore } from '../papr/permissionStore';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { launchAppBackend } from '../tools/workspaceAppTools';
import { getTranslation } from '../utils/i18n';
import type { Lang } from '../utils/i18n';
import { isPluginApp } from '../papr/pluginSurface';

interface AppDockPanelProps {
  lang?: Lang;
}

export function AppDockPanel({ lang }: AppDockPanelProps) {
  const t = getTranslation(lang);
  const workspacePath = useAgentStore((state) => state.workspacePath);
  const apps = useAppRuntimeStore((state) => state.apps);
  const openAppModal = useAppRuntimeStore((state) => state.openAppModal);
  const closeApp = useAppRuntimeStore((state) => state.closeApp);
  const pinPlugin = useAppRuntimeStore((state) => state.pinPlugin);
  const unpinPlugin = useAppRuntimeStore((state) => state.unpinPlugin);
  const pinnedPluginIds = useAppRuntimeStore((state) => state.pinnedPluginIds);
  const setAppRunning = useAppRuntimeStore((state) => state.setAppRunning);
  const setAppStopped = useAppRuntimeStore((state) => state.setAppStopped);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const selected = apps.find((a) => a.appId === selectedId) ?? null;
  const hasBackend = !!(selected?.command && selected?.port);
  const isRunning = hasBackend && !!selected?.pid && !!selected?.url;

  const handleSelect = useCallback((appId: string) => {
    setError('');
    setSelectedId(appId);
  }, []);

  const startBackendIfNeeded = useCallback(async (app: AppInstance): Promise<boolean> => {
    const needsBackend = !!(app.command && app.port);
    const running = needsBackend && !!app.pid && !!app.url;
    if (!needsBackend || running) return true;
    if (!app.command || app.port == null) return false;
    setBusy(true);
    setError('');
    try {
      const { pid, url } = await launchAppBackend(
        {
          appId: app.appId,
          command: app.command,
          args: app.args ?? [],
          port: app.port,
          manifestJson: app.manifestJson,
        },
        workspacePath,
      );
      setAppRunning(app.appId, pid, url);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }, [workspacePath, setAppRunning]);

  const handleDoubleClick = useCallback(async (app: AppInstance) => {
    if (isPluginApp(app)) {
      if (pinnedPluginIds.includes(app.appId)) unpinPlugin(app.appId);
      else pinPlugin(app.appId);
      return;
    }
    const ok = await startBackendIfNeeded(app);
    if (!ok) return;
    openAppModal(app.appId);
  }, [startBackendIfNeeded, openAppModal, pinPlugin, unpinPlugin, pinnedPluginIds]);

  const handleStart = useCallback(async () => {
    if (!selected || !selected.command || !selected.port || isRunning) return;
    await startBackendIfNeeded(selected);
  }, [selected, isRunning, startBackendIfNeeded]);

  const handleOpen = useCallback(async () => {
    if (!selected) return;
    if (isPluginApp(selected)) {
      if (pinnedPluginIds.includes(selected.appId)) unpinPlugin(selected.appId);
      else pinPlugin(selected.appId);
      return;
    }
    const ok = await startBackendIfNeeded(selected);
    if (!ok) return;
    openAppModal(selected.appId);
  }, [selected, startBackendIfNeeded, openAppModal, pinPlugin, unpinPlugin, pinnedPluginIds]);

  const handleStop = useCallback(async () => {
    if (!selected || !selected.pid) return;
    setBusy(true);
    try {
      await invoke('stop_background_process', { pid: selected.pid, source: 'app-dock-stop' });
    } catch {
      // ignore
    }
    setAppStopped(selected.appId);
    setBusy(false);
  }, [selected, setAppStopped]);

  const handleDelete = useCallback(async () => {
    if (!selected) return;
    // N13：删除不可逆（整个 app 目录含 db.sqlite），必须先确认——与角色卡/
    // 会话删除一致。取消则什么都不做。
    const confirmText =
      lang === 'en'
        ? `Delete app "${selected.title}"? Its directory and local data (database) will be permanently removed.`
        : lang === 'zh-TW'
          ? `刪除應用「${selected.title}」？其目錄與本地資料（資料庫）將被永久移除。`
          : `删除应用「${selected.title}」？其目录与本地数据（数据库）将被永久移除。`;
    if (typeof window !== 'undefined' && !window.confirm(confirmText)) return;

    setBusy(true);
    setError('');
    if (selected.pid) {
      try { await invoke('stop_background_process', { pid: selected.pid, source: 'app-dock-delete' }); } catch { /* ignore */ }
    }
    try {
      await invoke('papr_delete_app', { appId: selected.appId });
    } catch (e) {
      // N13：删除失败必须可见，且绝不能从 UI 移除该 app——目录仍在磁盘上，
      // 移除只会在下次启动时被扫描回来（"假删除"）。
      const detail = e instanceof Error ? e.message : String(e);
      setError(
        lang === 'en'
          ? `Failed to delete app: ${detail}`
          : lang === 'zh-TW'
            ? `刪除應用失敗：${detail}`
            : `删除应用失败：${detail}`
      );
      setBusy(false);
      return;
    }
    // 目录已删除：unregister 失败只影响映射，app 本身已不可恢复，尽力而为。
    try { await invoke('unregister_app_workspace', { appId: selected.appId }); } catch { /* ignore */ }
    usePermissionStore.getState().clearManifest(selected.appId);
    if (selectedId === selected.appId) setSelectedId(null);
    closeApp(selected.appId);
    setBusy(false);
  }, [selected, selectedId, closeApp, lang]);

  const selectedIsPlugin = !!(selected && isPluginApp(selected));
  const selectedPinned = !!(selected && pinnedPluginIds.includes(selected.appId));
  const canStart = !!(selected && hasBackend && !isRunning && !busy && !selectedIsPlugin);
  const canOpen = !!(selected && !busy);
  const canStop = !!(selected && isRunning && !busy && !selectedIsPlugin);
  const canDelete = !!(selected && !busy);
  const canExport = !!(selected && !busy);

  const handleExport = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      const dest = await save({
        defaultPath: `${selected.appId}.zip`,
        filters: [{ name: 'Zip', extensions: ['zip'] }],
      });
      if (!dest) return;
      await invoke('papr_export_app', {
        workspacePath,
        appId: selected.appId,
        destZip: dest,
      });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      setError(`${t.appExportFailed}: ${detail}`);
    } finally {
      setBusy(false);
    }
  }, [selected, workspacePath, t.appExportFailed]);

  useEffect(() => {
    const runningApps = apps.filter((a) => a.pid && a.port);
    if (runningApps.length === 0) return;
    const timer = setInterval(async () => {
      for (const app of runningApps) {
        try {
          // 进程存活是后端生死的直接证据；端口探测只是间接证据——
          // check_port_available 只绑 IPv4 127.0.0.1，当后端监听在 IPv6（::）
          // 时 IPv4 绑定会成功，误判「端口空闲」→ 错误 setAppStopped。
          // 停后端不再关闭已打开的窗口：AppModal 会提示「后端已停止」并提供重启。
          // 因此：只要进程还活着就绝不判停。
          const alive: boolean = await invoke('background_process_alive', { pid: app.pid });
          if (alive) continue;
          const runtimePort = app.url ? Number(new URL(app.url).port) : app.port;
          if (!runtimePort) {
            useAppRuntimeStore.getState().setAppStopped(app.appId);
            continue;
          }
          const available: boolean = await invoke('check_port_available', { port: runtimePort });
          if (available) {
            useAppRuntimeStore.getState().setAppStopped(app.appId);
          }
        } catch { /* ignore */ }
      }
    }, 15_000);
    return () => clearInterval(timer);
  }, [apps]);

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
        <div className="text-xs font-semibold text-fg-muted">{t.appDockEmptyTitle}</div>
        <p className="mt-1.5 max-w-[260px] text-[11px] leading-relaxed text-fg-dim">
          {t.appDockEmptyDesc}
        </p>
      </div>
    );
  }

  const btnBase = 'rounded border px-3 py-1.5 text-[11px] font-medium transition-colors';
  const btnActive = (active: boolean) =>
    `${btnBase} ${
      active
        ? 'border-accent-soft bg-accent-soft text-accent-text hover:border-accent hover:text-fg'
        : 'border-line text-fg-dim cursor-not-allowed'
    }`;

  const btnGreen = (active: boolean) =>
    `${btnBase} ${
      active
        ? 'border-ok-bg text-ok hover:border-ok hover:text-fg'
        : 'border-line text-fg-dim cursor-not-allowed'
    }`;

  const btnAmber = (active: boolean) =>
    `${btnBase} ${
      active
        ? 'border-warn-bg text-warn hover:border-warn hover:text-fg'
        : 'border-line text-fg-dim cursor-not-allowed'
    }`;

  const btnRed = (active: boolean) =>
    `${btnBase} ${
      active
        ? 'border-danger-bg text-danger hover:border-danger-bg hover:text-danger'
        : 'border-line text-fg-dim cursor-not-allowed'
    }`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {error && (
        <div className="shrink-0 mx-3 mt-2 rounded border border-danger-bg bg-danger-bg px-2 py-1 text-[10px] text-danger">
          {error}
          <button type="button" onClick={() => setError('')} className="ml-2 text-fg-muted hover:text-fg-soft">×</button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {apps.map((app) => {
          const hasBackend = !!(app.command && app.port);
          const appRunning = hasBackend && !!app.pid && !!app.url;
          const isSelected = app.appId === selectedId;
          const plugin = isPluginApp(app);
          const pinned = pinnedPluginIds.includes(app.appId);
          const statusLabel = plugin
            ? pinned
              ? t.appDockPinned
              : t.appDockReady
            : !hasBackend
            ? t.appDockReady
            : appRunning
              ? t.appDockRunning
              : t.appDockStopped;
          return (
            <div
              key={app.appId}
              onClick={() => handleSelect(app.appId)}
              onDoubleClick={() => handleDoubleClick(app)}
              className={`flex cursor-pointer items-center gap-2 px-3 py-2 transition-colors ${
                isSelected
                  ? 'bg-accent-soft border-l-2 border-accent'
                  : 'hover:bg-base border-l-2 border-transparent'
              }`}
            >
              <span
                title={statusLabel}
                className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${
                  plugin
                    ? pinned
                      ? 'bg-accent shadow-[0_0_6px_rgba(99,102,241,0.45)]'
                      : 'bg-fg-muted'
                    : !hasBackend
                    ? 'bg-fg-muted'
                    : appRunning
                      ? 'bg-ok shadow-[0_0_6px_rgba(52,211,153,0.4)]'
                      : 'bg-danger'
                }`}
              />
              <span className="flex-shrink-0 text-sm leading-none">
                {app.icon && app.icon.trim().length > 0 ? app.icon.trim().slice(0, 2) : plugin ? '📌' : '🖥️'}
              </span>
              <span className="truncate text-xs text-fg">{app.title}</span>
              {plugin && (
                <span className="ml-auto shrink-0 rounded bg-raised px-1 py-0.5 text-[9px] text-fg-muted">
                  {t.appDockPluginBadge}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="shrink-0 flex items-center gap-1.5 border-t border-line px-3 py-2">
        <button type="button" disabled={!canStart} onClick={handleStart} className={btnGreen(canStart)}>
          ▶ {t.appDockRun}
        </button>
        <button type="button" disabled={!canOpen} onClick={() => { void handleOpen(); }} className={btnActive(canOpen)}>
          {selectedIsPlugin ? (selectedPinned ? t.appDockUnpin : t.appDockPin) : t.appDockOpen}
        </button>
        <button type="button" disabled={!canStop} onClick={handleStop} className={btnAmber(canStop)}>
          ■ {t.appDockStop}
        </button>
        <button type="button" disabled={!canDelete} onClick={handleDelete} className={btnRed(canDelete)}>
          🗑 {t.appDockDelete}
        </button>
        <button type="button" disabled={!canExport} onClick={() => { void handleExport(); }} className={btnActive(canExport)}>
          ⤓ {t.appDockExport}
        </button>
      </div>
    </div>
  );
}
