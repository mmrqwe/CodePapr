export const DEFAULT_MAX_TOKENS = 393_216;
export const DEEPSEEK_MAX_TOKENS = 393_216;

export const CONTEXT_LIMITS: Record<string, number> = {
  deepseek: 1_048_565,
  claude: 200_000,
  openai: 128_000,
};

export function getProviderContextLimit(provider: string): number {
  return CONTEXT_LIMITS[provider] ?? 200_000;
}

export function getProviderMaxTokensLimit(
  provider: 'deepseek' | 'openai' | 'claude'
): number | null {
  return provider === 'deepseek' ? DEEPSEEK_MAX_TOKENS : null;
}

export function sanitizeMaxTokens(
  value: unknown,
  provider: 'deepseek' | 'openai' | 'claude',
  fallback: number = DEFAULT_MAX_TOKENS
): number {
  const normalized =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : Number.NaN;

  const safeFallback = Number.isFinite(fallback) ? Math.max(1, Math.floor(fallback)) : DEFAULT_MAX_TOKENS;
  const baseValue = Number.isFinite(normalized) ? Math.floor(normalized) : safeFallback;
  const boundedMin = Math.max(1, baseValue);
  const limit = getProviderMaxTokensLimit(provider);

  return limit === null ? boundedMin : Math.min(limit, boundedMin);
}
