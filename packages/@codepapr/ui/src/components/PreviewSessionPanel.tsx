import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { usePreviewStore } from '../store/previewStore';
import { getTranslation } from '../utils/i18n';
import type { Lang } from '../utils/i18n';

interface StopBackgroundProcessResult {
  pid: number;
  stopped: boolean;
}

interface BrowserPageCloseResult {
  workspacePath: string;
  closed: boolean;
}

interface PreviewSessionPanelProps {
  workspacePath: string;
  lang?: Lang;
}

export function PreviewSessionPanel({ workspacePath, lang }: PreviewSessionPanelProps) {
  const t = getTranslation(lang);
  const activePreviewSession = usePreviewStore((state) => state.activePreviewSession);
  const closePreviewSession = usePreviewStore((state) => state.closePreviewSession);
  const reloadPreviewSession = usePreviewStore((state) => state.reloadPreviewSession);
  const [frameKey, setFrameKey] = useState(0);
  const [error, setError] = useState('');
  const [isStopping, setIsStopping] = useState(false);

  const activePreview =
    activePreviewSession && activePreviewSession.workspacePath === workspacePath
      ? activePreviewSession
      : null;

  useEffect(() => {
    if (activePreviewSession && activePreviewSession.workspacePath !== workspacePath) {
      closePreviewSession();
    }
  }, [activePreviewSession, closePreviewSession, workspacePath]);

  useEffect(() => {
    setFrameKey((value) => value + 1);
    setError('');
  }, [activePreview?.openedAt, activePreview?.pid, activePreview?.url]);

  const reloadPreview = useCallback(() => {
    setError('');
    reloadPreviewSession();
  }, [reloadPreviewSession]);

  const closeAndStopPreview = useCallback(async () => {
    if (!activePreview) {
      closePreviewSession();
      return;
    }

    setIsStopping(true);
    setError('');
    try {
      await invoke<BrowserPageCloseResult>('close_browser_page', {
        workspacePath,
      });

      if (typeof activePreview.pid === 'number') {
        await invoke<StopBackgroundProcessResult>('stop_background_process', {
          pid: activePreview.pid,
        });
      }
      closePreviewSession();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsStopping(false);
    }
  }, [activePreview, closePreviewSession, workspacePath]);

  if (!activePreview) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-slate-600">
        {t.previewSessionEmpty}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#2a2d3a] bg-[#11141c] px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-slate-200">{activePreview.title}</div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-500">
            <span>{t.previewSessionUrl}: {activePreview.url}</span>
            <span>{t.previewSessionPid}: {activePreview.pid ?? t.previewSessionUnlinkedPid}</span>
          </div>
          <div className="mt-1 text-[10px] text-slate-600">{t.previewSessionHint}</div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={reloadPreview}
            className="rounded-md border border-[#2a2d3a] px-2 py-1 text-[10px] font-medium text-slate-300 transition-colors
                       hover:border-indigo-500/50 hover:text-white"
          >
            {t.previewSessionReload}
          </button>
          <button
            type="button"
            onClick={() => void closeAndStopPreview()}
            disabled={isStopping}
            className="rounded-md border border-red-500/30 px-2 py-1 text-[10px] font-medium text-red-200 transition-colors
                       hover:border-red-400/60 hover:text-red-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isStopping ? t.previewSessionClosing : t.previewSessionClose}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-200">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-[#2a2d3a] bg-[#0b0d12]">
        <iframe
          key={frameKey}
          src={activePreview.url}
          title={activePreview.title}
          className="h-full w-full bg-white"
          onError={() => setError(t.previewSessionLoadFailed)}
        />
      </div>
    </div>
  );
}