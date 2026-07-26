import { describe, expect, it, vi } from 'vitest';
import type { IChatRequest, IChatResponse, ILLMProvider } from '@codepapr/types';
import { Agent, DEFAULT_AGENT_MAX_TOOL_ROUNDS, ImmutablePrefix, Session, ToolRegistry, type ContextCompactionConfig } from '../src';

function createResponse(
  content: string,
  options: {
    reasoningContent?: string;
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  } = {}
): IChatResponse {
  return {
    id: 'resp-test',
    choices: [
      {
        message: {
          role: 'assistant',
          content,
          reasoningContent: options.reasoningContent,
          toolCalls: options.toolCalls,
        },
        finishReason: 'stop',
      },
    ],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
    },
  };
}

describe('Agent', () => {
  it('returns the final assistant round while keeping earlier rounds in the session log', async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(
      {
        name: 'read_file',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
          },
          required: ['path'],
        },
      },
      async () => ({ ok: true })
    );

    const provider: ILLMProvider = {
      name: 'openai',
      models: ['test-model'],
      validate: () => true,
      chat: vi
        .fn<(_: IChatRequest) => Promise<IChatResponse>>()
        .mockResolvedValueOnce(
          createResponse('第一段回复', {
            reasoningContent: '第一段思考',
            toolCalls: [
              {
                id: 'tool-1',
                name: 'read_file',
                arguments: { path: 'README.md' },
              },
            ],
          })
        )
        .mockResolvedValueOnce(
          createResponse('第二段回复', {
            reasoningContent: '第二段思考',
          })
        ),
    };

    const agent = new Agent({
      session: new Session({
        sessionId: 'session-1',
        prefix: new ImmutablePrefix({
          systemPrompt: '你是测试助手',
          tools: toolRegistry.getAll(),
          model: 'test-model',
          parameters: { temperature: 0.7, topP: 0.9, maxTokens: 1000 },
        }),
        toolRegistry,
      }),
      provider,
      providerName: 'openai',
      requestBuilder: {
        build: ({ model }) => ({
          model,
          messages: [],
        }),
      },
      cacheValidator: {
        validate: () => ({
          prefixCached: false,
          prefixCreated: false,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          newInputTokens: 1,
          outputTokens: 1,
          cacheHitRate: 0,
        }),
      },
    });

    const response = await agent.chat('读取并继续');

    expect(response.content).toBe('第二段回复');
    expect(response.reasoningContent).toBe('第二段思考');
    expect(provider.chat).toHaveBeenCalledTimes(2);
    expect(agent.getSession().logStore.length()).toBe(4);
    expect(agent.getSession().logStore.getAllMessages()[1]?.content).toBe('第一段回复');
    expect(agent.getSession().logStore.getAllMessages()[3]?.content).toBe('第二段回复');
  });

  it('emits round boundary events for internal tool rounds', async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(
      {
        name: 'read_file',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
          },
          required: ['path'],
        },
      },
      async () => ({ ok: true })
    );

    const provider: ILLMProvider = {
      name: 'openai',
      models: ['test-model'],
      validate: () => true,
      chat: vi
        .fn<(_: IChatRequest) => Promise<IChatResponse>>()
        .mockResolvedValueOnce(
          createResponse('第一轮读取', {
            toolCalls: [
              {
                id: 'tool-1',
                name: 'read_file',
                arguments: { path: 'README.md' },
              },
            ],
          })
        )
        .mockResolvedValueOnce(createResponse('第二轮总结')),
    };

    const agent = new Agent({
      session: new Session({
        sessionId: 'session-2',
        prefix: new ImmutablePrefix({
          systemPrompt: '你是测试助手',
          tools: toolRegistry.getAll(),
          model: 'test-model',
          parameters: { temperature: 0.7, topP: 0.9, maxTokens: 1000 },
        }),
        toolRegistry,
      }),
      provider,
      providerName: 'openai',
      requestBuilder: {
        build: ({ model }) => ({
          model,
          messages: [],
        }),
      },
      cacheValidator: {
        validate: () => ({
          prefixCached: false,
          prefixCreated: false,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          newInputTokens: 1,
          outputTokens: 1,
          cacheHitRate: 0,
        }),
      },
    });

    const events: string[] = [];
    await agent.chat('读取并继续', (event) => {
      if (event.type === 'request-context') {
        const payload = JSON.parse(event.content) as {
          round: number;
          model: string;
          messages: Array<{ role: string }>;
        };
        events.push(`context:${payload.round}:${payload.model}:${payload.messages.length}`);
      }
      if (event.type === 'assistant-round-complete') {
        events.push(`complete:${event.round}:${event.content}`);
      }
      if (event.type === 'assistant-round-start') {
        events.push(`start:${event.round}`);
      }
      if (event.type === 'tool-call-start') {
        events.push(`tool-start:${event.toolName}`);
      }
      if (event.type === 'tool-call-end') {
        events.push(`tool-end:${event.toolName}`);
      }
    });

    expect(events).toEqual([
      'context:1:test-model:0',
      'complete:1:第一轮读取',
      'tool-start:read_file',
      'tool-end:read_file',
      'start:2',
      'context:2:test-model:0',
      'complete:2:第二轮总结',
    ]);
  });

  it('allows more than five internal tool rounds by default', async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(
      {
        name: 'read_file',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
          },
          required: ['path'],
        },
      },
      async () => ({ ok: true })
    );

    const providerChat = vi.fn<(_: IChatRequest) => Promise<IChatResponse>>();
    for (let round = 1; round <= 5; round += 1) {
      providerChat.mockResolvedValueOnce(
        createResponse(`第${round}轮继续`, {
          toolCalls: [
            {
              id: `tool-${round}`,
              name: 'read_file',
              arguments: { path: `file-${round}.ts` },
            },
          ],
        })
      );
    }
    providerChat.mockResolvedValueOnce(createResponse('第六轮完成'));

    const provider: ILLMProvider = {
      name: 'openai',
      models: ['test-model'],
      validate: () => true,
      chat: providerChat,
    };

    const agent = new Agent({
      session: new Session({
        sessionId: 'session-2b',
        prefix: new ImmutablePrefix({
          systemPrompt: '你是测试助手',
          tools: toolRegistry.getAll(),
          model: 'test-model',
          parameters: { temperature: 0.7, topP: 0.9, maxTokens: 1000 },
        }),
        toolRegistry,
      }),
      provider,
      providerName: 'openai',
      requestBuilder: {
        build: ({ model }) => ({
          model,
          messages: [],
        }),
      },
      cacheValidator: {
        validate: () => ({
          prefixCached: false,
          prefixCreated: false,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          newInputTokens: 1,
          outputTokens: 1,
          cacheHitRate: 0,
        }),
      },
    });

    const response = await agent.chat('继续执行直到完成');

    expect(DEFAULT_AGENT_MAX_TOOL_ROUNDS).toBeGreaterThanOrEqual(500);
    expect(response.content).toBe('第六轮完成');
    expect(providerChat).toHaveBeenCalledTimes(6);
  });

  it('returns aggregated cache stats across internal tool rounds', async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(
      {
        name: 'read_file',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
          },
          required: ['path'],
        },
      },
      async () => ({ ok: true })
    );

    const provider: ILLMProvider = {
      name: 'openai',
      models: ['test-model'],
      validate: () => true,
      chat: vi
        .fn<(_: IChatRequest) => Promise<IChatResponse>>()
        .mockResolvedValueOnce(
          createResponse('第一轮', {
            toolCalls: [
              {
                id: 'tool-1',
                name: 'read_file',
                arguments: { path: 'README.md' },
              },
            ],
          })
        )
        .mockResolvedValueOnce(createResponse('第二轮完成')),
    };

    let validationCall = 0;
    const agent = new Agent({
      session: new Session({
        sessionId: 'session-3',
        prefix: new ImmutablePrefix({
          systemPrompt: '你是测试助手',
          tools: toolRegistry.getAll(),
          model: 'test-model',
          parameters: { temperature: 0.7, topP: 0.9, maxTokens: 1000 },
        }),
        toolRegistry,
      }),
      provider,
      providerName: 'openai',
      requestBuilder: {
        build: ({ model }) => ({
          model,
          messages: [],
        }),
      },
      cacheValidator: {
        validate: () => {
          validationCall += 1;
          return validationCall === 1
            ? {
                prefixCached: true,
                prefixCreated: false,
                cacheReadTokens: 80,
                cacheCreationTokens: 20,
                newInputTokens: 10,
                outputTokens: 5,
                cacheHitRate: 80 / 110,
              }
            : {
                prefixCached: false,
                prefixCreated: false,
                cacheReadTokens: 30,
                cacheCreationTokens: 10,
                newInputTokens: 20,
                outputTokens: 7,
                cacheHitRate: 30 / 60,
              };
        },
      },
    });

    const response = await agent.chat('读取并继续');

    expect(response.cacheStats).toEqual({
      cacheCreationTokens: 30,
      cacheReadTokens: 110,
      newInputTokens: 30,
      outputTokens: 12,
      cacheHitRate: 110 / 170,
      calls: 2,
    });
  });
});

