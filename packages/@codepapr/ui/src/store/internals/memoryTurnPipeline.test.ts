import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runMemoryCuratorMock, readMemoryMdMock } = vi.hoisted(() => ({
  runMemoryCuratorMock: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ kind: 'nochange' })),
  readMemoryMdMock: vi.fn(async (): Promise<string | null> => '# 记忆\n- 条目\n'),
}));

vi.mock('../../utils/memoryCuratorRunner', () => ({
  runMemoryCurator: runMemoryCuratorMock,
}));

vi.mock('../../utils/memoryFile', () => ({
  readMemoryMd: readMemoryMdMock,
}));

import {
  clearCuratorOutcomes,
  getLastCuratorOutcome,
  runDeliveryCuratorForTurn,
  runPreCompactCurator,
  scheduleDeliveryCuratorForTurn,
} from './memoryTurnPipeline';
import type { CompactionSettings, UIMessage } from './types';

const settings = { lang: 'zh-CN', model: 'm' } as unknown as CompactionSettings;

function userMsg(id: string, content: string): UIMessage {
  return { id, role: 'user', content, timestamp: 1 } as UIMessage;
}

function assistantMsg(id: string, content: string, command?: string): UIMessage {
  return {
    id,
    role: 'assistant',
    content,
    timestamp: 2,
    toolInvocations: command
      ? [{ id: `c${id}`, name: 'bash', arguments: { command }, status: 'success' as const }]
      : undefined,
  } as unknown as UIMessage;
}

beforeEach(() => {
  runMemoryCuratorMock.mockReset();
  runMemoryCuratorMock.mockResolvedValue({ kind: 'nochange' });
  readMemoryMdMock.mockReset();
  readMemoryMdMock.mockResolvedValue('# 记忆\n- 条目\n');
  clearCuratorOutcomes();
});

describe('交付卡点（双信号门）', () => {
  it('无线索词、无验证命令 → 不调 curator', async () => {
    await runDeliveryCuratorForTurn({
      workspacePath: '/ws',
      turnMessages: [userMsg('u1', '改一下按钮颜色'), assistantMsg('a1', '好了')],
      settings,
    });
    expect(runMemoryCuratorMock).not.toHaveBeenCalled();
    expect(getLastCuratorOutcome('/ws')).toBeUndefined();
  });

  it('线索词命中 → 调 curator，素材含用户原话与最终答复', async () => {
    await runDeliveryCuratorForTurn({
      workspacePath: '/ws',
      turnMessages: [userMsg('u1', '以后都必须用 pnpm'), assistantMsg('a1', '明白，已记录')],
      settings,
    });
    expect(runMemoryCuratorMock).toHaveBeenCalledTimes(1);
    const call = runMemoryCuratorMock.mock.calls[0]![0] as {
      material: string;
      currentMd: string | null;
    };
    expect(call.material).toContain('以后都必须用 pnpm');
    expect(call.material).toContain('明白，已记录');
    expect(call.currentMd).toContain('记忆');
    expect(getLastCuratorOutcome('/ws')).toMatchObject({ kind: 'nochange', trigger: 'turn' });
  });

  it('验证成功的测试命令 → 调 curator（无需线索词）', async () => {
    await runDeliveryCuratorForTurn({
      workspacePath: '/ws',
      turnMessages: [userMsg('u1', '跑一下'), assistantMsg('a1', '全绿', 'pnpm test')],
      settings,
    });
    expect(runMemoryCuratorMock).toHaveBeenCalledTimes(1);
  });

  it('curator 抛错 → 不上抛，记录 failed', async () => {
    runMemoryCuratorMock.mockRejectedValue(new Error('provider 500'));
    await runDeliveryCuratorForTurn({
      workspacePath: '/ws',
      turnMessages: [userMsg('u1', '必须用 pnpm'), assistantMsg('a1', '好')],
      settings,
    });
    expect(getLastCuratorOutcome('/ws')).toMatchObject({ kind: 'failed', trigger: 'turn' });
  });

  it('scheduleDeliveryCuratorForTurn：fire-and-forget 不抛', async () => {
    runMemoryCuratorMock.mockRejectedValue(new Error('boom'));
    expect(() =>
      scheduleDeliveryCuratorForTurn({
        workspacePath: '/ws',
        turnMessages: [userMsg('u1', '必须用 pnpm'), assistantMsg('a1', '好')],
        settings,
      })
    ).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getLastCuratorOutcome('/ws')).toMatchObject({ kind: 'failed' });
  });
});

describe('pre-compact 卡点（无条件）', () => {
  it('空骨架 → skipped，不调模型', async () => {
    await runPreCompactCurator({ workspacePath: '/ws', skeleton: [], settings });
    expect(runMemoryCuratorMock).not.toHaveBeenCalled();
    expect(getLastCuratorOutcome('/ws')).toMatchObject({ kind: 'skipped', trigger: 'compact' });
  });

  it('骨架行 → 素材含轮次问答，curator 被调一次', async () => {
    await runPreCompactCurator({
      workspacePath: '/ws',
      skeleton: [{ userId: 'u1', q: '端口是几', a: '5432', droppedToolCalls: 2 }],
      settings,
    });
    expect(runMemoryCuratorMock).toHaveBeenCalledTimes(1);
    const call = runMemoryCuratorMock.mock.calls[0]![0] as { material: string };
    expect(call.material).toContain('端口是几');
    expect(call.material).toContain('5432');
    expect(getLastCuratorOutcome('/ws')).toMatchObject({ kind: 'nochange', trigger: 'compact' });
  });

  it('超时（20s）→ 记录 timeout，不阻塞', async () => {
    vi.useFakeTimers();
    try {
      runMemoryCuratorMock.mockImplementation(() => new Promise(() => undefined));
      const pending = runPreCompactCurator({
        workspacePath: '/ws-timeout',
        skeleton: [{ userId: 'u1', q: 'q', a: 'a' }],
        settings,
      });
      await vi.advanceTimersByTimeAsync(20_100);
      await pending;
      expect(getLastCuratorOutcome('/ws-timeout')).toMatchObject({ kind: 'timeout', trigger: 'compact' });
    } finally {
      vi.useRealTimers();
    }
  });
});
