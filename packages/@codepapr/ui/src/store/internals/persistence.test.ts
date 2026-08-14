import { describe, expect, it } from 'vitest';
import {
  normalizeSessionMetaList,
  normalizeSessionProvider,
  sanitizeMessageForPersistence,
  touchSession,
} from './persistence';
import type { SessionMeta, UIMessage } from './types';

function session(id: string, createdAt: number, updatedAt?: number): SessionMeta {
  return {
    id,
    name: `任务 ${id}`,
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    createdAt,
    updatedAt: updatedAt ?? createdAt,
  };
}

describe('touchSession', () => {
  it('moves the touched session to the front with a fresh updatedAt', () => {
    const sessions = [session('a', 3), session('b', 2), session('c', 1)];
    const result = touchSession(sessions, 'b', 10);
    expect(result.map((s) => s.id)).toEqual(['b', 'a', 'c']);
    expect(result[0]?.updatedAt).toBe(10);
    expect(result[0]?.createdAt).toBe(2);
  });

  it('returns the list unchanged when the session is missing', () => {
    const sessions = [session('a', 1)];
    expect(touchSession(sessions, 'missing', 5)).toBe(sessions);
  });
});

describe('normalizeSessionMetaList', () => {
  it('sorts by updatedAt descending', () => {
    const sessions = [session('a', 1, 5), session('b', 2, 9), session('c', 3, 7)];
    expect(normalizeSessionMetaList(sessions).map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('falls back to createdAt when updatedAt is missing and keeps stable order', () => {
    const legacy = [
      { id: 'a', name: 'a', provider: 'deepseek', model: 'm', createdAt: 1 },
      { id: 'b', name: 'b', provider: 'deepseek', model: 'm', createdAt: 3 },
      { id: 'c', name: 'c', provider: 'deepseek', model: 'm', createdAt: 2 },
    ];
    const result = normalizeSessionMetaList(legacy);
    expect(result.map((s) => s.id)).toEqual(['b', 'c', 'a']);
    expect(result.every((s) => s.updatedAt === s.createdAt)).toBe(true);
  });

  it('normalizes invalid provider strings to the deepseek fallback', () => {
    const legacy = [
      { id: 'a', name: 'a', provider: 'unknown-provider', model: 'm', createdAt: 1 },
    ];
    const result = normalizeSessionMetaList(legacy);
    expect(result[0]?.provider).toBe('deepseek');
  });
});

describe('normalizeSessionProvider', () => {
  it('passes through valid providers unchanged', () => {
    expect(normalizeSessionProvider('deepseek')).toBe('deepseek');
    expect(normalizeSessionProvider('openai')).toBe('openai');
    expect(normalizeSessionProvider('claude')).toBe('claude');
  });

  it('falls back to deepseek for unknown values', () => {
    expect(normalizeSessionProvider('')).toBe('deepseek');
    expect(normalizeSessionProvider('gpt-4o')).toBe('deepseek');
  });
});

describe('sanitizeMessageForPersistence', () => {
  it('marks a running tool invocation as errored and backfills empty output', () => {
    const message: UIMessage = {
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: 1,
      toolInvocations: [
        { id: 'tool-call_00_x', name: 'run', arguments: {}, status: 'running' },
      ],
    };

    const sanitized = sanitizeMessageForPersistence(message, false);
    const invocation = sanitized.toolInvocations?.[0];
    expect(invocation?.status).toBe('error');
    expect(invocation?.error).toBe('未完成的工具调用');
    expect(invocation?.output).toBe('');
  });

  it('keeps completed invocation output intact', () => {
    const message: UIMessage = {
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: 1,
      toolInvocations: [
        { id: 'c1', name: 'run', arguments: {}, status: 'success', output: 'done' },
      ],
    };

    const sanitized = sanitizeMessageForPersistence(message, false);
    const invocation = sanitized.toolInvocations?.[0];
    expect(invocation?.status).toBe('success');
    expect(invocation?.output).toBe('done');
  });
});
