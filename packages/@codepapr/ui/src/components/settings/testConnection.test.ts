import { describe, expect, it, vi } from 'vitest';
import type { IChatRequest, IChatResponse, ILLMProvider } from '@codepapr/api';
import { CONNECTION_TEST_MAX_TOKENS, runConnectionTest } from './testConnection';

function mockProvider(chat: (req: IChatRequest) => Promise<IChatResponse>): ILLMProvider {
  return {
    name: 'openai',
    models: ['test-model'],
    validate: () => true,
    chat: chat as ILLMProvider['chat'],
  };
}

function okResponse(): IChatResponse {
  return {
    id: 'resp',
    choices: [
      {
        message: { role: 'assistant', content: 'ok' },
        finishReason: 'stop',
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

describe('runConnectionTest', () => {
  it('发极简请求且 maxTokens 足够大以携带 thinking（Claude 预算约束）', async () => {
    const chat = vi.fn<(_: IChatRequest) => Promise<IChatResponse>>().mockResolvedValue(okResponse());
    await runConnectionTest(mockProvider(chat), {
      model: 'test-model',
      providerName: 'openai',
      thinkingEnabled: false,
      reasoningEffort: '',
      thinkingBudgetTokens: 0,
    });

    const request = chat.mock.calls[0]?.[0] as IChatRequest;
    expect(request.model).toBe('test-model');
    expect(request.maxTokens).toBe(CONNECTION_TEST_MAX_TOKENS);
    expect(request.thinking).toBeUndefined();
  });

  it('开启思考时带上 reasoningEffort（任意值透传）', async () => {
    const chat = vi.fn<(_: IChatRequest) => Promise<IChatResponse>>().mockResolvedValue(okResponse());
    await runConnectionTest(mockProvider(chat), {
      model: 'test-model',
      providerName: 'openai',
      thinkingEnabled: true,
      reasoningEffort: 'xhigh',
      thinkingBudgetTokens: 0,
    });

    const request = chat.mock.calls[0]?.[0] as IChatRequest;
    expect(request.thinking).toEqual({ type: 'enabled', payload: 'reasoning', reasoningEffort: 'xhigh' });
  });

  it('claude 提供者开启思考时带上 budgetTokens', async () => {
    const chat = vi.fn<(_: IChatRequest) => Promise<IChatResponse>>().mockResolvedValue(okResponse());
    await runConnectionTest(mockProvider(chat), {
      model: 'test-model',
      providerName: 'claude',
      thinkingEnabled: true,
      reasoningEffort: '',
      thinkingBudgetTokens: 8000,
    });

    const request = chat.mock.calls[0]?.[0] as IChatRequest;
    expect(request.thinking).toEqual({ type: 'enabled', payload: 'reasoning', budgetTokens: 8000 });
  });

  it('deepseek 关闭思考时显式 disabled（省略字段会默认开思考）', async () => {
    const chat = vi.fn<(_: IChatRequest) => Promise<IChatResponse>>().mockResolvedValue(okResponse());
    await runConnectionTest(mockProvider(chat), {
      model: 'test-model',
      providerName: 'deepseek',
      thinkingEnabled: false,
      reasoningEffort: '',
      thinkingBudgetTokens: 0,
    });

    const request = chat.mock.calls[0]?.[0] as IChatRequest;
    expect(request.thinking).toEqual({ type: 'disabled' });
  });

  it('thinkingPayload 透传到 buildThinking', async () => {
    const chat = vi.fn<(_: IChatRequest) => Promise<IChatResponse>>().mockResolvedValue(okResponse());
    await runConnectionTest(mockProvider(chat), {
      model: 'test-model',
      providerName: 'response',
      thinkingEnabled: true,
      reasoningEffort: 'max',
      thinkingBudgetTokens: 0,
      thinkingPayload: 'both',
    });

    const request = chat.mock.calls[0]?.[0] as IChatRequest;
    expect(request.thinking).toEqual({
      type: 'enabled',
      payload: 'both',
      reasoningEffort: 'max',
    });
  });

  it('provider 抛错时原样向上传播', async () => {
    const chat = vi
      .fn<(_: IChatRequest) => Promise<IChatResponse>>()
      .mockRejectedValue(new Error('Invalid reasoning_effort value'));
    await expect(
      runConnectionTest(mockProvider(chat), {
        model: 'test-model',
        providerName: 'openai',
        thinkingEnabled: true,
        reasoningEffort: 'xhigh',
        thinkingBudgetTokens: 0,
      }),
    ).rejects.toThrow('Invalid reasoning_effort value');
  });
});
