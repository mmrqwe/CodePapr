import { getProviderContextLimit, sanitizeMaxTokens } from '@codepapr/api';

export type ContextProvider = 'deepseek' | 'openai' | 'claude';

/**
 * 上下文压缩/中途溢出共用的"有效上下文阈值"。
 *
 * 用户设定的 maxContextTokens（默认 500k，针对 DeepSeek 1M 上下文）会被钳制到
 * 所选服务商的上下文硬上限减去输出预留（maxTokens），防止在 Claude(200k)/
 * OpenAI(128k) 等较小上下文的服务商上压缩赶不上上限而导致请求超限 400。
 *
 * - DeepSeek：min(500k, 1M − maxTokens) = 500k
 * - Claude  ：min(500k, 200k − maxTokens) ≈ 200k
 * - OpenAI  ：min(500k, 128k − maxTokens) ≈ 128k
 */
export function effectiveMaxContextTokens(
  settings: { maxContextTokens: number; maxTokens: number },
  provider: ContextProvider
): number {
  const providerLimit = getProviderContextLimit(provider);
  const reserve = sanitizeMaxTokens(settings.maxTokens, provider);
  return Math.max(1000, Math.min(settings.maxContextTokens, providerLimit - reserve));
}
