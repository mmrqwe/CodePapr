import { describe, expect, it, vi } from 'vitest';
import type { IMessage } from '@codepapr/types';
import { coreMessagesToContextMessages, createContextCompactionHandler } from './compactionHandler';
import type { Settings, UIMessage } from '../store/internals/types';

vi.mock('../store/internals/contextCheckpoint', () => ({
  maybeGenerateContextCheckpoint: vi.fn(),
}));

import { maybeGenerateContextCheckpoint } from '../store/internals/contextCheckpoint';

describe('coreMessagesToContextMessages', () => {
  it('re-attaches tool results to the assistant toolInvocations and skips standalone tool messages', () => {
    const core: IMessage[] = [
      { id: 'u1', role: 'user', content: '修复 bug', timestamp: 1 },
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        reasoningContent: '思考',
        toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a' } }],
        timestamp: 2,
      },
      {
        id: 't1',
        role: 'tool',
        content: 'file content here',
        toolResult: { toolCallId: 'c1', success: true, result: 'file content here' },
        timestamp: 3,
      },
      { id: 'a2', role: 'assistant', content: '完成', timestamp: 4 },
    ];

    const result = coreMessagesToContextMessages(core);

    // user + assistant(toolInvocations) + final assistant; the standalone tool
    // message is folded into the assistant's toolInvocations.
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ id: 'u1', role: 'user', content: '修复 bug' });
    expect(result[1]?.role).toBe('assistant');
    expect(result[1]?.reasoningContent).toBe('思考');
    expect(result[1]?.toolInvocations).toHaveLength(1);
    expect(result[1]?.toolInvocations?.[0]).toMatchObject({
      id: 'c1',
      name: 'read',
      status: 'success',
      output: 'file content here',
    });
    expect(result[2]).toMatchObject({ id: 'a2', role: 'assistant', content: '完成' });
  });

  it('marks failed tool results as error status and preserves the output text', () => {
    const core: IMessage[] = [
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'run', arguments: {} }],
        timestamp: 1,
      },
      {
        id: 't1',
        role: 'tool',
        content: 'boom',
        toolResult: { toolCallId: 'c1', success: false, result: 'boom', error: 'failed' },
        timestamp: 2,
      },
    ];

    const result = coreMessagesToContextMessages(core);

    expect(result[0]?.toolInvocations?.[0]).toMatchObject({
      status: 'error',
      output: 'boom',
    });
  });

  it('marks session-bootstrap so classification and provenance can skip it', () => {
    const result = coreMessagesToContextMessages([
      {
        id: 'session-bootstrap',
        role: 'assistant',
        content: '# 记忆',
        timestamp: 1,
        metadata: { sessionBootstrap: true, isPrefixSystem: true },
      },
    ]);
    expect(result[0]).toMatchObject({ id: 'session-bootstrap', sessionBootstrap: true });
  });
});

