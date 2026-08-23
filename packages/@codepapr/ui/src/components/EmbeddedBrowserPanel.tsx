import { errorMessage } from '@codepapr/common';
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useBrowserViewStore } from '../store/browserViewStore';
import { getTranslation } from '../utils/i18n';
import type { Lang } from '../utils/i18n';

interface EmbeddedBrowserStateEvent {
  workspacePath: string;
  url: string;
  title: string;
}

interface EmbeddedBrowserPanelProps {
  workspacePath: string;
  lang?: Lang;
  /** 其他 HTML 弹层盖住面板时隐藏原生 WebView（它不受 CSS z-index 约束）。 */
  nativeLayerBlocked?: boolean;
}

/** N19：无 scheme 的地址默认补全协议。环回地址（localhost/127.x/[::1]）
 *  一律默认 http——本地 dev server 都是 http，强升 https 会导致导航失败
 *  且完全静默。其余地址保持 https 默认。 */
export function normalizeEmbeddedBrowserUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return trimmed;
  }
  const isLoopback =
    /^(localhost|127(\.\d{1,3}){3}|\[::1\]|\[::\])(:\d+)?([/?#]|$)/i.test(trimmed);
  return `${isLoopback ? 'http' : 'https'}://${trimmed}`;
}

export function EmbeddedBrowserPanel({
  workspacePath,
  lang,
  nativeLayerBlocked = false,
}: EmbeddedBrowserPanelProps) {
  const t = getTranslation(lang);
  const pageSession = useBrowserViewStore((state) => state.pageSession);
  const closePanel = useBrowserViewStore((state) => state.closePanel);
  const setPageSession = useBrowserViewStore((state) => state.setPageSession);

  const handleClose = useCallback(() => {
    closePanel();
    setPageSession(null);
    void invoke('close_browser_page', { workspacePath }).catch(() => undefined);
  }, [closePanel, setPageSession, workspacePath]);

  const placeholderRef = useRef<HTMLDivElement | null>(null);
  const [addressInput, setAddressInput] = useState('');
  const [isNavigating, setIsNavigating] = useState(false);
  const [actionError, setActionError] = useState('');

  const activeSession =
    pageSession && pageSession.workspacePath === workspacePath ? pageSession : null;

  // 把原生 WebView 定位到占位区域上方。
  const syncBounds = useCallback(async () => {
    const el = placeholderRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    try {
      await invoke('embedded_browser_set_bounds', {
        workspacePath,
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
    } catch {
      // 会话可能尚未创建；忽略定位失败。
    }
  }, [workspacePath]);

  // #21：导航类操作可能重建会话（如预览弹窗关闭连带关闭会话后再导航），
  // Rust 侧新建的 WebView 默认隐藏，而 show 只在面板挂载时调用一次——
  // 重建后的 WebView 会一直隐藏（占位区空白）。每次动作成功后补一次
  // show + 重新定位（幂等）。
  const ensureVisible = useCallback(async () => {
    if (nativeLayerBlocked) {
      try {
        await invoke('embedded_browser_hide', { workspacePath });
      } catch {
        // 无会话时 hide 会失败，属正常情况。
      }
      return;
    }
    try {
      await invoke('embedded_browser_show', { workspacePath });
    } catch {
      // 无会话时 show 会失败，属正常情况。
    }
    await syncBounds();
  }, [workspacePath, syncBounds, nativeLayerBlocked]);

  // 打开面板：显示原生 WebView 并持续跟随布局变化。
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | null = null;

    const show = async () => {
      if (nativeLayerBlocked) {
        try {
          await invoke('embedded_browser_hide', { workspacePath });
        } catch {
          // 无会话时 hide 会失败，属正常情况。
        }
        return;
      }
      try {
        await invoke('embedded_browser_show', { workspacePath });
      } catch {
        // 无会话时 show 会失败，属正常情况。
      }
      await syncBounds();
    };
    void show();

    const onStateChange = (event: { payload: EmbeddedBrowserStateEvent }) => {
      const payload = event.payload;
      if (payload.workspacePath !== workspacePath) return;
      setPageSession({
        url: payload.url,
        title: payload.title,
        workspacePath,
        startedAt: Date.now(),
      });
    };
    listen<EmbeddedBrowserStateEvent>('embedded-browser://state-changed', onStateChange).then(
      (fn) => {
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      }
    ).catch(() => undefined);

    const onResize = () => void syncBounds();
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('scroll', onResize);
    const observer = new ResizeObserver(() => void syncBounds());
    if (placeholderRef.current) observer.observe(placeholderRef.current);

    return () => {
      disposed = true;
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('scroll', onResize);
      observer.disconnect();
      if (unlisten) unlisten();
      void invoke('embedded_browser_hide', { workspacePath }).catch(() => undefined);
    };
  }, [workspacePath, syncBounds, setPageSession, nativeLayerBlocked]);

  // 地址栏跟随当前页面 URL。
  useEffect(() => {
    setAddressInput(activeSession?.url ?? '');
  }, [activeSession?.url]);

  const navigateTo = useCallback(
    async (rawUrl: string) => {
      const trimmed = rawUrl.trim();
      if (!trimmed) return;
      const url = normalizeEmbeddedBrowserUrl(trimmed);
      setIsNavigating(true);
      setActionError('');
      try {
        const result = await invoke<{ url: string; title: string }>(
          'embedded_browser_navigate',
          { workspacePath, url }
        );
        setPageSession({
          url: result.url,
          title: result.title,
          workspacePath,
          startedAt: Date.now(),
        });
        await ensureVisible();
      } catch (err) {
        setActionError(errorMessage(err));
      } finally {
        setIsNavigating(false);
      }
    },
    [workspacePath, setPageSession, ensureVisible]
  );

  const runAction = useCallback(
    async (action: () => Promise<{ url: string; title: string }>) => {
      setActionError('');
      try {
        const result = await action();
        setPageSession({
          url: result.url,
          title: result.title,
          workspacePath,
          startedAt: Date.now(),
        });
        await ensureVisible();
      } catch (err) {
        setActionError(errorMessage(err));
      }
    },
    [workspacePath, setPageSession, ensureVisible]
  );

  const goBack = useCallback(
    () =>
      void runAction(() =>
        invoke<{ url: string; title: string }>('embedded_browser_history', {
          workspacePath,
          direction: 'back',
        })
      ),
    [workspacePath, runAction]
  );

  const goForward = useCallback(
    () =>
      void runAction(() =>
        invoke<{ url: string; title: string }>('embedded_browser_history', {
          workspacePath,
          direction: 'forward',
        })
      ),
    [workspacePath, runAction]
  );

  const reload = useCallback(
    () =>
      void runAction(() =>
        invoke<{ url: string; title: string }>('embedded_browser_reload', { workspacePath })
      ),
    [workspacePath, runAction]
  );

  const openInSystemBrowser = useCallback(() => {
    if (!activeSession?.url) return;
    void invoke('open_browser_target', {
      workspacePath,
      url: activeSession.url,
    }).catch(() => undefined);
  }, [workspacePath, activeSession?.url]);

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-base px-3 py-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={goBack}
            title={t.embeddedBrowserBack}
            className="rounded-md border border-line px-2 py-1 text-xs text-fg-soft transition-colors hover:border-accent-soft hover:text-fg"
          >
            ←
          </button>
          <button
            type="button"
            onClick={goForward}
            title={t.embeddedBrowserForward}
            className="rounded-md border border-line px-2 py-1 text-xs text-fg-soft transition-colors hover:border-accent-soft hover:text-fg"
          >
            →
          </button>
          <button
            type="button"
            onClick={reload}
            title={t.embeddedBrowserReload}
            className="rounded-md border border-line px-2 py-1 text-xs text-fg-soft transition-colors hover:border-accent-soft hover:text-fg"
          >
            ⟳
          </button>
        </div>

        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            void navigateTo(addressInput);
          }}
        >
          <input
            type="text"
            value={addressInput}
            onChange={(event) => setAddressInput(event.target.value)}
            placeholder={t.embeddedBrowserAddressPlaceholder}
            className="w-full rounded-md border border-line bg-base px-2 py-1 text-xs text-fg outline-none transition-colors focus:border-accent-soft"
            spellCheck={false}
          />
        </form>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={openInSystemBrowser}
            title={t.embeddedBrowserOpenExternal}
            className="rounded-md border border-line px-2 py-1 text-[10px] font-medium text-fg-soft transition-colors hover:border-accent-soft hover:text-fg"
          >
            {t.embeddedBrowserOpenExternal}
          </button>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-md border border-danger-bg px-2 py-1 text-[10px] font-medium text-danger transition-colors hover:border-danger-bg hover:text-danger"
          >
            {t.embeddedBrowserClose}
          </button>
        </div>
      </div>

      {activeSession?.title && (
        <div className="truncate px-1 text-[11px] text-fg-muted">{activeSession.title}</div>
      )}

      {actionError && (
        <div className="rounded-xl border border-danger-bg bg-danger-bg px-3 py-2 text-xs leading-relaxed text-danger">
          {actionError}
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-line bg-base">
        {isNavigating && (
          <div className="absolute left-0 top-0 z-10 h-0.5 w-full animate-pulse bg-accent-soft" />
        )}
        <div ref={placeholderRef} className="h-full w-full" />
        {!activeSession && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-xs text-fg-dim">
            {t.embeddedBrowserEmpty}
          </div>
        )}
      </div>
    </div>
  );
}
