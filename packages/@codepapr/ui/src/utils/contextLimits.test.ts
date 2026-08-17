import { describe, expect, it } from 'vitest';
import { effectiveMaxContextTokens } from './contextLimits';

describe('effectiveMaxContextTokens', () => {
  it('uses the user-set value for every provider (no provider clamping)', () => {
    expect(
      effectiveMaxContextTokens({ maxContextTokens: 500_000 }, 'deepseek')
    ).toBe(500_000);
    expect(
      effectiveMaxContextTokens({ maxContextTokens: 500_000 }, 'openai')
    ).toBe(500_000);
    expect(
      effectiveMaxContextTokens({ maxContextTokens: 500_000 }, 'claude')
    ).toBe(500_000);
  });

  it('respects smaller user-set values', () => {
    expect(
      effectiveMaxContextTokens({ maxContextTokens: 100_000 }, 'openai')
    ).toBe(100_000);
  });

  it('works without an explicit provider', () => {
    expect(effectiveMaxContextTokens({ maxContextTokens: 200_000 })).toBe(200_000);
  });

  it('never goes below the 1000 floor', () => {
    expect(effectiveMaxContextTokens({ maxContextTokens: 500 }, 'claude')).toBe(1000);
  });

  it('falls back to the 500k default for NaN and Infinity', () => {
    expect(effectiveMaxContextTokens({ maxContextTokens: Number.NaN })).toBe(500_000);
    expect(effectiveMaxContextTokens({ maxContextTokens: Number.POSITIVE_INFINITY })).toBe(500_000);
    expect(effectiveMaxContextTokens({ maxContextTokens: Number.NEGATIVE_INFINITY })).toBe(500_000);
  });
});
