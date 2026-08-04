import { useEffect, useCallback, useState, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { PaprManifest, PaprAgentDef, PaprAppSettings, PaprLevel } from '@codepapr/types';
import { isPaprMessage, createPaprResponse } from './paprProtocol';
import { usePermissionStore } from './permissionStore';
import { LEVEL_GRANTS, levelAllows, resolveEffectiveLevel } from './levelGrants';
import { useAgentStore } from '../store/agentStore';
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
}

export function usePaprBridge({ iframeRef, appId, manifest }: UsePaprBridgeOptions) {
  const cacheManifest = usePermissionStore((s) => s.cacheManifest);
  const [appSettings, setAppSettings] = useState<PaprAppSettings | null>(null);

  const activeAgentRuns = useRef<Map<string, { cancel: () => void; agentName: string }>>(new Map());

  useEffect(() => {
    if (manifest) {
      cacheManifest(appId, manifest);
    }
    invoke<PaprAppSettings>('papr_get_app_settings').then(setAppSettings).catch(() => {});
  }, [appId, manifest, cacheManifest]);

  const effectiveLevel: PaprLevel = resolveEffectiveLevel(manifest?.level, appSettings, appId);
  const effectiveLevelRef = useRef(effectiveLevel);
  effectiveLevelRef.current = effectiveLevel;

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      const appOrigin = appOriginFor(appId);
      if (event.origin !== appOrigin) return;
      // Defense in depth: even though each app now has its own origin, only
      // accept messages from this bridge's own iframe window.
      if (iframeRef.current && event.source !== iframeRef.current.contentWindow) return;

      const data = event.data;
      if (!isPaprMessage(data)) return;

      const resolvedManifest = manifest ?? usePermissionStore.getState().manifests[appId];
      if (!resolvedManifest) {
        const resp = createPaprResponse(data.reqId, undefined, {
          code: 'NO_MANIFEST',
          message: `No manifest loaded for app '${appId}'`,
        });
        postToIframe(iframeRef, resp, appOrigin);
        return;
      }

      const permissions = resolvedManifest.permissions ?? [];
      const currentLevel = effectiveLevelRef.current;

      function hasPermission(capability: string): boolean {
        if (!levelAllows(currentLevel, capability)) return false;
        if (permissions.length === 0) return true;
        if (permissions.includes(capability as never)) return true;
        const prefix = capability.split(':')[0];
        return permissions.includes(prefix as never);
      }

      function deny(capability: string) {
        const resp = createPaprResponse(data.reqId, undefined, {
          code: 'PERMISSION_DENIED',
          message: `Permission denied: '${capability}' (app level ${currentLevel})`,
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
        const rawPerms = resolvedManifest.permissions ?? [];
        const effectivePermissions = rawPerms.length === 0
          ? Array.from(LEVEL_GRANTS[currentLevel] ?? [])
          : rawPerms.filter((p) => levelAllows(currentLevel, p as never));
        respond({
          appId,
          name: resolvedManifest.name,
          version: resolvedManifest.version ?? '0.0.0',
          permissions: effectivePermissions,
          level: currentLevel,
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
              level: currentLevel,
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
              if (err instanceof WorkerCrashError || (err instanceof Error && err.name === 'WorkerCrashError')) {
                useAgentStore.setState({ _agent: null });
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
    [appId, manifest, iframeRef, appSettings],
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
}
