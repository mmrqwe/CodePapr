import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useAppRuntimeStore } from '../store/appRuntimeStore';
import { useAgentStore } from '../store/agentStore';
import { getTranslation } from '../utils/i18n';
import type { Lang } from '../utils/i18n';
import type { PaprManifest } from '@codepapr/types';
import { usePaprBridge } from '../papr/usePaprBridge';
import { APP_IFRAME_SANDBOX } from '../papr/appIframe';
import { launchAppBackend } from '../tools/workspaceAppTools';
import { usePermissionStore as usePaprPermissionStore } from '../papr/permissionStore';
import { resolveEffectiveAccess } from '../papr/levelGrants';

interface AppModalProps {
  lang?: Lang;
}

export function AppModal({ lang }: AppModalProps) {
  const t = getTranslation(lang);
  const openedAppId = useAppRuntimeStore((state) => state.openedAppId);
  const openedApp = useAppRuntimeStore((state) =>
    state.openedAppId ? state.apps.find((app) => app.appId === state.openedAppId) ?? null : null
  );
  const closeAppModal = useAppRuntimeStore((state) => state.closeAppModal);
  const reloadApp = useAppRuntimeStore((state) => state.reloadApp);
  const setAppRunning = useAppRuntimeStore((state) => state.setAppRunning);
  const workspacePath = useAgentStore((state) => state.workspacePath);
  const [error, setError] = useState('');
  const [restarting, setRestarting] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const loadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 超时回调读 ref 而非 state：旧实现闭包捕获了 effect 运行时（切换前的）
  // loaded 值，从已加载 app 切到失败 app 时 10s 后 `if (!loaded)` 恒 false，
  // 白屏且无任何错误提示。
  const loadedRef = useRef(false);
  // #16：协议层错误页（404/403 文本）也会触发 iframe onLoad，单靠 onLoad
  // 无法区分成功失败。以 SDK 的 app-ready 握手为成功信号；onLoad 后短宽限
  // 内未收到握手 → 判定加载失败并提示。
  const readyRef = useRef(false);
  const sdkCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const handleIframeLoad = useCallback(() => {
    loadedRef.current = true;
    clearTimers();
  }, [clearTimers]);

  useEffect(() => {
    loadedRef.current = false;
    readyRef.current = false;
    setError('');
    clearTimers();
    loadTimerRef.current = setTimeout(() => {
      if (!loadedRef.current) {
        setError(t.appModalLoadFailed);
      }
    }, 10_000);
    return () => {
      clearTimers();
    };
  }, [openedAppId, openedApp?.updatedAt, clearTimers]);

  const manifest: PaprManifest | null = useMemo(() => {
    if (!openedApp?.manifestJson) return null;
    try {
      return JSON.parse(openedApp.manifestJson) as PaprManifest;
    } catch {
      return null;
    }
  }, [openedApp?.manifestJson]);

  // #15：入口文件尊重 manifest.entry（与 Rust scan_workspace_apps / 协议层一致）。
  // 旧实现硬编码 index.html，声明 entry: "app.html" 的 app 白屏/404 文本。
  const entryFile = useMemo(() => {
    const raw = manifest?.entry?.trim();
    if (!raw || raw.includes('..') || raw.includes('\\')) {
      return 'index.html';
    }
    return raw;
  }, [manifest]);

  const { postThemeNow } = usePaprBridge({
    iframeRef,
    appId: openedApp?.appId ?? '',
    manifest,
    // #16：SDK 握手到达 = 真实页面渲染成功，清除宽限检测定时器。
    onAppReady: () => {
      readyRef.current = true;
      loadedRef.current = true;
      clearTimers();
    },
  });

  const handleRestartBackend = useCallback(async () => {
    if (!openedApp?.command || !openedApp.port) return;
    setRestarting(true);
    setError('');
    try {
      const { pid, url } = await launchAppBackend(
        {
          appId: openedApp.appId,
          command: openedApp.command,
          args: openedApp.args ?? [],
          port: openedApp.port,
          manifestJson: openedApp.manifestJson,
        },
        workspacePath,
      );
      setAppRunning(openedApp.appId, pid, url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRestarting(false);
    }
  }, [openedApp, workspacePath, setAppRunning]);

  if (!openedApp) {
    return null;
  }

  const iframeSrc = `codepapr-app://${openedApp.appId}/${entryFile}`;

  const appSettings = usePaprPermissionStore((state) => state.appSettings);
  const effectiveAccess = manifest
    ? resolveEffectiveAccess(manifest, appSettings, openedApp.appId)
    : null;
  const hasMeta = !!manifest;
  const hasBackend = !!(openedApp.command && openedApp.port);
  const backendStopped = hasBackend && !(openedApp.pid && openedApp.url);

  return (
    <div className="flex h-full w-full flex-col bg-base">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <button
          type="button"
          onClick={closeAppModal}
          title={t.appModalClose}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-fg-muted transition-colors hover:bg-base hover:text-fg"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">          <path d="M19 12H5M12 19l-7-7 7-7"/></svg>
          {t.appModalClose}
        </button>

        <div className="min-w-0 flex-1">
          <span className="truncate text-xs font-semibold text-fg">{openedApp.title}</span>
        </div>

        {hasMeta && (
          <button
            type="button"
            onClick={() => setShowDetails(!showDetails)}
            title="Details"
            className={`shrink-0 rounded px-1.5 py-1 text-[10px] transition-colors ${
              showDetails
                ? 'bg-accent-soft text-accent-text'
                : 'text-fg-dim hover:text-fg-muted'
            }`}
          >
            {showDetails ? '▾' : '▸'} Info
          </button>
        )}

        <button
          type="button"
          onClick={() => { setError(''); reloadApp(openedApp.appId); }}
          className="shrink-0 rounded px-1.5 py-1 text-[10px] text-fg-muted transition-colors hover:text-fg-soft"
          title={t.appModalReload}
        >
          ⟳ {t.appModalReload}
        </button>
      </div>

      {backendStopped && (
        <div className="mx-3 mt-2 flex shrink-0 items-center justify-between gap-2 rounded-lg border border-warn-bg bg-warn-bg px-3 py-1.5 text-[11px] text-warn">
          <span>{t.appModalBackendStopped}</span>
          <button
            type="button"
            disabled={restarting}
            onClick={() => { void handleRestartBackend(); }}
            className="shrink-0 rounded border border-warn-bg px-2 py-0.5 text-[10px] font-medium text-warn hover:border-warn hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
          >
            {restarting ? t.appDockStarting : t.appModalRestartBackend}
          </button>
        </div>
      )}

      {error && (
        <div className="mx-3 mt-2 shrink-0 rounded-lg border border-danger-bg bg-danger-bg px-3 py-1.5 text-[11px] text-danger">
          {error}
        </div>
      )}

      {showDetails && (
        <div className="shrink-0 border-b border-line px-3 py-1.5">
          {effectiveAccess && (
            <div className="mb-1 flex flex-wrap items-center gap-1">
              <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[9px] text-accent-text font-mono">
                {t.appModalInfoLocal}: {effectiveAccess.local}
              </span>
              <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[9px] text-accent-text font-mono">
                {t.appModalInfoNetwork}: {effectiveAccess.network ? t.appModalNetworkOn : t.appModalNetworkOff}
              </span>
            </div>
          )}
          {manifest?.agents && manifest.agents.length > 0 ? (
            <div className="flex flex-col gap-0.5">
              {manifest.agents.map((a) => (
                <div key={a.name} className="text-[10px] text-fg-muted">
                  {'🤖'} {a.name}{a.model ? ` (${a.model})` : ''}
                  {a.tools && a.tools.length > 0 && ` · tools: ${a.tools.join(', ')}`}
                  {a.maxToolRounds && ` · maxRounds: ${a.maxToolRounds}`}
                </div>
              ))}
            </div>
          ) : (
            !effectiveAccess && (
              <div className="text-[10px] text-fg-dim">{t.appModalNoAccessMeta}</div>
            )
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 bg-white">
        <iframe
          ref={iframeRef}
          key={`${openedApp.appId}-${openedApp.updatedAt}`}
          src={iframeSrc}
          title={openedApp.title}
          sandbox={APP_IFRAME_SANDBOX}
          className="h-full w-full border-0"
          onLoad={() => {
            handleIframeLoad();
            postThemeNow();
            // #16：onLoad 只证明有响应（协议层 404/403 也会触发）。SDK 握手
            // 通常在 onLoad 前到达（head 内同步脚本）；未到达则给短宽限期，
            // 仍无握手 → 判定加载失败并提示（旧实现静默白屏）。
            if (!readyRef.current) {
              sdkCheckTimerRef.current = setTimeout(() => {
                if (!readyRef.current) {
                  setError(t.appModalSdkLoadFailed);
                }
              }, 2_500);
            }
          }}
          onError={() => setError(t.appModalLoadFailed)}
        />
      </div>
    </div>
  );
}
