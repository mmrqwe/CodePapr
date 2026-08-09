import { useState, useCallback, useEffect } from 'react';
import { useAppRuntimeStore, type AppInstance } from '../store/appRuntimeStore';
import { useAgentStore } from '../store/agentStore';
import { usePermissionStore } from '../papr/permissionStore';
import { invoke } from '@tauri-apps/api/core';
import { launchAppBackend } from '../tools/workspaceAppTools';
import { getTranslation } from '../utils/i18n';
import type { Lang } from '../utils/i18n';

interface AppDockPanelProps {
  lang?: Lang;
}

export function AppDockPanel({ lang }: AppDockPanelProps) {
  const t = getTranslation(lang);
  const workspacePath = useAgentStore((state) => state.workspacePath);
  const apps = useAppRuntimeStore((state) => state.apps);
  const openAppModal = useAppRuntimeStore((state) => state.openAppModal);
  const closeApp = useAppRuntimeStore((state) => state.closeApp);
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

  const handleDoubleClick = useCallback((app: AppInstance) => {
    openAppModal(app.appId);
  }, [openAppModal]);

  const handleStart = useCallback(async () => {
    if (!selected || !selected.command || !selected.port || isRunning) return;
    setBusy(true);
    setError('');
    try {
      // 与 app_start 工具同一条启动路径：manifest 沙箱 + 端口预检 + 监听等待
      const { pid, url } = await launchAppBackend(
        {
          appId: selected.appId,
          command: selected.command,
          args: selected.args ?? [],
          port: selected.port,
          manifestJson: selected.manifestJson,
        },
        workspacePath,
      );
      setAppRunning(selected.appId, pid, url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [selected, isRunning, workspacePath, setAppRunning]);

  const handleOpen = useCallback(() => {
    if (!selected) return;
    openAppModal(selected.appId);
  }, [selected, openAppModal]);

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
    setBusy(true);
    if (selected.pid) {
      try { await invoke('stop_background_process', { pid: selected.pid, source: 'app-dock-delete' }); } catch { /* ignore */ }
    }
    try { await invoke('papr_delete_app', { appId: selected.appId }); } catch { /* ignore */ }
    try { await invoke('unregister_app_workspace', { appId: selected.appId }); } catch { /* ignore */ }
    usePermissionStore.getState().clearManifest(selected.appId);
    if (selectedId === selected.appId) setSelectedId(null);
    closeApp(selected.appId);
    setBusy(false);
  }, [selected, selectedId, closeApp]);

  const canStart = !!(selected && hasBackend && !isRunning && !busy);
  const canOpen = !!(selected && !busy && (!hasBackend || isRunning));
  const canStop = !!(selected && isRunning && !busy);
  const canDelete = !!(selected && !busy);

  useEffect(() => {
    const runningApps = apps.filter((a) => a.pid && a.port);
    if (runningApps.length === 0) return;
    const timer = setInterval(async () => {
      for (const app of runningApps) {
        try {
          // 进程存活是后端生死的直接证据；端口探测只是间接证据——
          // check_port_available 只绑 IPv4 127.0.0.1，当后端监听在 IPv6（::）
          // 时 IPv4 绑定会成功，误判「端口空闲」→ 错误 setAppStopped →
          // 连带关掉打开的 app 弹窗（用户看到的「15 秒自动退出」）。
          // 因此：只要进程还活着就绝不判停。
          const alive: boolean = await invoke('background_process_alive', { pid: app.pid });
          if (alive) continue;
          // 进程确实已死，再用端口二次确认（进程条目可能刚被清理）
          const available: boolean = await invoke('check_port_available', { port: app.port });
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
        <div className="text-xs font-semibold text-slate-400">{t.appDockEmptyTitle}</div>
        <p className="mt-1.5 max-w-[260px] text-[11px] leading-relaxed text-slate-600">
          {t.appDockEmptyDesc}
        </p>
      </div>
    );
  }

  const btnBase = 'rounded border px-3 py-1.5 text-[11px] font-medium transition-colors';
  const btnActive = (active: boolean) =>
    `${btnBase} ${
      active
        ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-200 hover:border-indigo-400 hover:text-white'
        : 'border-[#2a2d3a] text-slate-600 cursor-not-allowed'
    }`;

  const btnGreen = (active: boolean) =>
    `${btnBase} ${
      active
        ? 'border-emerald-500/40 text-emerald-200 hover:border-emerald-400 hover:text-white'
        : 'border-[#2a2d3a] text-slate-600 cursor-not-allowed'
    }`;

  const btnAmber = (active: boolean) =>
    `${btnBase} ${
      active
        ? 'border-amber-500/40 text-amber-200 hover:border-amber-400 hover:text-white'
        : 'border-[#2a2d3a] text-slate-600 cursor-not-allowed'
    }`;

  const btnRed = (active: boolean) =>
    `${btnBase} ${
      active
        ? 'border-red-500/30 text-red-200 hover:border-red-400/60 hover:text-red-100'
        : 'border-[#2a2d3a] text-slate-600 cursor-not-allowed'
    }`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {error && (
        <div className="shrink-0 mx-3 mt-2 rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] text-red-300">
          {error}
          <button type="button" onClick={() => setError('')} className="ml-2 text-slate-500 hover:text-slate-300">×</button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {apps.map((app) => {
          const appRunning = !!(app.command && app.port && app.pid && app.url);
          const isSelected = app.appId === selectedId;
          return (
            <div
              key={app.appId}
              onClick={() => handleSelect(app.appId)}
              onDoubleClick={() => handleDoubleClick(app)}
              className={`flex cursor-pointer items-center gap-2 px-3 py-2 transition-colors ${
                isSelected
                  ? 'bg-indigo-500/15 border-l-2 border-indigo-500'
                  : 'hover:bg-[#1a1d28] border-l-2 border-transparent'
              }`}
            >
              <span
                className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${
                  appRunning ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.4)]' : 'bg-red-400'
                }`}
              />
              <span className="flex-shrink-0 text-sm leading-none">
                {app.icon && app.icon.trim().length > 0 ? app.icon.trim().slice(0, 2) : '🖥️'}
              </span>
              <span className="truncate text-xs text-slate-200">{app.title}</span>
            </div>
          );
        })}
      </div>

      <div className="shrink-0 flex items-center gap-1.5 border-t border-[#2a2d3a] px-3 py-2">
        <button type="button" disabled={!canStart} onClick={handleStart} className={btnGreen(canStart)}>
          ▶ {t.appDockRun}
        </button>
        <button type="button" disabled={!canOpen} onClick={handleOpen} className={btnActive(canOpen)}>
          {t.appDockOpen}
        </button>
        <button type="button" disabled={!canStop} onClick={handleStop} className={btnAmber(canStop)}>
          ■ {t.appDockStop}
        </button>
        <button type="button" disabled={!canDelete} onClick={handleDelete} className={btnRed(canDelete)}>
          🗑 {t.appDockDelete}
        </button>
      </div>
    </div>
  );
}