describe('Agent mid-loop context compaction', () => {
  const summaryMessage = {
    id: 'summary',
    role: 'assistant' as const,
    content: 'compacted summary',
    timestamp: 1,
  };

  function createAgentWithCompaction(
    handler: ContextCompactionConfig['handler'],
    maxContextTokens: number
  ) {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(
      {
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
      async () => ({ ok: true })
    );
    const provider: ILLMProvider = {
      name: 'openai',
      models: ['test-model'],
      validate: () => true,
      chat: vi
        .fn<(_: IChatRequest) => Promise<IChatResponse>>()
        .mockResolvedValueOnce(
          createResponse('第一轮', {
            toolCalls: [{ id: 't1', name: 'read_file', arguments: { path: 'a' } }],
          })
        )
        .mockResolvedValueOnce(createResponse('最终答案')),
    };
    const agent = new Agent({
      session: new Session({
        sessionId: 'session-compact',
        prefix: new ImmutablePrefix({
          systemPrompt: '你是测试助手',
          tools: toolRegistry.getAll(),
          model: 'test-model',
          parameters: { temperature: 0.7, topP: 0.9, maxTokens: 1000 },
        }),
        toolRegistry,
      }),
      provider,
      providerName: 'openai',
      requestBuilder: {
        build: ({ model }) => ({ model, messages: [] }),
        resetLogTracking: () => undefined,
      },
      cacheValidator: {
        validate: () => ({
          prefixCached: false,
          prefixCreated: false,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          newInputTokens: 1,
          outputTokens: 1,
          cacheHitRate: 0,
        }),
      },
      contextCompaction: { maxContextTokens, handler },
    });
    return { agent, provider };
  }

  it('compacts when context exceeds the budget and emits context-compacted', async () => {
    const handler = vi.fn().mockResolvedValue({
      messages: [summaryMessage],
      cacheStats: { cacheCreationTokens: 0, cacheReadTokens: 0, newInputTokens: 5, outputTokens: 2, calls: 1 },
    });
    const { agent } = createAgentWithCompaction(handler, 1);
    const events: string[] = [];
    await agent.chat('读取并继续', (e) => events.push(e.type));
    expect(handler).toHaveBeenCalled();
    expect(events).toContain('context-compacted');
  });

  it('does not compact when context is within budget', async () => {
    const handler = vi.fn();
    const { agent } = createAgentWithCompaction(handler, 1_000_000_000);
    await agent.chat('读取并继续');
    expect(handler).not.toHaveBeenCalled();
  });

  it('replaces the log with the compacted messages (new epoch)', async () => {
    const handler = vi.fn().mockResolvedValue({ messages: [summaryMessage] });
    const { agent } = createAgentWithCompaction(handler, 1);
    await agent.chat('读取并继续');
    const messages = agent.getSession().logStore.getAllMessages();
    expect(messages[0]?.content).toBe('compacted summary');
  });
});