describe('createContextCompactionHandler (mid-loop retained tail)', () => {
  it('inserts the checkpoint at the retention boundary so the recent tail survives', async () => {
    const settings = {
      maxContextTokens: 500000,
      maxTokens: 8000,
    } as unknown as Settings;

    const checkpointMessage = {
      id: 'cp1',
      role: 'assistant',
      content: '',
      synthetic: true,
      hidden: true,
      timestamp: 999,
      contextCheckpoint: {
        version: 2,
        summary: '检查点',
        renderedContent: '检查点摘要',
        sourceMessageCount: 6,
        sourceChars: 100,
        generatedAt: 999,
        modelName: 'test-model',
        modelTier: 'fast',
      },
    } as unknown as UIMessage;

    vi.mocked(maybeGenerateContextCheckpoint).mockResolvedValue({
      message: checkpointMessage,
      modelTier: 'fast',
      insertIndex: 6,
    });

    const coreMessages: IMessage[] = [];
    for (let r = 0; r < 4; r += 1) {
      coreMessages.push({ id: `u${r}`, role: 'user', content: `用户消息 ${r}`, timestamp: r * 2 + 1 });
      coreMessages.push({ id: `a${r}`, role: 'assistant', content: `助手回复 ${r}`, timestamp: r * 2 + 2 });
    }

    const config = createContextCompactionHandler(settings, 'deepseek', 'session-test');
    const result = await config.handler(coreMessages);

    expect(result).not.toBeNull();
    // checkpoint (user turn) + retained tail (u3, a3). If the checkpoint had been
    // appended at the end, the tail would be empty and only the checkpoint remains.
    expect(result!.messages).toHaveLength(3);
    expect(result!.messages[0]?.role).toBe('user');
    expect(result!.messages[0]?.content).toContain('检查点摘要');
    expect(result!.messages[1]?.content).toBe('用户消息 3');
    expect(result!.messages[2]?.content).toBe('助手回复 3');
  });

  it('returns null when no checkpoint is generated', async () => {
    const settings = {
      maxContextTokens: 500000,
      maxTokens: 8000,
    } as unknown as Settings;

    vi.mocked(maybeGenerateContextCheckpoint).mockResolvedValue(null);

    const config = createContextCompactionHandler(settings, 'deepseek', 'session-test');
    const result = await config.handler([
      { id: 'u1', role: 'user', content: 'hi', timestamp: 1 },
    ]);

    expect(result).toBeNull();
  });

  it('attaches the turn anchor (user id + source assistant rounds) to the commit', async () => {
    const settings = {
      maxContextTokens: 500000,
      maxTokens: 8000,
    } as unknown as Settings;

    const checkpointMessage = {
      id: 'cp1',
      role: 'assistant',
      content: '',
      synthetic: true,
      hidden: true,
      timestamp: 999,
      contextCheckpoint: {
        version: 2,
        summary: '检查点',
        renderedContent: '检查点摘要',
        sourceMessageCount: 4,
        sourceChars: 100,
        generatedAt: 999,
        modelName: 'test-model',
        modelTier: 'fast',
      },
    } as unknown as UIMessage;

    // insertIndex=4：source = [old-u, old-a, turn-user, w-a1]，retained = [w-a2]
    vi.mocked(maybeGenerateContextCheckpoint).mockResolvedValue({
      message: checkpointMessage,
      modelTier: 'fast',
      insertIndex: 4,
    });

    const coreMessages: IMessage[] = [
      { id: 'old-u', role: 'user', content: '旧消息', timestamp: 1 },
      { id: 'old-a', role: 'assistant', content: '旧回复', timestamp: 2 },
      { id: 'turn-user', role: 'user', content: '本回合输入', timestamp: 3 },
      { id: 'w-a1', role: 'assistant', content: '本回合回复 1', timestamp: 4 },
      { id: 'w-a2', role: 'assistant', content: '本回合回复 2', timestamp: 5 },
    ];

    const commits: Array<Record<string, unknown>> = [];
    const config = createContextCompactionHandler(
      settings,
      'deepseek',
      'session-test',
      undefined,
      undefined,
      (commit) => {
        commits.push(commit as unknown as Record<string, unknown>);
      },
      'turn-user'
    );
    await config.handler(coreMessages);

    expect(commits).toHaveLength(1);
    expect(commits[0]?.turnUserMessageId).toBe('turn-user');
    // source 区间内本回合 user 之后只有 w-a1 一条 assistant。
    expect(commits[0]?.sourceAssistantRoundsInTurn).toBe(1);
  });

  it('omits the turn anchor when no user message id is provided', async () => {
    const settings = {
      maxContextTokens: 500000,
      maxTokens: 8000,
    } as unknown as Settings;

    const checkpointMessage = {
      id: 'cp1',
      role: 'assistant',
      content: '',
      synthetic: true,
      hidden: true,
      timestamp: 999,
      contextCheckpoint: {
        version: 2,
        summary: '检查点',
        renderedContent: '检查点摘要',
        sourceMessageCount: 2,
        sourceChars: 50,
        generatedAt: 999,
        modelName: 'test-model',
        modelTier: 'fast',
      },
    } as unknown as UIMessage;

    vi.mocked(maybeGenerateContextCheckpoint).mockResolvedValue({
      message: checkpointMessage,
      modelTier: 'fast',
      insertIndex: 2,
    });

    const commits: Array<Record<string, unknown>> = [];
    const config = createContextCompactionHandler(
      settings,
      'deepseek',
      'session-test',
      undefined,
      undefined,
      (commit) => {
        commits.push(commit as unknown as Record<string, unknown>);
      }
    );
    await config.handler([
      { id: 'u1', role: 'user', content: 'hi', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'hello', timestamp: 2 },
      { id: 'a2', role: 'assistant', content: 'more', timestamp: 3 },
    ]);

    expect(commits).toHaveLength(1);
    expect(commits[0]?.turnUserMessageId).toBeUndefined();
    expect(commits[0]?.sourceAssistantRoundsInTurn).toBeUndefined();
  });
});

