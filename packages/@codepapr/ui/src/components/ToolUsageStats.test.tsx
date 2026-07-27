// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { aggregateToolUsage } from './ToolUsageStats';
import type { UIMessage } from '../store/internals/types';

function msg(toolInvocations: { name: string; status: 'success' | 'error' | 'running' }[]): UIMessage {
  return {
    id: `m-${Math.random()}`,
    role: 'assistant',
    content: '',
    timestamp: 1,
    toolInvocations: toolInvocations.map((ti, i) => ({
      id: `t-${i}`,
      name: ti.name,
      arguments: {},
      status: ti.status,
    })),
  } as UIMessage;
}

describe('aggregateToolUsage', () => {
  it('returns empty for no sessions/messages', () => {
    expect(aggregateToolUsage({})).toEqual([]);
    expect(aggregateToolUsage({ s1: [] })).toEqual([]);
  });

  it('counts calls per tool with success/error split, sorted by count desc', () => {
    const sessions: Record<string, UIMessage[]> = {
      s1: [
        msg([{ name: 'read', status: 'success' }, { name: 'read', status: 'success' }]),
        msg([{ name: 'write', status: 'error' }]),
      ],
      s2: [msg([{ name: 'read', status: 'success' }])],
    };
    const usage = aggregateToolUsage(sessions);
    expect(usage).toHaveLength(2);
    expect(usage[0]).toEqual({ name: 'read', count: 3, success: 3, error: 0 });
    expect(usage[1]).toEqual({ name: 'write', count: 1, success: 0, error: 1 });
  });
});
