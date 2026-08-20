import { describe, expect, it, vi } from 'vitest';
import { Agent, PARALLEL_TOOL_CHUNK_SIZE, type IRequestBuilder, type ICacheValidator } from './Agent';
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

function makeToolDefinition(name: string): IToolDefinition {
  return {
    name,
    description: `${name} 测试工具`,
    parameters: { type: 'object', properties: {} },
  };
}

function buildAgent(opts: {
  provider: ILLMProvider;
  tools: Array<{ def: IToolDefinition; handler: (args: Record<string, unknown>) => unknown }>;
}) {
  const registry = new ToolRegistry();
  for (const tool of opts.tools) {
    registry.register(tool.def, async (args) => tool.handler(args));
  }

  const prefix = new ImmutablePrefix({
    systemPrompt: '测试系统提示词',
    tools: opts.tools.map((tool) => tool.def),
    model: 'test-model',
    parameters: {
      temperature: 0.7,
      topP: 1,
    },
  });

  const log = new AppendOnlyLog('test-session');
  const session = new Session({
    sessionId: 'test-session',
    prefix,
    toolRegistry: registry,
    log,
  });

  const requestBuilder: IRequestBuilder = {
    build: (buildOpts) => {
      const messages = buildOpts.appendLog.getAllMessages().slice();
      const request: IChatRequest = {
        messages,
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
    provider: opts.provider,
    providerName: 'openai',
    requestBuilder,
    cacheValidator,
    maxToolRounds: 10,
  });

  return { agent, log };
}

function responseWithToolCalls(toolCalls: IToolCall[]): IChatResponse {
  return {
    id: 'resp-1',
    choices: [
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls,
        },
        finishReason: 'tool_calls',
      },
    ],
  };
}

const FINAL_RESPONSE: IChatResponse = {
  id: 'resp-final',
  choices: [
    {
      message: { role: 'assistant', content: 'done' },
      finishReason: 'stop',
    },
  ],
};

/** 首轮返回工具调用，之后返回最终文本收尾。 */
function providerWithOneToolRound(toolCalls: IToolCall[]): ILLMProvider {
  let calls = 0;
  return {
    name: 'mock',
    models: ['test-model'],
    validate: () => true,
    chat: vi.fn(async (): Promise<IChatResponse> => {
      calls += 1;
      return calls === 1 ? responseWithToolCalls(toolCalls) : FINAL_RESPONSE;
    }),
  };
}

