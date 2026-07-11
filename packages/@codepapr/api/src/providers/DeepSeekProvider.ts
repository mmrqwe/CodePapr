/**
 * DeepSeekProvider: DeepSeek API 适配器（缓存优化的核心）
 *
 * DeepSeek 默认启用自动前缀缓存：
 * - 后续请求只有完整匹配已落盘前缀单元时才会命中
 * - 官方统计字段为 usage.prompt_cache_hit_tokens / prompt_cache_miss_tokens
 * - 旧兼容字段 cache_hit_tokens / cache_miss_tokens 仅作回退
 */

import {
  IChatRequest,
  IChatResponse,
  IChatStreamEvent,
  IToolCall,
} from '@codepapr/types';
import { Logger, sortedStringify } from '@codepapr/common';
import { sanitizeToolCallArguments } from './streaming';
import { BaseLLMProvider, ProviderConfig } from './ILLMProvider';
import {
  applyStreamingToolCallDeltas,
  finalizeStreamingToolCalls,
  readSseStream,
  safeParseToolArguments,
} from './streaming';
import { buildOpenAIImageContent } from './imageContent';
import { DEFAULT_MAX_TOKENS } from '../tokenLimits';

const log = new Logger('DeepSeekProvider');

function isLegacyReasonerModel(model: string): boolean {
  return /reasoner/i.test(model);
}

interface DeepSeekUsageStats {
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  inputTokens: number;
  outputTokens: number;
}

function normalizeDeepSeekUsage(
  usage: DeepSeekResponse['usage'] | undefined
): DeepSeekUsageStats {
  const promptCacheHitTokens =
    usage?.prompt_cache_hit_tokens ?? usage?.cache_hit_tokens ?? 0;
  const promptCacheMissTokens =
    usage?.prompt_cache_miss_tokens ??
    usage?.cache_miss_tokens ??
    Math.max((usage?.prompt_tokens ?? 0) - promptCacheHitTokens, 0);

  return {
    promptCacheHitTokens,
    promptCacheMissTokens,
    cacheReadInputTokens: promptCacheHitTokens,
    cacheCreationInputTokens: 0,
    inputTokens: promptCacheMissTokens,
    outputTokens: usage?.completion_tokens ?? 0,
  };
}

interface DeepSeekResponse {
  id: string;
  choices: Array<{
    message: {
      role: 'assistant';
      content: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    cache_hit_tokens?: number;
    cache_miss_tokens?: number;
  };
  system_fingerprint?: string;
}

interface DeepSeekStreamChunk {
  id?: string;
  choices?: Array<{
    index: number;
    delta?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: 'function';
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: DeepSeekResponse['usage'];
  system_fingerprint?: string;
}

export class DeepSeekProvider extends BaseLLMProvider {
  name = 'deepseek';
  models = ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner'];

  constructor(config: ProviderConfig) {
    super({
      baseURL: 'https://api.deepseek.com/v1',
      ...config,
    });
  }

  async streamChat(
    request: IChatRequest,
    onEvent: (event: IChatStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<IChatResponse> {
    const url = `${this.config.baseURL}/chat/completions`;
    const payload = this.buildPayload(request, true);

    log.info('LLM request started', {
      model: payload.model,
      stream: true,
      messageCount: payload.messages.length,
    });

    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: sortedStringify(payload),
    }, signal);

    let responseId = '';
    let content = '';
    let reasoningContent = '';
    let finishReason = 'stop';
    let usage: DeepSeekResponse['usage'];
    let systemFingerprint: string | undefined;
    const toolCallStates: Array<{ id: string; name: string; argumentsText: string }> = [];

    await readSseStream(response, (payloadLine) => {
      if (payloadLine === '[DONE]') {
        return;
      }

      let chunk: DeepSeekStreamChunk;
      try {
        chunk = JSON.parse(payloadLine) as DeepSeekStreamChunk;
      } catch {
        log.warn('SSE chunk parse failed, skipping', { payloadLine: payloadLine.slice(0, 200) });
        return;
      }
      responseId = chunk.id ?? responseId;
      usage = chunk.usage ?? usage;
      systemFingerprint = chunk.system_fingerprint ?? systemFingerprint;

      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta;
        if (!delta) {
          finishReason = choice.finish_reason ?? finishReason;
          continue;
        }

        if (delta.reasoning_content) {
          reasoningContent += delta.reasoning_content;
          onEvent({ type: 'reasoning-delta', delta: delta.reasoning_content });
        }

        if (delta.content) {
          content += delta.content;
          onEvent({ type: 'content-delta', delta: delta.content });
        }

        if (delta.tool_calls?.length) {
          applyStreamingToolCallDeltas(toolCallStates, delta.tool_calls);
        }

        finishReason = choice.finish_reason ?? finishReason;
      }
    });

    const normalizedUsage = normalizeDeepSeekUsage(usage);

