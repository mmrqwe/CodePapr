import { errorMessage } from '@codepapr/common';
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { usePreviewStore } from '../store/previewStore';
import { useAppRuntimeStore } from '../store/appRuntimeStore';
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

  // 应用后端判定：pid 匹配是主守卫；URL 匹配必须用前缀——旧实现精确等于
  // `http://localhost:${port}/`，URL 带路径（/health、/api 等）即不匹配，
  // 关闭预览时会把 app 后端当普通后台进程误杀。
  const isAppBackend = Boolean(
    activePreview &&
      typeof activePreview.pid === 'number' &&
      useAppRuntimeStore.getState().apps.some(
        (app) =>
          app.pid === activePreview.pid ||
          (app.port &&
            activePreview.url.startsWith(`http://localhost:${app.port}`)),
      ),
  );

  useEffect(() => {
    if (activePreviewSession && activePreviewSession.workspacePath !== workspacePath) {
      closePreviewSession();
    }
  }, [activePreviewSession, closePreviewSession, workspacePath]);

  // 会话切换（openedAt/pid/url 变化）时用 key 重挂 iframe 以强制重新加载。
  // 首次挂载必须跳过：iframe 的 src 已在 JSX 中设置，mount 即开始加载，
  // 若再 bump key 会先卸载刚挂载的 iframe 再重挂同 URL，导致双重加载。
  const isFirstPreviewRender = useRef(true);
  useEffect(() => {
    if (isFirstPreviewRender.current) {
      isFirstPreviewRender.current = false;
      return;
    }
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

      // 应用后端的生命周期归应用面板管（app_start/app_stop）：关闭预览只解除
      // 关联，不顺手杀进程——否则用户关个预览窗口就把 app 后端停了。
      const isAppBackendForClose = typeof activePreview.pid === 'number'
        && useAppRuntimeStore.getState().apps.some(
          (app) => app.pid === activePreview.pid
            || (app.port && activePreview.url.startsWith(`http://localhost:${app.port}`)),
        );
      if (typeof activePreview.pid === 'number' && !isAppBackendForClose) {
        await invoke<StopBackgroundProcessResult>('stop_background_process', {
          pid: activePreview.pid,
          source: 'preview-session-panel-close',
        });
      }
      closePreviewSession();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setIsStopping(false);
    }
  }, [activePreview, closePreviewSession, workspacePath]);

  if (!activePreview) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-fg-dim">
        {t.previewSessionEmpty}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-base px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-fg">{activePreview.title}</div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-fg-muted">
            <span>{t.previewSessionUrl}: {activePreview.url}</span>
            <span>{t.previewSessionPid}: {activePreview.pid ?? t.previewSessionUnlinkedPid}</span>
          </div>
          <div className="mt-1 text-[10px] text-fg-dim">{t.previewSessionHint}</div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={reloadPreview}
            className="rounded-md border border-line px-2 py-1 text-[10px] font-medium text-fg-soft transition-colors
                       hover:border-accent-soft hover:text-fg"
          >
            {t.previewSessionReload}
          </button>
          <button
            type="button"
            onClick={() => void closeAndStopPreview()}
            disabled={isStopping}
            className="rounded-md border border-danger-bg px-2 py-1 text-[10px] font-medium text-danger transition-colors
                       hover:border-danger-bg hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isStopping ? t.previewSessionClosing : t.previewSessionClose}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-danger-bg bg-danger-bg px-3 py-2 text-xs leading-relaxed text-danger">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-line bg-base">
        <iframe
          key={frameKey}
          src={activePreview.url}
          title={activePreview.title}
          // 非 app 后端的任意 URL（agent 指定）必须沙箱化；app 后端需要
          // 同源脚本 + 表单/弹窗能力，保持宽松。
          sandbox={isAppBackend ? 'allow-scripts allow-same-origin allow-forms allow-modals' : 'allow-scripts allow-forms allow-modals'}
          className="h-full w-full bg-white"
          onError={() => setError(t.previewSessionLoadFailed)}
        />
      </div>
    </div>
  );
}