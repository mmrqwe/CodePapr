import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { usePreviewStore } from '../store/previewStore';
import { useAppRuntimeStore } from '../store/appRuntimeStore';
import { getTranslation } from '../utils/i18n';
import type { Lang } from '../utils/i18n';

interface BackgroundProcessEntry {
  pid: number;
  command: string;
  args: string[];
  workspacePath: string;
  startedAt: number;
  previewUrl?: string | null;
  logTail: string;
}

interface StopBackgroundProcessResult {
  pid: number;
  stopped: boolean;
}

interface StopAllBackgroundProcessesResult {
  stopped: number;
}

const AUTO_REFRESH_MS = 5000;
const TIME_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
};

function formatCommand(process: BackgroundProcessEntry): string {
  return [process.command, ...process.args].join(' ');
}

function toLocale(lang: Lang | undefined): string {
  switch (lang) {
    case 'en':
      return 'en-US';
    case 'zh-TW':
      return 'zh-TW';
    default:
      return 'zh-CN';
  }
}

function formatTime(value: number, lang: Lang | undefined): string {
  return new Date(value).toLocaleTimeString(toLocale(lang), TIME_FORMAT_OPTIONS);
}

interface BackgroundProcessPanelProps {
  workspacePath: string;
  lang?: Lang;
}

