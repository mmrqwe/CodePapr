import { describe, expect, it } from 'vitest';
import {
  appendSessionMessages,
  applyToolStreamEvent,
  cleanupStreamingAssistantMessage,
  updateAssistantMessage,
} from './messageMutators';
import type { AgentState, StoreSet, UIMessage } from './types';

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

function message(id: string, overrides: Partial<UIMessage> = {}): UIMessage {
  return { id, role: 'assistant', content: '', timestamp: 1, ...overrides };
}

function createHarness(initial: Pick<AgentState, 'activeSessionId' | 'messages' | 'sessionMessages'>) {
  let state = { ...initial };
  const set: StoreSet = (partial) => {
    const patch = typeof partial === 'function' ? partial(state as AgentState) : partial;
    state = { ...state, ...patch };
  };
  return {
    set,
    get: () => state,
  };
}

describe('session-scoped message mutators', () => {
  it('updateAssistantMessage updates the flat mirror only for the active session', () => {
    const harness = createHarness({
      activeSessionId: 'visible',
      messages: [message('v1', { content: 'visible' })],
      sessionMessages: {
        visible: [message('v1', { content: 'visible' })],
        background: [message('b1', { content: 'old', isStreaming: true })],
      },
    });

    updateAssistantMessage(harness.set, 'background', 'b1', (m) => ({ ...m, content: 'new' }));

    const state = harness.get();
    expect(state.sessionMessages['background']?.[0]?.content).toBe('new');
    expect(state.messages).toEqual([message('v1', { content: 'visible' })]);
  });

  it('updateAssistantMessage keeps the mirror in sync for the active session', () => {
    const harness = createHarness({
      activeSessionId: 'visible',
      messages: [message('v1', { content: 'visible' })],
      sessionMessages: { visible: [message('v1', { content: 'visible' })] },
    });

    updateAssistantMessage(harness.set, 'visible', 'v1', (m) => ({ ...m, content: 'changed' }));

    const state = harness.get();
    expect(state.messages[0]?.content).toBe('changed');
    expect(state.sessionMessages['visible']?.[0]?.content).toBe('changed');
  });

  it('appendSessionMessages does not leak background session messages into the mirror', () => {
    const harness = createHarness({
      activeSessionId: 'visible',
      messages: [message('v1')],
      sessionMessages: { visible: [message('v1')], background: [message('b1')] },
    });

    appendSessionMessages(harness.set, 'background', [message('b2')]);

    const state = harness.get();
    expect(state.sessionMessages['background']?.map((m) => m.id)).toEqual(['b1', 'b2']);
    expect(state.messages.map((m) => m.id)).toEqual(['v1']);
  });

  it('cleanupStreamingAssistantMessage finalizes background session without touching the mirror', () => {
    const harness = createHarness({
      activeSessionId: 'visible',
      messages: [message('v1')],
      sessionMessages: {
        visible: [message('v1')],
        background: [message('b1', { isStreaming: true, content: 'partial' })],
      },
    });

    cleanupStreamingAssistantMessage(harness.set, 'background', 'b1');

    const state = harness.get();
    expect(state.sessionMessages['background']?.[0]?.isStreaming).toBe(false);
    expect(state.messages.map((m) => m.id)).toEqual(['v1']);
  });
});
