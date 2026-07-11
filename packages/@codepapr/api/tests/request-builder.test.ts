import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppendOnlyLog, ImmutablePrefix } from '@codepapr/core';
import { CacheConsistencyError, type IMessage, type IToolDefinition } from '@codepapr/types';
import { RequestBuilder } from '../src';

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

    expect(req.maxTokens).toBe(393_216);
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
