export const DEFAULT_MAX_TOKENS = 36_000;
export const DEEPSEEK_MAX_TOKENS = 100_000;
export const DEEPSEEK_DEFAULT_MAX_TOKENS = 100_000;
export const DEFAULT_MAX_CONTEXT_TOKENS = 220_000;
export const DEEPSEEK_DEFAULT_MAX_CONTEXT_TOKENS = 500_000;

export const CONTEXT_LIMITS: Record<string, number> = {
  deepseek: 500_000,
  claude: 220_000,
  openai: 220_000,
  response: 220_000,
};

export function getProviderContextLimit(provider: string): number {
  return CONTEXT_LIMITS[provider] ?? DEFAULT_MAX_CONTEXT_TOKENS;
}

/**
 * 不做任何人为上限钳制，由用户和具体 Model Profile / API 端点自主决定。
 */
export function getProviderMaxTokensLimit(
  _provider?: string
): number | null {
  return null;
}

/**
 * 校验 maxTokens，保证为正整数。不做任何人为上限钳制，完全尊重用户与服务端配置。
 */
export function sanitizeMaxTokens(
  value: unknown,
  provider?: string,
  fallback?: number
): number {
  const defaultFallback = provider === 'deepseek' ? DEEPSEEK_DEFAULT_MAX_TOKENS : DEFAULT_MAX_TOKENS;
  const safeFallback = Number.isFinite(fallback) ? Math.max(1, Math.floor(fallback!)) : defaultFallback;
  const normalized =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : Number.NaN;

  const baseValue = Number.isFinite(normalized) ? Math.floor(normalized) : safeFallback;
  return Math.max(1, baseValue);
}
