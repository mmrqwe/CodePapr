import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import {
  cancelExternalAccessRequests,
  usePermissionStore,
} from './permissionStore';

describe('permissionStore', () => {
  beforeEach(() => {
    cancelExternalAccessRequests();
    usePermissionStore.setState({
      pendingRequest: null,
      allowedExternalDirs: [],
      allowedExternalFiles: [],
      yolo: false,
    });
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'grant_external_access') {
        return {
          yolo: false,
          allowedDirs: ['/tmp'],
          allowedFiles: [],
        };
      }
      if (command === 'get_external_access_policy') {
        return { yolo: false, allowedDirs: [], allowedFiles: [] };
      }
      if (command === 'set_external_access_yolo') {
        return { yolo: true, allowedDirs: [], allowedFiles: [] };
      }
      return undefined;
    });
  });

  it('queues requests and returns denial to the waiting tool', async () => {
    const first = usePermissionStore
      .getState()
      .requestExternalAccess('/tmp/first.txt', 'read', '/workspace');
    const second = usePermissionStore
      .getState()
      .requestExternalAccess('/tmp/second.txt', 'read', '/workspace');

    expect(usePermissionStore.getState().pendingRequest?.path).toBe('/tmp/first.txt');

    await usePermissionStore.getState().respondToExternalAccess(false, 'file');
    await expect(first).resolves.toEqual({ approved: false, scope: 'file' });
    expect(usePermissionStore.getState().pendingRequest?.path).toBe('/tmp/second.txt');

    await usePermissionStore.getState().respondToExternalAccess(true, 'directory');
    await expect(second).resolves.toEqual({ approved: true, scope: 'directory' });
    expect(invokeMock).toHaveBeenCalledWith('grant_external_access', {
      workspacePath: '/workspace',
      rawPath: '/tmp',
      scope: 'directory',
    });
    expect(usePermissionStore.getState().pendingRequest).toBeNull();
  });

  it('does not resolve a request until the user responds', async () => {
    let settled = false;
    const request = usePermissionStore
      .getState()
      .requestExternalAccess('/tmp/wait.txt', 'read', '/workspace')
      .then(() => {
        settled = true;
      });

    await Promise.resolve();
    expect(settled).toBe(false);
    await usePermissionStore.getState().respondToExternalAccess(false, 'file');
    await request;
    expect(settled).toBe(true);
  });

  it('hydrates YOLO without adding an automatic permanent grant', async () => {
    await usePermissionStore.getState().setYolo(true);
    expect(usePermissionStore.getState().yolo).toBe(true);
    expect(usePermissionStore.getState().allowedExternalDirs).toEqual([]);
  });
});
