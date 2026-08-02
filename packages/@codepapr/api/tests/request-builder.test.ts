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

  it('keeps prior messages byte-identical across rounds (no per-request pruning)', async () => {
    const prefix = createPrefix();
    const log = new AppendOnlyLog('rounds');
    // A large old tool result that the legacy sliding-window pruner would have
    // replaced with a placeholder once it fell outside the protection window,
    // mutating mid-prefix bytes and breaking DeepSeek's prefix cache each round.
    const bigToolResult = 'x'.repeat(30_000);
    await log.append({ id: 'u1', role: 'user', content: 'q', timestamp: 1 });
    await log.append({
      id: 'a1',
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'read', arguments: {} }],
      timestamp: 2,
    } as IMessage);
    await log.append({
      id: 't1',
      role: 'tool',
      content: bigToolResult,
      toolResult: { toolCallId: 'c1', success: true, result: bigToolResult },
      timestamp: 3,
    } as IMessage);

    const builder = new RequestBuilder();
    const req1 = builder.build({ prefix, appendLog: log, model: 'deepseek-chat', provider: 'deepseek' });
    const firstSnapshot = JSON.stringify(req1.messages);

    // Append several more assistant rounds so the old tool result sits far
    // outside any protection window.
    for (let i = 2; i <= 8; i += 1) {
      await log.append({ id: `a${i}`, role: 'assistant', content: `round ${i}`, timestamp: 3 + i });
    }
    const req2 = builder.build({ prefix, appendLog: log, model: 'deepseek-chat', provider: 'deepseek' });

    // The first four messages (system prefix + user + assistant + the large tool
    // result) must be unchanged — no placeholder substitution mid-prefix.
    expect(JSON.stringify(req2.messages.slice(0, req1.messages.length))).toBe(firstSnapshot);
    expect(req2.messages[3]?.content).toBe(bigToolResult);
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

  it('resetLogTracking 让压缩替换后的日志不再误报 append-only 违规', async () => {
    const log = new AppendOnlyLog('compact-reset');
    await log.append({ id: 'm1', role: 'user', content: 'first', timestamp: 1 });
    await log.append({ id: 'm2', role: 'assistant', content: 'second', timestamp: 2 });
    const builder = new RequestBuilder();
    builder.build({ prefix: createPrefix(), appendLog: log, model: 'deepseek-chat', provider: 'deepseek' });

    // Simulate compaction: replace the log with a shorter compacted history.
    log.reset();
    await log.append({ id: 'c1', role: 'assistant', content: 'summary', timestamp: 3 });
    builder.resetLogTracking();

    expect(() =>
      builder.build({ prefix: createPrefix(), appendLog: log, model: 'deepseek-chat', provider: 'deepseek' })
    ).not.toThrow();
  });

  it('未 resetLogTracking 时替换日志仍会触发 append-only 违规', async () => {
    const log = new AppendOnlyLog('compact-no-reset');
    await log.append({ id: 'm1', role: 'user', content: 'first', timestamp: 1 });
    await log.append({ id: 'm2', role: 'assistant', content: 'second', timestamp: 2 });
    const builder = new RequestBuilder();
    builder.build({ prefix: createPrefix(), appendLog: log, model: 'deepseek-chat', provider: 'deepseek' });

    log.reset();
    await log.append({ id: 'c1', role: 'assistant', content: 'summary', timestamp: 3 });
    // No resetLogTracking → the shrunken log must trip the guard.

    expect(() =>
      builder.build({ prefix: createPrefix(), appendLog: log, model: 'deepseek-chat', provider: 'deepseek' })
    ).toThrow(CacheConsistencyError);
  });
});

describe('RequestBuilder - tool context mode (history summaries)', () => {
  const SUMMARY_KEY = 'toolSummary';

  function assistantWithTools(id: string, callIds: string[]): IMessage {
    return {
      id,
      role: 'assistant',
      content: '',
      toolCalls: callIds.map((cid) => ({ id: cid, name: 'read', arguments: {} })),
      timestamp: 1,
    } as IMessage;
  }

  function toolResult(id: string, callId: string, content: string, summary?: string): IMessage {
    return {
      id,
      role: 'tool',
      content,
      toolResult: { toolCallId: callId, success: true, result: content },
      ...(summary ? { metadata: { [SUMMARY_KEY]: summary } } : {}),
      timestamp: 1,
    } as IMessage;
  }

  async function buildLog(messages: IMessage[]): Promise<{ req: ReturnType<RequestBuilder['build']> }> {
    const log = new AppendOnlyLog('history-summaries');
    for (const msg of messages) {
      await log.append(msg);
    }
    const req = new RequestBuilder().build({
      prefix: createPrefix(),
      appendLog: log,
      model: 'deepseek-chat',
      provider: 'deepseek',
    });
    return { req };
  }

  it('keeps the latest tool batch full and rewrites older results to frozen summaries', async () => {
    const { req } = await buildLog([
      assistantWithTools('a1', ['c1']),
      toolResult('t1', 'c1', 'full-1', '[read] summary-1'),
      assistantWithTools('a2', ['c2']),
      toolResult('t2', 'c2', 'full-2', '[read] summary-2'),
    ]);

    // messages[0] is the system prefix; log messages start at index 1.
    expect(req.messages[2]?.content).toBe('[read] summary-1');
    expect(req.messages[4]?.content).toBe('full-2');
  });

  it('does not rewrite the log itself (copy-only mutation)', async () => {
    const log = new AppendOnlyLog('copy-only');
    await log.append(assistantWithTools('a1', ['c1']));
    await log.append(toolResult('t1', 'c1', 'full-1', '[read] summary-1'));
    await log.append(assistantWithTools('a2', ['c2']));
    await log.append(toolResult('t2', 'c2', 'full-2', '[read] summary-2'));

    new RequestBuilder().build({
      prefix: createPrefix(),
      appendLog: log,
      model: 'deepseek-chat',
      provider: 'deepseek',
    });

    expect(log.toMessageArray()[1]?.content).toBe('full-1');
  });

  it('leaves full-mode results (no frozen summary) untouched', async () => {
    const { req } = await buildLog([
      assistantWithTools('a1', ['c1']),
      toolResult('t1', 'c1', 'full-1'),
      assistantWithTools('a2', ['c2']),
      toolResult('t2', 'c2', 'full-2'),
    ]);
    expect(req.messages[2]?.content).toBe('full-1');
    expect(req.messages[4]?.content).toBe('full-2');
  });

  it('is byte-identical for identical logs (rebuild/live parity)', async () => {
    const make = () => [
      assistantWithTools('a1', ['c1']),
      toolResult('t1', 'c1', 'full-1', '[read] summary-1'),
      assistantWithTools('a2', ['c2']),
      toolResult('t2', 'c2', 'full-2', '[read] summary-2'),
    ];
    const { req: req1 } = await buildLog(make());
    const { req: req2 } = await buildLog(make());
    expect(JSON.stringify(req1.messages)).toBe(JSON.stringify(req2.messages));
    expect(req1.metadata?.requestShapeHash).toBe(req2.metadata?.requestShapeHash);
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
