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
  stripReasoningPlaceholderEchoes,
  withReasoningRoundTripFallback,
} from './reasoningRoundTrip';
import {
  applyStreamingToolCallDeltas,
  finalizeStreamingToolCalls,
  isRetriableStreamErrorType,
  readSseStream,
  safeParseToolArguments,
  StreamIdleTimeoutError,
  withStreamIdleRetry,
} from './streaming';
import { DEFAULT_MAX_TOKENS } from '../tokenLimits';
import { shouldSendReasoningEffort, shouldSendThinkingType } from './thinkingPayload';

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
  /** 中转/网关以 SSE data 下发的确定性错误对象（鉴权失败/欠费/上下文超限等）。
   *  官方 API 走 HTTP 4xx，此字段主要面向兼容中转——不分类会被当成
   *  「流提前结束」无限重连（见 streamChatCore 的处理注释）。 */
  error?: {
    message?: string;
    type?: string;
  };
}

export class DeepSeekProvider extends BaseLLMProvider {
  name = 'deepseek';
  models = ['deepseek-v4-pro', 'deepseek-flash', 'deepseek-chat', 'deepseek-reasoner'];

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
            // 进度协议：只有真实输出（reasoning/content/tool-call delta）才返回
            // true；心跳/usage 等空载荷不续命空闲超时（心跳不算数据）。
            let progress = false;
            if (payloadLine === '[DONE]') {
              sawDone = true;
              return false;
            }

            let chunk: DeepSeekStreamChunk;
            try {
              chunk = JSON.parse(payloadLine) as DeepSeekStreamChunk;
            } catch {
              log.warn('SSE chunk parse failed, skipping', { payloadLine: payloadLine.slice(0, 200) });
              return false;
            }
            responseId = chunk.id ?? responseId;
            if (chunk.usage) {
              usage = chunk.usage;
            }
            systemFingerprint = chunk.system_fingerprint ?? systemFingerprint;

            // 流内 error 对象 = 确定性 API 错误（鉴权失败/欠费/上下文超限等），
            // 不是网络断流：分类后立即抛出。与 OpenAIProvider/ClaudeProvider 对齐——
            // 中转常以 SSE data 下发错误后干净关流，若不分类会被当成
            // 「流提前结束」触发无限重连，永久卡死并持续烧请求。
            // overloaded/rate_limit 之外一律不重试。
            if (chunk.error) {
              const errorType = chunk.error.type ?? '';
              const errorMessage = chunk.error.message ?? '未知错误';
              log.error(`${this.name} stream error event`, { errorType, errorMessage });
              throw new ProviderRequestError({
                provider: this.name,
                message: `OpenAI-compatible API error (${errorType || 'unknown'}): ${errorMessage}`,
                retriable: isRetriableStreamErrorType(errorType),
              });
            }

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
                onEvent({ type: 'reasoning-delta', delta: reasoningDelta });
                progress = true;
              }

              if (delta.content) {
                content += delta.content;
                onEvent({ type: 'content-delta', delta: delta.content });
                progress = true;
              }

              if (delta.tool_calls?.length) {
                applyStreamingToolCallDeltas(toolCallStates, delta.tool_calls);
                progress = true;
              }

              if (choice.finish_reason) {
                finishReason = choice.finish_reason;
                sawFinishReason = true;
              }
            }

            return progress;
          }, signal, {
            idleTimeoutMs: this.config.idleTimeoutMs,
            waitNotifyIntervalMs: this.config.waitNotifyIntervalMs,
            onWait: (waitMs) => onEvent({ type: 'stream-wait', waitMs }),
          });
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            throw err;
          }
          if (err instanceof StreamIdleTimeoutError) {
            throw err;
          }
          // 流内 error 事件已分类的 ProviderRequestError 必须原样穿透：
          // 否则确定性错误会被包成「流中断」(retriable: true) 被流层无限重连。
          if (err instanceof ProviderRequestError) {
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

        // 部分中转只发 [DONE] 不发 finish_reason：绝不能默认按 'stop' 处理——
        // 那会掩盖实际被截断的输出，绕过 Agent 侧针对 'length' 的续写守卫。
        // 无 finish_reason 时以输出 token 达到 max_tokens 作为截断证据降级为
        // 'length'；否则显式标记 'unknown'（Agent 按正常结束处理，但语义不再
        // 被伪装成模型主动停止）。
        const effectiveFinishReason = sawFinishReason
          ? finishReason
          : normalizedUsage.outputTokens >= (request.maxTokens ?? DEFAULT_MAX_TOKENS)
            ? 'length'
            : 'unknown';

        const result: IChatResponse = {
          id: responseId,
          choices: [
            {
              message: {
                role: 'assistant',
                content,
                reasoningContent: stripReasoningPlaceholderEchoes(reasoningContent),
                toolCalls: finalizeStreamingToolCalls(toolCallStates),
              },
              finishReason: effectiveFinishReason,
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
          finishReason: effectiveFinishReason,
          inputTokens: result.usage?.input_tokens ?? 0,
          outputTokens: result.usage?.output_tokens ?? 0,
        });

        return result;
      },
      {
        signal,
        // undefined = 无限重试：可重试故障不终止回合。
        maxRetries: this.config.streamMaxRetries,
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

    // 非流式 body 读取必须保持在超时/取消保护之下（见 fetchWithRetry 注释）。
    const protection: { release: () => void } = { release: () => undefined };
    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: sortedStringify(payload),
    }, signal, undefined, protection);

    let data: DeepSeekResponse;
    try {
      data = (await response.json()) as DeepSeekResponse;
    } catch (err) {
      // 超时/取消中止 body 读取时产生 AbortError：原样上抛，不得误归为
      // 「响应不是合法 JSON」。
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      // 200 但非 JSON 正文（代理 HTML 错误页等）：转成带 provider 上下文的
      // 错误，而不是裸 SyntaxError。
      throw new ProviderRequestError({
        provider: this.name,
        message: `响应不是合法 JSON: ${(err as Error).message}`,
        retriable: false,
      });
    } finally {
      protection.release();
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
        request.thinking &&
        (request.thinking.type === 'disabled' || shouldSendThinkingType(request, 'thinking')) && {
          thinking: {
            type: request.thinking.type,
          },
        }),
      ...(supportsThinkingPayload &&
        shouldSendReasoningEffort(request, 'thinking') &&
        request.thinking?.reasoningEffort && {
          reasoning_effort: request.thinking.reasoningEffort,
        }),
      temperature: request.temperature ?? 0.7,
      top_p: request.topP ?? 0.9,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(request.tools &&
        request.tools.length > 0 && {
          tools: request.tools
            .filter((t) => typeof t?.name === 'string' && t.name.trim().length > 0)
            .map((t) => {
              const name = t.name.trim();
              const description = t.description || '';
              const parameters = t.parameters || { type: 'object', properties: {} };
              // OpenAI 兼容规范:{ type: 'function', function: {...} };顶层重复的
              // name/description/parameters 属非标准字段,严格网关可能 400。
              return {
                type: 'function' as const,
                function: {
                  name,
                  description,
                  parameters,
                },
              };
            }),
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
          reasoningContent: stripReasoningPlaceholderEchoes(c.message.reasoning_content),
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