function readCall(id: string, path: string): IToolCall {
  return { id, name: 'read', arguments: { relativePath: path } };
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!cond()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('Agent parallel tool execution', () => {
  it('executes consecutive parallel-safe calls concurrently', async () => {
    const started: string[] = [];
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const provider = providerWithOneToolRound([
      readCall('call-r1', 'a.txt'),
      readCall('call-r2', 'b.txt'),
    ]);
    const { agent, log } = buildAgent({
      provider,
      tools: [
        {
          def: makeToolDefinition('read'),
          handler: (args) => {
            started.push(args.relativePath as string);
            return gate.then(() => ({ content: args.relativePath }));
          },
        },
      ],
    });

    const chatPromise = agent.chat('用户输入');
    // 两个 read 必须都已启动（并行），而不是第一个完成后才启动第二个
    await waitFor(() => started.length === 2);
    expect(started.sort()).toEqual(['a.txt', 'b.txt']);
    releaseGate();
    await chatPromise;

    const toolMessages = log.getAllMessages().filter((m) => m.role === 'tool');
    expect(toolMessages.map((m) => m.toolResult?.toolCallId)).toEqual(['call-r1', 'call-r2']);
    expect(toolMessages.every((m) => m.toolResult?.success === true)).toBe(true);
  });

  it('emits all start events of a parallel group before any end event', async () => {
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const events: IChatStreamEvent[] = [];

    const provider = providerWithOneToolRound([
      readCall('call-r1', 'a.txt'),
      readCall('call-r2', 'b.txt'),
    ]);
    const { agent } = buildAgent({
      provider,
      tools: [
        {
          def: makeToolDefinition('read'),
          handler: () => gate.then(() => ({ content: 'x' })),
        },
      ],
    });

    const chatPromise = agent.chat('用户输入', (event) => events.push(event));
    await waitFor(() => events.filter((e) => e.type === 'tool-call-start').length === 2);
    releaseGate();
    await chatPromise;

    const startIds = events
      .filter((e): e is Extract<IChatStreamEvent, { type: 'tool-call-start' }> => e.type === 'tool-call-start')
      .map((e) => e.toolCallId);
    const endIds = events
      .filter((e): e is Extract<IChatStreamEvent, { type: 'tool-call-end' }> => e.type === 'tool-call-end')
      .map((e) => e.toolCallId);
    expect(startIds).toEqual(['call-r1', 'call-r2']);
    // end 事件按原始调用顺序落账
    expect(endIds).toEqual(['call-r1', 'call-r2']);
    // 全部 start 先于任何 end
    const firstEndIndex = events.findIndex((e) => e.type === 'tool-call-end');
    const lastStartIndex = events.map((e) => e.type).lastIndexOf('tool-call-start');
    expect(lastStartIndex).toBeLessThan(firstEndIndex);
  });

  it('appends tool messages in original call order when serial tools interleave parallel groups', async () => {
    const provider = providerWithOneToolRound([
      readCall('call-r1', 'a.txt'),
      { id: 'call-w', name: 'write', arguments: { relativePath: 'w.txt', content: 'x' } },
      readCall('call-r2', 'c.txt'),
    ]);
    const { agent, log } = buildAgent({
      provider,
      tools: [
        {
          def: makeToolDefinition('read'),
          handler: (args) => ({ content: args.relativePath }),
        },
        {
          def: makeToolDefinition('write'),
          handler: () => ({ ok: true }),
        },
      ],
    });

    await agent.chat('用户输入');
    const toolMessages = log.getAllMessages().filter((m) => m.role === 'tool');
    expect(toolMessages.map((m) => m.toolResult?.toolCallId)).toEqual([
      'call-r1',
      'call-w',
      'call-r2',
    ]);
  });

  it('keeps non-safe tools strictly serial', async () => {
    const timeline: string[] = [];
    const provider = providerWithOneToolRound([
      { id: 'call-w1', name: 'write', arguments: { relativePath: 'w1.txt', content: 'x' } },
      { id: 'call-w2', name: 'write', arguments: { relativePath: 'w2.txt', content: 'y' } },
    ]);
    const { agent } = buildAgent({
      provider,
      tools: [
        {
          def: makeToolDefinition('write'),
          handler: async (args) => {
            timeline.push(`start:${args.relativePath}`);
            await new Promise((resolve) => setTimeout(resolve, 10));
            timeline.push(`end:${args.relativePath}`);
            return { ok: true };
          },
        },
      ],
    });

    await agent.chat('用户输入');
    expect(timeline).toEqual([
      'start:w1.txt',
      'end:w1.txt',
      'start:w2.txt',
      'end:w2.txt',
    ]);
  });

  it('caps concurrency of a parallel group at PARALLEL_TOOL_CHUNK_SIZE', async () => {
    const totalCalls = PARALLEL_TOOL_CHUNK_SIZE + 2;
    const calls = Array.from({ length: totalCalls }, (_, index) =>
      readCall(`call-r${index}`, `f${index}.txt`)
    );
    let active = 0;
    let peak = 0;

    const provider = providerWithOneToolRound(calls);
    const { agent, log } = buildAgent({
      provider,
      tools: [
        {
          def: makeToolDefinition('read'),
          handler: async () => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 15));
            active -= 1;
            return { content: 'x' };
          },
        },
      ],
    });

    await agent.chat('用户输入');
    expect(peak).toBe(PARALLEL_TOOL_CHUNK_SIZE);
    const toolMessages = log.getAllMessages().filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(totalCalls);
    // 落账顺序 = 原始调用顺序
    expect(toolMessages.map((m) => m.toolResult?.toolCallId)).toEqual(
      calls.map((call) => call.id)
    );
  });

  it('still short-circuits on question after a parallel group and placeholders the skipped calls', async () => {
    let tailReadExecuted = false;
    const provider = providerWithOneToolRound([
      readCall('call-r1', 'a.txt'),
      readCall('call-r2', 'b.txt'),
      { id: 'call-q', name: 'question', arguments: { question: '继续吗？', header: '确认' } },
      readCall('call-r3', 'c.txt'),
    ]);
    const { agent, log } = buildAgent({
      provider,
      tools: [
        {
          def: makeToolDefinition('read'),
          handler: (args) => {
            if (args.relativePath === 'c.txt') tailReadExecuted = true;
            return { content: 'x' };
          },
        },
        {
          def: makeToolDefinition('question'),
          handler: () => ({
            __question: true,
            question: '继续吗？',
            header: '确认',
          }),
        },
      ],
    });

    const result = await agent.chat('用户输入');
    expect(result.question?.question).toBe('继续吗？');
    expect(tailReadExecuted).toBe(false);

    const toolMessages = log.getAllMessages().filter((m) => m.role === 'tool');
    expect(toolMessages.map((m) => m.toolResult?.toolCallId)).toEqual([
      'call-r1',
      'call-r2',
      'call-q',
      'call-r3',
    ]);
    const skipped = toolMessages[3];
    expect(skipped.toolResult?.success).toBe(false);
    expect(skipped.content).toContain('被跳过');
  });

  it('aborts in-flight parallel calls without hanging and records them as failed', async () => {
    const started: string[] = [];
    const controller = new AbortController();
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const provider = providerWithOneToolRound([
      readCall('call-r1', 'a.txt'),
      readCall('call-r2', 'b.txt'),
    ]);
    const { agent, log } = buildAgent({
      provider,
      tools: [
        {
          def: makeToolDefinition('read'),
          handler: (args) => {
            started.push(args.relativePath as string);
            return gate.then(() => ({ content: 'x' }));
          },
        },
      ],
    });

    const chatPromise = agent.chat('用户输入', undefined, undefined, controller.signal);
    await waitFor(() => started.length === 2);
    controller.abort();
    // 放行 gate 确保不是因为 handler 卡住才结束——中止必须独立生效
    releaseGate();
    const result = await chatPromise;

    expect(result.content).toBe('');
    const toolMessages = log.getAllMessages().filter((m) => m.role === 'tool');
    expect(toolMessages.map((m) => m.toolResult?.toolCallId)).toEqual(['call-r1', 'call-r2']);
    expect(toolMessages.every((m) => m.toolResult?.success === false)).toBe(true);
    // provider 只被调用一轮：中止后不再进入下一轮
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it('executes consecutive task calls concurrently', async () => {
    const started: string[] = [];
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const events: IChatStreamEvent[] = [];

    const provider = providerWithOneToolRound([
      { id: 'call-t1', name: 'task', arguments: { agent: 'explore', prompt: 'a' } },
      { id: 'call-t2', name: 'task', arguments: { agent: 'scout', prompt: 'b' } },
    ]);
    const { agent } = buildAgent({
      provider,
      tools: [
        {
          def: makeToolDefinition('task'),
          handler: (args) => {
            started.push(args.agent as string);
            return gate.then(() => ({ agent: args.agent, content: 'ok' }));
          },
        },
      ],
    });

    const chatPromise = agent.chat('用户输入', (event) => events.push(event));
    await waitFor(() => started.length === 2);
    expect(started.sort()).toEqual(['explore', 'scout']);
    const startCount = events.filter((e) => e.type === 'tool-call-start').length;
    expect(startCount).toBe(2);
    expect(events.some((e) => e.type === 'tool-call-end')).toBe(false);
    releaseGate();
    await chatPromise;
  });

  it('keeps write serial when adjacent to task', async () => {
    const timeline: string[] = [];
    const provider = providerWithOneToolRound([
      { id: 'call-w', name: 'write', arguments: { relativePath: 'a.txt' } },
      { id: 'call-t', name: 'task', arguments: { agent: 'explore', prompt: 'x' } },
    ]);
    const { agent } = buildAgent({
      provider,
      tools: [
        {
          def: makeToolDefinition('write'),
          handler: async () => {
            timeline.push('start:write');
            await new Promise((resolve) => setTimeout(resolve, 10));
            timeline.push('end:write');
            return { ok: true };
          },
        },
        {
          def: makeToolDefinition('task'),
          handler: async () => {
            timeline.push('start:task');
            await new Promise((resolve) => setTimeout(resolve, 10));
            timeline.push('end:task');
            return { content: 'ok' };
          },
        },
      ],
    });

    await agent.chat('用户输入');
    expect(timeline).toEqual(['start:write', 'end:write', 'start:task', 'end:task']);
  });

  it('still short-circuits on question after a task group', async () => {
    let tailTaskExecuted = false;
    const provider = providerWithOneToolRound([
      { id: 'call-t1', name: 'task', arguments: { agent: 'explore', prompt: 'a' } },
      { id: 'call-q', name: 'question', arguments: { question: '继续吗？', header: '确认' } },
      { id: 'call-t2', name: 'task', arguments: { agent: 'scout', prompt: 'b' } },
    ]);
    const { agent } = buildAgent({
      provider,
      tools: [
        {
          def: makeToolDefinition('task'),
          handler: (args) => {
            if (args.agent === 'scout') tailTaskExecuted = true;
            return { content: 'ok' };
          },
        },
        {
          def: makeToolDefinition('question'),
          handler: () => ({
            __question: true,
            question: '继续吗？',
            header: '确认',
          }),
        },
      ],
    });

    const result = await agent.chat('用户输入');
    expect(result.question?.question).toBe('继续吗？');
    expect(tailTaskExecuted).toBe(false);
  });
});
