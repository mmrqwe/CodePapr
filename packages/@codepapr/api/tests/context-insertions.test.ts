import { describe, expect, it } from 'vitest';
import { AppendOnlyLog, ImmutablePrefix } from '@codepapr/core';
import type { IMessage, RequestContextInsertion } from '@codepapr/types';
import { insertAnchoredContext, RequestBuilder } from '../src';

function user(id: string, content: string): IMessage {
  return { id, role: 'user', content, timestamp: 1 };
}

function assistant(id: string, content: string): IMessage {
  return { id, role: 'assistant', content, timestamp: 2 };
}

function insertion(anchorMessageId: string, content: string, order = 0): RequestContextInsertion {
  return {
    id: `insert-${anchorMessageId}-${order}`,
    anchorMessageId,
    placement: 'before',
    role: 'user',
    content,
    source: 'memory-recall',
    order,
  };
}

describe('insertAnchoredContext (PR5 B3)', () => {
  it('inserts before the anchor message', () => {
    const messages = [user('u1', '历史'), assistant('a1', 'ok'), user('u2', '当前问题')];
    const compiled = insertAnchoredContext(messages, [
      insertion('u2', '[Recall] 相关内容'),
    ]);
    expect(compiled.map((m) => m.id)).toEqual(['u1', 'a1', 'insert-u2-0', 'u2']);
    expect(compiled[2]!.content).toBe('[Recall] 相关内容');
    expect((compiled[2]!.metadata as Record<string, unknown>).requestOnly).toBe(true);
  });

  it('orders multiple insertions on the same anchor by order asc', () => {
    const messages = [user('u2', '问题')];
    const compiled = insertAnchoredContext(messages, [
      insertion('u2', 'second', 2),
      insertion('u2', 'first', 1),
    ]);
    expect(compiled.map((m) => m.content)).toEqual(['first', 'second', '问题']);
  });

  it('skips insertions whose anchor is missing and keeps others', () => {
    const messages = [user('u2', '问题')];
    const compiled = insertAnchoredContext(messages, [
      insertion('ghost', 'should be skipped'),
      insertion('u2', 'kept'),
    ]);
    expect(compiled.map((m) => m.content)).toEqual(['kept', '问题']);
  });

  it('returns the input untouched when there are no insertions', () => {
    const messages = [user('u1', 'hi')];
    expect(insertAnchoredContext(messages, [])).toEqual(messages);
  });
});

describe('RequestBuilder contextInsertions (PR5 B3)', () => {
  const parameters = { temperature: 0.7, topP: 0.9, maxTokens: 100 };

  it('compiles insertion into the request without touching append-only tracking', async () => {
    const prefix = new ImmutablePrefix({
      systemPrompt: 'system',
      tools: [],
      model: 'deepseek-chat',
      parameters,
    });
    const log = new AppendOnlyLog('s1');
    await log.append(user('u1', '当前用户问题'));

    const builder = new RequestBuilder();
    const request = builder.build({
      prefix,
      appendLog: log,
      model: 'deepseek-chat',
      provider: 'deepseek',
      contextInsertions: [insertion('u1', '[Recall Block]')],
    });

    expect(request.messages.map((m) => m.id)).toEqual([
      'prefix-system',
      'insert-u1-0',
      'u1',
    ]);

    // 插入不改变 log 的 append-only 基线：第二轮追加后仍通过校验
    await log.append(assistant('a1', '回答'));
    const second = builder.build({
      prefix,
      appendLog: log,
      model: 'deepseek-chat',
      provider: 'deepseek',
      contextInsertions: [insertion('u1', '[Recall Block]')],
    });
    expect(second.messages.map((m) => m.id)).toEqual([
      'prefix-system',
      'insert-u1-0',
      'u1',
      'a1',
    ]);
  });

  it('keeps suffix messages after the compiled log', async () => {
    const prefix = new ImmutablePrefix({
      systemPrompt: 'system',
      tools: [],
      model: 'deepseek-chat',
      parameters,
    });
    const log = new AppendOnlyLog('s1');
    await log.append(user('u1', '问题'));

    const request = new RequestBuilder().build({
      prefix,
      appendLog: log,
      model: 'deepseek-chat',
      provider: 'deepseek',
      contextInsertions: [insertion('u1', '[Recall Block]')],
      suffixMessages: [{ id: 'suffix-1', role: 'user', content: '续写', timestamp: 9 }],
    });
    expect(request.messages.map((m) => m.id).slice(-2)).toEqual(['u1', 'suffix-1']);
  });
});
