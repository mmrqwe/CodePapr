import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '@codepapr/core';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (_command: string, _args?: Record<string, unknown>) => ({})),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import { createWorkspaceToolContext } from './workspaceToolContext';
import { usePermissionStore, cancelExternalAccessRequests } from '../store/permissionStore';

function buildCtx() {
  const registry = new ToolRegistry();
  return createWorkspaceToolContext({
    registry,
    workspacePath: '/tmp/ws',
    options: { mode: 'agent' },
  });
}

async function flushPendingDialog() {
  // requestDangerousCommand 同步入队并 setState；多轮 microtask + 一个宏任务
  // 让 await 链就位到 pendingRequest 可读、respond 可解析。
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('高危命令 Confirm 闸门（WebView JS 宿主入口）', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async () => ({}));
    cancelExternalAccessRequests();
  });

  afterEach(() => {
    cancelExternalAccessRequests();
  });

  it('Confirm + 批准：弹窗展示命令/原因，批准后创建检查点再放行', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'classify_dangerous_command') {
        return { verdict: 'confirm', reason: 'git reset --hard 会丢弃未提交改动' };
      }
      if (command === 'snapshot_create') {
        return { sha: 'abc', label: 'before-bash', fileCount: 1 };
      }
      return {};
    });
    const ctx = buildCtx();
    const gate = ctx.ensureDangerousCommandAllowed('git reset --hard HEAD~1');
    await flushPendingDialog();

    const pending = usePermissionStore.getState().pendingRequest;
    expect(pending?.kind).toBe('dangerousCommand');
    expect(pending?.command).toBe('git reset --hard HEAD~1');
    expect(pending?.reason).toContain('git reset --hard');

    await usePermissionStore.getState().respondToExternalAccess(true, 'file');
    await gate;

    const snapshotCall = invokeMock.mock.calls.find(([c]) => c === 'snapshot_create');
    expect(snapshotCall?.[1]).toMatchObject({ workspacePath: '/tmp/ws' });
    expect(String(snapshotCall?.[1]?.label)).toContain('before-bash');
  });

  it('Confirm + 拒绝：可行动错误明确禁止改写绕过', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'classify_dangerous_command') {
        return { verdict: 'confirm', reason: '递归 chmod 批量改写权限' };
      }
      return {};
    });
    const ctx = buildCtx();
    const gate = ctx.ensureDangerousCommandAllowed('chmod -R 777 /srv/app');
    await flushPendingDialog();
    await usePermissionStore.getState().respondToExternalAccess(false, 'file');
    await expect(gate).rejects.toThrow(/用户拒绝执行高危命令/);
    await expect(gate).rejects.toThrow(/绕过|question 工具|手动运行/);
  });

  it('检查点创建失败 fail-closed：拒绝执行，即便用户已批准', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'classify_dangerous_command') {
        return { verdict: 'confirm', reason: '批量删除' };
      }
      if (command === 'snapshot_create') {
        throw new Error('snapshot repo locked');
      }
      return {};
    });
    const ctx = buildCtx();
    const gate = ctx.ensureDangerousCommandAllowed('find . -delete');
    await flushPendingDialog();
    await usePermissionStore.getState().respondToExternalAccess(true, 'file');
    await expect(gate).rejects.toThrow(/检查点创建失败/);
  });

  it('Allow 直接放行；Block 交 Rust impl 兜底；classify 不可用时不阻断', async () => {
    for (const verdict of [{ verdict: 'allow' }, { verdict: 'block', reason: 'x' }]) {
      invokeMock.mockImplementation(async (command: string) =>
        command === 'classify_dangerous_command' ? verdict : {}
      );
      const ctx = buildCtx();
      await expect(ctx.ensureDangerousCommandAllowed('some command')).resolves.toBeUndefined();
      expect(usePermissionStore.getState().pendingRequest).toBeNull();
    }
    // classify 命令本身抛错（非桌面运行时）：静默放行，不阻断正常命令
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'classify_dangerous_command') throw new Error('no such command');
      return {};
    });
    const ctx = buildCtx();
    await expect(ctx.ensureDangerousCommandAllowed('ls -la')).resolves.toBeUndefined();
  });
});
