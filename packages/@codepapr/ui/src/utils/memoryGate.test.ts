import { describe, expect, it } from 'vitest';
import {
  buildSkeletonMaterial,
  buildTurnMaterial,
  detectTurnMemorySignals,
  shouldRunDeliveryCurator,
  type GateMessage,
} from './memoryGate';

function user(id: string, content: string, extra: Partial<GateMessage> = {}): GateMessage {
  return { id, role: 'user', content, ...extra };
}

function assistant(
  id: string,
  content: string,
  toolInvocations?: GateMessage['toolInvocations'],
  extra: Partial<GateMessage> = {}
): GateMessage {
  return { id, role: 'assistant', content, toolInvocations, ...extra };
}

function bash(
  command: string,
  status: 'success' | 'error' = 'success',
  error?: string
): NonNullable<GateMessage['toolInvocations']>[number] {
  return { id: `c-${command}`, name: 'bash', arguments: { command }, status, error };
}

describe('detectTurnMemorySignals', () => {
  it('线索词：记住/以后都 命中；普通模态词「必须/禁止/always use/must use」不再触发', () => {
    expect(detectTurnMemorySignals([user('u1', '记住以后都用 pnpm')]).cue).toBe(true);
    expect(detectTurnMemorySignals([user('u1', '以后都用 pnpm')]).cue).toBe(true);
    expect(detectTurnMemorySignals([user('u1', '这个项目必须用中文注释')]).cue).toBe(false);
    expect(detectTurnMemorySignals([user('u1', '这个项目必须用中文注释')]).constraint).toBe(false);
    expect(detectTurnMemorySignals([user('u1', '禁止提交 .env')]).cue).toBe(false);
    expect(detectTurnMemorySignals([user('u1', 'you must use the --force flag')]).cue).toBe(false);
    expect(detectTurnMemorySignals([user('u1', 'always use the cache here')]).cue).toBe(false);
    expect(detectTurnMemorySignals([user('u1', '接下来改按钮样式')]).cue).toBe(false);
  });

  it('持久禁令：不要再用 / never … again 命中；never use 仍视为强信号', () => {
    expect(detectTurnMemorySignals([user('u1', '不要再用 npm 安装依赖')]).constraint).toBe(true);
    expect(detectTurnMemorySignals([user('u1', 'never use npm again')]).constraint).toBe(true);
    expect(detectTurnMemorySignals([user('u1', 'never use npm')]).cue).toBe(true);
  });

  it('线索词忽略合成/隐藏消息（goal 锚点、checkpoint）', () => {
    expect(
      detectTurnMemorySignals([user('u1', '必须记住', { synthetic: true })]).cue
    ).toBe(false);
    expect(
      detectTurnMemorySignals([
        user('u1', '必须记住', { contextCheckpoint: {} as never }),
      ]).cue
    ).toBe(false);
  });

  it('Agent 主动提议：最终答复「记忆候选：」命中；ask 答复与合成消息不算', () => {
    expect(
      detectTurnMemorySignals([
        user('u1', '把构建脚本整理一下'),
        assistant('a1', '完成了。\n记忆候选：构建统一走 pnpm，禁止 npm'),
      ]).agentProposal
    ).toBe(true);
    expect(
      detectTurnMemorySignals([
        assistant('a1', '完成了。\nMemory candidate: use pnpm everywhere'),
      ]).agentProposal
    ).toBe(true);
    expect(
      detectTurnMemorySignals([
        assistant('a1', '记忆候选：提问语境', undefined, { workMode: 'ask' }),
      ]).agentProposal
    ).toBe(false);
    expect(
      detectTurnMemorySignals([
        assistant('a1', '记忆候选：合成', undefined, { synthetic: true }),
      ]).agentProposal
    ).toBe(false);
  });

  it('工作事件：验证成功的测试/构建命令命中，失败或非测试命令不命中', () => {
    expect(
      detectTurnMemorySignals([assistant('a1', 'done', [bash('pnpm test')])]).verifiedCommand
    ).toBe('pnpm test');
    expect(
      detectTurnMemorySignals([assistant('a1', 'done', [bash('pnpm test', 'error', 'boom')])])
        .verifiedCommand
    ).toBeNull();
    expect(
      detectTurnMemorySignals([assistant('a1', 'done', [bash('ls -la')])]).verifiedCommand
    ).toBeNull();
    expect(
      detectTurnMemorySignals([assistant('a1', 'done', [bash('npm run build')])]).verifiedCommand
    ).toBe('npm run build');
  });

  it('shouldRunDeliveryCurator：任一信号命中即开', () => {
    expect(
      shouldRunDeliveryCurator({
        cue: false,
        constraint: false,
        agentProposal: false,
        verifiedCommand: null,
      })
    ).toBe(false);
    expect(
      shouldRunDeliveryCurator({
        cue: true,
        constraint: false,
        agentProposal: false,
        verifiedCommand: null,
      })
    ).toBe(true);
    expect(
      shouldRunDeliveryCurator({
        cue: false,
        constraint: true,
        agentProposal: false,
        verifiedCommand: null,
      })
    ).toBe(true);
    expect(
      shouldRunDeliveryCurator({
        cue: false,
        constraint: false,
        agentProposal: true,
        verifiedCommand: null,
      })
    ).toBe(true);
    expect(
      shouldRunDeliveryCurator({
        cue: false,
        constraint: false,
        agentProposal: false,
        verifiedCommand: 'pnpm test',
      })
    ).toBe(true);
  });
});

describe('buildTurnMaterial', () => {
  it('只取最后一个真实用户消息 + 最近 assistant 最终文本，不超过截断长度', () => {
    const material = buildTurnMaterial([
      user('u1', '第一轮问题'),
      assistant('a1', '第一轮答复'),
      user('u2', '第二轮问题 ' + 'x'.repeat(3000)),
      assistant('a2', '最终答复 ' + 'y'.repeat(3000)),
    ]);
    expect(material).toContain('User: 第二轮问题');
    expect(material).not.toContain('第一轮问题');
    expect(material).toContain('Assistant: 最终答复');
    expect(material.length).toBeLessThan(3000);
  });

  it('忽略合成消息与 checkpoint/ask 消息', () => {
    const material = buildTurnMaterial([
      user('u1', '真实问题'),
      user('u2', 'goal 迭代锚点', { synthetic: true }),
      assistant('a1', 'ask 模式答复', undefined),
      assistant('a2', '最终答复', undefined),
    ]);
    expect(material).toContain('真实问题');
    expect(material).not.toContain('goal 迭代锚点');
    expect(material).toContain('最终答复');
  });
});

describe('buildSkeletonMaterial', () => {
  it('渲染骨架行 + 活动行 + 既有摘要', () => {
    const material = buildSkeletonMaterial(
      [
        { userId: 'u1', q: '问题一', a: '答复一', droppedToolCalls: 3 },
        { userId: 'u2', q: '问题二', a: '答复二' },
      ],
      { activityText: '- [步骤 1] bash —— 跑测试', summaryBlock: '更早的摘要' }
    );
    expect(material).toContain('[轮次 1] User: 问题一');
    expect(material).toContain('Assistant: 答复一');
    expect(material).toContain('[轮次 2] User: 问题二');
    expect(material).toContain('更早的摘要');
    expect(material).toContain('跑测试');
  });

  it('空骨架 + 无活动行 → 空串（调用方跳过）', () => {
    expect(buildSkeletonMaterial([])).toBe('');
  });
});
