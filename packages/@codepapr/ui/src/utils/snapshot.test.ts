// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import { snapshotCreateWithRetry } from './snapshot';

function snapshotInfo(sha: string) {
  return { sha, shortHash: sha.slice(0, 7), label: 'cp', timestamp: 1, fileCount: 2, isHead: true };
}

describe('snapshotCreateWithRetry', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('首次成功直接返回，不重试', async () => {
    invokeMock.mockResolvedValueOnce(snapshotInfo('sha-1'));
    const result = await snapshotCreateWithRetry('/ws', 'cp');
    expect(result?.sha).toBe('sha-1');
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('锁冲突错误会重试并在成功后返回', async () => {
    invokeMock
      .mockRejectedValueOnce(new Error('failed to lock file for writing index'))
      .mockResolvedValueOnce(snapshotInfo('sha-2'));
    const result = await snapshotCreateWithRetry('/ws', 'cp', { baseDelayMs: 1 });
    expect(result?.sha).toBe('sha-2');
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('非锁冲突错误不重试，立即抛出', async () => {
    invokeMock.mockRejectedValue(new Error('open repo: permission denied'));
    await expect(snapshotCreateWithRetry('/ws', 'cp', { baseDelayMs: 1 })).rejects.toThrow(
      'open repo'
    );
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('重试达到上限后抛出最后一次错误', async () => {
    invokeMock.mockRejectedValue(new Error('index.lock exists'));
    await expect(
      snapshotCreateWithRetry('/ws', 'cp', { attempts: 3, baseDelayMs: 1 })
    ).rejects.toThrow('index.lock');
    expect(invokeMock).toHaveBeenCalledTimes(3);
  });

  it('shouldAbort 为 true 时不再重试', async () => {
    invokeMock.mockRejectedValue(new Error('index.lock exists'));
    await expect(
      snapshotCreateWithRetry('/ws', 'cp', { baseDelayMs: 1, shouldAbort: () => true })
    ).rejects.toThrow('index.lock');
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
