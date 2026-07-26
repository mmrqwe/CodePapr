import { describe, expect, it } from 'vitest';
import { effectiveMaxContextTokens } from './contextLimits';

describe('effectiveMaxContextTokens', () => {
  it('keeps 500k for DeepSeek (1M context limit)', () => {
    expect(
      effectiveMaxContextTokens({ maxContextTokens: 500_000, maxTokens: 8_000 }, 'deepseek')
    ).toBe(500_000);
  });

  it('clamps to the provider limit minus the output reserve for smaller providers', () => {
    // OpenAI 128k limit − 8k reserve = 120k.
    expect(
      effectiveMaxContextTokens({ maxContextTokens: 500_000, maxTokens: 8_000 }, 'openai')
    ).toBe(128_000 - 8_000);
    // Claude 200k limit − 8k reserve = 192k.
    expect(
      effectiveMaxContextTokens({ maxContextTokens: 500_000, maxTokens: 8_000 }, 'claude')
    ).toBe(200_000 - 8_000);
  });

  it('respects a user-set value below the provider limit', () => {
    expect(
      effectiveMaxContextTokens({ maxContextTokens: 100_000, maxTokens: 8_000 }, 'deepseek')
    ).toBe(100_000);
  });

  it('never goes below the 1000 floor', () => {
    expect(
      effectiveMaxContextTokens({ maxContextTokens: 500_000, maxTokens: 199_500 }, 'claude')
    ).toBe(1000);
  });
});
