import { describe, expect, it, vi } from 'vitest';
import { ResponseProvider } from '@codepapr/api';
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
  it.each([true, false])('sends a valid GPT-6 Luna payload with thinking=%s', async (thinkingEnabled) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hi' }] }],
    }));
    const provider = new ResponseProvider({ apiKey: 'test-key', fetchFn });

    await runConnectionTest(provider, {
      model: 'gpt-6-luna',
      providerName: 'response',
      thinkingEnabled,
      reasoningEffort: 'high',
      thinkingBudgetTokens: 4096,
      thinkingPayload: 'both',
    });

    const payload = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    expect(payload).not.toHaveProperty('thinking');
    expect(payload.reasoning).toEqual(thinkingEnabled ? { effort: 'high', summary: 'auto' } : { effort: 'none' });
    if (thinkingEnabled) {
      expect(payload).not.toHaveProperty('temperature');
      expect(payload).not.toHaveProperty('top_p');
    } else {
      expect(payload).toMatchObject({ temperature: 0.3, top_p: 0.9 });
    }
  });

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
