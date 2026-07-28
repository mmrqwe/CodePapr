import { describe, expect, it } from 'vitest';
import { applyToolStreamEvent } from './messageMutators';
import type { UIMessage } from './types';

function baseMessage(): UIMessage {
  return { id: 'm1', role: 'assistant', content: '', timestamp: 1 };
}

describe('applyToolStreamEvent subagentToolInvocations', () => {
  it('persists subagentToolInvocations from a tool-call-end event', () => {
    const subagentToolInvocations = [
      { id: 's1', name: 'graph', arguments: { action: 'full' }, status: 'success' as const, output: 'graph-out' },
      { id: 's2', name: 'read', arguments: { relativePath: 'a.ts' }, status: 'error' as const, error: 'boom' },
    ];
    const next = applyToolStreamEvent(baseMessage(), {
      type: 'tool-call-end',
      toolCallId: 'c1',
      toolName: 'task',
      success: true,
      output: '{"agent":"explore"}',
      subagentToolInvocations,
    });
    expect(next.toolInvocations).toHaveLength(1);
    expect(next.toolInvocations?.[0]?.name).toBe('task');
    expect(next.toolInvocations?.[0]?.status).toBe('success');
    expect(next.toolInvocations?.[0]?.subagentToolInvocations).toEqual(subagentToolInvocations);
  });

  it('attaches invocations to the matching running invocation from tool-call-start', () => {
    const started = applyToolStreamEvent(baseMessage(), {
      type: 'tool-call-start',
      toolCallId: 'c1',
      toolName: 'task',
      arguments: { agent: 'explore', prompt: 'p' },
    });
    const ended = applyToolStreamEvent(started, {
      type: 'tool-call-end',
      toolCallId: 'c1',
      toolName: 'task',
      success: true,
      output: '{}',
      subagentToolInvocations: [
        { id: 's1', name: 'lsp', arguments: {}, status: 'success' as const },
      ],
    });
    expect(ended.toolInvocations).toHaveLength(1);
    expect(ended.toolInvocations?.[0]?.arguments).toEqual({ agent: 'explore', prompt: 'p' });
    expect(ended.toolInvocations?.[0]?.subagentToolInvocations?.[0]?.name).toBe('lsp');
  });

  it('leaves subagentToolInvocations undefined when the event has none', () => {
    const next = applyToolStreamEvent(baseMessage(), {
      type: 'tool-call-end',
      toolCallId: 'c2',
      toolName: 'read',
      success: true,
      output: 'ok',
    });
    expect(next.toolInvocations?.[0]?.subagentToolInvocations).toBeUndefined();
  });
});
