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

  it('preserves archivedAt when present', () => {
    const result = normalizeSessionMetaList([
      { id: 'a', name: 'a', provider: 'deepseek', model: 'm', createdAt: 1, archivedAt: 42 },
    ]);
    expect(result[0]?.archivedAt).toBe(42);
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

    const sanitized = sanitizeMessageForPersistence(message);
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

    const sanitized = sanitizeMessageForPersistence(message);
    const invocation = sanitized.toolInvocations?.[0];
    expect(invocation?.status).toBe('success');
    expect(invocation?.output).toBe('done');
  });

  it('strips assistant promptContent while keeping user promptContent', () => {
    const assistant: UIMessage = {
      id: 'a1',
      role: 'assistant',
      content: 'ok',
      timestamp: 1,
      promptContent: '{"messages":[{"role":"user","content":"hello"}]}',
    };
    expect(sanitizeMessageForPersistence(assistant).promptContent).toBeUndefined();

    const user: UIMessage = {
      id: 'u1',
      role: 'user',
      content: 'hi',
      timestamp: 1,
      promptContent: 'full wrapped prompt',
    };
    expect(sanitizeMessageForPersistence(user).promptContent).toBe('full wrapped prompt');
  });

  it('keeps attached file names and strips image payloads without disk refs', () => {
    const user: UIMessage = {
      id: 'u1',
      role: 'user',
      content: 'see this',
      timestamp: 1,
      images: [{ mediaType: 'image/png', data: 'AAAA' }],
      attachedFiles: [{ name: 'notes.ts', size: 12 }],
    };
    const sanitized = sanitizeMessageForPersistence(user);
    expect(sanitized.images).toBeUndefined();
    expect(sanitized.attachedFiles).toEqual([{ name: 'notes.ts', size: 12 }]);
  });

  it('persists image disk references without base64 payloads', () => {
    const user: UIMessage = {
      id: 'u1',
      role: 'user',
      content: 'see this',
      timestamp: 1,
      images: [
        { mediaType: 'image/png', data: 'AAAA', path: '.CodePapr/chat-images/1.png' },
        { mediaType: 'image/jpeg', data: 'BBBB' },
      ],
    };
    const sanitized = sanitizeMessageForPersistence(user);
    expect(sanitized.images).toEqual([
      { mediaType: 'image/png', data: '', path: '.CodePapr/chat-images/1.png' },
    ]);
  });
});

describe('sanitizeMessageForPersistence 工具图片转录 redact（存量 base64 防御）', () => {
  const legacyOutput = JSON.stringify({
    path: 'assets/x.png',
    mediaType: 'image/png',
    bytes: 780000,
    __images: [{ mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg'.repeat(50), path: 'assets/x.png' }],
  });

  it('output 字符串里的 __images[].data 落盘前置空，引用字段保留', () => {
    const message: UIMessage = {
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: 1,
      toolInvocations: [
        { id: 't1', name: 'read_image', status: 'success', arguments: {}, output: legacyOutput },
      ],
    };
    const output = sanitizeMessageForPersistence(message).toolInvocations?.[0]?.output as string;
    expect(output).not.toContain('iVBORw0KGgo');
    expect(output).toContain('"data":""');
    expect(output).toContain('assets/x.png');
    expect(output).toContain('"bytes":780000');
  });

  it('纯文本与坏 JSON 的 output 原样保留', () => {
    const message: UIMessage = {
      id: 'a2',
      role: 'assistant',
      content: '',
      timestamp: 1,
      toolInvocations: [
        { id: 't1', name: 'bash', status: 'success', arguments: {}, output: 'plain output' },
        { id: 't2', name: 'bash', status: 'success', arguments: {}, output: '{"broken": ' },
        { id: 't3', name: 'bash', status: 'success', arguments: {}, output: '__images 出现在普通文本里' },
      ],
    };
    const sanitized = sanitizeMessageForPersistence(message);
    expect(sanitized.toolInvocations?.[0]?.output).toBe('plain output');
    expect(sanitized.toolInvocations?.[1]?.output).toBe('{"broken": ');
    expect(sanitized.toolInvocations?.[2]?.output).toBe('__images 出现在普通文本里');
  });
});
