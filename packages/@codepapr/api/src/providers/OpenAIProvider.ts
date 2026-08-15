/**
 * OpenAIProvider: OpenAI 兼容的 API 适配器
 *
 * 用于 OpenAI 官方 API 及其他兼容服务（Azure OpenAI、本地模型等）
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

const log = new Logger('OpenAIProvider');

interface OpenAIResponse {
  id: string;
  choices: Array<{
    message: {
      role: 'assistant';
      content: string | Array<{ type?: string; text?: string }>;
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
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  system_fingerprint?: string;
}

interface OpenAIStreamChunk {
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
  usage?: OpenAIResponse['usage'];
  system_fingerprint?: string;
  /** OpenAI 兼容中转可能以 SSE data 下发 error 对象（鉴权/限流/上下文超限）。
   *  旧实现忽略它——流干净结束后被误判为瞬态断流，叠加无限重连永久卡死。 */
  error?: {
    message?: string;
    type?: string;
  };
}

function getOpenAICachedTokens(usage: OpenAIResponse['usage'] | undefined): number {
  return usage?.cache_read_input_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0;
}

function getOpenAICreationTokens(usage: OpenAIResponse['usage'] | undefined): number {
  return usage?.cache_creation_input_tokens ?? 0;
}

function getOpenAIInputTokens(usage: OpenAIResponse['usage'] | undefined): number {
  if (typeof usage?.input_tokens === 'number') {
    return usage.input_tokens;
  }

  const totalPromptTokens = usage?.prompt_tokens ?? 0;
  return Math.max(0, totalPromptTokens - getOpenAICachedTokens(usage));
}

function getOpenAIOutputTokens(usage: OpenAIResponse['usage'] | undefined): number {
  return usage?.output_tokens ?? usage?.completion_tokens ?? 0;
}

function normalizeOpenAIContent(
  content: OpenAIResponse['choices'][number]['message']['content']
): string {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .map((part) => (part.type === 'text' || !part.type ? part.text ?? '' : ''))
    .join('');
}

export class OpenAIProvider extends BaseLLMProvider {
  name = 'openai';
  models = ['gpt-4o', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo'];

  constructor(config: ProviderConfig) {
    super({
      baseURL: 'https://api.openai.com/v1',
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
          'OpenAI-compatible endpoint rejected reasoning_content round-trip (400); retrying this request with thinking disabled',
          { error: err.message.slice(0, 300) }
        );
      }
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
        let usage: OpenAIResponse['usage'];
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

            let chunk: OpenAIStreamChunk;
            try {
              chunk = JSON.parse(payloadLine) as OpenAIStreamChunk;
            } catch {
              log.warn('SSE chunk parse failed, skipping', { payloadLine: payloadLine.slice(0, 200) });
              return;
            }

            // 流内 error 对象 = 确定性 API 错误（鉴权/配置/上下文超限等），
            // 不是网络断流：分类后立即抛出。overloaded/rate_limit 之外一律
            // 不重试，避免无限重连。
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

              if (delta.content) {
                content += delta.content;
                onEvent({ type: 'content-delta', delta: delta.content });
              }

              const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
              if (reasoningDelta) {
                reasoningContent += reasoningDelta;
                onEvent({ type: 'reasoning-delta', delta: reasoningDelta });
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
          // 流内 error 事件（#6）已分类的 ProviderRequestError 必须原样穿透：
          // 旧实现把任何非超时错误包成 retriable=true 的「流中断」。
          if (err instanceof ProviderRequestError) {
            throw err;
          }
          // Mid-stream body breaks (connection reset / truncated body — surfaced
          // by reqwest as "error decoding response body") are retriable at the
          // stream level; a `stream-restart` event lets consumers drop partial
          // output of the dead attempt.
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

        // 部分中转只发 [DONE] 不发 finish_reason：绝不能默认按 'stop' 处理——
        // 那会掩盖实际被截断的输出，绕过 Agent 侧针对 'length' 的续写守卫。
        // 无 finish_reason 时以输出 token 达到 max_tokens 作为截断证据降级为
        // 'length'；否则显式标记 'unknown'（Agent 按正常结束处理，但语义不再
        // 被伪装成模型主动停止）。
        const outputTokensSeen = getOpenAIOutputTokens(usage);
        const effectiveFinishReason = sawFinishReason
          ? finishReason
          : outputTokensSeen >= (request.maxTokens ?? DEFAULT_MAX_TOKENS)
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
            cache_read_input_tokens: getOpenAICachedTokens(usage),
            cache_creation_input_tokens: getOpenAICreationTokens(usage),
            input_tokens: getOpenAIInputTokens(usage),
            output_tokens: getOpenAIOutputTokens(usage),
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
          'OpenAI-compatible endpoint rejected reasoning_content round-trip (400); retrying this request with thinking disabled',
          { error: err.message.slice(0, 300) }
        );
      }
    );
  }

  private async chatCore(request: IChatRequest, signal?: AbortSignal): Promise<IChatResponse> {
    const url = `${this.config.baseURL}/chat/completions`;
    const payload = this.buildPayload(request);

    log.info('LLM request started', {
      messageCount: payload.messages.length,
      model: payload.model,
      stream: false,
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

    let data: OpenAIResponse;
    try {
      data = (await response.json()) as OpenAIResponse;
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
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    });
    return this.transformResponse(data);
  }

  private buildPayload(request: IChatRequest, stream: boolean = false) {
    // OpenAI 兼容端点（含 Console Go 等转发 DeepSeek 的中继）同样需要
    // reasoning_content 回传/占位注入（见 reasoningRoundTrip.ts）。
    //
    // thinking 字段是 DeepSeek 风格扩展：官方 OpenAI 对未知请求参数返回
    // 400「Unrecognized request argument」，只能发给中继端点。
    // reasoning_effort 是官方 o 系列参数，不受此限制。
    let isOfficialOpenAIEndpoint = false;
    try {
      isOfficialOpenAIEndpoint = /(^|\.)api\.openai\.com$/i.test(
        new URL(this.config.baseURL ?? 'https://api.openai.com/v1').hostname
      );
    } catch {
      isOfficialOpenAIEndpoint = false;
    }
    return {
      model: request.model,
      messages: buildOpenAICompatibleMessages(request, { supportsThinkingPayload: true }),
      temperature: request.temperature ?? 0.7,
      top_p: request.topP ?? 0.9,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(request.thinking &&
        !isOfficialOpenAIEndpoint && {
          thinking: {
            type: request.thinking.type,
          },
        }),
      ...(request.thinking?.reasoningEffort && {
        reasoning_effort: request.thinking.reasoningEffort,
      }),
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

  private transformResponse(data: OpenAIResponse): IChatResponse {
    return {
      id: data.id,
      choices: data.choices.map((c) => ({
        message: {
          role: 'assistant' as const,
          content: normalizeOpenAIContent(c.message.content),
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
        cache_read_input_tokens: getOpenAICachedTokens(data.usage),
        cache_creation_input_tokens: getOpenAICreationTokens(data.usage),
        input_tokens: getOpenAIInputTokens(data.usage),
        output_tokens: getOpenAIOutputTokens(data.usage),
      },
      system_fingerprint: data.system_fingerprint,
    };
  }
}
