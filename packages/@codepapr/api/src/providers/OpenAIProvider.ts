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
  applyStreamingToolCallDeltas,
  DEFAULT_STREAM_MAX_RETRIES,
  finalizeStreamingToolCalls,
  readSseStream,
  safeParseToolArguments,
  sanitizeToolCallArguments,
  StreamIdleTimeoutError,
  withStreamIdleRetry,
} from './streaming';
import { buildOpenAIImageContent } from './imageContent';
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
        }, signal);

        let responseId = '';
        let content = '';
        let reasoningContent = '';
        let finishReason = 'stop';
        let usage: OpenAIResponse['usage'];
        let systemFingerprint: string | undefined;
        const toolCallStates: Array<{ id: string; name: string; argumentsText: string }> = [];

        try {
          await readSseStream(response, (payloadLine) => {
            if (payloadLine === '[DONE]') {
              return;
            }

            let chunk: OpenAIStreamChunk;
            try {
              chunk = JSON.parse(payloadLine) as OpenAIStreamChunk;
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

              if (delta.content) {
                content += delta.content;
                trackEvent({ type: 'content-delta', delta: delta.content });
              }

              if (delta.reasoning_content) {
                reasoningContent += delta.reasoning_content;
                trackEvent({ type: 'reasoning-delta', delta: delta.reasoning_content });
              }

              if (delta.tool_calls?.length) {
                applyStreamingToolCallDeltas(toolCallStates, delta.tool_calls);
              }

              finishReason = choice.finish_reason ?? finishReason;
            }
          }, signal, { idleTimeoutMs: this.config.idleTimeoutMs });
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            throw err;
          }
          if (err instanceof StreamIdleTimeoutError) {
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
          finishReason,
          inputTokens: result.usage?.input_tokens ?? 0,
          outputTokens: result.usage?.output_tokens ?? 0,
        });

        return result;
      },
      {
        signal,
        hasEmitted: () => emitted,
        retryDelayMs: this.config.streamRetryDelayMs,
        onRetry: (attempt, err) => {
          if (emitted) {
            onEvent({
              type: 'stream-restart',
              attempt,
              maxRetries: DEFAULT_STREAM_MAX_RETRIES,
            });
          }
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
    const url = `${this.config.baseURL}/chat/completions`;
    const payload = this.buildPayload(request);

    log.info('LLM request started', {
      messageCount: payload.messages.length,
      model: payload.model,
      stream: false,
    });

    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: sortedStringify(payload),
    }, signal);

    let data: OpenAIResponse;
    try {
      data = (await response.json()) as OpenAIResponse;
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
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    });
    return this.transformResponse(data);
  }

  private buildPayload(request: IChatRequest, stream: boolean = false) {
    return {
      model: request.model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: buildOpenAIImageContent(m.content, m.images) ?? m.content,
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
      })),
      temperature: request.temperature ?? 0.7,
      top_p: request.topP ?? 0.9,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(request.thinking && {
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
        cache_read_input_tokens: getOpenAICachedTokens(data.usage),
        cache_creation_input_tokens: getOpenAICreationTokens(data.usage),
        input_tokens: getOpenAIInputTokens(data.usage),
        output_tokens: getOpenAIOutputTokens(data.usage),
      },
      system_fingerprint: data.system_fingerprint,
    };
  }
}
