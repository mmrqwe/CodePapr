import { describe, expect, it } from 'vitest';
import { CacheConsistencyError } from '@codepapr/types';
import { CacheValidator } from '../src';

describe('CacheValidator', () => {
  it('rejects request shape drift between build and validation', () => {
    const validator = new CacheValidator();

    expect(() =>
      validator.validate(
        {
          model: 'deepseek-chat',
          messages: [
            {
              id: 'u1',
              role: 'user',
              content: 'hello',
              timestamp: 1,
            },
          ],
          metadata: {
            prefixHash: 'prefix',
            logHash: 'log',
            requestShapeHash: 'wrong-hash',
          },
        },
        {
          id: 'resp-1',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
          },
        },
        'prefix',
        'log'
      )
    ).toThrow(CacheConsistencyError);
  });

  it('includes cache creation tokens in cache hit rate denominator', () => {
    const validator = new CacheValidator();
    const result = validator.validate(
      {
        model: 'deepseek-chat',
        messages: [],
        metadata: {
          prefixHash: 'prefix',
          logHash: 'log',
        },
      },
      {
        id: 'resp-1',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }],
        usage: {
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 30,
          input_tokens: 50,
          output_tokens: 10,
        },
      },
      'prefix',
      'log'
    );

    expect(result.cacheHitRate).toBe(0.3);
  });

  it('prefers official prompt cache hit/miss fields when available', () => {
    const validator = new CacheValidator();
    const result = validator.validate(
      {
        model: 'deepseek-chat',
        messages: [],
        metadata: {
          prefixHash: 'prefix',
          logHash: 'log',
        },
      },
      {
        id: 'resp-official',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }],
        usage: {
          prompt_cache_hit_tokens: 70,
          prompt_cache_miss_tokens: 30,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 999,
          input_tokens: 888,
          output_tokens: 10,
        },
      },
      'prefix',
      'log'
    );

    expect(result.cacheReadTokens).toBe(70);
    expect(result.newInputTokens).toBe(30);
    expect(result.promptCacheHitTokens).toBe(70);
    expect(result.promptCacheMissTokens).toBe(30);
    expect(result.cacheHitRate).toBe(0.7);
  });
});
