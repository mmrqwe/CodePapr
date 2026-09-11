/**
 * D：任务清单跨压缩存活的端到端验证。
 *
 * 压缩会毁掉模型可见的历史，如果计划只活在历史里，模型每次压缩后都会重新规划
 * 一遍（实测一个回合内 todo 全量重建 11 次、永远收不了尾）。清单必须作为权威
 * 分区出现在 checkpoint 正文里，且前言要改成「继续原清单」。
 */
import { describe, expect, it, vi } from 'vitest';
import type { TodoListContext } from '@codepapr/types';
import type { UIMessage } from './types';

vi.mock('../../tools/todoListRegistry', () => ({
  getTodoListContext: vi.fn(),
}));

import { getTodoListContext } from '../../tools/todoListRegistry';
import { maybeGenerateContextCheckpoint } from './contextCheckpoint';
import type { CompactionSettings } from './types';

const settings = {
  lang: 'zh-CN',
  model: 'test-model',
  compactionModel: 'fast',
  fastModelEnabled: false,
  fastModel: '',
  maxContextTokens: 200_000,
  compactionMaxTokens: 8_000,
} as unknown as CompactionSettings;

function uiMessage(id: string, role: 'user' | 'assistant', content: string): UIMessage {
  return {
    id,
    role,
    content,
    timestamp: Number(id.replace(/\D/g, '')) || 1,
    toolInvocations: [],
  } as unknown as UIMessage;
}

// v4 缩容校验要求 after < before：给旧回合足够体量，骨架化才有真实收益。
const messages = [
  uiMessage('u1', 'user', '星球间距离、比例不对，太阳过曝了 ' + 'q'.repeat(2000)),
  uiMessage('a1', 'assistant', '我先诊断渲染链路，再按方向改 ' + 'a'.repeat(4000)),
  uiMessage('u2', 'user', '继续'),
  uiMessage('a2', 'assistant', '已经缩小光晕，太阳仍偏白'),
];

const activePlan: TodoListContext = {
  goal: '修太阳过曝',
  currentTaskId: 'fix-sun-v2',
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
  tasks: [
    {
      id: 'diagnose',
      title: '诊断渲染链路',
      description: '定位链路',
      status: 'completed',
      summary: '链路已定位',
    },
    { id: 'fix-sun-v2', title: '二轮修正太阳光效果', description: '改 solarSystem.js', status: 'running' },
    { id: 'verify-v2', title: '验证二轮修改', description: '截图对比', status: 'pending' },
  ],
};

function renderedContentOf(result: Awaited<ReturnType<typeof maybeGenerateContextCheckpoint>>): string {
  if (!result || !('message' in result)) {
    throw new Error('未生成 checkpoint');
  }
  return result.message.contextCheckpoint!.renderedContent;
}

describe('maybeGenerateContextCheckpoint：权威任务清单进正文', () => {
  it('清单仍有未完成项时，渲染清单 + 「继续原清单」前言', async () => {
    vi.mocked(getTodoListContext).mockReturnValue(activePlan);
    const result = await maybeGenerateContextCheckpoint(
      settings,
      messages,
      true,
      [
        '[TodoList] 目标: 修太阳过曝',
        '  ✓ diagnose: 诊断渲染链路',
        '  ▶ fix-sun-v2: 二轮修正太阳光效果 ← current',
        '  ○ verify-v2: 验证二轮修改',
      ].join('\n'),
      undefined,
      undefined,
      'session-d'
    );
    const content = renderedContentOf(result);
    expect(content).toContain('当前任务清单（权威状态）');
    expect(content).toContain('fix-sun-v2');
    expect(content).toContain('verify-v2');
    expect(content).toContain('请继续推进其中 running/pending 的任务');
    expect(content).not.toContain('否则不要主动恢复或继续检查点中的旧任务');
  });

  it('清单已全部终结时不渲染（不误导模型继续已完成的计划）', async () => {
    vi.mocked(getTodoListContext).mockReturnValue({
      ...activePlan,
      status: 'completed',
      currentTaskId: null,
      tasks: activePlan.tasks.map((task) => ({ ...task, status: 'completed' as const })),
    });
    const result = await maybeGenerateContextCheckpoint(
      settings,
      messages,
      true,
      '[TodoList] 目标: 修太阳过曝\n  ✓ diagnose: 诊断渲染链路',
      undefined,
      undefined,
      'session-d-done'
    );
    const content = renderedContentOf(result);
    expect(content).not.toContain('当前任务清单（权威状态）');
    expect(content).toContain('否则不要主动恢复或继续检查点中的旧任务');
  });

  it('F：确定性装配零 LLM 时 summaryInfo 记 deterministic-skeleton（compactor_unavailable 见预算用例）', async () => {
    vi.mocked(getTodoListContext).mockReturnValue(activePlan);
    const result = await maybeGenerateContextCheckpoint(
      settings,
      messages,
      true,
      undefined,
      undefined,
      undefined,
      'session-f'
    );
    if (!result || !('message' in result)) throw new Error('未生成 checkpoint');
    const payload = result.message.contextCheckpoint!;
    expect(payload.summaryInfo?.kind).toBe('local-fallback');
    expect(payload.summaryInfo?.failureCode).toBe('deterministic-skeleton');
    expect(payload.skeleton!.length).toBeGreaterThan(0);
  });
});
