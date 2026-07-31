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
});

describe('createContextCompactionHandler (mid-loop retained tail)', () => {
  it('inserts the checkpoint at the retention boundary so the recent tail survives', async () => {
    const settings = {
      pruneOldToolResults: false,
      pruneProtectRounds: 6,
      pruneMinChars: 20000,
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
      pruneOldToolResults: false,
      pruneProtectRounds: 6,
      pruneMinChars: 20000,
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
});
