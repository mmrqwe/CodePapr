/**
 * 预算估算的「上线口径」回归：工具截图只随消费它的那一次请求发送，历史里留下的
 * base64 不得再计入上下文预算。旧实现按 log 全量字节/4 估算，两三张截图就"超"
 * 过 200K 预算 → 每一轮都触发压缩 → 压缩看不见图片、纸面缩容通过、下一轮继续
 * 压缩（实测 2.7 小时 31 次，每次毁掉一个上下文纪元与模型的计划）。
 */
import { describe, expect, it, vi } from 'vitest';
import type { IChatRequest, IChatResponse, IChatStreamEvent, ILLMProvider } from '@codepapr/types';
import {
  Agent,
  ImmutablePrefix,
  Session,
  ToolRegistry,
  type ContextCompactionConfig,
} from '../src';

const SCREENSHOT_BASE64 = 'iVBORw0KGgo'.repeat(40_000); // ~360KB，相当于一张 PNG 截图

function createResponse(
  content: string,
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
  usage?: { input_tokens: number; cache_read_input_tokens?: number }
): IChatResponse {
  return {
    id: 'resp',
    choices: [
      {
        message: { role: 'assistant', content, ...(toolCalls ? { toolCalls } : {}) },
        finishReason: 'stop',
      },
    ],
    usage: { output_tokens: 10, input_tokens: 1_000, ...(usage ?? {})},
  };
}

function createAgent(
  handler: ContextCompactionConfig['handler'],
  maxContextTokens: number,
  usage?: { input_tokens: number; cache_read_input_tokens?: number }
) {
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(
    {
      name: 'screenshot',
      description: 'Take a screenshot',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    async () => ({
      ok: true,
      __images: [{ mediaType: 'image/png', data: SCREENSHOT_BASE64, path: '.CodePapr/screenshots/a.png' }],
    })
  );

  const provider: ILLMProvider = {
    name: 'openai',
    models: ['test-model'],
    validate: () => true,
    chat: vi
      .fn<(_: IChatRequest) => Promise<IChatResponse>>()
      .mockResolvedValueOnce(createResponse('第一轮', [{ id: 's1', name: 'screenshot', arguments: {} }], usage))
      .mockResolvedValueOnce(createResponse('第二轮', [{ id: 's2', name: 'screenshot', arguments: {} }], usage))
      .mockResolvedValueOnce(createResponse('第三轮', [{ id: 's3', name: 'screenshot', arguments: {} }], usage))
      .mockResolvedValueOnce(createResponse('最终答案', undefined, usage)),
  };

  const agent = new Agent({
    session: new Session({
      sessionId: 'image-budget-session',
      prefix: new ImmutablePrefix({
        systemPrompt: '你是测试助手',
        tools: toolRegistry.getAll(),
        model: 'test-model',
        parameters: { temperature: 0.7, topP: 0.9, maxTokens: 100 },
      }),
      toolRegistry,
    }),
    provider,
    providerName: 'openai',
    requestBuilder: { build: ({ model }) => ({ model, messages: [] }), resetLogTracking: () => undefined },
    cacheValidator: {
      validate: () => ({
        prefixCached: false,
        prefixCreated: false,
        cacheReadTokens: 30_000,
        cacheCreationTokens: 0,
        newInputTokens: 1_000,
        outputTokens: 10,
        cacheHitRate: 0.9,
      }),
    },
    contextCompaction: {
      maxContextTokens,
      softMaxTokens: Math.floor(maxContextTokens * 0.7),
      handler,
    },
  });
  return { agent };
}

describe('Agent：截图不再把预算撑爆', () => {
  it('连续三轮 screenshot（log 里 ~1MB 死 base64）不触发压缩', async () => {
    const handler = vi.fn();
    const { agent } = createAgent(handler, 200_000);
    const events: IChatStreamEvent[] = [];
    await agent.chat('看看渲染效果', (e) => events.push(e));

    expect(handler).not.toHaveBeenCalled();
    // 历史里确实留着已经不再上线的 base64（旧口径正是把它当上下文）
    const messages = agent.getSession().logStore.getAllMessages();
    const imageMessages = messages.filter((m) => (m.images?.length ?? 0) > 0);
    expect(imageMessages.length).toBe(3);
    expect(agent.getSession().logStore.getContentBytes()).toBeGreaterThan(1_000_000);
    expect(agent.getSession().logStore.getWireFootprint().wireBytes).toBeLessThan(20_000);
  });
});

describe('Agent：压缩熔断（不再空转）', () => {
  it('连续两次压缩没有实际缩容后停止尝试并发事件', async () => {
    // handler 永远返回一份比当前 log 更大的"摘要"：纸面压缩成功、实际没缩容。
    const handler = vi.fn().mockResolvedValue({
      messages: [
        {
          id: 'summary',
          role: 'assistant' as const,
          content: 'x'.repeat(400_000),
          timestamp: 1,
        },
      ],
    });
    const { agent } = createAgent(handler, 1_000);
    const events: IChatStreamEvent[] = [];
    await agent.chat('看看渲染效果', (e) => events.push(e));

    const blocked = events.filter((e) => e.type === 'context-compaction-blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ reason: 'no-effective-shrink' });
    // 熔断后不再空试：调用次数被钉在阈值上（此前每轮都会试一次，直到回合结束）
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe('Agent：provider 实测对账（含缓存读取量，且工具轮后仍生效）', () => {
  it('真实入站量 = input_tokens + cache read：5K 总量不压缩（不把缓存量当噪声）', async () => {
    const handler = vi.fn();
    const { agent } = createAgent(handler, 20_000, {
      input_tokens: 1_000,
      cache_read_input_tokens: 4_000,
    });
    await agent.chat('看看渲染效果');
    expect(handler).not.toHaveBeenCalled();
  });

  it('实测总量超预算时逐轮压缩（工具轮追加消息不再让实测失效）', async () => {
    const handler = vi.fn().mockResolvedValue({
      messages: [{ id: 'summary', role: 'assistant' as const, content: '压缩后的摘要', timestamp: 1 }],
    });
    const { agent } = createAgent(handler, 20_000, {
      input_tokens: 1_000,
      cache_read_input_tokens: 35_000,
    });
    const events: IChatStreamEvent[] = [];
    await agent.chat('看看渲染效果', (e) => events.push(e));
    // 真实上下文 = 1K 新输入 + 35K 缓存读取 = 36K，远超 20K 硬预算，而 heuristic
    // （log 很小）完全看不出超限。旧实现 log 一变就放弃实测 → 永不压缩。
    // round1 / round2 各压缩一次：压缩后实测清空，下一次请求又带回实测 → 再压缩
    expect(handler.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(events.filter((e) => e.type === 'context-compacted').length).toBeGreaterThanOrEqual(2);
  });
});
