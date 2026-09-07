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
  /** 缺省 externalPath；dangerousCommand 时展示 command/reason，once-only。 */
  kind?: 'externalPath' | 'dangerousCommand';
  command?: string;
  reason?: string;
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
        let approved: boolean;
        let scope: string;
        if (event.payload.kind === 'dangerousCommand') {
          // 高危命令确认：Rust 侧批准后自行创建 fail-closed 检查点，
          // 这里只回报批准与否（scope 用 'once'，不产生任何持久授权）。
          approved = await usePermissionStore.getState().requestDangerousCommand(
            event.payload.command ?? event.payload.path,
            event.payload.reason ?? '该命令具有破坏性，需用户确认。',
            event.payload.workspacePath,
            controller.signal,
          );
          scope = 'once';
        } else {
          const result = await usePermissionStore.getState().requestExternalAccess(
            event.payload.path,
            event.payload.operation,
            event.payload.workspacePath,
            event.payload.allowFile,
            controller.signal,
          );
          approved = result.approved;
          scope = result.scope;
        }
        await invoke('agent_runtime_permission_respond', {
          requestId: event.payload.requestId,
          approved,
          scope,
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
