/**
 * CodePapr API: LLM 提供商适配 + 请求/响应处理
 */

// Providers
export { BaseLLMProvider, ProviderRequestError, setGlobalFetchFn, getGlobalFetchFn } from './providers/ILLMProvider';
export type { ProviderConfig } from './providers/ILLMProvider';
export { DeepSeekProvider } from './providers/DeepSeekProvider';
export { OpenAIProvider } from './providers/OpenAIProvider';
export { ClaudeProvider } from './providers/ClaudeProvider';
export { LocalProvider, DEFAULT_LOCAL_BASE_URL } from './providers/LocalProvider';
export {
  buildOpenAIImageContent,
  buildClaudeImageContent,
} from './providers/imageContent';
export {
  DEFAULT_STREAM_MAX_RETRIES,
  DEFAULT_STREAM_RETRY_DELAYS_MS,
  defaultStreamRetryDelayMs,
  StreamIdleTimeoutError,
} from './providers/streaming';

// Request / Response
export { RequestBuilder, stripConsumedImages } from './request/RequestBuilder';
export { CacheValidator } from './response/CacheValidator';
export { DEFAULT_MAX_TOKENS, DEEPSEEK_MAX_TOKENS, getProviderMaxTokensLimit, getProviderContextLimit, CONTEXT_LIMITS, sanitizeMaxTokens } from './tokenLimits';

// Re-export types
export * from '@codepapr/types';
