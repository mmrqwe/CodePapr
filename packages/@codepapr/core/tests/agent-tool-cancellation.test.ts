import { describe, expect, it, vi } from 'vitest';
import type { IChatRequest, IChatResponse, ILLMProvider, IMessage } from '@codepapr/types';
import {
  Agent,
  ImmutablePrefix,
  Session,
  ToolRegistry,
  runSubagentSession,
  resolveSubagentExecution,
  SUBAGENT_WALL_CLOCK_TIMEOUT_MS,
  type SubagentSessionDeps,
} from '../src';

function createResponse(
  content: string,
  options: {
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
          toolCalls: options.toolCalls,
        },
        finishReason: 'stop',
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function createAgent(opts: {
  registry: ToolRegistry;
  provider: ILLMProvider;
  toolTimeouts?: Record<string, number>;
}): Agent {
  return new Agent({
    session: new Session({
      sessionId: 'session-cancel-test',
      prefix: new ImmutablePrefix({
        systemPrompt: '你是测试助手',
        tools: opts.registry.getAll(),
        model: 'test-model',
        parameters: { temperature: 0.7, topP: 0.9, maxTokens: 1000 },
      }),
      toolRegistry: opts.registry,
    }),
    provider: opts.provider,
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
    toolTimeouts: opts.toolTimeouts,
    emptyCompletionRetryDelaysMs: [],
  });
}

describe('Agent 工具取消通道', () => {
  it('工具超时时 withTimeout 必须 abort 工具收到的 signal（工具停止后台执行）', async () => {
    const registry = new ToolRegistry();
    let capturedSignal: AbortSignal | undefined;
    let handlerSettled = false;
    registry.register(
      {
        name: 'slow_tool',
        description: 'slow',
        parameters: { type: 'object', properties: {} },
      },
      async (_args, context) => {
        capturedSignal = context?.signal;
        // 工具监听 signal：abort 时立即停止（模拟 bash 杀进程后返回）
        await new Promise<void>((resolve, reject) => {
          context?.signal?.addEventListener('abort', () => reject(new DOMException('已取消', 'AbortError')), { once: true });
        }).catch(() => undefined);
        handlerSettled = true;
        return { ok: true };
      }
    );

    const provider: ILLMProvider = {
      name: 'openai',
      models: ['test-model'],
      validate: () => true,
      chat: vi
        .fn<(_: IChatRequest) => Promise<IChatResponse>>()
        .mockResolvedValueOnce(
          createResponse('', {
            toolCalls: [{ id: 't1', name: 'slow_tool', arguments: {} }],
          })
        )
        .mockResolvedValueOnce(createResponse('收尾')),
    };

    const agent = createAgent({ registry, provider, toolTimeouts: { slow_tool: 50 } });
    const response = await agent.chat('跑一个慢工具');

    expect(capturedSignal).toBeDefined();
    // 超时后 signal 必须被 abort，工具才能感知取消并停止
    expect(capturedSignal?.aborted).toBe(true);
    // 工具内部因 abort 而结算（而不是继续挂起跑完）
    await vi.waitFor(() => expect(handlerSettled).toBe(true));
    expect(response.content).toBe('收尾');
  });

  it('主会话取消会 abort 正在执行的工具 signal', async () => {
    const registry = new ToolRegistry();
    let capturedSignal: AbortSignal | undefined;
    registry.register(
      {
        name: 'blocking_tool',
        description: 'blocking',
        parameters: { type: 'object', properties: {} },
      },
      async (_args, context) => {
        capturedSignal = context?.signal;
        await new Promise<void>((resolve, reject) => {
          context?.signal?.addEventListener('abort', () => reject(new DOMException('已取消', 'AbortError')), { once: true });
        });
        return { ok: true };
      }
    );

    const provider: ILLMProvider = {
      name: 'openai',
      models: ['test-model'],
      validate: () => true,
      chat: vi
        .fn<(_: IChatRequest) => Promise<IChatResponse>>()
        .mockResolvedValueOnce(
          createResponse('', {
            toolCalls: [{ id: 't1', name: 'blocking_tool', arguments: {} }],
          })
        ),
    };

    const agent = createAgent({ registry, provider });
    const chatPromise = agent.chat('跑一个阻塞工具');
    await vi.waitFor(() => expect(capturedSignal).toBeDefined());

    agent.cancel();

    // Agent 收到取消后正常收尾返回（roundLoop 检查 signal 后 break），
    // 关键断言是：取消传播到了正在执行的工具 signal。
    await expect(chatPromise).resolves.toBeDefined();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('正常完成的工具收到未中止的 signal 且结果不被超时误伤', async () => {
    const registry = new ToolRegistry();
    let capturedSignal: AbortSignal | undefined;
    registry.register(
      {
        name: 'fast_tool',
        description: 'fast',
        parameters: { type: 'object', properties: {} },
      },
      async (_args, context) => {
        capturedSignal = context?.signal;
        return { ok: true };
      }
    );

    const provider: ILLMProvider = {
      name: 'openai',
      models: ['test-model'],
      validate: () => true,
      chat: vi
        .fn<(_: IChatRequest) => Promise<IChatResponse>>()
        .mockResolvedValueOnce(
          createResponse('', {
            toolCalls: [{ id: 't1', name: 'fast_tool', arguments: {} }],
          })
        )
        .mockResolvedValueOnce(createResponse('收尾')),
    };

    const agent = createAgent({ registry, provider });
    const response = await agent.chat('跑一个快工具');

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);
    expect(response.content).toBe('收尾');
  });
});

describe('runSubagentSession 父级取消', () => {
  function makeDeps(overrides: Partial<SubagentSessionDeps> = {}): SubagentSessionDeps {
    const registry = new ToolRegistry();
    const exec = resolveSubagentExecution({
      definition: { name: 'explore', prompt: '探索' },
      currentDepth: 0,
      taskPrompt: 'task',
      baseModel: 'test-model',
      fastModel: '',
      fastModelEnabled: false,
      defaultMaxTokens: 1000,
      globalMaxToolRounds: 100,
      thinkingFallback: false,
      fallbackApiKey: 'key',
      fallbackBaseURL: '',
    });
    return {
      definition: { name: 'explore', prompt: '探索' },
      prompt: '子任务',
      workspacePath: '/tmp/codepapr-subagent-cancel',
      lang: 'zh-CN',
      exec,
      registry,
      provider: {
        name: 'openai',
        models: ['test-model'],
        validate: () => true,
        chat: vi
          .fn<(_: IChatRequest) => Promise<IChatResponse>>()
          .mockImplementation(
            () =>
              new Promise((_resolve, reject) => {
                // 永不返回：子代理挂起直到被取消
                void reject;
              })
          ),
      },
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
      graphToolTimeoutMs: 600_000,
      maxWallClockMs: SUBAGENT_WALL_CLOCK_TIMEOUT_MS,
      ...overrides,
    };
  }

  it('父级 abort 立即取消子代理执行（不再后台烧 token）', async () => {
    const controller = new AbortController();
    const runPromise = runSubagentSession(makeDeps({ abortSignal: controller.signal }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    controller.abort();

    await expect(runPromise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('已 aborted 的父级信号直接拒绝，不启动子代理', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runSubagentSession(makeDeps({ abortSignal: controller.signal }))
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

// 保证类型/导入引用被使用（避免未使用导入告警）
void (null as unknown as IMessage[]);
