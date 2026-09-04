import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppRuntimeStore, type AppInstance } from '../store/appRuntimeStore';
import { useAgentStore } from '../store/agentStore';
import { usePaprBridge } from '../papr/usePaprBridge';
import { APP_IFRAME_SANDBOX } from '../papr/appIframe';
import {
  applyOverlayResize,
  clampOverlayOrigin,
  clampOverlayRect,
  defaultOverlayOrigin,
  isOverlayResizable,
  isPluginApp,
  overlayToWindowBounds,
  OVERLAY_CHROME_HEIGHT,
  readAppManifest,
  resolveOverlaySurface,
  resolvePaprEntryFile,
  resolveShowPlacement,
  shouldPersistPluginPosition,
  type OverlayLayout,
  type OverlayResizeDir,
} from '../papr/pluginSurface';
import { getTranslation } from '../utils/i18n';
import type { Lang } from '../utils/i18n';
import { usePluginDockRect } from '../papr/pluginDockSlot';

interface PluginOverlayHostProps {
  lang?: Lang;
}

const RESIZE_HANDLES: Array<{ dir: OverlayResizeDir; className: string }> = [
  { dir: 'n', className: 'left-2 right-2 -top-0.5 h-2 cursor-ns-resize' },
  { dir: 's', className: 'left-2 right-2 -bottom-0.5 h-2 cursor-ns-resize' },
  { dir: 'e', className: 'top-2 bottom-2 -right-0.5 w-2 cursor-ew-resize' },
  { dir: 'w', className: 'top-2 bottom-2 -left-0.5 w-2 cursor-ew-resize' },
  { dir: 'ne', className: '-top-0.5 -right-0.5 h-2.5 w-2.5 cursor-nesw-resize' },
  { dir: 'nw', className: '-top-0.5 -left-0.5 h-2.5 w-2.5 cursor-nwse-resize' },
  { dir: 'se', className: '-bottom-0.5 -right-0.5 h-2.5 w-2.5 cursor-nwse-resize' },
  { dir: 'sw', className: '-bottom-0.5 -left-0.5 h-2.5 w-2.5 cursor-nesw-resize' },
];

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

function resolveCardLayout(
  app: AppInstance,
  stored: OverlayLayout | undefined,
  viewport: { width: number; height: number },
  index: number,
): OverlayLayout {
  const manifest = readAppManifest(app);
  const surface = resolveOverlaySurface(manifest);
  const size = {
    width: stored?.width ?? surface.width,
    height: stored?.height ?? surface.height,
  };
  if (stored && shouldPersistPluginPosition(manifest)) {
    return clampOverlayRect({ ...stored, ...size }, viewport);
  }
  return clampOverlayRect(
    { ...defaultOverlayOrigin(surface.position, size, viewport, index), ...size, sizeSource: stored?.sizeSource ?? 'manifest' },
    viewport,
  );
}

