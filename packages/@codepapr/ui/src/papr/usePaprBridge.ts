import { useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { PaprManifest, PaprAgentDef, PaprAppSettings } from '@codepapr/types';
import { isPaprMessage, createPaprResponse } from './paprProtocol';
import { usePermissionStore } from './permissionStore';
import { normalizeWorkspaceId } from './projectRecordScope';
import { accessAllows, resolveEffectiveAccess } from './levelGrants';
import { registerAppPoster, flushPendingAppEvents } from './appChannelHub';
import { useAgentStore } from '../store/agentStore';
import { useAppRuntimeStore } from '../store/appRuntimeStore';
import {
  clampOverlayRect,
  defaultOverlayOrigin,
  isPluginManifest,
  overlayFromSetSize,
  overlayToWindowBounds,
  resolveOverlaySurface,
  resolveShowPlacement,
  type PluginWindowBounds,
} from './pluginSurface';
import { getPluginDockSlot } from './pluginDockSlot';
import { useThemeStore } from '../store/themeStore';
import type { ThemeMode } from '../theme/types';
import { WorkerCrashError } from '../agent/WorkerBackedAgent';
import { pushDebugLog } from '../store/debugLogStore';
import { platformSandboxWarning } from '../utils/platformSandbox';
import { acquireSleepPrevention, releaseSleepPrevention } from '../utils/sleepPrevention';

// Each app is served from its own origin (codepapr-app://<appId>) so apps are
// isolated from one another (separate localStorage / cookies / IndexedDB).
function appOriginFor(appId: string): string {
  return `codepapr-app://${appId}`;
}

function postToIframe(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
  message: unknown,
  targetOrigin: string,
) {
  iframeRef.current?.contentWindow?.postMessage(message, targetOrigin);
}

interface UsePaprBridgeOptions {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  appId: string;
  manifest: PaprManifest | null;
  /** 应用页面 SDK 执行握手（papr://app-ready）到达时回调。
   *  AppModal 用它区分「协议层错误页」与「真实页面加载成功」。 */
  onAppReady?: () => void;
  /** iframe 内 console / 未捕获错误转发。 */
  onConsole?: (entry: { level: string; message: string; ts: number }) => void;
}

export function usePaprBridge({ iframeRef, appId, manifest, onAppReady, onConsole }: UsePaprBridgeOptions) {
  const cacheManifest = usePermissionStore((s) => s.cacheManifest);
  const appSettings = usePermissionStore((s) => s.appSettings);
  const setAppSettings = usePermissionStore((s) => s.setAppSettings);

  const activeAgentRuns = useRef<Map<string, { cancel: () => void; agentName: string }>>(new Map());

  /** 取消全部在飞的 papr.agent.run。iframe 文档被换（热重载 key 变更）而宿主
   * 不卸载时，订阅 effect 的 cleanup 不会触发（handleMessage 刻意稳定），
   * 必须由宿主在换 key 前显式调用，否则旧文档的 run 成为烧 token 的孤儿。 */
  const cancelAllRuns = useCallback(() => {
    for (const [, run] of activeAgentRuns.current) {
      run.cancel();
    }
    activeAgentRuns.current.clear();
  }, []);

  useEffect(() => {
    if (manifest) {
      cacheManifest(appId, manifest);
    }
  }, [appId, manifest, cacheManifest]);

  // app_publish 下行通道：把这个 iframe 注册为该 app 的 poster。
  // postMessage 只发往本 app 的 origin（与上行的 origin+source 双校验对等）。
  useEffect(() => {
    return registerAppPoster(appId, (envelope) => {
      const win = iframeRef.current?.contentWindow;
      if (!win) return;
      win.postMessage(envelope, appOriginFor(appId));
    });
  }, [appId, iframeRef]);

  // 设置走 zustand：Settings 保存后打开中的 app 立刻拿到新档，不必重挂 iframe。
  useEffect(() => {
    if (appSettings) return;
    let cancelled = false;
    invoke<PaprAppSettings>('papr_get_app_settings')
      .then((settings) => {
        if (cancelled) return;
        if (settings && typeof settings.defaultLocal === 'string') {
          setAppSettings(settings);
        } else {
          setAppSettings({ defaultLocal: 'none', defaultNetwork: false, appOverrides: {} });
        }
      })
      .catch(() => {
        if (cancelled || usePermissionStore.getState().appSettings) return;
        setAppSettings({ defaultLocal: 'none', defaultNetwork: false, appOverrides: {} });
      });
    return () => {
      cancelled = true;
    };
  }, [appSettings, setAppSettings]);

  const themeId = useThemeStore((s) => s.resolvedThemeId);
  const themeMode = useThemeStore((s) => s.mode);

  // papr://theme 协议 v2：携带 theme id + mode，SDK 按主题设置
  // data-theme/data-mode/.dark；dark 布尔保留向后兼容旧 SDK。
  const postTheme = useCallback(
    (resolvedThemeId: string, mode: ThemeMode, isDark: boolean) => {
      const win = iframeRef.current?.contentWindow;
      if (!win) return;
      win.postMessage(
        { __papr: true, type: 'papr://theme', payload: { theme: resolvedThemeId, mode, dark: isDark } },
        appOriginFor(appId),
      );
    },
    [appId, iframeRef],
  );

  const postThemeNow = useCallback(() => {
    const state = useThemeStore.getState();
    postTheme(state.resolvedThemeId, state.mode, state.mode === 'dark');
  }, [postTheme]);

  const postWindowBounds = useCallback(
    (bounds: PluginWindowBounds) => {
      const win = iframeRef.current?.contentWindow;
      if (!win) return;
      win.postMessage(
        { __papr: true, type: 'papr://window.bounds', payload: bounds },
        appOriginFor(appId),
      );
    },
    [appId, iframeRef],
  );

  useEffect(() => {
    postTheme(themeId, themeMode, themeMode === 'dark');
  }, [themeId, themeMode, postTheme]);

  const workspacePath = useAgentStore((s) => s.workspacePath);
  const effectiveAccess = resolveEffectiveAccess(
    manifest,
    appSettings,
    appId,
    normalizeWorkspaceId(workspacePath),
  );
  const effectiveAccessRef = useRef(effectiveAccess);
  effectiveAccessRef.current = effectiveAccess;

  // manifest 走 ref：父组件每次渲染传入新对象（即使内容相同）时，
  // handleMessage 的 identity 不能变——否则订阅 effect 的 cleanup 会把
  // 所有在飞的 app agent 取消（旧实现 appSettings 异步加载就必然触发一次）。
  const manifestRef = useRef(manifest);
  manifestRef.current = manifest;

  // onAppReady 同样走 ref：不得改变 handleMessage identity（同上）。
  const onAppReadyRef = useRef(onAppReady);
  onAppReadyRef.current = onAppReady;
  const onConsoleRef = useRef(onConsole);
  onConsoleRef.current = onConsole;

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      const appOrigin = appOriginFor(appId);
      if (event.origin !== appOrigin) return;
      // Defense in depth: even though each app now has its own origin, only
      // accept messages from this bridge's own iframe window.
      if (iframeRef.current && event.source !== iframeRef.current.contentWindow) return;

      const data = event.data;
      if (!data || typeof data !== 'object' || (data as { __papr?: unknown }).__papr !== true) {
        return;
      }

      // 加载检测握手（无 reqId，先于 isPaprMessage 的 reqId 校验处理）：
      // SDK 执行即证明真实应用页面已渲染——协议层错误页（404/403）不注入 SDK。
      if ((data as { type?: string }).type === 'papr://app-ready') {
        // 挂载竞态补发：广播时本 app 零挂载而排队的 papr://event，趁文档刚
        // ready、先于 onAppReady 记账冲刷给这个实例（reveal-on-publish 场景）。
        // 与应用的 db 回放可能重叠，接收方按 seq 去重是契约的一部分。
        flushPendingAppEvents(appId, (envelope) => {
          iframeRef.current?.contentWindow?.postMessage(envelope, appOrigin);
        });
        onAppReadyRef.current?.();
        return;
      }

      if ((data as { type?: string }).type === 'papr://console') {
        const payload = (data as { payload?: { level?: string; message?: string; ts?: number } }).payload;
        onConsoleRef.current?.({
          level: typeof payload?.level === 'string' ? payload.level : 'log',
          message: typeof payload?.message === 'string' ? payload.message : '',
          ts: typeof payload?.ts === 'number' ? payload.ts : Date.now(),
        });
        return;
      }

      if (!isPaprMessage(data)) return;

      const resolvedManifest = manifestRef.current ?? usePermissionStore.getState().manifests[appId];
      if (!resolvedManifest) {
        const resp = createPaprResponse(data.reqId, undefined, {
          code: 'NO_MANIFEST',
          message: `No manifest loaded for app '${appId}'`,
        });
        postToIframe(iframeRef, resp, appOrigin);
        return;
      }

      const permissions = resolvedManifest.permissions ?? [];
      const currentAccess = effectiveAccessRef.current;

      function hasPermission(capability: string): boolean {
        return accessAllows(currentAccess, capability, resolvedManifest);
      }

      function deny(capability: string) {
        const resp = createPaprResponse(data.reqId, undefined, {
          code: 'PERMISSION_DENIED',
          message: `Permission denied: '${capability}' (app local=${currentAccess.local}, network=${currentAccess.network})`,
        });
        postToIframe(iframeRef, resp, appOrigin);
      }

      function respond(result?: unknown, error?: { code: string; message: string }) {
        const resp = createPaprResponse(data.reqId, result, error);
        postToIframe(iframeRef, resp, appOrigin);
      }

      const type = data.type;

      if (type === 'papr://db.get') {
        if (!hasPermission('storage:read')) return deny('storage:read');
        const key = (data.payload as Record<string, unknown>)?.key;
        if (typeof key !== 'string' || key.length === 0) {
          respond(undefined, { code: 'INVALID_REQUEST', message: 'key must be a non-empty string' });
          return;
        }
        invoke('papr_storage_get', { appId, key })
          .then((result) => respond(result))
          .catch((err) => respond(undefined, { code: 'DB_ERROR', message: String(err) }));
        return;
      }

      if (type === 'papr://db.set') {
        if (!hasPermission('storage:write')) return deny('storage:write');
        const payload = data.payload as Record<string, unknown>;
        const key = payload?.key;
        if (typeof key !== 'string' || key.length === 0) {
          respond(undefined, { code: 'INVALID_REQUEST', message: 'key must be a non-empty string' });
          return;
        }
        const serialized = JSON.stringify(payload?.value);
        if (serialized.length > 1_000_000) {
          respond(undefined, { code: 'INVALID_REQUEST', message: 'value exceeds 1MB size limit' });
          return;
        }
        invoke('papr_storage_set', { appId, key, value: serialized })
          .then(() => respond(null))
          .catch((err) => respond(undefined, { code: 'DB_ERROR', message: String(err) }));
        return;
      }

      if (type === 'papr://db.delete') {
        if (!hasPermission('storage:write')) return deny('storage:write');
        const key = (data.payload as Record<string, unknown>)?.key;
        if (typeof key !== 'string' || key.length === 0) {
          respond(undefined, { code: 'INVALID_REQUEST', message: 'key must be a non-empty string' });
          return;
        }
        invoke('papr_storage_delete', { appId, key })
          .then(() => respond(null))
          .catch((err) => respond(undefined, { code: 'DB_ERROR', message: String(err) }));
        return;
      }

      if (type === 'papr://db.keys') {
        if (!hasPermission('storage:read')) return deny('storage:read');
        invoke<string[]>('papr_storage_keys', { appId })
          .then((keys) => respond(keys))
          .catch((err) => respond(undefined, { code: 'DB_ERROR', message: String(err) }));
        return;
      }

      if (type === 'papr://app.info') {
        const running = useAppRuntimeStore.getState().apps.find((a) => a.appId === appId);
        const runningUrl = running?.url?.replace(/\/$/, '') ?? null;
        const workspaceId = normalizeWorkspaceId(useAgentStore.getState().workspacePath);
        const workspaceName = workspaceId.split(/[/\\]/).pop() || '';
        respond({
          appId,
          name: resolvedManifest.name,
          version: resolvedManifest.version ?? '0.0.0',
          permissions,
          local: currentAccess.local,
          network: currentAccess.network,
          workspaceId,
          workspaceName,
          workspacePath: workspaceId,
          lang: useAgentStore.getState().settings.lang ?? 'zh-CN',
          scope: running?.scope ?? 'workspace',
          backendUrl: runningUrl
            ?? (resolvedManifest.port ? `http://127.0.0.1:${resolvedManifest.port}` : null),
        });
        return;
      }

      if (type === 'papr://window.getBounds' || type === 'papr://window.setSize') {
        if (!isPluginManifest(resolvedManifest)) {
          respond(undefined, {
            code: 'NOT_A_PLUGIN',
            message: 'papr.window is only available on kind:"plugin" overlays',
          });
          return;
        }
        const runtime = useAppRuntimeStore.getState();
        if (!runtime.pinnedPluginIds.includes(appId)) {
          respond(undefined, {
            code: 'NOT_PINNED',
            message: 'plugin overlay is not visible',
          });
          return;
        }
        const docked = resolveShowPlacement(resolvedManifest, runtime.pluginChrome[appId]) === 'right';
        if (docked) {
          const slot = getPluginDockSlot();
          const rect = slot?.getBoundingClientRect();
          const bounds = overlayToWindowBounds({
            x: rect?.x ?? 0,
            y: rect?.y ?? 0,
            width: rect?.width ?? 0,
            height: rect?.height ?? 0,
          });
          if (type === 'papr://window.getBounds') {
            respond(bounds);
            return;
          }
          respond(bounds);
          return;
        }
        const surface = resolveOverlaySurface(resolvedManifest);
        const viewport = { width: window.innerWidth, height: window.innerHeight };
        const stored = runtime.overlayLayouts[appId];
        const current = clampOverlayRect(
          stored ?? defaultOverlayOrigin(surface.position, surface, viewport, 0),
          viewport,
        );
        if (type === 'papr://window.getBounds') {
          respond(overlayToWindowBounds(current));
          return;
        }
        const payload = (data.payload ?? {}) as Record<string, unknown>;
        const width = typeof payload.width === 'number' && Number.isFinite(payload.width) ? payload.width : NaN;
        const height = typeof payload.height === 'number' && Number.isFinite(payload.height) ? payload.height : NaN;
        if (!Number.isFinite(width) || !Number.isFinite(height)) {
          respond(undefined, { code: 'INVALID_REQUEST', message: 'width and height must be finite numbers' });
          return;
        }
        const next = clampOverlayRect(
          overlayFromSetSize(current, { width, height, box: payload.box }),
          viewport,
        );
        runtime.setOverlayLayout(appId, next);
        runtime.persistPluginUi();
        respond(overlayToWindowBounds(next));
        return;
      }

      if (type === 'papr://agent.run') {
        const payload = data.payload as Record<string, unknown> | undefined;
        const agentName = String(payload?.agent ?? payload?.agentName ?? '');
        const task = String(payload?.task ?? '');
        const runtimeModel = typeof payload?.model === 'string' ? payload.model : undefined;
        if (!agentName) {
          respond(undefined, { code: 'INVALID_REQUEST', message: 'agent name is required (use `agent` field)' });
          return;
        }
        if (agentName.length > 64) {
          respond(undefined, { code: 'INVALID_REQUEST', message: 'agent name exceeds 64 character limit' });
          return;
        }
        if (task.length > 200_000) {
          respond(undefined, { code: 'INVALID_REQUEST', message: 'task exceeds 200KB limit' });
          return;
        }
        const capability = `agent:run:${agentName}`;
        if (!hasPermission(capability)) return deny(capability);

        const agentDef = resolvedManifest.agents?.find((a: PaprAgentDef) => a.name === agentName);
        if (!agentDef) {
          respond(undefined, { code: 'AGENT_NOT_FOUND', message: `Agent '${agentName}' not found in manifest` });
          return;
        }

        const runId = data.reqId;

        void (async () => {
          // 用户可能从未发过聊天消息（_agent 为空）：按需初始化 Agent，
          // 而不是要求用户先去对话里发一条消息。
          let agent;
          try {
            agent = await useAgentStore.getState().ensureAgentForApp();
          } catch (err) {
            respond(undefined, {
              code: 'NO_AGENT',
              message: err instanceof Error ? err.message : String(err),
            });
            return;
          }

          // 初始化期间 App 可能已被关闭：避免启动无人消费的后台运行。
          if (!iframeRef.current) return;

          const workspacePath = useAgentStore.getState().workspacePath;

          // C-5：非 macOS 平台两轴沙箱不生效——app agent 的 bash 进程实际
          // 不受 network:false / local 收窄约束，向 UI 显式推一条告警。
          const sandboxWarning = platformSandboxWarning({
            network: currentAccess.network,
            local: currentAccess.local,
          });
          if (sandboxWarning) pushDebugLog('papr', `[${appId}] ${sandboxWarning}`);

          // App Agent 运行期间防休眠：专用 Worker 被系统休眠杀掉后，
          // iframe 内的 papr.agent.run 会挂起。
          void acquireSleepPrevention();

          const runPromise = agent.runAppAgent(
            {
              appId,
              agentName,
              systemPrompt: agentDef.systemPrompt,
              model: runtimeModel || agentDef.model,
              task,
              tools: agentDef.tools,
              maxToolRounds: agentDef.maxToolRounds,
              workspacePath,
              local: currentAccess.local,
              network: currentAccess.network,
              inheritContext: agentDef.inheritContext,
            },
            (event) => {
              postToIframe(iframeRef, {
                __papr: true,
                reqId: data.reqId,
                type: 'stream',
                event,
              }, appOrigin);
            },
            runId,
          );

          activeAgentRuns.current.set(runId, {
            cancel: () => agent.cancelAppAgent?.(runId),
            agentName,
          });

          runPromise
            .then((result) => respond(result))
            .catch((err) => {
              // Worker 崩溃时清空 store 中的 agent，避免后续聊天复用死 worker。
              // 仅当 store 仍持有本次运行使用的同一实例时才清理：运行期间
              // 聊天回合可能已销毁旧 agent 并重建了新实例，无条件置 null 会
              // 把新 agent 的 store 引用 orphan 掉（其 Worker、心跳定时器、
              // visibilitychange 监听器永不销毁，全部泄漏），且不同步重置
              // _agentModel/_agentPromptKey/_agentSessionId。
              if (err instanceof WorkerCrashError || (err instanceof Error && err.name === 'WorkerCrashError')) {
                if (useAgentStore.getState()._appAgent === agent) {
                  try {
                    agent.destroy();
                  } catch {
                    // already torn down
                  }
                  useAgentStore.setState({ _appAgent: null });
                }
              }
              const errMsg = String(err);
              let code = 'AGENT_ERROR';
              if (err instanceof DOMException && err.name === 'AbortError') {
                code = 'CANCELLED';
              } else if (errMsg.includes('timeout') || errMsg.includes('timed out') || errMsg.includes('TIMEOUT')) {
                code = 'TIMEOUT';
              } else if (errMsg.includes('model') && (errMsg.includes('not found') || errMsg.includes('invalid') || errMsg.includes('配置'))) {
                code = 'MODEL_ERROR';
              } else if (errMsg.includes('API key') || errMsg.includes('api key') || errMsg.includes('authentication') || errMsg.includes('401') || errMsg.includes('403')) {
                code = 'AUTH_ERROR';
              } else if (errMsg.includes('network') || errMsg.includes('fetch') || errMsg.includes('ECONNREFUSED') || errMsg.includes('ENOTFOUND')) {
                code = 'NETWORK_ERROR';
              } else if (errMsg.includes('permission denied') || errMsg.includes('权限') || errMsg.includes('PERMISSION')) {
                code = 'PERMISSION_DENIED';
              }
              respond(undefined, { code, message: errMsg });
            })
            .finally(() => {
              activeAgentRuns.current.delete(runId);
              void releaseSleepPrevention();
            });
        })();
        return;
      }

      if (type === 'papr://agent.cancel') {
        const payload = data.payload as Record<string, unknown> | undefined;
        const cancelReqId = String(payload?.reqId ?? '');
        if (!cancelReqId) {
          respond(undefined, { code: 'INVALID_REQUEST', message: 'reqId of the run to cancel is required' });
          return;
        }
        const run = activeAgentRuns.current.get(cancelReqId);
        if (!run) {
          respond(undefined, { code: 'NOT_FOUND', message: `No active agent run with reqId ${cancelReqId}` });
          return;
        }
        const capability = `agent:run:${run.agentName}`;
        if (!hasPermission(capability)) return deny(capability);
        run.cancel();
        respond({ cancelled: true });
        return;
      }

      if (type === 'papr://http.get') {
        if (!hasPermission('http:get')) return deny('http:get');
        const payload = data.payload as Record<string, unknown> | undefined;
        const url = payload?.url;
        if (typeof url !== 'string' || url.length === 0) {
          respond(undefined, { code: 'INVALID_REQUEST', message: 'url must be a non-empty string' });
          return;
        }
        invoke('papr_http_get', {
          appId,
          url,
          maxBytes: typeof payload?.maxBytes === 'number' ? payload.maxBytes : undefined,
        })
          .then((result) => respond(result))
          .catch((err) => respond(undefined, { code: 'HTTP_ERROR', message: String(err) }));
        return;
      }

      if (type === 'papr://http.post') {
        if (!hasPermission('http:post')) return deny('http:post');
        const payload = data.payload as Record<string, unknown> | undefined;
        const url = payload?.url;
        if (typeof url !== 'string' || url.length === 0) {
          respond(undefined, { code: 'INVALID_REQUEST', message: 'url must be a non-empty string' });
          return;
        }
        invoke('papr_http_post', {
          appId,
          url,
          body: typeof payload?.body === 'string' ? payload.body : '',
          contentType: typeof payload?.contentType === 'string' ? payload.contentType : undefined,
        })
          .then((result) => respond(result))
          .catch((err) => respond(undefined, { code: 'HTTP_ERROR', message: String(err) }));
        return;
      }

      if (type === 'papr://http.request') {
        if (!hasPermission('http:request')) return deny('http:request');
        const payload = data.payload as Record<string, unknown> | undefined;
        const url = payload?.url;
        if (typeof url !== 'string' || url.length === 0) {
          respond(undefined, { code: 'INVALID_REQUEST', message: 'url must be a non-empty string' });
          return;
        }
        const method = typeof payload?.method === 'string' ? payload.method : 'GET';
        const rawHeaders = payload?.headers;
        const headers =
          rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)
            ? Object.fromEntries(
                Object.entries(rawHeaders as Record<string, unknown>).filter(
                  (entry): entry is [string, string] => typeof entry[1] === 'string',
                ),
              )
            : undefined;
        invoke('papr_http_request', {
          appId,
          method,
          url,
          headers,
          body: typeof payload?.body === 'string' ? payload.body : undefined,
          maxBytes: typeof payload?.maxBytes === 'number' ? payload.maxBytes : undefined,
        })
          .then((result) => respond(result))
          .catch((err) => respond(undefined, { code: 'HTTP_ERROR', message: String(err) }));
        return;
      }

      if (type === 'papr://fs.read') {
        if (!hasPermission('fs:read')) return deny('fs:read');
        const payload = data.payload as Record<string, unknown> | undefined;
        const path = payload?.path;
        if (typeof path !== 'string' || path.length === 0) {
          respond(undefined, { code: 'INVALID_REQUEST', message: 'path must be a non-empty string' });
          return;
        }
        invoke('papr_fs_read', {
          appId,
          path,
          maxBytes: typeof payload?.maxBytes === 'number' ? payload.maxBytes : undefined,
          encoding: typeof payload?.encoding === 'string' ? payload.encoding : undefined,
        })
          .then((result) => respond(result))
          .catch((err) => respond(undefined, { code: 'FS_ERROR', message: String(err) }));
        return;
      }

      if (type === 'papr://fs.write') {
        if (!hasPermission('fs:write')) return deny('fs:write');
        const payload = data.payload as Record<string, unknown> | undefined;
        const path = payload?.path;
        if (typeof path !== 'string' || path.length === 0) {
          respond(undefined, { code: 'INVALID_REQUEST', message: 'path must be a non-empty string' });
          return;
        }
        invoke('papr_fs_write', {
          appId,
          path,
          content: typeof payload?.content === 'string' ? payload.content : '',
          encoding: typeof payload?.encoding === 'string' ? payload.encoding : undefined,
        })
          .then(() => respond(null))
          .catch((err) => respond(undefined, { code: 'FS_ERROR', message: String(err) }));
        return;
      }

      if (type === 'papr://fs.exists') {
        if (!hasPermission('fs:read')) return deny('fs:read');
        const payload = data.payload as Record<string, unknown> | undefined;
        const path = payload?.path;
        if (typeof path !== 'string' || path.length === 0) {
          respond(undefined, { code: 'INVALID_REQUEST', message: 'path must be a non-empty string' });
          return;
        }
        invoke('papr_fs_exists', { appId, path })
          .then((result) => respond(result))
          .catch((err) => respond(undefined, { code: 'FS_ERROR', message: String(err) }));
        return;
      }

      if (type === 'papr://fs.list') {
        if (!hasPermission('fs:read')) return deny('fs:read');
        const payload = data.payload as Record<string, unknown> | undefined;
        invoke('papr_fs_list', {
          appId,
          path: typeof payload?.path === 'string' ? payload.path : undefined,
        })
          .then((result) => respond(result))
          .catch((err) => respond(undefined, { code: 'FS_ERROR', message: String(err) }));
        return;
      }

      if (type === 'papr://fs.delete') {
        if (!hasPermission('fs:write')) return deny('fs:write');
        const payload = data.payload as Record<string, unknown> | undefined;
        const path = payload?.path;
        if (typeof path !== 'string' || path.length === 0) {
          respond(undefined, { code: 'INVALID_REQUEST', message: 'path must be a non-empty string' });
          return;
        }
        invoke('papr_fs_delete', {
          appId,
          path,
        })
          .then(() => respond(null))
          .catch((err) => respond(undefined, { code: 'FS_ERROR', message: String(err) }));
        return;
      }

      respond(undefined, {
        code: 'UNKNOWN_TYPE',
        message: `Unknown request type: ${type}`,
      });
    },
    // 稳定依赖：只随 appId/iframe 变化。manifest/appSettings 都经 ref 读取，
    // 它们的异步加载/父组件重渲染不再改变 handleMessage identity——否则订阅
    // effect 的 cleanup 会取消全部在飞的 app agent 执行。
    [appId, iframeRef],
  );

  useEffect(() => {
    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
      cancelAllRuns();
    };
  }, [handleMessage, cancelAllRuns]);

  return { postThemeNow, postWindowBounds, cancelAllRuns };
}
