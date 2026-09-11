import { describe, expect, it } from 'vitest';
import { maybeGenerateContextCheckpoint } from '../store/internals/contextCheckpoint';
import type { CompactionSettings, UIMessage } from '../store/internals/types';
import type { ContextCheckpointPayload, ContextMessageLike } from './contextCompaction';
import { estimateTokens } from '@codepapr/common';
import { setTodoListContext, resetTodoListContext } from '../tools/todoListRegistry';

function settings(hard: number): CompactionSettings {
  return {
    maxContextTokens: hard,
    lang: 'zh-CN',
    model: 'deepseek-v4',
    fastModelEnabled: false,
    fastModel: '',
    compactionModel: 'fast',
    compactionMaxTokens: 4096,
    compactionTemperature: 0.2,
  } as unknown as CompactionSettings;
}

function user(id: string, content: string): ContextMessageLike {
  return { id, role: 'user', content, timestamp: 1 };
}

function assistantWithTool(id: string, content: string, output: string): ContextMessageLike {
  return {
    id,
    role: 'assistant',
    content,
    timestamp: 2,
    toolInvocations: [
      { id: `${id}-c1`, name: 'bash', arguments: {}, status: 'success', output },
    ],
  };
}

function round(i: number, toolChars: number): ContextMessageLike[] {
  return [
    user(`u${i}`, `问题 ${i} ${'q'.repeat(80)}`),
    assistantWithTool(`a${i}`, `结论 ${i} ${'a'.repeat(80)}`, 'x'.repeat(toolChars)),
  ];
}

const asUI = (messages: ContextMessageLike[]): UIMessage[] => messages as unknown as UIMessage[];