export function PluginOverlayHost({ lang }: PluginOverlayHostProps) {
  const openedAppId = useAppRuntimeStore((state) => state.openedAppId);
  const apps = useAppRuntimeStore((state) => state.apps);
  const pinnedPluginIds = useAppRuntimeStore((state) => state.pinnedPluginIds);
  const overlayLayouts = useAppRuntimeStore((state) => state.overlayLayouts);
  const pluginChrome = useAppRuntimeStore((state) => state.pluginChrome);
  const setOverlayLayout = useAppRuntimeStore((state) => state.setOverlayLayout);
  const viewport = useViewportSize();
  const dockRect = usePluginDockRect();

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
      const placement = resolveShowPlacement(readAppManifest(app), pluginChrome[app.appId]);
      if (placement === 'right') return;
      setOverlayLayout(app.appId, resolveCardLayout(app, undefined, viewport, index));
    });
  }, [pinned, overlayLayouts, pluginChrome, setOverlayLayout, viewport]);

  if (pinned.length === 0) return null;

  const hidden = !!openedAppId;

  return (
    <>
      {pinned.map((app, index) => {
        const placement = resolveShowPlacement(readAppManifest(app), pluginChrome[app.appId]);
        const docked = placement === 'right' && !!dockRect && dockRect.width > 1 && dockRect.height > 1;
        const waitingForDock = placement === 'right' && !docked;
        const layout = docked && dockRect
          ? {
              x: dockRect.x,
              y: dockRect.y,
              width: dockRect.width,
              height: dockRect.height,
              sizeSource: overlayLayouts[app.appId]?.sizeSource,
            }
          : resolveCardLayout(app, overlayLayouts[app.appId], viewport, index);
        return (
          <PluginOverlayCard
            key={app.appId}
            app={app}
            lang={lang}
            layout={layout}
            zIndex={30 + index}
            hidden={hidden || waitingForDock}
            docked={docked}
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
  zIndex: number;
  hidden?: boolean;
  docked?: boolean;
}

function PluginOverlayCard({ app, lang, layout, zIndex, hidden, docked }: PluginOverlayCardProps) {
  const t = getTranslation(lang);
  const workspacePath = useAgentStore((state) => state.workspacePath);
  const unpinPlugin = useAppRuntimeStore((state) => state.unpinPlugin);
  const pinPlugin = useAppRuntimeStore((state) => state.pinPlugin);
  const dockPlugin = useAppRuntimeStore((state) => state.dockPlugin);
  const undockPlugin = useAppRuntimeStore((state) => state.undockPlugin);
  const reloadApp = useAppRuntimeStore((state) => state.reloadApp);
  const setOverlayLayout = useAppRuntimeStore((state) => state.setOverlayLayout);
  const persistPluginUi = useAppRuntimeStore((state) => state.persistPluginUi);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState<OverlayResizeDir | null>(null);
  const dragOffset = useRef({ x: 0, y: 0 });
  const resizeStart = useRef<{ x: number; y: number; layout: OverlayLayout } | null>(null);
  const loadedRef = useRef(false);
  const readyRef = useRef(false);
  const loadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sdkCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const manifest = useMemo(() => readAppManifest(app), [app]);
  const resizable = isOverlayResizable(manifest);
  const entryFile = resolvePaprEntryFile(manifest);
  const iframeSrc = `codepapr-app://${app.appId}/${entryFile}`;
  const interacting = !docked && (dragging || !!resizing);

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

  const { postThemeNow, postWindowBounds, cancelAllRuns } = usePaprBridge({
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

  // C-1：热重载换 iframe 文档（key 含 updatedAt）时宿主卡片不卸载，
  // 订阅 cleanup 不触发 → 在纪元切换时显式取消旧文档的 agent run。
  useEffect(
    () => () => {
      cancelAllRuns();
    },
    [app.appId, app.updatedAt, cancelAllRuns],
  );

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

  useEffect(() => {
    if (interacting) return;
    postWindowBounds(overlayToWindowBounds(layout));
  }, [layout.x, layout.y, layout.width, layout.height, interacting, postWindowBounds]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if ((event.target as HTMLElement).closest('button')) return;
      if (docked) return;
      pinPlugin(app.appId);
      setDragging(true);
      dragOffset.current = { x: event.clientX - layout.x, y: event.clientY - layout.y };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [app.appId, docked, layout.x, layout.y, pinPlugin],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      const origin = clampOverlayOrigin(
        { x: event.clientX - dragOffset.current.x, y: event.clientY - dragOffset.current.y },
        layout,
        { width: window.innerWidth, height: window.innerHeight },
      );
      setOverlayLayout(app.appId, { ...layout, ...origin });
    },
    [app.appId, dragging, layout, setOverlayLayout],
  );

  const onPointerUp = useCallback(() => {
    if (dragging) persistPluginUi();
    setDragging(false);
  }, [dragging, persistPluginUi]);

  const onResizePointerDown = useCallback(
    (dir: OverlayResizeDir, event: React.PointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      pinPlugin(app.appId);
      setResizing(dir);
      resizeStart.current = { x: event.clientX, y: event.clientY, layout };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [app.appId, layout, pinPlugin],
  );

  const onResizePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!resizing || !resizeStart.current) return;
      const dx = event.clientX - resizeStart.current.x;
      const dy = event.clientY - resizeStart.current.y;
      const next = clampOverlayRect(
        applyOverlayResize(resizeStart.current.layout, resizing, dx, dy),
        { width: window.innerWidth, height: window.innerHeight },
      );
      setOverlayLayout(app.appId, next);
    },
    [app.appId, resizing, setOverlayLayout],
  );

  const onResizePointerUp = useCallback(() => {
    if (resizing) persistPluginUi();
    setResizing(null);
    resizeStart.current = null;
  }, [persistPluginUi, resizing]);

  return (
    <div
      data-plugin-overlay={app.appId}
      data-plugin-docked={docked ? 'true' : undefined}
      aria-hidden={hidden || undefined}
      className={`fixed border border-line bg-base ${
        docked
          ? 'rounded-none border-y-0 border-r-0'
          : 'rounded-lg shadow-[0_12px_40px_rgba(0,0,0,0.35)]'
      } ${hidden ? 'invisible pointer-events-none' : ''}`}
      style={{ left: layout.x, top: layout.y, width: layout.width, height: layout.height, zIndex }}
    >
      <div className="flex h-full flex-col overflow-hidden rounded-lg">
        <div
          className={`flex h-7 shrink-0 items-center gap-1.5 border-b border-line px-2 ${
            docked ? '' : dragging ? 'cursor-grabbing' : 'cursor-grab'
          }`}
          style={{ height: OVERLAY_CHROME_HEIGHT }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          title={docked ? undefined : t.appPluginDrag}
        >
          <span className="flex-shrink-0 text-[11px] leading-none">
            {app.icon && app.icon.trim().length > 0 ? app.icon.trim().slice(0, 2) : '📌'}
          </span>
          <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-fg">{app.title}</span>
          {docked ? (
            <button
              type="button"
              className="rounded px-1 py-0.5 text-[10px] text-fg-muted hover:bg-raised hover:text-fg"
              title={t.appPluginUndock}
              onClick={() => undockPlugin(app.appId)}
            >
              {t.appPluginUndock}
            </button>
          ) : (
            <button
              type="button"
              className="rounded px-1 py-0.5 text-[10px] text-fg-muted hover:bg-raised hover:text-fg"
              title={t.appPluginDockRight}
              onClick={() => dockPlugin(app.appId)}
            >
              {t.appPluginDockRight}
            </button>
          )}
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
          className={`min-h-0 flex-1 border-0 bg-white ${interacting ? 'pointer-events-none' : ''}`}
          onLoad={() => {
            loadedRef.current = true;
            clearTimers();
            postThemeNow();
            postWindowBounds(overlayToWindowBounds(layout));
            if (!readyRef.current) {
              sdkCheckTimerRef.current = setTimeout(() => {
                if (!readyRef.current) setError(t.appModalSdkLoadFailed);
              }, 2_500);
            }
          }}
          onError={() => setError(t.appModalLoadFailed)}
        />
      </div>
      {resizable && !hidden && !docked && RESIZE_HANDLES.map((handle) => (
        <div
          key={handle.dir}
          data-plugin-resize={handle.dir}
          className={`absolute z-10 ${handle.className}`}
          title={t.appPluginResize}
          onPointerDown={(event) => onResizePointerDown(handle.dir, event)}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          onPointerCancel={onResizePointerUp}
        />
      ))}
    </div>
  );
}
