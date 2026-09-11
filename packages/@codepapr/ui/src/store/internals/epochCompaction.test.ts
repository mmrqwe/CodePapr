import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UIMessage } from './types';

const { runPreCompactCuratorMock, loadMemorySectionMock, createAgentMock, buildBootstrapMock } =
  vi.hoisted(() => ({
    runPreCompactCuratorMock: vi.fn(async (..._args: unknown[]) => undefined),
    loadMemorySectionMock: vi.fn(async (..._args: unknown[]) => '## 项目记忆\n- 新条目'),
    createAgentMock: vi.fn((..._args: unknown[]) => ({ id: 'rebuilt-agent' })),
    buildBootstrapMock: vi.fn(
      (...args: unknown[]) => `BOOT:${String(args[3] ?? '')}`
    ),
  }));

vi.mock('./memoryTurnPipeline', () => ({
  runPreCompactCurator: runPreCompactCuratorMock,
}));
vi.mock('../../utils/memoryFile', () => ({
  loadMemorySectionForPrompt: loadMemorySectionMock,
}));
vi.mock('./agentFactory', () => ({
  createAgent: createAgentMock,
}));
vi.mock('./promptBuilders', () => ({
  buildAgentSessionBootstrapPrompt: buildBootstrapMock,
}));

import { applyEpochCompaction, isSafeCheckpointInsert } from './epochCompaction';

function zeroStats() {
  return {
    totalCacheRead: 0,
    totalCacheCreation: 0,
    totalInput: 0,
    totalOutput: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
    calls: 0,
    rounds: 0,
  };
}

function emptyConversationStats() {
  return { primary: zeroStats(), fast: zeroStats(), mentor: zeroStats() };
}

function message(id: string, timestamp: number): UIMessage {
  return { id, role: 'user', content: id, timestamp } as UIMessage;
}

function checkpoint(insertIndex = 1) {
  return {
    message: {
      id: 'cp',
      role: 'assistant',
      content: '',
      synthetic: true,
      hidden: true,
      timestamp: 3,
      contextCheckpoint: {
        version: 4,
        summary: '骨架',
        renderedContent: '骨架内容',
        sourceMessageCount: 1,
        sourceChars: 10,
        generatedAt: 1,
        modelName: 'local-checkpoint',
        modelTier: 'local',
        skeleton: [{ userId: 'u1', assistantId: null, q: 'q', a: 'a', droppedToolCalls: 0 }],
      },
    } as UIMessage,
    modelTier: 'local' as const,
    insertIndex,
  };
}

function makeStore(
  overrides: Record<string, unknown> = {},
  messages: UIMessage[] = [message('u1', 1), message('u2', 2)]
) {
  const state: Record<string, unknown> = {
    sessionMessages: { s1: messages },
    activeSessionId: 's1',
    _agent: null,
    _agentModel: null,
    _agentPromptKey: null,
    _agentSessionId: null,
    conversationStats: emptyConversationStats(),
    sessionConversationStats: {},
    ...overrides,
  };
  const set = (partial: unknown) => {
    const patch =
      typeof partial === 'function'
        ? (partial as (s: unknown) => Record<string, unknown>)(state)
        : (partial as Record<string, unknown>);
    Object.assign(state, patch);
  };
  const get = () => state as never;
  return { state, set: set as never, get, messages };
}

beforeEach(() => {
  runPreCompactCuratorMock.mockClear();
  loadMemorySectionMock.mockClear();
  loadMemorySectionMock.mockResolvedValue('## 项目记忆\n- 新条目');
  createAgentMock.mockClear();
  buildBootstrapMock.mockClear();
});

