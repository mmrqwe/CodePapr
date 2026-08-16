import { describe, expect, it, vi } from 'vitest';
import { Agent, type IRequestBuilder, type ICacheValidator } from './Agent';
import { Session } from './Session';
import { ImmutablePrefix } from '../cache/ImmutablePrefix';
import { AppendOnlyLog } from '../cache/AppendOnlyLog';
import { ToolRegistry } from '../tool/ToolRegistry';
import type {
  ICacheValidation,
  IChatRequest,
  IChatResponse,
  IChatStreamEvent,
  ILLMProvider,
} from '@codepapr/types';

function overflowError(): Error {
  return Object.assign(
    new Error('OpenAI-compatible API error (context_length_exceeded): maximum context length exceeded'),
    { retriable: false, status: 400 }
  );
}

interface BuildOptions {
  provider: ILLMProvider;
  compactionHandler: (messages: unknown[], trigger?: unknown) => Promise<{ messages: unknown[] } | null>;
}

function buildAgent(options: BuildOptions) {
  const registry = new ToolRegistry();
  const prefix = new ImmutablePrefix({
    systemPrompt: '测试系统提示词',
    tools: [],
    model: 'test-model',
    parameters: { temperature: 0.7, topP: 1 },
  });
  const log = new AppendOnlyLog('test-session');
  const session = new Session({ sessionId: 'test-session', prefix, toolRegistry: registry, log });

  const requestBuilder: IRequestBuilder = {
    build: (buildOpts) => {
      const request: IChatRequest = {
        messages: buildOpts.appendLog.getAllMessages().slice(),
        model: buildOpts.model,
        temperature: buildOpts.temperature,
        tools: buildOpts.tools,
      };
      return request;
    },
    resetLogTracking: vi.fn(),
  };
  const cacheValidator: ICacheValidator = {
    validate: (): ICacheValidation => ({
      prefixCached: false,
      prefixCreated: false,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      newInputTokens: 100,
      outputTokens: 10,
      cacheHitRate: 0,
    }),
  };

  const agent = new Agent({
    session,
    provider: options.provider,
    providerName: 'deepseek',
    requestBuilder,
    cacheValidator,
    maxToolRounds: 5,
    contextCompaction: {
      maxContextTokens: 1_000,
      handler: options.compactionHandler as never,
    },
  });
  return agent;
}

function okResponse(content: string): IChatResponse {
  return {
    id: 'resp',
    choices: [{ message: { role: 'assistant', content }, finishReason: 'stop' }],
  };
}

function buildProvider(chat: ILLMProvider['chat']): ILLMProvider {
  return {
    name: 'test',
    models: ['test-model'],
    chat,
    validate: () => true,
  };
}

describe('Agent provider-overflow recovery (PR3)', () => {
  it('runs emergency compaction once and retries the request', async () => {
    const chat = vi.fn<ILLMProvider['chat']>()
      .mockRejectedValueOnce(overflowError())
      .mockResolvedValueOnce(okResponse('恢复成功'));

    const handler = vi.fn(async () => ({
      messages: [{ id: 'cp', role: 'user' as const, content: '[摘要]', timestamp: 1 }],
    }));

    const agent = buildAgent({ provider: buildProvider(chat), compactionHandler: handler });
    const events: IChatStreamEvent[] = [];
    const response = await agent.chat('hi', (event) => events.push(event));

    expect(chat).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledTimes(1);
    expect((handler.mock.calls[0] as unknown[])[1]).toBe('provider-overflow');
    expect(events.some((event) => event.type === 'context-compacted')).toBe(true);
    expect(response.content).toBe('恢复成功');
  });

  it('retries at most once: second overflow propagates to the caller', async () => {
    const chat = vi.fn<ILLMProvider['chat']>().mockRejectedValue(overflowError());

    const handler = vi.fn(async () => ({
      messages: [{ id: 'cp', role: 'user' as const, content: '[摘要]', timestamp: 1 }],
    }));

    const agent = buildAgent({ provider: buildProvider(chat), compactionHandler: handler });
    await expect(agent.chat('hi')).rejects.toThrow();
    expect(chat).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('propagates the original error when compaction fails', async () => {
    const chat = vi.fn<ILLMProvider['chat']>().mockRejectedValue(overflowError());

    const handler = vi.fn(async () => null);
    const agent = buildAgent({
      provider: buildProvider(chat),
      compactionHandler: handler as BuildOptions['compactionHandler'],
    });
    await expect(agent.chat('hi')).rejects.toThrow('context_length_exceeded');
    expect(chat).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not compact on non-overflow errors', async () => {
    const chat = vi.fn<ILLMProvider['chat']>().mockRejectedValue(new Error('network down'));

    const handler = vi.fn(async () => null);
    const agent = buildAgent({
      provider: buildProvider(chat),
      compactionHandler: handler as BuildOptions['compactionHandler'],
    });
    await expect(agent.chat('hi')).rejects.toThrow('network down');
    expect(handler).not.toHaveBeenCalled();
  });
});
