import { describe, expect, it } from 'vitest';
import type { IMessage } from '@codepapr/types';
import { coreMessagesToContextMessages } from './compactionHandler';

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
