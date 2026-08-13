export const DEFAULT_MAX_TOKENS = 200_000;
export const DEEPSEEK_MAX_TOKENS = 200_000;
/** Anthropic 现役旗舰模型最大输出上限；超出即 400。旧实现对 claude 不钳制，
 *  默认 maxTokens=200000 原样下发，新用户切到 claude 格式后每个请求都 400。 */
export const CLAUDE_MAX_OUTPUT_TOKENS = 64_000;
/** OpenAI 主流聊天模型的安全输出上限（与设置面板滑块上限一致）。
 *  o 系列支持更高，但 32K 对全部聊天模型合法，避免默认 200K 必然 400。 */
export const OPENAI_MAX_OUTPUT_TOKENS = 32_000;

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
  switch (provider) {
    case 'deepseek':
      return DEEPSEEK_MAX_TOKENS;
    case 'claude':
      return CLAUDE_MAX_OUTPUT_TOKENS;
    case 'openai':
      return OPENAI_MAX_OUTPUT_TOKENS;
    default:
      return null;
  }
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
