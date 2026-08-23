import { describe, it, expect } from 'vitest';
import {
  ImmutablePrefix,
  ToolRegistry,
  Session,
  Agent,
} from '@codepapr/core';
import { RequestBuilder, CacheValidator } from '../src';
import type { ILLMProvider, IChatRequest, IChatResponse } from '@codepapr/types';

/**
 * Mock provider: 模拟 DeepSeek 缓存命中场景
 */
class MockProvider implements ILLMProvider {
  name = 'mock';
  models = ['mock-model'];
  callCount = 0;
  lastRequest?: IChatRequest;

  async chat(req: IChatRequest): Promise<IChatResponse> {
    this.callCount++;
    this.lastRequest = req;
    // 首轮 cache create，后续 cache read
    const isFirst = this.callCount === 1;
    return {
      id: `r${this.callCount}`,
      choices: [
        {
          message: { role: 'assistant', content: `回复 #${this.callCount}` },
          finishReason: 'stop',
        },
      ],
      usage: {
        cache_creation_input_tokens: isFirst ? 100 : 0,
        cache_read_input_tokens: isFirst ? 0 : 100,
        input_tokens: 10,
        output_tokens: 20,
      },
    };
  }

  validate(): boolean {
    return true;
  }
}

describe('E2E: Agent 多轮对话 + 缓存一致性', () => {
  it('多轮对话保持 prefix hash 不变 + 缓存命中', async () => {
    const prefix = new ImmutablePrefix({
      systemPrompt: '你是一个助手',
      tools: [],
      model: 'mock-model',
      parameters: { temperature: 0.7, topP: 0.9, maxTokens: 100 },
    });
    const prefixHashBefore = prefix.computeHash();

    const toolRegistry = new ToolRegistry();
    const session = new Session({ sessionId: 'test-1', prefix, toolRegistry });
    const mock = new MockProvider();
    const agent = new Agent({
      session,
      provider: mock,
      providerName: 'deepseek',
      requestBuilder: new RequestBuilder(),
      cacheValidator: new CacheValidator(),
    });

    const r1 = await agent.chat('你好');
    expect(r1.content).toBe('回复 #1');
    expect(r1.cacheStats?.cacheCreationTokens).toBe(100);
    expect(r1.cacheStats?.cacheReadTokens).toBe(0);

    const r2 = await agent.chat('再问一题');
    expect(r2.cacheStats?.cacheReadTokens).toBe(100);
    expect((r2.cacheStats?.cacheHitRate ?? 0) > 0.5).toBe(true);

    const r3 = await agent.chat('继续');
    expect(r3.cacheStats?.cacheReadTokens).toBe(100);

    // prefix hash 不变
    expect(prefix.computeHash()).toBe(prefixHashBefore);
    // log 长度增加 (每轮 user + assistant)
    expect(session.logStore.length()).toBe(6);
    // append-only 校验
    expect(session.logStore.validate()).toBe(true);
  });

  it('工具调用流程: assistant 请求工具 → 执行 → 追加结果', async () => {
    const prefix = new ImmutablePrefix({
      systemPrompt: '助手',
      tools: [
        { name: 'add', description: 'add', parameters: { type: 'object', properties: {} } },
      ],
      model: 'mock-model',
      parameters: { temperature: 0.7, topP: 0.9, maxTokens: 100 },
    });
    const reg = new ToolRegistry();
    reg.register(
      { name: 'add', description: 'add', parameters: { type: 'object', properties: {} } },
      async () => ({ sum: 42 })
    );

    let round = 0;
    const provider: ILLMProvider = {
      name: 'mock',
      models: ['mock-model'],
      async chat(): Promise<IChatResponse> {
        round++;
        if (round === 1) {
          return {
            id: 'r1',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '',
                  toolCalls: [{ id: 'c1', name: 'add', arguments: { a: 1, b: 2 } }],
                },
                finishReason: 'tool_calls',
              },
            ],
            usage: { input_tokens: 5, output_tokens: 5 },
          };
        }
        return {
          id: 'r2',
          choices: [{ message: { role: 'assistant', content: '结果是 42' }, finishReason: 'stop' }],
          usage: { input_tokens: 5, output_tokens: 5 },
        };
      },
      validate: () => true,
    };

    const session = new Session({ sessionId: 't2', prefix, toolRegistry: reg });
    const agent = new Agent({
      session,
      provider,
      providerName: 'deepseek',
      requestBuilder: new RequestBuilder(),
      cacheValidator: new CacheValidator(),
    });

    const events: string[] = [];
    const res = await agent.chat('帮我加 1 和 2', (event) => {
      if (event.type === 'tool-call-start') {
        events.push(`start:${event.toolName}`);
      }
      if (event.type === 'tool-call-end') {
        events.push(`end:${event.toolName}:${event.success ? 'ok' : 'error'}`);
      }
    });
    expect(res.content).toBe('结果是 42');
    expect(events).toEqual(['start:add', 'end:add:ok']);
    // user + assistant(tool_call) + tool(result) + assistant(final) = 4
    expect(session.logStore.length()).toBe(4);
    const msgs = session.logStore.getAllMessages();
    expect(msgs[2]?.role).toBe('tool');
  });

  it('DeepSeek 思考模式会在多轮中保留 reasoning_content', async () => {
    const prefix = new ImmutablePrefix({
      systemPrompt: '你是一个会思考的助手',
      tools: [],
      model: 'deepseek-v4-pro',
      parameters: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 100,
        thinkingEnabled: true,
      },
    });

    let round = 0;
    const provider: ILLMProvider = {
      name: 'mock',
      models: ['deepseek-v4-pro'],
      async chat(req): Promise<IChatResponse> {
        round++;
        expect(req.thinking?.type).toBe('enabled');

        if (round === 1) {
          return {
            id: 'reasoning-1',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '第一次回答',
                  reasoningContent: '第一次思考',
                },
                finishReason: 'stop',
              },
            ],
            usage: { input_tokens: 10, output_tokens: 20 },
          };
        }

        expect(
          req.messages.some(
            (message) =>
              message.role === 'assistant' &&
              message.reasoningContent === '第一次思考'
          )
        ).toBe(true);

        return {
          id: 'reasoning-2',
          choices: [
            {
              message: {
                role: 'assistant',
                content: '第二次回答',
                reasoningContent: '第二次思考',
              },
              finishReason: 'stop',
            },
          ],
          usage: { input_tokens: 10, output_tokens: 20 },
        };
      },
      validate: () => true,
    };

    const session = new Session({
      sessionId: 'reasoning-test',
      prefix,
      toolRegistry: new ToolRegistry(),
    });
    const agent = new Agent({
      session,
      provider,
      providerName: 'deepseek',
      requestBuilder: new RequestBuilder(),
      cacheValidator: new CacheValidator(),
    });

    const first = await agent.chat('第一问');
    expect(first.reasoningContent).toBe('第一次思考');

    const second = await agent.chat('第二问');
    expect(second.reasoningContent).toBe('第二次思考');
  });
});
