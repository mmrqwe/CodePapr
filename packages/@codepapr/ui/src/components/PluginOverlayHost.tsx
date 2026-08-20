import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppRuntimeStore, type AppInstance } from '../store/appRuntimeStore';
import { useAgentStore } from '../store/agentStore';
import { usePaprBridge } from '../papr/usePaprBridge';
import { APP_IFRAME_SANDBOX } from '../papr/appIframe';
import {
  clampOverlayOrigin,
  defaultOverlayOrigin,
  isPluginApp,
  readAppManifest,
  resolveOverlaySurface,
  resolvePaprEntryFile,
  type OverlayLayout,
} from '../papr/pluginSurface';
import { getTranslation } from '../utils/i18n';
import type { Lang } from '../utils/i18n';

interface PluginOverlayHostProps {
  lang?: Lang;
}

function useViewportSize(): { width: number; height: number } {
  const [size, setSize] = useState(() => ({
    width: typeof window === 'undefined' ? 1280 : window.innerWidth,
    height: typeof window === 'undefined' ? 800 : window.innerHeight,
  }));
  useEffect(() => {
    const update = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return size;
}

export function PluginOverlayHost({ lang }: PluginOverlayHostProps) {
  const openedAppId = useAppRuntimeStore((state) => state.openedAppId);
  const apps = useAppRuntimeStore((state) => state.apps);
  const pinnedPluginIds = useAppRuntimeStore((state) => state.pinnedPluginIds);
  const overlayLayouts = useAppRuntimeStore((state) => state.overlayLayouts);
  const setOverlayLayout = useAppRuntimeStore((state) => state.setOverlayLayout);
  const viewport = useViewportSize();

  const pinned = useMemo(
    () =>
      pinnedPluginIds
        .map((id) => apps.find((app) => app.appId === id))
        .filter((app): app is AppInstance => !!app && isPluginApp(app)),
    [apps, pinnedPluginIds],
  );

  useEffect(() => {
    pinned.forEach((app, index) => {
      if (overlayLayouts[app.appId]) return;
      const surface = resolveOverlaySurface(readAppManifest(app));
      setOverlayLayout(app.appId, defaultOverlayOrigin(surface.position, surface, viewport, index));
    });
  }, [pinned, overlayLayouts, setOverlayLayout, viewport]);

  if (openedAppId || pinned.length === 0) return null;

  return (
    <>
      {pinned.map((app, index) => {
        const surface = resolveOverlaySurface(readAppManifest(app));
        const origin = clampOverlayOrigin(
          overlayLayouts[app.appId] ?? defaultOverlayOrigin(surface.position, surface, viewport, index),
          surface,
          viewport,
        );
        return (
          <PluginOverlayCard
            key={app.appId}
            app={app}
            lang={lang}
            layout={origin}
            size={surface}
            zIndex={30 + index}
          />
        );
      })}
    </>
  );
}

interface PluginOverlayCardProps {
  app: AppInstance;
  lang?: Lang;
  layout: OverlayLayout;
  size: { width: number; height: number };
  zIndex: number;
}

function PluginOverlayCard({ app, lang, layout, size, zIndex }: PluginOverlayCardProps) {
  const t = getTranslation(lang);
  const workspacePath = useAgentStore((state) => state.workspacePath);
  const unpinPlugin = useAppRuntimeStore((state) => state.unpinPlugin);
  const pinPlugin = useAppRuntimeStore((state) => state.pinPlugin);
  const reloadApp = useAppRuntimeStore((state) => state.reloadApp);
  const setOverlayLayout = useAppRuntimeStore((state) => state.setOverlayLayout);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const loadedRef = useRef(false);
  const readyRef = useRef(false);
  const loadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sdkCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const manifest = useMemo(() => readAppManifest(app), [app]);
  const entryFile = resolvePaprEntryFile(manifest);
  const iframeSrc = `codepapr-app://${app.appId}/${entryFile}`;

  const clearTimers = useCallback(() => {
    if (loadTimerRef.current) {
      clearTimeout(loadTimerRef.current);
      loadTimerRef.current = null;
    }
    if (sdkCheckTimerRef.current) {
      clearTimeout(sdkCheckTimerRef.current);
      sdkCheckTimerRef.current = null;
    }
  }, []);

  const { postThemeNow } = usePaprBridge({
    iframeRef,
    appId: app.appId,
    manifest,
    onAppReady: () => {
      readyRef.current = true;
      loadedRef.current = true;
      clearTimers();
      setError('');
    },
  });

  useEffect(() => {
    loadedRef.current = false;
    readyRef.current = false;
    setError('');
    clearTimers();
    loadTimerRef.current = setTimeout(() => {
      if (!loadedRef.current) setError(t.appModalLoadFailed);
    }, 10_000);
    return () => clearTimers();
  }, [app.appId, app.updatedAt, clearTimers, t.appModalLoadFailed]);

  useEffect(() => {
    if (!workspacePath) return;
    let cancelled = false;
    let last = 0;
    const tick = async () => {
      try {
        const mtime = await invoke<number>('app_frontend_mtime', {
          workspacePath,
          appId: app.appId,
        });
        if (cancelled) return;
        const next = Number(mtime) || 0;
        if (last > 0 && next > last) reloadApp(app.appId);
        last = next;
      } catch {
        // 轮询失败不打断使用
      }
    };
    void tick();
    const id = window.setInterval(() => {
      void tick();
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [app.appId, workspacePath, reloadApp]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if ((event.target as HTMLElement).closest('button')) return;
      pinPlugin(app.appId);
      setDragging(true);
      dragOffset.current = { x: event.clientX - layout.x, y: event.clientY - layout.y };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [app.appId, layout.x, layout.y, pinPlugin],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      const next = clampOverlayOrigin(
        { x: event.clientX - dragOffset.current.x, y: event.clientY - dragOffset.current.y },
        size,
        { width: window.innerWidth, height: window.innerHeight },
      );
      setOverlayLayout(app.appId, next);
    },
    [app.appId, dragging, setOverlayLayout, size],
  );

  const onPointerUp = useCallback(() => {
    setDragging(false);
  }, []);

  return (
    <div
      className="fixed overflow-hidden rounded-lg border border-line bg-base shadow-[0_12px_40px_rgba(0,0,0,0.35)]"
      style={{ left: layout.x, top: layout.y, width: size.width, height: size.height, zIndex }}
    >
      <div className="flex h-full flex-col">
        <div
          className={`flex shrink-0 cursor-grab items-center gap-1.5 border-b border-line px-2 py-1 ${dragging ? 'cursor-grabbing' : ''}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          title={t.appPluginDrag}
        >
          <span className="flex-shrink-0 text-[11px] leading-none">
            {app.icon && app.icon.trim().length > 0 ? app.icon.trim().slice(0, 2) : '📌'}
          </span>
          <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-fg">{app.title}</span>
          <button
            type="button"
            className="rounded px-1 py-0.5 text-[10px] text-fg-muted hover:bg-raised hover:text-fg"
            title={t.appModalReload}
            onClick={() => {
              setError('');
              reloadApp(app.appId);
            }}
          >
            ⟳
          </button>
          <button
            type="button"
            className="rounded px-1 py-0.5 text-[10px] text-fg-muted hover:bg-raised hover:text-fg"
            title={t.appPluginClose}
            onClick={() => unpinPlugin(app.appId)}
          >
            ×
          </button>
        </div>
        {error && (
          <div className="shrink-0 border-b border-danger-bg bg-danger-bg px-2 py-1 text-[10px] text-danger">
            {error}
          </div>
        )}
        <iframe
          ref={iframeRef}
          key={`${app.appId}-${app.updatedAt}`}
          src={iframeSrc}
          title={app.title}
          sandbox={APP_IFRAME_SANDBOX}
          className={`min-h-0 flex-1 border-0 bg-white ${dragging ? 'pointer-events-none' : ''}`}
          onLoad={() => {
            loadedRef.current = true;
            clearTimers();
            postThemeNow();
            if (!readyRef.current) {
              sdkCheckTimerRef.current = setTimeout(() => {
                if (!readyRef.current) setError(t.appModalSdkLoadFailed);
              }, 2_500);
            }
          }}
          onError={() => setError(t.appModalLoadFailed)}
        />
      </div>
    </div>
  );
}