describe('applyEpochCompaction', () => {
  it('destroy：curator → 插 checkpoint → 销毁旧 agent → await commit', async () => {
    const destroy = vi.fn();
    const fakeAgent = { destroy, hasActiveAppAgentRequests: () => false };
    const { state, set, get, messages: baseMessages } = makeStore({
      _agent: fakeAgent,
      _agentSessionId: 's1',
    });
    const commit = vi.fn(async () => true);
    const cp = checkpoint();

    const result = await applyEpochCompaction(get, set, {
      checkpoint: cp,
      baseMessages,
      trigger: 'manual',
      sessionId: 's1',
      strategy: 'destroy',
      settings: {} as never,
      workspacePath: '/ws',
      commit,
    });

    expect(runPreCompactCuratorMock).toHaveBeenCalledTimes(1);
    expect(runPreCompactCuratorMock.mock.calls[0]![0]).toMatchObject({
      workspacePath: '/ws',
      skeleton: cp.message.contextCheckpoint!.skeleton,
    });
    expect(result).toEqual({ applied: true, committed: true, rebuiltAgent: null });
    expect((state.sessionMessages as Record<string, UIMessage[]>)['s1']!.map((m) => m.id)).toEqual([
      'u1',
      'cp',
      'u2',
    ]);
    expect(state._agent).toBeNull();
    expect(state._agentSessionId).toBeNull();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        workspace: '/ws',
        trigger: 'manual',
        checkpointMessageId: 'cp',
      })
    );
  });

  it('destroy：基座失效（并发清空）→ 不提交、不销毁，applied=false', async () => {
    const destroy = vi.fn();
    const fakeAgent = { destroy, hasActiveAppAgentRequests: () => false };
    const { state, set, get, messages: baseMessages } = makeStore({
      _agent: fakeAgent,
      _agentSessionId: 's1',
      sessionMessages: { s1: [] },
    });
    const commit = vi.fn(async () => true);

    const result = await applyEpochCompaction(get, set, {
      checkpoint: checkpoint(),
      baseMessages,
      trigger: 'manual',
      sessionId: 's1',
      strategy: 'destroy',
      settings: {} as never,
      workspacePath: '/ws',
      commit,
    });

    expect(result).toEqual({ applied: false, committed: false, rebuiltAgent: null });
    expect(commit).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(state._agent).toBe(fakeAgent);
  });

  it('rebuild：重渲 Bootstrap 写回 config、就地重建 agent、commit 失败返回 committed=false', async () => {
    const prevDestroy = vi.fn();
    const prevAgent = { destroy: prevDestroy, hasActiveAppAgentRequests: () => false };
    const rebuilt = { id: 'rebuilt-agent' };
    createAgentMock.mockReturnValue(rebuilt);
    const runtimeAgentConfig: Record<string, unknown> = { sessionBootstrapPrompt: 'OLD' };
    const { state, set, get, messages: baseMessages } = makeStore({
      _agent: prevAgent,
      _agentSessionId: 's1',
    });
    const commit = vi.fn(async () => false);
    const cp = checkpoint();

    const result = await applyEpochCompaction(get, set, {
      checkpoint: cp,
      baseMessages,
      trigger: 'token-limit',
      sessionId: 's1',
      workspacePath: '/ws',
      settings: {} as never,
      commit,
      rebuild: {
        skillDefinitions: [],
        pluginsSection: 'P',
        mode: 'agent',
        route: { model: 'm', temperature: 0, maxTokens: 1, thinkingEnabled: false } as never,
        runtimeSystemPrompt: 'SYS',
        fallbackBootstrapPrompt: 'OLD',
        runtimeAgentConfig: runtimeAgentConfig as never,
      },
    });

    expect(buildBootstrapMock).toHaveBeenCalledTimes(1);
    expect(runtimeAgentConfig.sessionBootstrapPrompt).toBe('BOOT:## 项目记忆\n- 新条目');
    expect(state._agent).toBe(rebuilt);
    expect(state._agentPromptKey).toBe(
      'SYS\n\n--- session-bootstrap ---\n\nBOOT:## 项目记忆\n- 新条目'
    );
    expect(prevDestroy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ applied: true, committed: false, rebuiltAgent: rebuilt });
  });

  it('rebuild：目标会话不是当前查看会话时不动当前 agent 句柄（防误杀/泄漏）', async () => {
    const otherAgent = { id: 'other-session-agent' };
    const { state, set, get, messages: baseMessages } = makeStore({
      activeSessionId: 's2',
      _agent: otherAgent,
      _agentSessionId: 's2',
    });
    const commit = vi.fn(async () => true);
    createAgentMock.mockReturnValue({ id: 'never-used' });

    const result = await applyEpochCompaction(get, set, {
      checkpoint: checkpoint(),
      baseMessages,
      trigger: 'token-limit',
      sessionId: 's1',
      workspacePath: '/ws',
      settings: {} as never,
      commit,
      rebuild: {
        skillDefinitions: [],
        mode: 'agent',
        route: { model: 'm', temperature: 0, maxTokens: 1, thinkingEnabled: false } as never,
        runtimeSystemPrompt: 'SYS',
        runtimeAgentConfig: {} as never,
      },
    });

    expect(state._agent).toBe(otherAgent);
    expect(state._agentSessionId).toBe('s2');
    expect(createAgentMock).not.toHaveBeenCalled();
    expect(result.rebuiltAgent).toBeNull();
    expect((state.sessionMessages as Record<string, UIMessage[]>)['s1']!.some((m) => m.id === 'cp')).toBe(
      true
    );
  });

  it('无工作区 → 跳过 curator（旧 /compact 无项目行为）', async () => {
    const { set, get, messages: baseMessages } = makeStore();
    const commit = vi.fn(async () => true);

    const result = await applyEpochCompaction(get, set, {
      checkpoint: checkpoint(),
      baseMessages,
      trigger: 'manual',
      sessionId: 's1',
      strategy: 'destroy',
      settings: {} as never,
      workspacePath: '  ',
      commit,
    });

    expect(runPreCompactCuratorMock).not.toHaveBeenCalled();
    expect(result.applied).toBe(true);
    expect(commit).toHaveBeenCalledTimes(1);
  });
});

describe('isSafeCheckpointInsert', () => {
  it('允许追加、拒绝删除/重排', () => {
    const base = [message('u1', 1), message('u2', 2)];
    expect(isSafeCheckpointInsert(base, base, 1)).toBe(true);
    expect(isSafeCheckpointInsert(base, [...base, message('u3', 3)], 1)).toBe(true);
    expect(isSafeCheckpointInsert(base, [], 1)).toBe(false);
    expect(isSafeCheckpointInsert(base, [message('u1', 1)], 1)).toBe(false);
    expect(isSafeCheckpointInsert(base, [message('u2', 2), message('u1', 1)], 1)).toBe(false);
  });
});
