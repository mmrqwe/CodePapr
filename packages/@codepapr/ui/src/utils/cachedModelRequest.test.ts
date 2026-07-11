import { describe, expect, it, vi } from 'vitest';
import type { IChatRequest, IChatResponse, ILLMProvider } from '@codepapr/types';
import { runCachedModelRequest } from './cachedModelRequest';

describe('runCachedModelRequest', () => {
  it('routes auxiliary requests through RequestBuilder and returns normalized cache stats', async () => {
    const chat = vi.fn(async (request: IChatRequest): Promise<IChatResponse> => {
      expect(request.metadata?.requestShapeHash).toBeTruthy();
      expect(request.metadata?.prefixHash).toBeTruthy();
      expect(request.messages).toHaveLength(2);
      expect(request.messages[0]?.role).toBe('system');
      expect(request.messages[0]?.content).toBe('Stable auxiliary system prompt');
      expect(request.messages[1]?.role).toBe('user');
      expect(request.messages[1]?.content).toBe('Summarize the latest execution result');

      return {
        id: 'aux-1',
        choices: [
          {
            message: { role: 'assistant', content: 'Rewritten summary' },
            finishReason: 'stop',
          },
        ],
        usage: {
          cache_read_input_tokens: 40,
          cache_creation_input_tokens: 5,
          input_tokens: 15,
          output_tokens: 10,
        },
      };
    });

    const provider: ILLMProvider = {
      name: 'mock',
      models: ['mock-model'],
      chat,
      validate: () => true,
    };

    const result = await runCachedModelRequest({
      provider,
      providerName: 'deepseek',
      model: 'mock-model',
      systemPrompt: 'Stable auxiliary system prompt',
      userPrompt: 'Summarize the latest execution result',
      thinking: { type: 'disabled' },
      temperature: 0.1,
      maxTokens: 256,
      sessionId: 'summary:mock-model',
    });

    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.response.choices[0]?.message.content).toBe('Rewritten summary');
    expect(result.cacheStats).toEqual({
      cacheCreationTokens: 5,
      cacheReadTokens: 40,
      newInputTokens: 15,
      outputTokens: 10,
      cacheHitRate: 40 / 60,
      calls: 1,
      promptCacheHitTokens: undefined,
      promptCacheMissTokens: undefined,
    });
  });
});