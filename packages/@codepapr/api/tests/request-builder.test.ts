import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppendOnlyLog, ImmutablePrefix } from '@codepapr/core';
import { CacheConsistencyError, type IMessage, type IToolDefinition } from '@codepapr/types';
import { RequestBuilder, stripConsumedImages } from '../src';

const parameters = { temperature: 0.7, topP: 0.9, maxTokens: 100 };

afterEach(() => {
  vi.restoreAllMocks();
});

function createPrefix(tools: IToolDefinition[] = []): ImmutablePrefix {
  return new ImmutablePrefix({
    systemPrompt: 'You are a cache-stable assistant.',
    tools,
    model: 'deepseek-chat',
    parameters,
  });
}

describe('RequestBuilder - DeepSeek cache stability', () => {
  it('requestShapeHash 忽略本地 id/timestamp，只跟 API 相关内容有关', async () => {
    const log1 = new AppendOnlyLog('s1');
    const log2 = new AppendOnlyLog('s2');

    await log1.append({ id: 'local-a', role: 'user', content: 'same question', timestamp: 1 });
    await log2.append({ id: 'local-b', role: 'user', content: 'same question', timestamp: 999 });

    const req1 = new RequestBuilder().build({
      prefix: createPrefix(),
      appendLog: log1,
      model: 'deepseek-chat',
      provider: 'deepseek',
    });
    const req2 = new RequestBuilder().build({
      prefix: createPrefix(),
      appendLog: log2,
      model: 'deepseek-chat',
      provider: 'deepseek',
    });

    expect(req1.metadata?.expectedPrefixHash).toBe(req2.metadata?.expectedPrefixHash);
    expect(req1.metadata?.requestShapeHash).toBe(req2.metadata?.requestShapeHash);
  });

  it('拒绝与冻结前缀不一致的运行时工具定义', () => {
    const prefixTool: IToolDefinition = {
      name: 'search',
      description: 'Search docs',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    };
    const runtimeTool: IToolDefinition = {
      name: 'search',
      description: 'Changed at runtime',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    };

    expect(() =>
      new RequestBuilder().build({
        prefix: createPrefix([prefixTool]),
        appendLog: new AppendOnlyLog('tools'),
        model: 'deepseek-chat',
        provider: 'deepseek',
        tools: [runtimeTool],
      })
    ).toThrow(CacheConsistencyError);
  });

  it('拒绝历史消息被改写的 append-only 日志', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const log = new AppendOnlyLog('tamper');
    await log.append({ id: 'm1', role: 'user', content: 'first', timestamp: 1 });

    const builder = new RequestBuilder();
    builder.build({
      prefix: createPrefix(),
      appendLog: log,
      model: 'deepseek-chat',
      provider: 'deepseek',
    });

    const internals = log as unknown as { messages: IMessage[] };
    internals.messages[0] = { ...internals.messages[0]!, content: 'rewritten' };

    expect(() =>
      builder.build({
        prefix: createPrefix(),
        appendLog: log,
        model: 'deepseek-chat',
        provider: 'deepseek',
      })
    ).toThrow(CacheConsistencyError);
  });

  it('会把 DeepSeek 的超限 maxTokens 截断到服务端允许范围', () => {
    const req = new RequestBuilder().build({
      prefix: createPrefix(),
      appendLog: new AppendOnlyLog('clamp'),
      model: 'deepseek-v4-pro',
      provider: 'deepseek',
      maxTokens: 1_024_000,
    });

    expect(req.maxTokens).toBe(200_000);
  });

  it('只为支持显式缓存提示的 provider 生成 cacheControl', () => {
    const builder = new RequestBuilder();
    const deepseekReq = builder.build({
      prefix: createPrefix(),
      appendLog: new AppendOnlyLog('deepseek-cache-control'),
      model: 'deepseek-chat',
      provider: 'deepseek',
    });
    const openaiReq = builder.build({
      prefix: createPrefix(),
      appendLog: new AppendOnlyLog('openai-cache-control'),
      model: 'gpt-4o',
      provider: 'openai',
    });
    const claudeReq = builder.build({
      prefix: createPrefix(),
      appendLog: new AppendOnlyLog('claude-cache-control'),
      model: 'claude-sonnet-4-6',
      provider: 'claude',
    });

    expect(deepseekReq.cacheControl).toBeUndefined();
    expect(openaiReq.cacheControl).toBeUndefined();
    expect(claudeReq.cacheControl).toMatchObject({
      type: 'session',
    });
    expect(claudeReq.cacheControl?.budgetTokens).toBeGreaterThan(0);
  });
});

describe('stripConsumedImages', () => {
  function user(content: string, images?: IMessage['images']): IMessage {
    return { id: `u-${content}`, role: 'user', content, images, timestamp: 1 } as IMessage;
  }
  function assistant(content: string): IMessage {
    return { id: `a-${content}`, role: 'assistant', content, timestamp: 2 } as IMessage;
  }
  function tool(id: string): IMessage {
    return { id: `t-${id}`, role: 'tool', content: 'result', toolResult: { toolCallId: id, success: true, result: 'ok' }, timestamp: 3 } as IMessage;
  }
  const img = [{ mediaType: 'image/png', data: 'fakebase64' }];

  it('strips image after model has responded (assistant after)', () => {
    const msgs = [user('img', img), assistant('seen'), user('text')];
    const result = stripConsumedImages(msgs);
    expect(result[0].images).toBeUndefined();
    expect(result[2].images).toBeUndefined();  // no images
  });

  it('keeps image not yet responded (no assistant after)', () => {
    const msgs = [user('img', img), tool('t1')];
    const result = stripConsumedImages(msgs);
    expect(result[0].images).toEqual(img);
  });

  it('keeps first image, strips second (both consumed)', () => {
    const msgs = [
      user('img1', img),
      assistant('a1'),
      user('img2', img),
      assistant('a2'),
    ];
    const result = stripConsumedImages(msgs);
    expect(result[0].images).toBeUndefined();
    expect(result[2].images).toBeUndefined();
  });

  it('returns unchanged when no images', () => {
    const msgs = [user('hi'), assistant('hey')];
    const result = stripConsumedImages(msgs);
    expect(result).toEqual(msgs);
  });

  it('keeps new image, strips old consumed one', () => {
    const msgs = [
      user('img1', img),
      assistant('a1'),
      user('img2-noimg'),
      assistant('a2'),
      user('img3', img),  // last, no assistant after
    ];
    const result = stripConsumedImages(msgs);
    expect(result[0].images).toBeUndefined();
    expect(result[2].images).toBeUndefined(); // no images
    expect(result[4].images).toEqual(img);
  });
});
