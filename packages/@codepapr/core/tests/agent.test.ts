import { describe, expect, it, vi } from 'vitest';
import type { IChatRequest, IChatResponse, IContextSnapshot, ILLMProvider, IMessage } from '@codepapr/types';
import {
  Agent,
  CONTINUATION_NUDGE,
  DEFAULT_AGENT_MAX_TOOL_ROUNDS,
  EMPTY_COMPLETION_DISABLE_THINKING_AFTER,
  EMPTY_COMPLETION_RETRY_DELAYS_MS,
  ImmutablePrefix,
  MAX_CONTINUATIONS_PER_ROUND,
  MAX_EMPTY_COMPLETION_RETRIES_PER_ROUND,
  Session,
  ToolRegistry,
  type ContextCompactionConfig,
} from '../src';

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
  it('logStore.append 抛错时 finally 仍复位 scratch 与 abortController（旧实现抛错跳过复位）', async () => {
    const toolRegistry = new ToolRegistry();
    const session = new Session({
      sessionId: 'session-reset',
      prefix: new ImmutablePrefix({
        systemPrompt: '你是测试助手',
        tools: [],
        model: 'test-model',
        parameters: { temperature: 0.7, topP: 0.9, maxTokens: 1000 },
      }),
      toolRegistry,
    });

    // 第一次 append 抛错，之后恢复正常
    const originalAppend = session.logStore.append.bind(session.logStore);
    vi.spyOn(session.logStore, 'append')
      .mockRejectedValueOnce(new Error('append failed'))
      .mockImplementation((msg) => originalAppend(msg));

    const provider: ILLMProvider = {
      name: 'openai',
      models: ['test-model'],
      validate: () => true,
      chat: vi
        .fn<(_: IChatRequest) => Promise<IChatResponse>>()
        .mockResolvedValue(createResponse('ok')),
    };

    const agent = new Agent({
      session,
      provider,
      providerName: 'openai',
      requestBuilder: {
        build: ({ model }) => ({ model, messages: [] }),
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

    await expect(agent.chat('hi')).rejects.toThrow('append failed');

    // finally 已执行：markRoundEnd 写入结束数据（旧实现 append 在 try 之前
    // 抛错，scratch 停在「回合进行中」，lastRoundData 永远不会写入）
    const scratchInternals = session.scratch as unknown as {
      lastRoundData: { duration?: number };
      roundStartTime: number;
    };
    expect(typeof scratchInternals.lastRoundData.duration).toBe('number');
    expect(scratchInternals.roundStartTime).toBe(0);

    // abortController 已清空：新回合不受陈旧 controller 影响
    const agentInternals = agent as unknown as { abortController: AbortController | null };
    expect(agentInternals.abortController).toBeNull();

    // 失败后同一 agent 仍可正常开启新回合
    const response = await agent.chat('hi again');
    expect(response.content).toBe('ok');
  });

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

  it('keeps full tool output in the log and freezes a history summary in metadata (tool context mode)', async () => {
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
      async () => 'line1\nline2\nline3'
    );

    const provider: ILLMProvider = {
      name: 'openai',
      models: ['test-model'],
      validate: () => true,
      chat: vi
        .fn<(_: IChatRequest) => Promise<IChatResponse>>()
        .mockResolvedValueOnce(
          createResponse('读取', {
            toolCalls: [{ id: 'tool-1', name: 'read_file', arguments: { path: 'a.ts' } }],
          })
        )
        .mockResolvedValueOnce(createResponse('完成')),
    };

    const agent = new Agent({
      session: new Session({
        sessionId: 'session-tool-ctx',
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
      toolContextConfig: {
        defaultMode: 'summary',
        overrides: {},
        summaryMaxChars: 500,
        autoThresholdChars: 5000,
      },
    });

    let endEvent: { contextContent?: string; contextSummary?: string } | undefined;
    await agent.chat('读取并继续', (event) => {
      if (event.type === 'tool-call-end') {
        endEvent = event;
      }
    });

    // The log keeps the FULL tool output (what the LLM saw this round)…
    const toolMsg = agent
      .getSession()
      .logStore.getAllMessages()
      .find((m) => m.role === 'tool');
    expect(toolMsg?.content).toBe('line1\nline2\nline3');
    // …with a frozen history summary attached for later request builds.
    expect(toolMsg?.metadata?.toolSummary).toContain('[read_file]');

    // The stream event carries both: full content for byte-exact rebuilds and
    // the frozen summary for history.
    expect(endEvent?.contextContent).toBe('line1\nline2\nline3');
    expect(endEvent?.contextSummary).toContain('[read_file]');
  });

  it('attaches a staged context snapshot to the request-context event', async () => {
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
        .mockResolvedValueOnce(createResponse('完成')),
    };

    const agent = new Agent({
      session: new Session({
        sessionId: 'session-snapshot',
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
          tools: toolRegistry.getAll(),
          messages: [
            {
              id: 'prefix-system',
              role: 'system',
              content: '你是测试助手',
              timestamp: 0,
              metadata: { isPrefixSystem: true },
            },
            {
              id: 'session-bootstrap',
              role: 'assistant',
              content: '会话引导内容',
              timestamp: 1,
              metadata: { sessionBootstrap: true, isPrefixSystem: true },
            },
            {
              id: 'user-1',
              role: 'user',
              content: '你好',
              timestamp: 2,
            },
          ],
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

    let snapshot: IContextSnapshot | undefined;
    await agent.chat('你好', (event) => {
      if (event.type === 'request-context') {
        snapshot = event.snapshot;
      }
    });

    expect(snapshot).toBeDefined();
    expect(snapshot!.round).toBe(1);
    expect(snapshot!.messages).toHaveLength(3);
    expect(snapshot!.messages[0]?.stage).toBe('stable-prefix');
    expect(snapshot!.messages[1]?.stage).toBe('session-state');
    expect(snapshot!.messages[2]?.stage).toBe('conversation');
    expect(snapshot!.toolsTokenEstimate).toBeGreaterThan(0);
    expect(snapshot!.toolNames).toEqual(['read_file']);
    expect(snapshot!.tokensByStage['stable-prefix']).toBeGreaterThan(0);
    expect(snapshot!.tokensByStage['session-state']).toBeGreaterThan(0);
    expect(snapshot!.tokensByStage.conversation).toBeGreaterThan(0);
    expect(snapshot!.totalTokens).toBe(
      snapshot!.tokensByStage['stable-prefix'] +
        snapshot!.tokensByStage['session-state'] +
        snapshot!.tokensByStage.conversation
    );
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

  it('compacts on consecutive over-budget rounds (no stale cooldown skipping)', async () => {
    // 旧实现 round - lastCompactionRound >= 2：round 0 压缩后，round 1 即使
    // 仍超预算也跳过——超预算请求照发，与「任何请求都不超限」矛盾。
    // 修复后：压缩成功 → 无冷却，连续超限的每一轮都压缩。
    const handler = vi.fn().mockResolvedValue({ messages: [summaryMessage] });
    const { agent } = createAgentWithCompaction(handler, 1);
    const events: string[] = [];
    await agent.chat('读取并继续', (e) => {
      if (e.type === 'context-compacted') events.push(e.type);
    });
    // round 0（请求前）与 round 1（工具结果落日志后）各压缩一次
    expect(handler).toHaveBeenCalledTimes(2);
    expect(events).toEqual(['context-compacted', 'context-compacted']);
  });

  it('cooldowns one round after a failed compaction instead of hot-looping, then retries', async () => {
    // 三轮（工具→工具→收尾）覆盖 round 0/1/2 的压缩检查：
    // handler 持续返回 null（无可压缩内容）→ round 0 尝试失败 → round 1
    // 冷却（不空试）→ round 2 重试（再次失败）。旧实现在失败场景同样被
    // >= 2 冷却，但成功的场景被错误地一起冷却了；这里锁定失败场景不回退。
    const handler = vi.fn().mockResolvedValue(null);
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
        .mockResolvedValueOnce(
          createResponse('第二轮', {
            toolCalls: [{ id: 't2', name: 'read_file', arguments: { path: 'b' } }],
          })
        )
        .mockResolvedValueOnce(createResponse('最终答案')),
    };
    const agent = new Agent({
      session: new Session({
        sessionId: 'session-compact-fail',
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
      requestBuilder: { build: ({ model }) => ({ model, messages: [] }) },
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
      contextCompaction: { maxContextTokens: 1, handler },
    });
    await agent.chat('读取并继续');

    // round 0 失败、round 1 冷却、round 2 重试（再次失败）→ 2 次调用
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('a failed compaction does not suppress the next successful one', async () => {
    const handler = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ messages: [summaryMessage] });
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
        .mockResolvedValueOnce(
          createResponse('第二轮', {
            toolCalls: [{ id: 't2', name: 'read_file', arguments: { path: 'b' } }],
          })
        )
        .mockResolvedValueOnce(createResponse('最终答案')),
    };
    const agent = new Agent({
      session: new Session({
        sessionId: 'session-compact-recover',
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
      requestBuilder: { build: ({ model }) => ({ model, messages: [] }) },
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
      contextCompaction: { maxContextTokens: 1, handler },
    });
    const events: string[] = [];
    await agent.chat('读取并继续', (e) => {
      if (e.type === 'context-compacted') events.push(e.type);
    });
    // round 0 失败 → round 1 冷却 → round 2 重试成功
    expect(handler).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(1);
  });
});

describe('Agent completion-quality guards (no silent stops)', () => {
  function lengthResponse(content: string, reasoningContent?: string): IChatResponse {
    return {
      id: 'resp-length',
      choices: [
        {
          message: { role: 'assistant', content, reasoningContent },
          finishReason: 'length',
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }

  function stopResponse(content: string): IChatResponse {
    return {
      id: 'resp-stop',
      choices: [
        {
          message: { role: 'assistant', content },
          finishReason: 'stop',
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }

  function emptyResponse(): IChatResponse {
    return {
      id: 'resp-empty',
      choices: [
        {
          message: { role: 'assistant', content: '' },
          finishReason: 'stop',
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }

  /** 仅有思考、无内容、无工具调用的退化响应（实测为 reasoning 占位符回声）。 */
  function reasoningOnlyResponse(reasoningContent: string): IChatResponse {
    return {
      id: 'resp-reasoning-only',
      choices: [
        {
          message: { role: 'assistant', content: '', reasoningContent },
          finishReason: 'stop',
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }

  const noopValidator = {
    validate: () => ({
      prefixCached: false,
      prefixCreated: false,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      newInputTokens: 1,
      outputTokens: 1,
      cacheHitRate: 0,
    }),
  };

  function createGuardedAgent(
    provider: ILLMProvider,
    providerName: 'deepseek' | 'openai' | 'claude',
    buildSpy: (opts: { suffixMessages?: IMessage[]; thinking?: unknown }) => void,
    parameters: Record<string, unknown> = { temperature: 0.7, topP: 0.9, maxTokens: 1000 },
  ): Agent {
    const toolRegistry = new ToolRegistry();
    return new Agent({
      session: new Session({
        sessionId: 'session-guard',
        prefix: new ImmutablePrefix({
          systemPrompt: '你是测试助手',
          tools: toolRegistry.getAll(),
          model: 'test-model',
          parameters,
        }),
        toolRegistry,
      }),
      provider,
      providerName,
      requestBuilder: {
        build: (opts) => {
          buildSpy(opts);
          return { model: 'test-model', messages: [] };
        },
      },
      cacheValidator: noopValidator,
      emptyCompletionRetryDelaysMs: [0],
    });
  }

  it('continues automatically when output is truncated by max_tokens (finish_reason=length)', async () => {
    const provider: ILLMProvider = {
      name: 'openai',
      models: ['test-model'],
      validate: () => true,
      chat: vi
        .fn<(_: IChatRequest) => Promise<IChatResponse>>()
        .mockResolvedValueOnce(lengthResponse('你好，世'))
        .mockResolvedValueOnce(stopResponse('界！')),
    };
    const builds: Array<{ suffixMessages?: IMessage[] }> = [];
    const agent = createGuardedAgent(provider, 'openai', (opts) => builds.push({ suffixMessages: opts.suffixMessages }));
    const events: Array<{ type: string; reason?: string }> = [];

    const response = await agent.chat('请回答', (e) => {
      if (e.type === 'round-retry') events.push({ type: e.type, reason: e.reason });
    });

    // 两个片段合并为一条完整回复
    expect(response.content).toBe('你好，世界！');
    expect(provider.chat).toHaveBeenCalledTimes(2);

    // 日志中该回合只有一条 assistant 消息（片段不单独落日志）
    const messages = agent.getSession().logStore.getAllMessages();
    expect(messages).toHaveLength(2);
    expect(messages[1]?.role).toBe('assistant');
    expect(messages[1]?.content).toBe('你好，世界！');

    // 第一次请求无 suffix；续写请求携带 部分输出 + 续写指令
    expect(builds[0]?.suffixMessages).toBeUndefined();
    const suffix = builds[1]?.suffixMessages;
    expect(suffix).toHaveLength(2);
    expect(suffix?.[0]?.role).toBe('assistant');
    expect(suffix?.[0]?.content).toBe('你好，世');
    expect(suffix?.[1]?.role).toBe('user');
    expect(suffix?.[1]?.content).toBe(CONTINUATION_NUDGE);

    expect(events).toEqual([{ type: 'round-retry', reason: 'length-continue' }]);
  });

  it('disables thinking on continuation attempts (deepseek)', async () => {
    const provider: ILLMProvider = {
      name: 'deepseek',
      models: ['test-model'],
      validate: () => true,
      chat: vi
        .fn<(_: IChatRequest) => Promise<IChatResponse>>()
        .mockResolvedValueOnce(lengthResponse('部分'))
        .mockResolvedValueOnce(stopResponse('完整')),
    };
    const builds: Array<{ thinking?: unknown }> = [];
    const agent = createGuardedAgent(
      provider,
      'deepseek',
      (opts) => builds.push({ thinking: opts.thinking }),
      { temperature: 0.7, topP: 0.9, maxTokens: 1000, thinkingEnabled: true },
    );

    await agent.chat('请回答');

    expect(builds[0]?.thinking).toEqual({ type: 'enabled' });
    // DeepSeek 省略 thinking 会默认开启思考，续写必须显式 disabled
    expect(builds[1]?.thinking).toEqual({ type: 'disabled' });
  });

  it('openai/claude 提供者开启思考时发送 thinking（任意 effort 透传 + budget）', async () => {
    const provider: ILLMProvider = {
      name: 'openai',
      models: ['test-model'],
      validate: () => true,
      chat: vi.fn<(_: IChatRequest) => Promise<IChatResponse>>().mockResolvedValue(stopResponse('ok')),
    };
    const builds: Array<{ thinking?: unknown }> = [];
    const agent = createGuardedAgent(
      provider,
      'openai',
      (opts) => builds.push({ thinking: opts.thinking }),
      { temperature: 0.7, topP: 0.9, maxTokens: 1000, thinkingEnabled: true, reasoningEffort: 'xhigh', thinkingBudgetTokens: 8000 },
    );

    await agent.chat('请回答');

    expect(builds[0]?.thinking).toEqual({
      type: 'enabled',
      reasoningEffort: 'xhigh',
      budgetTokens: 8000,
    });
  });

  it('openai/claude 提供者关闭思考时不发 thinking 字段（避免第三方端点 400）', async () => {
    const provider: ILLMProvider = {
      name: 'openai',
      models: ['test-model'],
      validate: () => true,
      chat: vi.fn<(_: IChatRequest) => Promise<IChatResponse>>().mockResolvedValue(stopResponse('ok')),
    };
    const builds: Array<{ thinking?: unknown }> = [];
    const agent = createGuardedAgent(
      provider,
      'openai',
      (opts) => builds.push({ thinking: opts.thinking }),
      { temperature: 0.7, topP: 0.9, maxTokens: 1000, thinkingEnabled: false },
    );

    await agent.chat('请回答');

    expect(builds[0]?.thinking).toBeUndefined();
  });

  it('claude 提供者思考开启时携带 budgetTokens', async () => {
    const provider: ILLMProvider = {
      name: 'claude',
      models: ['test-model'],
      validate: () => true,
      chat: vi.fn<(_: IChatRequest) => Promise<IChatResponse>>().mockResolvedValue(stopResponse('ok')),
    };
    const builds: Array<{ thinking?: unknown }> = [];
    const agent = createGuardedAgent(
      provider,
      'claude',
      (opts) => builds.push({ thinking: opts.thinking }),
      { temperature: 0.7, topP: 0.9, maxTokens: 1000, thinkingEnabled: true, thinkingBudgetTokens: 6000 },
    );

    await agent.chat('请回答');

    expect(builds[0]?.thinking).toEqual({ type: 'enabled', budgetTokens: 6000 });
  });

  it('deepseek 提供者任意 effort 值透传（不再只认 high/max）', async () => {
    const provider: ILLMProvider = {
      name: 'deepseek',
      models: ['test-model'],
      validate: () => true,
      chat: vi.fn<(_: IChatRequest) => Promise<IChatResponse>>().mockResolvedValue(stopResponse('ok')),
    };
    const builds: Array<{ thinking?: unknown }> = [];
    const agent = createGuardedAgent(
      provider,
      'deepseek',
      (opts) => builds.push({ thinking: opts.thinking }),
      { temperature: 0.7, topP: 0.9, maxTokens: 1000, thinkingEnabled: true, reasoningEffort: 'medium' },
    );

    await agent.chat('请回答');

    expect(builds[0]?.thinking).toEqual({ type: 'enabled', reasoningEffort: 'medium' });
  });

  it('stops continuing after MAX_CONTINUATIONS_PER_ROUND and ends gracefully (no throw)', async () => {
    const chatMock = vi.fn<(_: IChatRequest) => Promise<IChatResponse>>();
    for (let i = 0; i < MAX_CONTINUATIONS_PER_ROUND + 1; i += 1) {
      chatMock.mockResolvedValueOnce(lengthResponse(`片段${i}`));
    }
    const provider: ILLMProvider = {
      name: 'openai',
      models: ['test-model'],
      validate: () => true,
      chat: chatMock,
    };
    const agent = createGuardedAgent(provider, 'openai', () => undefined);

    const response = await agent.chat('请回答');

    // 达到续写上限后以已合并内容正常收尾（绝不抛错）
    expect(chatMock).toHaveBeenCalledTimes(MAX_CONTINUATIONS_PER_ROUND + 1);
    const expected = Array.from({ length: MAX_CONTINUATIONS_PER_ROUND + 1 }, (_, i) => `片段${i}`).join('');
    expect(response.content).toBe(expected);
    expect(response.toolCalls).toBeUndefined();
  });

  it('retries an empty completion instead of silently ending the turn', async () => {
    const provider: ILLMProvider = {
      name: 'openai',
      models: ['test-model'],
      validate: () => true,
      chat: vi
        .fn<(_: IChatRequest) => Promise<IChatResponse>>()
        .mockResolvedValueOnce(emptyResponse())
        .mockResolvedValueOnce(emptyResponse())
        .mockResolvedValueOnce(stopResponse('最终答案')),
    };
    const agent = createGuardedAgent(provider, 'openai', () => undefined);
    const attempts: number[] = [];

    const response = await agent.chat('请回答', (e) => {
      if (e.type === 'round-retry' && e.reason === 'empty') attempts.push(e.attempt);
    });

    expect(response.content).toBe('最终答案');
    expect(provider.chat).toHaveBeenCalledTimes(3);
    expect(attempts).toEqual([1, 2]);
    // 空完成不落日志：仅 user + 最终 assistant
    const messages = agent.getSession().logStore.getAllMessages();
    expect(messages).toHaveLength(2);
    expect(messages[1]?.content).toBe('最终答案');
  });

  it('throws after MAX_EMPTY_COMPLETION_RETRIES_PER_ROUND consecutive empty completions', async () => {
    const chatMock = vi.fn<(_: IChatRequest) => Promise<IChatResponse>>();
    // 持续空完成：旧实现会每 30s 无限重试、永久挂起并烧 token。
    for (let i = 0; i < MAX_EMPTY_COMPLETION_RETRIES_PER_ROUND + 2; i += 1) {
      chatMock.mockResolvedValueOnce(emptyResponse());
    }
    const provider: ILLMProvider = {
      name: 'openai',
      models: ['test-model'],
      validate: () => true,
      chat: chatMock,
    };
    const agent = createGuardedAgent(provider, 'openai', () => undefined);

    await expect(agent.chat('请回答')).rejects.toThrow(/空完成/);
    // 重试上限次请求后抛错，而不是无限继续
    expect(chatMock).toHaveBeenCalledTimes(MAX_EMPTY_COMPLETION_RETRIES_PER_ROUND + 1);
  });

  it('retries a reasoning-only completion instead of silently ending the turn', async () => {
    // 实测故障：模型把 reasoning 占位符回声成唯一输出（无内容/无工具调用）。
    // 旧实现因 reasoningContent 非空判为正常结束，回合静默终止。
    const provider: ILLMProvider = {
      name: 'openai',
      models: ['test-model'],
      validate: () => true,
      chat: vi
        .fn<(_: IChatRequest) => Promise<IChatResponse>>()
        .mockResolvedValueOnce(reasoningOnlyResponse('Called browser to proceed.'))
        .mockResolvedValueOnce(reasoningOnlyResponse('Called browser to proceed.'))
        .mockResolvedValueOnce(stopResponse('最终答案')),
    };
    const agent = createGuardedAgent(provider, 'openai', () => undefined);
    const attempts: number[] = [];

    const response = await agent.chat('请回答', (e) => {
      if (e.type === 'round-retry' && e.reason === 'empty') attempts.push(e.attempt);
    });

    expect(response.content).toBe('最终答案');
    expect(provider.chat).toHaveBeenCalledTimes(3);
    expect(attempts).toEqual([1, 2]);
    // reasoning-only 响应不落日志：仅 user + 最终 assistant
    const messages = agent.getSession().logStore.getAllMessages();
    expect(messages).toHaveLength(2);
    expect(messages[1]?.content).toBe('最终答案');
  });

  it('throws after sustained reasoning-only completions (never hangs silently)', async () => {
    const chatMock = vi.fn<(_: IChatRequest) => Promise<IChatResponse>>();
    for (let i = 0; i < MAX_EMPTY_COMPLETION_RETRIES_PER_ROUND + 2; i += 1) {
      chatMock.mockResolvedValueOnce(reasoningOnlyResponse('Called browser to proceed.'));
    }
    const provider: ILLMProvider = {
      name: 'openai',
      models: ['test-model'],
      validate: () => true,
      chat: chatMock,
    };
    const agent = createGuardedAgent(provider, 'openai', () => undefined);

    await expect(agent.chat('请回答')).rejects.toThrow(/空完成/);
    expect(chatMock).toHaveBeenCalledTimes(MAX_EMPTY_COMPLETION_RETRIES_PER_ROUND + 1);
  });

  it('empty-completion retry schedule: delays strictly increase and cover the retry cap', () => {
    expect(EMPTY_COMPLETION_RETRY_DELAYS_MS).toHaveLength(MAX_EMPTY_COMPLETION_RETRIES_PER_ROUND);
    for (let i = 1; i < EMPTY_COMPLETION_RETRY_DELAYS_MS.length; i += 1) {
      expect(EMPTY_COMPLETION_RETRY_DELAYS_MS[i]).toBeGreaterThan(
        EMPTY_COMPLETION_RETRY_DELAYS_MS[i - 1] ?? Number.NaN
      );
    }
    // 关 thinking 阈值必须落在重试区间内（太早浪费思考、太晚失去兜底意义）
    expect(EMPTY_COMPLETION_DISABLE_THINKING_AFTER).toBeGreaterThanOrEqual(1);
    expect(EMPTY_COMPLETION_DISABLE_THINKING_AFTER).toBeLessThanOrEqual(
      MAX_EMPTY_COMPLETION_RETRIES_PER_ROUND
    );
  });
});