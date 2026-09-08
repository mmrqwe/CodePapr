/**
 * CodePapr API: LLM 提供商适配 + 请求/响应处理
 */

// Providers
export { BaseLLMProvider, ProviderRequestError, setGlobalFetchFn, getGlobalFetchFn, mergeExtraHeaders } from './providers/ILLMProvider';
export type { ProviderConfig } from './providers/ILLMProvider';
export { DeepSeekProvider } from './providers/DeepSeekProvider';
export { OpenAIProvider } from './providers/OpenAIProvider';
export { ResponseProvider, CODEPAPR_OPENCODE_USER_AGENT } from './providers/ResponseProvider';
export { ClaudeProvider } from './providers/ClaudeProvider';
export { LocalProvider, DEFAULT_LOCAL_BASE_URL } from './providers/LocalProvider';
export {
  ANTHROPIC_API_VERSION,
  LIST_MODELS_TIMEOUT_MS,
  ListModelsError,
  isListModelsError,
  listModels,
  parseModelCatalog,
} from './providers/listModels';
export type { ListModelsAuth, ListModelsErrorKind } from './providers/listModels';
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
export {
  LEGACY_REASONING_PLACEHOLDER,
  REASONING_PLACEHOLDER_FALLBACK,
  isLegacyReasoningPlaceholder,
  isReasoningPlaceholderEcho,
  stripReasoningPlaceholderEchoes,
} from './providers/reasoningRoundTrip';

// Request / Response
export { RequestBuilder, stripConsumedImages, insertAnchoredContext } from './request/RequestBuilder';
export { CacheValidator } from './response/CacheValidator';
export {
  DEFAULT_MAX_TOKENS,
  DEEPSEEK_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_CONTEXT_TOKENS,
  DEEPSEEK_DEFAULT_MAX_CONTEXT_TOKENS,
  getProviderMaxTokensLimit,
  getProviderContextLimit,
  CONTEXT_LIMITS,
  sanitizeMaxTokens,
} from './tokenLimits';
export {
  resolveRequestThinkingPayload,
  shouldSendReasoningEffort,
  shouldSendThinkingType,
} from './providers/thinkingPayload';

// Re-export types
export * from '@codepapr/types';
