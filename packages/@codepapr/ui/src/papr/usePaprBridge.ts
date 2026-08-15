import { useEffect, useCallback, useState, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { PaprManifest, PaprAgentDef, PaprAppSettings } from '@codepapr/types';
import { isPaprMessage, createPaprResponse } from './paprProtocol';
import { usePermissionStore } from './permissionStore';
import { accessAllows, resolveEffectiveAccess } from './levelGrants';
import { useAgentStore } from '../store/agentStore';
import { useThemeStore } from '../store/themeStore';
import type { ThemeMode } from '../theme/types';
import { invalidateAgentHandle } from '../store/internals/sendMessage';
import { WorkerCrashError } from '../agent/WorkerBackedAgent';
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
}

export function usePaprBridge({ iframeRef, appId, manifest, onAppReady }: UsePaprBridgeOptions) {
  const cacheManifest = usePermissionStore((s) => s.cacheManifest);
  const [appSettings, setAppSettings] = useState<PaprAppSettings | null>(null);

  const activeAgentRuns = useRef<Map<string, { cancel: () => void; agentName: string }>>(new Map());

  useEffect(() => {
    if (manifest) {
      cacheManifest(appId, manifest);
    }
    invoke<PaprAppSettings>('papr_get_app_settings').then(setAppSettings).catch(() => {});
  }, [appId, manifest, cacheManifest]);

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

  useEffect(() => {
    postTheme(themeId, themeMode, themeMode === 'dark');
  }, [themeId, themeMode, postTheme]);

  const effectiveAccess = resolveEffectiveAccess(manifest, appSettings, appId);
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
        onAppReadyRef.current?.();
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
        respond({
          appId,
          name: resolvedManifest.name,
          version: resolvedManifest.version ?? '0.0.0',
          permissions,
          local: currentAccess.local,
          network: currentAccess.network,
        });
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

          // App Agent 运行期间同样防休眠：它复用聊天 Agent 的 Worker，
          // 休眠会连 Worker 一起杀掉。
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
                if (useAgentStore.getState()._agent === agent) {
                  invalidateAgentHandle(useAgentStore.getState, useAgentStore.setState);
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
        })
          .then(() => respond(null))
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
      for (const [, run] of activeAgentRuns.current) {
        run.cancel();
      }
      activeAgentRuns.current.clear();
    };
  }, [handleMessage]);

  return { postThemeNow };
}