describe('v4 压缩触发线（窗口 × 90%，取代轮数/软硬分层）', () => {
  it('低于 90% 线：不压缩', async () => {
    const messages = [...round(1, 400), ...round(2, 400)];
    const hard = 4_000;
    const result = await maybeGenerateContextCheckpoint(settings(hard), asUI(messages));
    expect(result).toBeNull();
  });

  it('达到 90% 线：产出 v4 骨架检查点，最近 5 回合逐字', async () => {
    const messages: ContextMessageLike[] = [];
    for (let i = 1; i <= 8; i += 1) messages.push(...round(i, 400));
    const hard = 1_500;
    const result = await maybeGenerateContextCheckpoint(
      settings(hard),
      asUI(messages),
      undefined,
      undefined,
      undefined,
      { trigger: 'token-limit', generation: 1, parentGeneration: 0 }
    );
    expect(result).not.toBeNull();
    const payload = (result!.message as ContextMessageLike).contextCheckpoint!;
    expect(payload.version).toBe(4);
    expect(payload.skeleton).toBeDefined();
    expect(payload.skeleton!.length).toBeGreaterThanOrEqual(1);
    expect(payload.renderedContent).toContain('[第 ');
    expect(payload.renderedContent).toContain('问：');
    expect(payload.trigger).toBe('token-limit');
    expect(payload.modelTier).toBe('local'); // 零 LLM 的确定性装配
    expect(payload.summaryInfo?.failureCode).toBe('deterministic-skeleton');
    expect(payload.tokenStats!.estimatedTokensAfter).toBeLessThan(
      payload.tokenStats!.estimatedTokensBefore
    );
    // 边界落在某条 user 消息之前（回合级 tail）
    const boundary = messages[result!.insertIndex];
    expect(boundary?.role).toBe('user');
    expect(messages.length - result!.insertIndex).toBe(10); // 最近 5 回合逐字（10 条 UI 消息）
  });

  it('force（/compact）低于触发线也压，trigger=manual；无内容可压则 null', async () => {
    const messages: ContextMessageLike[] = [];
    for (let i = 1; i <= 3; i += 1) messages.push(...round(i, 800));
    const result = await maybeGenerateContextCheckpoint(settings(40_000), asUI(messages), true);
    if (result) {
      expect((result.message as ContextMessageLike).contextCheckpoint!.trigger).toBe('manual');
    }
    const nothing = await maybeGenerateContextCheckpoint(
      settings(40_000),
      asUI([user('u1', '短'), assistantWithTool('a1', '更短', 'ok')]),
      true
    );
    expect(nothing).toBeNull();
  });

  it('骨架也装不下：一次二级摘要降级（compactor 不可用 → 确定性截断，零网络）', async () => {
    const messages: ContextMessageLike[] = [];
    for (let i = 1; i <= 60; i += 1) messages.push(...round(i, 1200));
    const result = await maybeGenerateContextCheckpoint(settings(1_000), asUI(messages));
    expect(result).not.toBeNull();
    const payload = (result!.message as ContextMessageLike).contextCheckpoint!;
    expect(payload.version).toBe(4);
    expect(payload.modelTier).toBe('local');
    expect(payload.summaryInfo).toMatchObject({
      kind: 'local-fallback',
      failureCode: 'compactor_unavailable',
    });
    // 摘要块存在且长度可控（估算口径不超过 before）
    expect(payload.summary.length).toBeGreaterThan(0);
    expect(payload.tokenStats!.estimatedTokensAfter).toBeLessThan(
      payload.tokenStats!.estimatedTokensBefore
    );
  });

  it('prior checkpoint 文本并入新块首（不摘要套摘要、不丢历史）', async () => {
    const priorPayload: ContextCheckpointPayload = {
      version: 3,
      summary: '早期结论 Z',
      renderedContent: '以下是先前长会话…\n早期结论 Z',
      sourceMessageCount: 4,
      sourceChars: 100,
      generatedAt: 1,
      modelName: 'x',
      modelTier: 'local',
    };
    const messages: ContextMessageLike[] = [
      user('u0', '最初的问题'),
      {
        id: 'cp-old',
        role: 'assistant',
        content: '',
        synthetic: true,
        hidden: true,
        timestamp: 2,
        contextCheckpoint: priorPayload,
      },
    ];
    for (let i = 1; i <= 8; i += 1) messages.push(...round(i, 4000));
    const result = await maybeGenerateContextCheckpoint(settings(4_000), asUI(messages));
    expect(result).not.toBeNull();
    const payload = (result!.message as ContextMessageLike).contextCheckpoint!;
    expect(payload.renderedContent).toContain('早期结论 Z');
    expect(payload.version).toBe(4);
    // 边界仍在旧 checkpoint 之后（旧节点不复活、不重摘）
    expect(result!.insertIndex).toBeGreaterThan(messages.findIndex((m) => m.id === 'cp-old'));
  });

  it('pinned：todo digest 独立渲染在检查点块尾', async () => {
    setTodoListContext('sess-pin', {
      goal: '压缩重构',
      tasks: [
        { id: 'eng', title: '压缩引擎改造', description: '', status: 'running' },
        { id: 'sub', title: '子代理接线', description: '', status: 'pending' },
      ],
      currentTaskId: 'eng',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    });
    const messages: ContextMessageLike[] = [];
    for (let i = 1; i <= 8; i += 1) messages.push(...round(i, 4000));
    const result = await maybeGenerateContextCheckpoint(
      settings(4_000),
      asUI(messages),
      undefined,
      '1. [running] 压缩引擎改造 ← current\n2. [pending] 子代理接线',
      undefined,
      undefined,
      'sess-pin'
    );
    resetTodoListContext('sess-pin');
    expect(result).not.toBeNull();
    const payload = (result!.message as ContextMessageLike).contextCheckpoint!;
    expect(payload.renderedContent).toContain('当前任务清单（权威状态）');
    expect(payload.renderedContent).toContain('压缩引擎改造');
    expect(estimateTokens(payload.renderedContent)).toBeGreaterThan(0);
  });
});
