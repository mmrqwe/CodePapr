import { describe, expect, it, vi } from 'vitest';
import {
  Agent,
  type IRequestBuilder,
  type ICacheValidator,
  type ContextCompactionConfig,
} from './Agent';
import { ContextBudgetRejectedError } from '../context/ContextBudget';
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
  IToolCall,
  IToolDefinition,
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
  contextCompaction?: Partial<ContextCompactionConfig>;
  tools?: Array<{ def: IToolDefinition; handler: (args: Record<string, unknown>) => unknown }>;
}

function makeToolDefinition(name: string): IToolDefinition {
  return {
    name,
    description: `${name} 测试工具`,
    parameters: { type: 'object', properties: {} },
  };
}

function buildAgent(options: BuildOptions) {
  const registry = new ToolRegistry();
  for (const tool of options.tools ?? []) {
    registry.register(tool.def, async (args) => tool.handler(args));
  }

  const prefix = new ImmutablePrefix({
    systemPrompt: '测试系统提示词',
    tools: (options.tools ?? []).map((tool) => tool.def),
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
      softMaxTokens: 800,
      pruneOptions: {
        enabled: true,
        protectRecentRounds: 1,
        minPrunableChars: 10,
        protectedTools: new Set(['todo']),
        placeholder: '[Old tool result content cleared]',
      },
      handler: options.compactionHandler as never,
      ...options.contextCompaction,
    },
  });
  return { agent, log };
}

function okResponse(content: string): IChatResponse {
  return {
    id: 'resp',
    choices: [{ message: { role: 'assistant', content }, finishReason: 'stop' }],
  };
}

function responseWithToolCalls(toolCalls: IToolCall[]): IChatResponse {
  return {
    id: 'resp-1',
    choices: [
      {
        message: { role: 'assistant', content: '', toolCalls },
        finishReason: 'tool_calls',
      },
    ],
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

const COMPACTION_RESULT = {
  messages: [{ id: 'cp', role: 'user' as const, content: '[摘要]', timestamp: 1 }],
};

describe('Agent provider-overflow recovery (PR3)', () => {
  it('runs emergency compaction once and retries the request', async () => {
    const chat = vi.fn<ILLMProvider['chat']>()
      .mockRejectedValueOnce(overflowError())
      .mockResolvedValueOnce(okResponse('恢复成功'));

    const handler = vi.fn(async () => COMPACTION_RESULT);

    const { agent } = buildAgent({ provider: buildProvider(chat), compactionHandler: handler });
    const events: IChatStreamEvent[] = [];
    const response = await agent.chat('hi', (event) => events.push(event));

    expect(chat).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledTimes(1);
    expect((handler.mock.calls[0] as unknown[])[1]).toBe('provider-overflow');
    expect(events.some((event) => event.type === 'context-compacted')).toBe(true);
    expect(response.content).toBe('恢复成功');
  });

  it('retries at most once: second overflow throws ContextBudgetRejectedError', async () => {
    const chat = vi.fn<ILLMProvider['chat']>().mockRejectedValue(overflowError());

    const handler = vi.fn(async () => COMPACTION_RESULT);

    const { agent } = buildAgent({ provider: buildProvider(chat), compactionHandler: handler });
    await expect(agent.chat('hi')).rejects.toBeInstanceOf(ContextBudgetRejectedError);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('throws ContextBudgetRejectedError when emergency compaction fails', async () => {
    const chat = vi.fn<ILLMProvider['chat']>().mockRejectedValue(overflowError());

    const handler = vi.fn(async () => null);
    const { agent } = buildAgent({
      provider: buildProvider(chat),
      compactionHandler: handler as BuildOptions['compactionHandler'],
    });
    await expect(agent.chat('hi')).rejects.toBeInstanceOf(ContextBudgetRejectedError);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not compact on non-overflow errors', async () => {
    const chat = vi.fn<ILLMProvider['chat']>().mockRejectedValue(new Error('network down'));

    const handler = vi.fn(async () => null);
    const { agent } = buildAgent({
      provider: buildProvider(chat),
      compactionHandler: handler as BuildOptions['compactionHandler'],
    });
    await expect(agent.chat('hi')).rejects.toThrow('network down');
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('Agent round-start context budget decision (PR2)', () => {
  function bigOutputToolResponse(id: string, name = 'read'): IChatResponse {
    return responseWithToolCalls([{ id, name, arguments: {} }]);
  }

  it('soft~hard 区间：prune-tool-results 原地裁剪，不调用压缩 handler', async () => {
    const handler = vi.fn(async () => COMPACTION_RESULT);
    const big = 'x'.repeat(500);
    const chat = vi.fn<ILLMProvider['chat']>()
      .mockResolvedValueOnce(bigOutputToolResponse('t0'))
      .mockResolvedValueOnce(bigOutputToolResponse('t1'))
      .mockResolvedValueOnce(okResponse('done'));
    const { agent, log } = buildAgent({
      provider: buildProvider(chat),
      compactionHandler: handler,
      tools: [{ def: makeToolDefinition('read'), handler: () => big }],
      contextCompaction: {
        softMaxTokens: 400,
        pruneOptions: {
          enabled: true,
          protectRecentRounds: 0,
          minPrunableChars: 10,
          protectedTools: new Set(['todo']),
          placeholder: '[Old tool result content cleared]',
        },
      },
    });

    const events: IChatStreamEvent[] = [];
    const response = await agent.chat('hi', (event) => events.push(event));

    expect(response.content).toBe('done');
    expect(handler).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === 'context-pruned')).toBe(true);
    const prunedCount = log
      .getAllMessages()
      .filter((m) => m.role === 'tool' && m.content === '[Old tool result content cleared]')
      .length;
    expect(prunedCount).toBeGreaterThan(0);
  });

  it('低于 soft 预算：不裁剪、不压缩', async () => {
    const handler = vi.fn(async () => COMPACTION_RESULT);
    const chat = vi.fn<ILLMProvider['chat']>().mockResolvedValueOnce(okResponse('ok'));
    const { agent } = buildAgent({ provider: buildProvider(chat), compactionHandler: handler });

    const events: IChatStreamEvent[] = [];
    await agent.chat('hi', (event) => events.push(event));

    expect(handler).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === 'context-pruned')).toBe(false);
    expect(events.some((event) => event.type === 'context-compacted')).toBe(false);
  });

  it('超过 hard 预算：走压缩 handler（token-limit）', async () => {
    const handler = vi.fn(async () => COMPACTION_RESULT);
    const big = 'y'.repeat(20_000);
    const chat = vi.fn<ILLMProvider['chat']>()
      .mockResolvedValueOnce(bigOutputToolResponse('t0'))
      .mockResolvedValueOnce(okResponse('compacted'));
    const { agent } = buildAgent({
      provider: buildProvider(chat),
      compactionHandler: handler,
      tools: [{ def: makeToolDefinition('read'), handler: () => big }],
    });

    const response = await agent.chat('hi');

    expect(response.content).toBe('compacted');
    expect(handler).toHaveBeenCalledTimes(1);
    expect((handler.mock.calls[0] as unknown[])[1]).toBe('token-limit');
  });
});
