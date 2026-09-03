export type ContextProvider = 'deepseek' | 'openai' | 'claude' | 'response';

/** 与 settings 默认值对齐；NaN / Infinity 时回退到此值。 */
export const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;

/**
 * 上下文压缩/中途溢出共用的"有效上下文阈值"。
 *
 * 统一采用用户设定的 maxContextTokens（默认 200k），不再按服务商硬上限钳制：
 * OpenAI/Claude 兼容端点常是转发网关（如 OpenAI 网关转发 DeepSeek），实际
 * 可用上下文可能远大于服务商名义上限，钳制会导致长任务频繁触发压缩。上限
 * 由用户对该配置项的取值负责（设置 → 高级 → 最大上下文(输入)）。
 */
export function effectiveMaxContextTokens(
  settings: { maxContextTokens: number },
  _provider?: ContextProvider
): number {
  const raw = settings.maxContextTokens;
  if (!Number.isFinite(raw)) {
    return DEFAULT_MAX_CONTEXT_TOKENS;
  }
  return Math.max(1000, Math.floor(raw));
}
