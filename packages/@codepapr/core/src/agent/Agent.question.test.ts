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

  return agent;
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

describe('Agent question tool flow', () => {
  it('captures __question from the question tool result and returns QuestionData', async () => {
    const questionCall: IToolCall = {
      id: 'call-q',
      name: 'question',
      arguments: {
        question: '确认技术栈？',
        header: '技术栈',
        options: [{ label: 'rust+tauri' }, { label: 'react+vite' }],
      },
    };

    const provider: ILLMProvider = {
      name: 'mock',
      models: ['test-model'],
      validate: () => true,
      chat: vi.fn(async () => responseWithToolCalls([questionCall])),
    };

    const agent = buildAgent({
      provider,
      tools: [
        {
          def: makeToolDefinition('question'),
          handler: () => ({
            __question: true,
            question: '确认技术栈？',
            header: '技术栈',
            options: [{ label: 'rust+tauri' }, { label: 'react+vite' }],
            multiple: false,
          }),
        },
      ],
    });

    const result = await agent.chat('用户输入');
    expect(result.question).toMatchObject({
      question: '确认技术栈？',
      header: '技术栈',
      options: [{ label: 'rust+tauri' }, { label: 'react+vite' }],
    });
    // 提问后应终止工具循环，不再进入下一轮
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it('breaks the round immediately when question is asked, skipping later tool calls', async () => {
    const questionCall: IToolCall = {
      id: 'call-q',
      name: 'question',
      arguments: { question: '要修改文件吗？', header: '确认' },
    };
    const writeCall: IToolCall = {
      id: 'call-w',
      name: 'write',
      arguments: { relativePath: 'a.txt', content: 'x' },
    };

    const provider: ILLMProvider = {
      name: 'mock',
      models: ['test-model'],
      validate: () => true,
      chat: vi.fn(async (): Promise<IChatResponse> => ({
        id: 'resp-1',
        choices: [
          {
            message: { role: 'assistant', content: '', toolCalls: [questionCall, writeCall] },
            finishReason: 'tool_calls',
          },
        ],
      })),
    };

    let writeExecuted = false;
    const agent = buildAgent({
      provider,
      tools: [
        {
          def: makeToolDefinition('question'),
          handler: () => ({
            __question: true,
            question: '要修改文件吗？',
            header: '确认',
          }),
        },
        {
          def: makeToolDefinition('write'),
          handler: () => {
            writeExecuted = true;
            return { ok: true };
          },
        },
      ],
    });

    const result = await agent.chat('用户输入');
    expect(result.question).toBeDefined();
    // question 一旦出现，同一轮里排在后面的 write 不得执行
    expect(writeExecuted).toBe(false);
  });

  it('still executes tools that appear before the question call in the same round', async () => {
    const readCall: IToolCall = {
      id: 'call-r',
      name: 'read',
      arguments: { relativePath: 'a.txt' },
    };
    const questionCall: IToolCall = {
      id: 'call-q',
      name: 'question',
      arguments: { question: '继续吗？', header: '确认' },
    };

    const provider: ILLMProvider = {
      name: 'mock',
      models: ['test-model'],
      validate: () => true,
      chat: vi.fn(async (): Promise<IChatResponse> => ({
        id: 'resp-1',
        choices: [
          {
            message: { role: 'assistant', content: '', toolCalls: [readCall, questionCall] },
            finishReason: 'tool_calls',
          },
        ],
      })),
    };

    let readExecuted = false;
    const agent = buildAgent({
      provider,
      tools: [
        {
          def: makeToolDefinition('read'),
          handler: () => {
            readExecuted = true;
            return { content: 'file content' };
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
    expect(readExecuted).toBe(true);
    expect(result.question?.question).toBe('继续吗？');
  });
});
