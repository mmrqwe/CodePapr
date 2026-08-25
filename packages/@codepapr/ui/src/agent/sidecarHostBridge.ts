import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { usePermissionStore } from '../store/permissionStore';

const PERMISSION_EVENT = 'agent-runtime://permission-request';
const PERMISSION_CANCEL_EVENT = 'agent-runtime://permission-cancel';
const WORKSPACE_MUTATED_EVENT = 'agent-runtime://workspace-mutated';

interface PermissionRequestPayload {
  runtimeId: string;
  requestId: string;
  path: string;
  operation: 'read' | 'list' | 'write' | 'execute';
  workspacePath: string;
  exists: boolean;
  allowFile: boolean;
}

interface PermissionCancelPayload {
  runtimeId: string;
  requestId: string;
}

interface WorkspaceMutatedPayload {
  runtimeId: string;
  paths: string[];
}

/**
 * Sidecar P1: Rust asks the UI to show the existing permission dialog, then
 * writes tool-response itself. Workspace mutations still refresh the file tree.
 */
export async function attachSidecarHostBridge(options: {
  runtimeId: string;
  onWorkspaceMutated?: (paths: string[]) => void;
}): Promise<() => void> {
  const controllers = new Map<string, AbortController>();
  const unlistenPermission = await listen<PermissionRequestPayload>(PERMISSION_EVENT, (event) => {
    if (event.payload.runtimeId !== options.runtimeId) return;
    const controller = new AbortController();
    controllers.set(event.payload.requestId, controller);
    void (async () => {
      try {
        const result = await usePermissionStore.getState().requestExternalAccess(
          event.payload.path,
          event.payload.operation,
          event.payload.workspacePath,
          event.payload.allowFile,
          controller.signal,
        );
        await invoke('agent_runtime_permission_respond', {
          requestId: event.payload.requestId,
          approved: result.approved,
          scope: result.scope,
        });
      } catch {
        await invoke('agent_runtime_permission_respond', {
          requestId: event.payload.requestId,
          approved: false,
          scope: 'file',
        }).catch(() => undefined);
      } finally {
        controllers.delete(event.payload.requestId);
      }
    })();
  });
  const unlistenCancel = await listen<PermissionCancelPayload>(PERMISSION_CANCEL_EVENT, (event) => {
    if (event.payload.runtimeId !== options.runtimeId) return;
    controllers.get(event.payload.requestId)?.abort();
  });
  const unlistenMutated = await listen<WorkspaceMutatedPayload>(WORKSPACE_MUTATED_EVENT, (event) => {
    if (event.payload.runtimeId !== options.runtimeId) return;
    options.onWorkspaceMutated?.(event.payload.paths);
  });

  return () => {
    for (const controller of controllers.values()) {
      controller.abort();
    }
    controllers.clear();
    unlistenPermission();
    unlistenCancel();
    unlistenMutated();
  };
}

export function _sidecarHostBridgeEventsForTest(): {
  permission: string;
  cancel: string;
  mutated: string;
} {
  return {
    permission: PERMISSION_EVENT,
    cancel: PERMISSION_CANCEL_EVENT,
    mutated: WORKSPACE_MUTATED_EVENT,
  };
}
