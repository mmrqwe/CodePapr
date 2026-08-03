import { describe, expect, it } from 'vitest';
import { normalizeSessionMetaList, touchSession } from './persistence';
import type { SessionMeta } from './types';

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
    ] as unknown as SessionMeta[];
    const result = normalizeSessionMetaList(legacy);
    expect(result.map((s) => s.id)).toEqual(['b', 'c', 'a']);
    expect(result.every((s) => s.updatedAt === s.createdAt)).toBe(true);
  });
});
