import { RequestBuilder, CacheValidator } from '@codepapr/api';
import { AppendOnlyLog, ImmutablePrefix } from '@codepapr/core';
import type {
  ICacheStatistics,
  IChatResponse,
  IChatThinking,
  ILLMProvider,
} from '@codepapr/types';

export interface CachedModelRequestParams {
  provider: ILLMProvider;
  providerName: 'deepseek' | 'openai' | 'claude' | 'response';
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  maxTokens?: number;
  topP?: number;
  thinking?: IChatThinking;
  sessionId?: string;
}

export interface CachedModelRequestResult {
  response: IChatResponse;
  cacheStats: ICacheStatistics;
  prefixHash: string;
  logHash: string;
}

export async function runCachedModelRequest(
  params: CachedModelRequestParams
): Promise<CachedModelRequestResult> {
  const prefix = new ImmutablePrefix({
    systemPrompt: params.systemPrompt,
    tools: [],
    model: params.model,
    parameters: {
      temperature: params.temperature,
      topP: params.topP ?? 0.9,
      maxTokens: params.maxTokens,
      thinkingEnabled: params.thinking?.type === 'enabled',
    },
  });
  const log = new AppendOnlyLog(
    params.sessionId ?? `aux:${params.providerName}:${params.model}`
  );
  await log.append({
    id: 'aux-user',
    role: 'user',
    content: params.userPrompt,
    timestamp: Date.now(),
  });

  const request = new RequestBuilder().build({
    prefix,
    appendLog: log,
    model: params.model,
    provider: params.providerName,
    thinking: params.thinking,
    temperature: params.temperature,
    topP: params.topP,
    maxTokens: params.maxTokens,
    tools: [],
  });
  const response = await params.provider.chat(request);
  const validation = new CacheValidator().validate(
    request,
    response,
    prefix.computeHash(),
    log.computeHash()
  );

  return {
    response,
    cacheStats: {
      cacheCreationTokens: validation.cacheCreationTokens,
      cacheReadTokens: validation.cacheReadTokens,
      newInputTokens: validation.newInputTokens,
      outputTokens: validation.outputTokens,
      cacheHitRate: validation.cacheHitRate,
      promptCacheHitTokens: validation.promptCacheHitTokens,
      promptCacheMissTokens: validation.promptCacheMissTokens,
      calls: 1,
    },
    prefixHash: prefix.computeHash(),
    logHash: log.computeHash(),
  };
}