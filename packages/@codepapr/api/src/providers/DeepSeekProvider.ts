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
import { BaseLLMProvider, ProviderConfig, ProviderRequestError } from './ILLMProvider';
import {
  buildOpenAICompatibleMessages,
  isReasoningRoundTripError,
  stripLegacyReasoningPlaceholder,
  withReasoningRoundTripFallback,
} from './reasoningRoundTrip';
import {
  applyStreamingToolCallDeltas,
  finalizeStreamingToolCalls,
  readSseStream,
  safeParseToolArguments,
  StreamIdleTimeoutError,
  withStreamIdleRetry,
} from './streaming';
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
      /** 兼容个别中继以下发思考内容的别名字段。 */
      reasoning?: string;
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
    return withReasoningRoundTripFallback(
      request,
      (effective) => this.streamChatCore(effective, onEvent, signal),
      (err) => {
        log.warn(
          'DeepSeek 400: reasoning_content round-trip rejected; retrying this request with thinking disabled',
          { error: err.message.slice(0, 300) }
        );
      },
      (err) => isReasoningRoundTripError(err) && request.thinking?.type === 'enabled' && !isLegacyReasonerModel(request.model)
    );
  }

  private async streamChatCore(
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

    let emitted = false;
    const trackEvent = (event: IChatStreamEvent): void => {
      if (event.type === 'content-delta' || event.type === 'reasoning-delta') {
        emitted = true;
      }
      onEvent(event);
    };

    return withStreamIdleRetry(
      async () => {
        const response = await this.fetchWithRetry(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body: sortedStringify(payload),
        }, signal, (attempt, maxRetries, err) => {
          onEvent({
            type: 'request-retry',
            attempt,
            maxRetries,
          });
          log.warn('LLM request failed, retrying', {
            model: payload.model,
            attempt,
            maxRetries,
            error: err.message,
          });
        });

        let responseId = '';
        let content = '';
        let reasoningContent = '';
        let finishReason = 'stop';
        let usage: DeepSeekResponse['usage'];
        let systemFingerprint: string | undefined;
        let sawDone = false;
        let sawFinishReason = false;
        const toolCallStates: Array<{ id: string; name: string; argumentsText: string }> = [];

        try {
          await readSseStream(response, (payloadLine) => {
            if (payloadLine === '[DONE]') {
              sawDone = true;
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
            if (chunk.usage) {
              usage = chunk.usage;
            }
            systemFingerprint = chunk.system_fingerprint ?? systemFingerprint;

            for (const choice of chunk.choices ?? []) {
              const delta = choice.delta;
              if (!delta) {
                if (choice.finish_reason) {
                  finishReason = choice.finish_reason;
                  sawFinishReason = true;
                }
                continue;
              }

              const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
              if (reasoningDelta) {
                reasoningContent += reasoningDelta;
                trackEvent({ type: 'reasoning-delta', delta: reasoningDelta });
              }

              if (delta.content) {
                content += delta.content;
                trackEvent({ type: 'content-delta', delta: delta.content });
              }

              if (delta.tool_calls?.length) {
                applyStreamingToolCallDeltas(toolCallStates, delta.tool_calls);
              }

              if (choice.finish_reason) {
                finishReason = choice.finish_reason;
                sawFinishReason = true;
              }
            }
          }, signal, { idleTimeoutMs: this.config.idleTimeoutMs });
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            throw err;
          }
          if (err instanceof StreamIdleTimeoutError) {
            throw err;
          }
          throw new ProviderRequestError({
            provider: this.name,
            message: `Stream interrupted: ${err instanceof Error ? err.message : String(err)}`,
            retriable: true,
          });
        }

        // 流干净地结束但没有任何终止信号（[DONE]/finish_reason）：
        // 典型是中转/网关把响应截断后直接关闭连接。此时内容不完整，绝不能当
        // 正常完成处理——抛可重试错误走流层无限重连。
        // 注意：usage 不算终止信号——截断流常常先发 usage 再掐断连接，
        // 若放行，部分内容会被当成正常完成返回，且 finish_reason 缺失导致
        // 输出截断绕过 Agent 侧的 length 守卫。
        if (!sawDone && !sawFinishReason) {
          throw new ProviderRequestError({
            provider: this.name,
            message: 'Stream ended prematurely: no [DONE]/finish_reason received',
            retriable: true,
          });
        }

        const normalizedUsage = normalizeDeepSeekUsage(usage);

        const result: IChatResponse = {
          id: responseId,
          choices: [
            {
              message: {
                role: 'assistant',
                content,
                reasoningContent: stripLegacyReasoningPlaceholder(reasoningContent),
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
      },
      {
        signal,
        // undefined = 无限重试：可重试故障不终止回合。
        maxRetries: this.config.streamMaxRetries,
        hasEmitted: () => emitted,
        retryDelayMs: this.config.streamRetryDelayMs,
        onRetry: (attempt, err) => {
          // 无论是否已有输出都发 stream-restart：让 UI 状态可见，也让上层
          // idle 看门狗看到活动。无输出时清空操作是幂等的。maxRetries 缺省
          // （无限重试）——可重试故障不终止回合。
          onEvent({ type: 'stream-restart', attempt, maxRetries: this.config.streamMaxRetries });
          log.warn('LLM stream interrupted, retrying', {
            model: payload.model,
            attempt,
            error: err.message,
          });
        },
      }
    );
  }

  async chat(request: IChatRequest, signal?: AbortSignal): Promise<IChatResponse> {
    return withReasoningRoundTripFallback(
      request,
      (effective) => this.chatCore(effective, signal),
      (err) => {
        log.warn(
          'DeepSeek 400: reasoning_content round-trip rejected; retrying this request with thinking disabled',
          { error: err.message.slice(0, 300) }
        );
      },
      (err) => isReasoningRoundTripError(err) && request.thinking?.type === 'enabled' && !isLegacyReasonerModel(request.model)
    );
  }

  private async chatCore(request: IChatRequest, signal?: AbortSignal): Promise<IChatResponse> {
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

    let data: DeepSeekResponse;
    try {
      data = (await response.json()) as DeepSeekResponse;
    } catch (err) {
      // 200 但非 JSON 正文（代理 HTML 错误页等）：转成带 provider 上下文的
      // 错误，而不是裸 SyntaxError。
      throw new ProviderRequestError({
        provider: this.name,
        message: `响应不是合法 JSON: ${(err as Error).message}`,
        retriable: false,
      });
    }

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

    // 统一处理 reasoning_content 回传 / 占位注入（见 reasoningRoundTrip.ts）：
    // - 带 tool_calls 且存有 reasoning 的 assistant 必须回传（与 thinking 开关、
    //   模型能力解耦），否则 API 400；
    // - 带 tool_calls 但缺失 reasoning 的 assistant 注入稳定占位符，thinking 不降级。
    return {
      model: request.model,
      messages: buildOpenAICompatibleMessages(request, { supportsThinkingPayload }),
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
          reasoningContent: stripLegacyReasoningPlaceholder(c.message.reasoning_content),
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