export function BackgroundProcessPanel({ workspacePath, lang }: BackgroundProcessPanelProps) {
  const t = getTranslation(lang);
  const activePreviewSession = usePreviewStore((state) => state.activePreviewSession);
  const openPreviewSession = usePreviewStore((state) => state.openPreviewSession);
  const clearPreviewSessionByPid = usePreviewStore((state) => state.clearPreviewSessionByPid);
  const [processes, setProcesses] = useState<BackgroundProcessEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [stoppingPid, setStoppingPid] = useState<number | null>(null);
  const [isStoppingAll, setIsStoppingAll] = useState(false);

  const activePreviewPid =
    activePreviewSession && activePreviewSession.workspacePath === workspacePath
      ? activePreviewSession.pid
      : null;

  const apps = useAppRuntimeStore((state) => state.apps);
  // previewUrl 与 app 的端口一一对应（http://localhost:<port>/）；命中即该进程是 app 后端
  const findOwnerApp = useCallback((previewUrl?: string | null) => {
    if (!previewUrl) return undefined;
    return apps.find((app) => app.port && previewUrl === `http://localhost:${app.port}/`);
  }, [apps]);

  const refreshProcesses = useCallback(async (silent: boolean = false) => {
    if (!workspacePath) {
      setProcesses([]);
      setError('');
      return;
    }

    if (!silent) {
      setIsLoading(true);
    }

    try {
      const result = await invoke<BackgroundProcessEntry[]>('list_background_processes', {
        workspacePath,
      });
      setProcesses(result);
      if (activePreviewPid !== null && !result.some((process) => process.pid === activePreviewPid)) {
        clearPreviewSessionByPid(activePreviewPid);
      }
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      if (!silent) {
        setIsLoading(false);
      }
    }
  }, [activePreviewPid, clearPreviewSessionByPid, workspacePath]);

  useEffect(() => {
    void refreshProcesses();

    if (!workspacePath) {
      return;
    }

    const timerId = window.setInterval(() => {
      void refreshProcesses(true);
    }, AUTO_REFRESH_MS);

    return () => {
      window.clearInterval(timerId);
    };
  }, [refreshProcesses, workspacePath]);

  const stopProcess = useCallback(async (pid: number) => {
    // 应用后端受 app_start/app_stop 生命周期管理：此处的通用停止按钮可能误触，
    // 停掉后应用立即不可用，必须先确认（也拦截无人操作的幽灵点击）。
    const process = processes.find((entry) => entry.pid === pid);
    const ownerApp = process ? findOwnerApp(process.previewUrl) : undefined;
    if (ownerApp && typeof window !== 'undefined'
      && !window.confirm(t.backgroundProcessStopAppConfirm.replace('{title}', ownerApp.title))) {
      return;
    }
    setStoppingPid(pid);
    try {
      await invoke<StopBackgroundProcessResult>('stop_background_process', { pid, source: 'background-process-panel' });
      clearPreviewSessionByPid(pid);
      await refreshProcesses(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStoppingPid(null);
    }
  }, [clearPreviewSessionByPid, findOwnerApp, processes, refreshProcesses, t]);

  const stopAllProcesses = useCallback(async () => {
    const ownedApps = processes
      .map((entry) => findOwnerApp(entry.previewUrl))
      .filter((app): app is NonNullable<typeof app> => app !== undefined);
    if (ownedApps.length > 0 && typeof window !== 'undefined') {
      const titles = Array.from(new Set(ownedApps.map((app) => app.title))).join('、');
      if (!window.confirm(t.backgroundProcessStopAppConfirm.replace('{title}', titles))) {
        return;
      }
    }
    setIsStoppingAll(true);
    try {
      await invoke<StopAllBackgroundProcessesResult>('stop_all_background_processes', {
        workspacePath,
        source: 'background-process-panel-stop-all',
      });
      if (activePreviewPid !== null) {
        clearPreviewSessionByPid(activePreviewPid);
      }
      await refreshProcesses(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsStoppingAll(false);
    }
  }, [activePreviewPid, clearPreviewSessionByPid, findOwnerApp, processes, refreshProcesses, t, workspacePath]);

  const openPreview = useCallback((process: BackgroundProcessEntry) => {
    if (!process.previewUrl) {
      return;
    }

    openPreviewSession({
      pid: process.pid,
      url: process.previewUrl,
      title: formatCommand(process),
      workspacePath,
    });
  }, [openPreviewSession, workspacePath]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[#2a2d3a] px-4 py-2.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-400">{t.backgroundProcesses}</span>
              <span className="rounded-full border border-sky-500/30 px-2 py-0.5 text-[10px] font-semibold text-sky-200">
                {processes.length}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refreshProcesses()}
              title={t.backgroundProcessesRefreshTip}
              disabled={isLoading}
              className="rounded-md border border-[#2a2d3a] px-2 py-1 text-[10px] font-medium text-slate-400 transition-colors
                         hover:border-indigo-500/50 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t.backgroundProcessesRefresh}
            </button>
            <button
              type="button"
              onClick={() => void stopAllProcesses()}
              title={t.backgroundProcessesStopAllTip}
              disabled={processes.length === 0 || isStoppingAll}
              className="rounded-md border border-red-500/30 px-2 py-1 text-[10px] font-medium text-red-200 transition-colors
                         hover:border-red-400/60 hover:text-red-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isStoppingAll ? t.backgroundProcessesStoppingAll : t.backgroundProcessesStopAll}
            </button>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-thin scrollbar-stable px-3 pb-3">
        {error && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-200">
            {error}
          </div>
        )}

        {!error && !isLoading && processes.length === 0 && (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-slate-600">
            {t.backgroundProcessesEmpty}
          </div>
        )}

        <div className="space-y-2">
          {processes.map((process) => {
            const isStopping = stoppingPid === process.pid;
            const isPreviewing = activePreviewPid === process.pid;

            return (
              <div key={process.pid} className="rounded-xl border border-[#2a2d3a] bg-[#11141c] px-3 py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[11px] text-slate-200">{formatCommand(process)}</div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-500">
                      <span>PID {process.pid}</span>
                      <span>
                        {t.backgroundProcessStartedAt}: {formatTime(process.startedAt, lang)}
                      </span>
                      {isPreviewing && (
                        <span className="rounded-full border border-emerald-500/30 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-200">
                          {t.backgroundProcessPreviewing}
                        </span>
                      )}
                    </div>
                    <div className="mt-2 text-[10px] text-slate-500">
                      {t.backgroundProcessPreviewUrl}: {process.previewUrl ?? t.backgroundProcessNoPreviewUrl}
                    </div>
                    <div className="mt-2 rounded-lg border border-[#232734] bg-[#0d1017] px-2 py-2">
                      <div className="mb-1 text-[10px] font-semibold text-slate-500">{t.backgroundProcessLogTail}</div>
                      <pre className="max-h-24 overflow-auto overscroll-contain scrollbar-thin scrollbar-stable whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-slate-300">
                        {process.logTail || t.backgroundProcessNoLogs}
                      </pre>
                    </div>
                  </div>

                  <div className="flex flex-shrink-0 flex-col gap-2">
                    <button
                      type="button"
                      onClick={() => openPreview(process)}
                      title={t.backgroundProcessOpenPreview}
                      disabled={!process.previewUrl}
                      className="rounded-md border border-sky-500/30 px-2 py-1 text-[10px] font-medium text-sky-200 transition-colors
                                 hover:border-sky-400/60 hover:text-sky-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isPreviewing ? t.backgroundProcessPreviewing : t.backgroundProcessOpenPreview}
                    </button>
                    <button
                      type="button"
                      onClick={() => void stopProcess(process.pid)}
                      title={t.backgroundProcessStop}
                      disabled={isStopping || isStoppingAll}
                      className="rounded-md border border-red-500/30 px-2 py-1 text-[10px] font-medium text-red-200 transition-colors
                                 hover:border-red-400/60 hover:text-red-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isStopping ? t.backgroundProcessStopping : t.backgroundProcessStop}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