describe('createContextCompactionHandler (bootstrap refresh)', () => {
  const settings = {
    maxContextTokens: 500000,
    maxTokens: 8000,
  } as unknown as Settings;

  const checkpointMessage = {
    id: 'cp1',
    role: 'assistant',
    content: '',
    synthetic: true,
    hidden: true,
    timestamp: 999,
    contextCheckpoint: {
      version: 2,
      summary: '检查点',
      renderedContent: '检查点摘要',
      sourceMessageCount: 6,
      sourceChars: 100,
      generatedAt: 999,
      modelName: 'test-model',
      modelTier: 'fast',
    },
  } as unknown as UIMessage;

  function fourRounds(): IMessage[] {
    const coreMessages: IMessage[] = [];
    for (let r = 0; r < 4; r += 1) {
      coreMessages.push({ id: `u${r}`, role: 'user', content: `用户消息 ${r}`, timestamp: r * 2 + 1 });
      coreMessages.push({ id: `a${r}`, role: 'assistant', content: `助手回复 ${r}`, timestamp: r * 2 + 2 });
    }
    return coreMessages;
  }

  it('prefixes a fresh session bootstrap when refreshBootstrap returns content', async () => {
    vi.mocked(maybeGenerateContextCheckpoint).mockResolvedValue({
      message: checkpointMessage,
      modelTier: 'fast',
      insertIndex: 6,
    });

    const refreshBootstrap = vi.fn().mockResolvedValue('# 会话上下文\n\n## 项目记忆\n新鲜记忆');
    const config = createContextCompactionHandler(settings, 'deepseek', 'session-test', refreshBootstrap);
    const result = await config.handler(fourRounds());

    expect(refreshBootstrap).toHaveBeenCalledTimes(1);
    expect(result).not.toBeNull();
    // bootstrap + checkpoint + retained tail (u3, a3)
    expect(result!.messages).toHaveLength(4);
    const bootstrap = result!.messages[0]!;
    expect(bootstrap.role).toBe('assistant');
    expect(bootstrap.content).toContain('新鲜记忆');
    expect(bootstrap.metadata?.sessionBootstrap).toBe(true);
    expect(bootstrap.metadata?.isPrefixSystem).toBe(true);
    // checkpoint follows the bootstrap
    expect(result!.messages[1]?.role).toBe('user');
    expect(result!.messages[1]?.content).toContain('检查点摘要');
  });

  it('does not prefix a bootstrap when refreshBootstrap returns null', async () => {
    vi.mocked(maybeGenerateContextCheckpoint).mockResolvedValue({
      message: checkpointMessage,
      modelTier: 'fast',
      insertIndex: 6,
    });

    const refreshBootstrap = vi.fn().mockResolvedValue(null);
    const config = createContextCompactionHandler(settings, 'deepseek', 'session-test', refreshBootstrap);
    const result = await config.handler(fourRounds());

    expect(result).not.toBeNull();
    // checkpoint + tail only, no bootstrap
    expect(result!.messages).toHaveLength(3);
    expect(result!.messages[0]?.role).toBe('user');
    expect(result!.messages[0]?.content).toContain('检查点摘要');
  });

  it('does not prefix a bootstrap when refreshBootstrap returns an empty string', async () => {
    vi.mocked(maybeGenerateContextCheckpoint).mockResolvedValue({
      message: checkpointMessage,
      modelTier: 'fast',
      insertIndex: 6,
    });

    const refreshBootstrap = vi.fn().mockResolvedValue('   ');
    const config = createContextCompactionHandler(settings, 'deepseek', 'session-test', refreshBootstrap);
    const result = await config.handler(fourRounds());

    expect(result!.messages).toHaveLength(3);
    expect(result!.messages[0]?.content).toContain('检查点摘要');
  });

  it('falls back to a bootstrap-less epoch when refreshBootstrap throws', async () => {
    vi.mocked(maybeGenerateContextCheckpoint).mockResolvedValue({
      message: checkpointMessage,
      modelTier: 'fast',
      insertIndex: 6,
    });

    const refreshBootstrap = vi.fn().mockRejectedValue(new Error('disk read failed'));
    const config = createContextCompactionHandler(settings, 'deepseek', 'session-test', refreshBootstrap);
    const result = await config.handler(fourRounds());

    expect(result).not.toBeNull();
    expect(result!.messages).toHaveLength(3);
    expect(result!.messages[0]?.content).toContain('检查点摘要');
  });

  it('v4：刷新失败时沿用压缩前冻结的 bootstrap——绝不产出无记忆前缀的 epoch', async () => {
    vi.mocked(maybeGenerateContextCheckpoint).mockResolvedValue({
      message: checkpointMessage,
      modelTier: 'fast',
      insertIndex: 6,
    });
    const logWithBootstrap: IMessage[] = [
      {
        id: 'session-bootstrap',
        role: 'assistant',
        content: '旧冻结记忆前缀',
        timestamp: 0,
        metadata: { sessionBootstrap: true, isPrefixSystem: true },
      } as IMessage,
      ...fourRounds(),
    ];
    const refreshBootstrap = vi.fn().mockRejectedValue(new Error('ledger unreachable'));
    const config = createContextCompactionHandler(settings, 'deepseek', 'session-test', refreshBootstrap);
    const result = await config.handler(logWithBootstrap);

    expect(result).not.toBeNull();
    expect(result!.messages[0]?.metadata?.sessionBootstrap).toBe(true);
    expect(result!.messages[0]?.content).toContain('旧冻结记忆前缀');
    expect(result!.messages[1]?.content).toContain('检查点摘要');
  });

  it('keeps backward compatibility when no refreshBootstrap is provided', async () => {
    vi.mocked(maybeGenerateContextCheckpoint).mockResolvedValue({
      message: checkpointMessage,
      modelTier: 'fast',
      insertIndex: 6,
    });

    const config = createContextCompactionHandler(settings, 'deepseek', 'session-test');
    const result = await config.handler(fourRounds());

    expect(result!.messages).toHaveLength(3);
    expect(result!.messages[0]?.content).toContain('检查点摘要');
  });

  it('returns null when onCheckpoint rejects so the agent does not replaceLog', async () => {
    vi.mocked(maybeGenerateContextCheckpoint).mockResolvedValue({
      message: checkpointMessage,
      modelTier: 'fast',
      insertIndex: 6,
    });
    const onCheckpoint = vi.fn().mockRejectedValue(new Error('schema invalid'));
    const config = createContextCompactionHandler(
      settings,
      'deepseek',
      'session-test',
      undefined,
      undefined,
      onCheckpoint
    );
    const result = await config.handler(fourRounds());
    expect(result).toBeNull();
    expect(onCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('excludes session-bootstrap from provenance sourceMessageIds', async () => {
    vi.mocked(maybeGenerateContextCheckpoint).mockResolvedValue({
      message: checkpointMessage,
      modelTier: 'fast',
      insertIndex: 7,
    });
    const onCheckpoint = vi.fn().mockResolvedValue(undefined);
    const config = createContextCompactionHandler(
      settings,
      'deepseek',
      'session-test',
      undefined,
      undefined,
      onCheckpoint
    );
    const core: IMessage[] = [
      {
        id: 'session-bootstrap',
        role: 'assistant',
        content: '# 项目记忆',
        timestamp: 1,
        metadata: { sessionBootstrap: true, isPrefixSystem: true },
      },
      ...fourRounds(),
    ];
    await config.handler(core);
    expect(onCheckpoint).toHaveBeenCalledTimes(1);
    const commit = onCheckpoint.mock.calls[0]?.[0] as { sourceMessageIds: string[] };
    expect(commit.sourceMessageIds).not.toContain('session-bootstrap');
    expect(commit.sourceMessageIds.length).toBeGreaterThan(0);
  });
});

describe('createContextCompactionHandler (abort)', () => {
  const settings = {
    maxContextTokens: 500000,
    maxTokens: 8000,
  } as unknown as Settings;

  it('getAbortSignal 的 signal 透传给 maybeGenerateContextCheckpoint', async () => {
    vi.mocked(maybeGenerateContextCheckpoint).mockResolvedValue(null);
    const controller = new AbortController();
    const getAbortSignal = vi.fn(() => controller.signal);

    const config = createContextCompactionHandler(settings, 'deepseek', 'session-test', undefined, getAbortSignal);
    await config.handler([{ id: 'u1', role: 'user', content: 'hi', timestamp: 1 }]);

    expect(getAbortSignal).toHaveBeenCalledTimes(1);
    expect(maybeGenerateContextCheckpoint).toHaveBeenCalledWith(
      settings,
      expect.anything(),
      true,
      undefined,
      controller.signal,
      { trigger: 'token-limit' },
      'session-test'
    );
  });

  it('压缩中飞被取消（AbortError）→ 返回 null 优雅收尾，不误报压缩失败', async () => {
    vi.mocked(maybeGenerateContextCheckpoint).mockRejectedValue(
      new DOMException('已取消', 'AbortError')
    );

    const config = createContextCompactionHandler(settings, 'deepseek', 'session-test');
    const result = await config.handler([{ id: 'u1', role: 'user', content: 'hi', timestamp: 1 }]);

    expect(result).toBeNull();
  });

  it('非取消错误继续上抛（保留旧语义：压缩失败由上层决定）', async () => {
    vi.mocked(maybeGenerateContextCheckpoint).mockRejectedValue(new Error('provider down'));

    const config = createContextCompactionHandler(settings, 'deepseek', 'session-test');
    await expect(
      config.handler([{ id: 'u1', role: 'user', content: 'hi', timestamp: 1 }])
    ).rejects.toThrow('provider down');
  });
});
