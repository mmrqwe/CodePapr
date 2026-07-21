import { useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { PaprManifest, PaprAgentDef } from '@codepapr/types';
import { isPaprMessage, createPaprResponse } from './paprProtocol';
import { usePermissionStore } from './permissionStore';
import { getActiveAgent } from '../agent/WorkerBackedAgent';
import { useAgentStore } from '../store/agentStore';

interface UsePaprBridgeOptions {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  appId: string;
  manifest: PaprManifest | null;
}

export function usePaprBridge({ iframeRef, appId, manifest }: UsePaprBridgeOptions) {
  const cacheManifest = usePermissionStore((s) => s.cacheManifest);

  useEffect(() => {
    if (manifest) {
      cacheManifest(appId, manifest);
    }
  }, [appId, manifest, cacheManifest]);

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      const data = event.data;
      if (!isPaprMessage(data)) return;

      const resolvedManifest = manifest ?? usePermissionStore.getState().manifests[appId];
      if (!resolvedManifest) {
        const resp = createPaprResponse(data.reqId, undefined, {
          code: 'NO_MANIFEST',
          message: `No manifest loaded for app '${appId}'`,
        });
        iframeRef.current?.contentWindow?.postMessage(resp, '*');
        return;
      }

      const permissions = resolvedManifest.permissions ?? [];

      function hasPermission(capability: string): boolean {
        if (permissions.includes(capability as never)) return true;
        const prefix = capability.split(':')[0];
        return permissions.includes(prefix as never);
      }

      function deny(capability: string) {
        const resp = createPaprResponse(data.reqId, undefined, {
          code: 'PERMISSION_DENIED',
          message: `Permission denied: '${capability}' not in manifest`,
        });
        iframeRef.current?.contentWindow?.postMessage(resp, '*');
      }

      function respond(result?: unknown, error?: { code: string; message: string }) {
        const resp = createPaprResponse(data.reqId, result, error);
        iframeRef.current?.contentWindow?.postMessage(resp, '*');
      }

      const type = data.type;

      // ── db.* ─────────────────────────────────────────────────────
      if (type === 'papr://db.get') {
        if (!hasPermission('storage:read')) return deny('storage:read');
        const key = (data.payload as Record<string, unknown>)?.key as string;
        invoke('papr_storage_get', { appId, key })
          .then((result) => respond(result))
          .catch((err) => respond(undefined, { code: 'DB_ERROR', message: String(err) }));
        return;
      }

      if (type === 'papr://db.set') {
        if (!hasPermission('storage:write')) return deny('storage:write');
        const payload = data.payload as Record<string, unknown>;
        invoke('papr_storage_set', { appId, key: payload.key as string, value: JSON.stringify(payload.value) })
          .then(() => respond(null))
          .catch((err) => respond(undefined, { code: 'DB_ERROR', message: String(err) }));
        return;
      }

      if (type === 'papr://db.delete') {
        if (!hasPermission('storage:write')) return deny('storage:write');
        const key = (data.payload as Record<string, unknown>)?.key as string;
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

      // ── app.info ─────────────────────────────────────────────────
      if (type === 'papr://app.info') {
        respond({
          appId,
          name: resolvedManifest.name,
          version: resolvedManifest.version ?? '0.0.0',
          permissions: resolvedManifest.permissions ?? [],
        });
        return;
      }

      if (type === 'papr://agent.run') {
        const payload = data.payload as Record<string, unknown> | undefined;
        const agentName = String(payload?.agentName ?? '');
        const task = String(payload?.task ?? '');
        if (!agentName) {
          respond(undefined, { code: 'INVALID_REQUEST', message: 'agentName is required' });
          return;
        }
        const capability = `agent:run:${agentName}`;
        if (!hasPermission(capability)) return deny(capability);

        const agentDef = resolvedManifest.agents?.find((a: PaprAgentDef) => a.name === agentName);
        if (!agentDef) {
          respond(undefined, { code: 'AGENT_NOT_FOUND', message: `Agent '${agentName}' not found in manifest` });
          return;
        }

        const agent = getActiveAgent();
        if (!agent) {
          respond(undefined, { code: 'NO_AGENT', message: 'No active agent session. Open a chat first.' });
          return;
        }

        const workspacePath = useAgentStore.getState().workspacePath;

        agent.runAppAgent(
          {
            appId,
            agentName,
            systemPrompt: agentDef.systemPrompt,
            model: agentDef.model,
            task,
            tools: agentDef.tools,
            maxToolRounds: agentDef.maxToolRounds,
            workspacePath,
          },
          (event) => {
            iframeRef.current?.contentWindow?.postMessage({
              __papr: true,
              reqId: data.reqId,
              type: 'stream',
              event,
            }, '*');
          },
        )
          .then((result) => respond(result))
          .catch((err) => respond(undefined, { code: 'AGENT_ERROR', message: String(err) }));
        return;
      }

      // ── http.* ────────────────────────────────────────────────────
      if (type === 'papr://http.get') {
        if (!hasPermission('http:get')) return deny('http:get');
        const payload = data.payload as Record<string, unknown> | undefined;
        invoke('papr_http_get', {
          appId,
          url: payload?.url as string,
          maxBytes: payload?.maxBytes as number | undefined,
        })
          .then((result) => respond(result))
          .catch((err) => respond(undefined, { code: 'HTTP_ERROR', message: String(err) }));
        return;
      }

      if (type === 'papr://http.post') {
        if (!hasPermission('http:post')) return deny('http:post');
        const payload = data.payload as Record<string, unknown> | undefined;
        invoke('papr_http_post', {
          appId,
          url: payload?.url as string,
          body: payload?.body as string,
          contentType: payload?.contentType as string | undefined,
        })
          .then((result) => respond(result))
          .catch((err) => respond(undefined, { code: 'HTTP_ERROR', message: String(err) }));
        return;
      }

      // ── fs.* ──────────────────────────────────────────────────────
      if (type === 'papr://fs.read') {
        if (!hasPermission('fs:read')) return deny('fs:read');
        const payload = data.payload as Record<string, unknown> | undefined;
        invoke('papr_fs_read', {
          appId,
          path: payload?.path as string,
          maxBytes: payload?.maxBytes as number | undefined,
        })
          .then((result) => respond(result))
          .catch((err) => respond(undefined, { code: 'FS_ERROR', message: String(err) }));
        return;
      }

      if (type === 'papr://fs.write') {
        if (!hasPermission('fs:write')) return deny('fs:write');
        const payload = data.payload as Record<string, unknown> | undefined;
        invoke('papr_fs_write', {
          appId,
          path: payload?.path as string,
          content: payload?.content as string,
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
          path: payload?.path as string | undefined,
        })
          .then((result) => respond(result))
          .catch((err) => respond(undefined, { code: 'FS_ERROR', message: String(err) }));
        return;
      }

      if (type === 'papr://fs.delete') {
        if (!hasPermission('fs:write')) return deny('fs:write');
        const payload = data.payload as Record<string, unknown> | undefined;
        invoke('papr_fs_delete', {
          appId,
          path: payload?.path as string,
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
    [appId, manifest, iframeRef],
  );

  useEffect(() => {
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [handleMessage]);
}