    const result: IChatResponse = {
      id: responseId,
      choices: [
        {
          message: {
            role: 'assistant',
            content,
            reasoningContent: reasoningContent || undefined,
            toolCalls: finalizeStreamingToolCalls(toolCallStates),
          },
          finishReason,
        },
      ],
      usage: {
        prompt_cache_hit_tokens: normalizedUsage.promptCacheHitTokens,
        prompt_cache_miss_tokens: normalizedUsage.promptCacheMissTokens,
        cache_read_input_tokens: normalizedUsage.cacheReadInputTokens,
        cache_creation_input_tokens: normalizedUsage.cacheCreationInputTokens,
        input_tokens: normalizedUsage.inputTokens,
        output_tokens: normalizedUsage.outputTokens,
      },
      system_fingerprint: systemFingerprint,
    };

    log.info('LLM request completed', {
      model: payload.model,
      stream: true,
      finishReason,
      inputTokens: result.usage?.input_tokens ?? 0,
      outputTokens: result.usage?.output_tokens ?? 0,
    });

    return result;
  }

  async chat(request: IChatRequest, signal?: AbortSignal): Promise<IChatResponse> {
    const url = `${this.config.baseURL}/chat/completions`;
    const payload = this.buildPayload(request);

    log.info('LLM request started', {
      messageCount: payload.messages.length,
      model: payload.model,
      stream: false,
      thinking: payload.thinking,
      prefixHash: request.metadata?.prefixHash,
    });

    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: sortedStringify(payload),
    }, signal);

    const data = (await response.json()) as DeepSeekResponse;

    log.info('LLM request completed', {
      model: payload.model,
      stream: false,
      finishReason: data.choices[0]?.finish_reason,
      cacheHit: normalizeDeepSeekUsage(data.usage).promptCacheHitTokens,
      cacheMiss: normalizeDeepSeekUsage(data.usage).promptCacheMissTokens,
    });

    return this.transformResponse(data);
  }

  private buildPayload(request: IChatRequest, stream: boolean = false) {
    const supportsThinkingPayload = !isLegacyReasonerModel(request.model);
    const shouldRoundTripReasoning =
      supportsThinkingPayload && request.thinking?.type === 'enabled';

    return {
      model: request.model,
      messages: request.messages.map((m) => {
        const isAssistantWithToolCalls =
          m.role === 'assistant' && !!m.toolCalls && m.toolCalls.length > 0;
        const hasReasoningContent =
          typeof m.reasoningContent === 'string' &&
          m.reasoningContent.length > 0;

        // DeepSeek 官方要求：若 assistant 中间轮发起了工具调用，
        // 其 reasoning_content 必须在后续每次请求中持续回传，
        // 否则 API 会返回 400 "Load fail"。这一约束与当前 thinking
        // 开关无关——即使本轮关闭了 thinking，历史中那些带 tool_calls
        // 的 assistant 仍需保留 reasoning_content。
        const mustRoundTripReasoningContent =
          isAssistantWithToolCalls && hasReasoningContent;

        const optionallyRoundTripReasoningContent =
          shouldRoundTripReasoning &&
          !isAssistantWithToolCalls &&
          m.role === 'assistant' &&
          hasReasoningContent;

        const includeReasoningContent =
          mustRoundTripReasoningContent || optionallyRoundTripReasoningContent;

        return {
          role: m.role,
          content: buildOpenAIImageContent(m.content, m.images) ?? m.content,
          ...(includeReasoningContent && {
            reasoning_content: m.reasoningContent,
          }),
          ...(m.toolCalls && {
            tool_calls: m.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: sortedStringify(sanitizeToolCallArguments(tc.arguments)),
              },
            })),
          }),
          ...(m.toolResult && {
            tool_call_id: m.toolResult.toolCallId,
          }),
        };
      }),
      ...(supportsThinkingPayload &&
        request.thinking && {
          thinking: {
            type: request.thinking.type,
          },
        }),
      ...(supportsThinkingPayload &&
        request.thinking?.reasoningEffort && {
          reasoning_effort: request.thinking.reasoningEffort,
        }),
      temperature: request.temperature ?? 0.7,
      top_p: request.topP ?? 0.9,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(request.tools &&
        request.tools.length > 0 && {
          tools: request.tools.map((t) => ({
            type: 'function' as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          })),
        }),
      ...(stream && {
        stream: true,
        stream_options: {
          include_usage: true,
        },
      }),
    };
  }

  /**
   * 转换 DeepSeek 响应为统一格式
   */
  private transformResponse(data: DeepSeekResponse): IChatResponse {
    const normalizedUsage = normalizeDeepSeekUsage(data.usage);

    return {
      id: data.id,
      choices: data.choices.map((c) => ({
        message: {
          role: 'assistant' as const,
          content: c.message.content,
          reasoningContent: c.message.reasoning_content,
          toolCalls: c.message.tool_calls?.map(
            (tc): IToolCall => ({
              id: tc.id,
              name: tc.function.name,
              arguments: safeParseToolArguments(tc.function.arguments),
            })
          ),
        },
        finishReason: c.finish_reason,
      })),
      usage: {
        prompt_cache_hit_tokens: normalizedUsage.promptCacheHitTokens,
        prompt_cache_miss_tokens: normalizedUsage.promptCacheMissTokens,
        cache_read_input_tokens: normalizedUsage.cacheReadInputTokens,
        cache_creation_input_tokens: normalizedUsage.cacheCreationInputTokens,
        input_tokens: normalizedUsage.inputTokens,
        output_tokens: normalizedUsage.outputTokens,
      },
      system_fingerprint: data.system_fingerprint,
    };
  }
}
