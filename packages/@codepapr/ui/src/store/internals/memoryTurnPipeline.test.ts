import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runMemoryCuratorMock, readMemoryMdMock, getMemoryMdPressureMock } = vi.hoisted(() => ({
  runMemoryCuratorMock: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ kind: 'nochange' })),
  readMemoryMdMock: vi.fn(async (): Promise<string | null> => '# 记忆\n- 条目\n'),
  getMemoryMdPressureMock: vi.fn(() => ({ tokens: 0, lines: 0, overPressure: false })),
}));

vi.mock('../../utils/memoryCuratorRunner', () => ({
  runMemoryCurator: runMemoryCuratorMock,
}));

vi.mock('../../utils/memoryFile', () => ({
  readMemoryMd: readMemoryMdMock,
  getMemoryMdPressure: getMemoryMdPressureMock,
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
  getMemoryMdPressureMock.mockReset();
  getMemoryMdPressureMock.mockReturnValue({ tokens: 0, lines: 0, overPressure: false });
  clearCuratorOutcomes();
});

describe('交付卡点（多信号门）', () => {
  it('无信号、无验证命令 → 不调 curator', async () => {
    await runDeliveryCuratorForTurn({
      workspacePath: '/ws',
      turnMessages: [userMsg('u1', '改一下按钮颜色'), assistantMsg('a1', '好了')],
      settings,
    });
    expect(runMemoryCuratorMock).not.toHaveBeenCalled();
    expect(getLastCuratorOutcome('/ws')).toBeUndefined();
  });

  it('普通模态词「必须」不触发（日常任务指令不再每回合误触）', async () => {
    await runDeliveryCuratorForTurn({
      workspacePath: '/ws-must',
      turnMessages: [userMsg('u1', '这个必须修复'), assistantMsg('a1', '好了')],
      settings,
    });
    expect(runMemoryCuratorMock).not.toHaveBeenCalled();
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

  it('Agent「记忆候选」提议 → 调 curator（无需用户线索词）', async () => {
    await runDeliveryCuratorForTurn({
      workspacePath: '/ws',
      turnMessages: [
        userMsg('u1', '把 CI 理顺'),
        assistantMsg('a1', '完成。\n记忆候选：CI 统一 node 22'),
      ],
      settings,
    });
    expect(runMemoryCuratorMock).toHaveBeenCalledTimes(1);
  });

  it('Ask 模式 → 永不触发交付 curator（压缩前卡点兜底）', async () => {
    await runDeliveryCuratorForTurn({
      workspacePath: '/ws-ask',
      turnMessages: [userMsg('u1', '记住这个约束'), assistantMsg('a1', '好的')],
      settings,
      workMode: 'ask',
    });
    expect(runMemoryCuratorMock).not.toHaveBeenCalled();
    scheduleDeliveryCuratorForTurn({
      workspacePath: '/ws-ask',
      turnMessages: [userMsg('u1', '记住这个约束'), assistantMsg('a1', '好的')],
      settings,
      workMode: 'ask',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runMemoryCuratorMock).not.toHaveBeenCalled();
  });

  it('curator 抛错 → 不上抛，记录 failed', async () => {
    runMemoryCuratorMock.mockRejectedValue(new Error('provider 500'));
    await runDeliveryCuratorForTurn({
      workspacePath: '/ws',
      turnMessages: [userMsg('u1', '不要再用 npm'), assistantMsg('a1', '好')],
      settings,
    });
    expect(getLastCuratorOutcome('/ws')).toMatchObject({ kind: 'failed', trigger: 'turn' });
  });

  it('scheduleDeliveryCuratorForTurn：fire-and-forget 不抛', async () => {
    runMemoryCuratorMock.mockRejectedValue(new Error('boom'));
    expect(() =>
      scheduleDeliveryCuratorForTurn({
        workspacePath: '/ws',
        turnMessages: [userMsg('u1', '不要再用 npm'), assistantMsg('a1', '好')],
        settings,
      })
    ).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getLastCuratorOutcome('/ws')).toMatchObject({ kind: 'failed' });
  });
});

describe('预算压力整理（ADR-017：无信号也整理）', () => {
  const bigMd = '# 大记忆\n- 条目\n';

  it('无信号但文件达压力线 → consolidate 模式兜底触发', async () => {
    readMemoryMdMock.mockResolvedValue(bigMd);
    getMemoryMdPressureMock.mockReturnValue({ tokens: 3900, lines: 110, overPressure: true });
    await runDeliveryCuratorForTurn({
      workspacePath: '/ws-press',
      turnMessages: [userMsg('u1', '改一下按钮颜色'), assistantMsg('a1', '好了')],
      settings,
    });
    expect(runMemoryCuratorMock).toHaveBeenCalledTimes(1);
    const call = runMemoryCuratorMock.mock.calls[0]![0] as { mode?: string; currentMd?: string };
    expect(call.mode).toBe('consolidate');
    expect(call.currentMd).toBe(bigMd);
    expect(getLastCuratorOutcome('/ws-press')).toMatchObject({
      kind: 'nochange',
      trigger: 'turn',
      mode: 'consolidate',
    });
  });

  it('信号命中且超预算 → 同样切 consolidate（新事实合并 + 压缩一把过）', async () => {
    readMemoryMdMock.mockResolvedValue(bigMd);
    getMemoryMdPressureMock.mockReturnValue({ tokens: 3900, lines: 110, overPressure: true });
    await runDeliveryCuratorForTurn({
      workspacePath: '/ws-sig',
      turnMessages: [userMsg('u1', '记住：端口是 5432'), assistantMsg('a1', '好')],
      settings,
    });
    expect(runMemoryCuratorMock).toHaveBeenCalledTimes(1);
    expect(
      (runMemoryCuratorMock.mock.calls[0]![0] as { mode?: string }).mode
    ).toBe('consolidate');
  });

  it('节流：整理未落盘且文件未变 → 不再重复触发；文件变化后恢复', async () => {
    getMemoryMdPressureMock.mockReturnValue({ tokens: 3900, lines: 110, overPressure: true });
    readMemoryMdMock.mockResolvedValue(bigMd);
    const turn = {
      workspacePath: '/ws-wall',
      turnMessages: [userMsg('u1', '改颜色'), assistantMsg('a1', '好了')],
      settings,
    };
    await runDeliveryCuratorForTurn(turn);
    await runDeliveryCuratorForTurn(turn);
    expect(runMemoryCuratorMock).toHaveBeenCalledTimes(1);

    readMemoryMdMock.mockResolvedValue('# 大记忆 v2\n- 条目\n');
    await runDeliveryCuratorForTurn(turn);
    expect(runMemoryCuratorMock).toHaveBeenCalledTimes(2);
  });

  it('整理成功落盘 → 节流墙清除（仍超线时下一回合继续迭代压缩）', async () => {
    getMemoryMdPressureMock.mockReturnValue({ tokens: 3900, lines: 110, overPressure: true });
    readMemoryMdMock.mockResolvedValue(bigMd);
    runMemoryCuratorMock.mockResolvedValue({ kind: 'updated', written: true });
    const turn = {
      workspacePath: '/ws-iter',
      turnMessages: [userMsg('u1', '改颜色'), assistantMsg('a1', '好了')],
      settings,
    };
    await runDeliveryCuratorForTurn(turn);
    await runDeliveryCuratorForTurn(turn);
    expect(runMemoryCuratorMock).toHaveBeenCalledTimes(2);
  });

  it('pre-compact：文件达压力线 → consolidate 模式；否则 update', async () => {
    getMemoryMdPressureMock.mockReturnValue({ tokens: 3900, lines: 110, overPressure: true });
    await runPreCompactCurator({
      workspacePath: '/ws-p',
      skeleton: [{ userId: 'u1', q: 'q', a: 'a' }],
      settings,
    });
    expect(
      (runMemoryCuratorMock.mock.calls[0]![0] as { mode?: string }).mode
    ).toBe('consolidate');

    runMemoryCuratorMock.mockClear();
    getMemoryMdPressureMock.mockReturnValue({ tokens: 100, lines: 5, overPressure: false });
    await runPreCompactCurator({
      workspacePath: '/ws-p',
      skeleton: [{ userId: 'u1', q: 'q', a: 'a' }],
      settings,
    });
    expect(
      (runMemoryCuratorMock.mock.calls[0]![0] as { mode?: string }).mode
    ).toBe('update');
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

  it('超时（20s）→ abort 在飞会话并记录 timeout，不阻塞', async () => {
    vi.useFakeTimers();
    try {
      let capturedSignal: AbortSignal | undefined;
      runMemoryCuratorMock.mockImplementation((...callArgs: unknown[]) => {
        capturedSignal = (callArgs[0] as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
        return new Promise(() => undefined);
      });
      const pending = runPreCompactCurator({
        workspacePath: '/ws-timeout',
        skeleton: [{ userId: 'u1', q: 'q', a: 'a' }],
        settings,
      });
      await vi.advanceTimersByTimeAsync(20_100);
      await pending;
      expect(capturedSignal?.aborted).toBe(true);
      expect(getLastCuratorOutcome('/ws-timeout')).toMatchObject({ kind: 'timeout', trigger: 'compact' });
    } finally {
      vi.useRealTimers();
    }
  });
});
