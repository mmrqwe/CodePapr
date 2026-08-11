/**
 * ClaudeProvider: Anthropic Claude API 适配器
 *
 * Claude 使用 cache_control 标记前缀以启用 Prompt Caching
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
  isRetriableStreamErrorType,
  readSseStream,
  safeParseToolArguments,
  sanitizeToolCallArguments,
  StreamIdleTimeoutError,
  withStreamIdleRetry,
} from './streaming';
import { buildClaudeImageContent, ClaudeContentPart } from './imageContent';
import { DEFAULT_MAX_TOKENS } from '../tokenLimits';

const log = new Logger('ClaudeProvider');

/** Claude thinking 的思考预算（token）。Anthropic API 硬性要求
 *  thinking.enabled 时必须携带 budget_tokens（≥1024 且 ≤ max_tokens），
 *  缺失立即 400 invalid_request_error——旧实现只发 {type:"enabled"}，任何
 *  调用方启用 thinking 都会当场 400。 */
export const CLAUDE_THINKING_BUDGET_TOKENS = 4096;

function isPrefixSystemMessage(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.isPrefixSystem === true;
}

function isSystemMessage(message: IChatRequest['messages'][number]): boolean {
  return message.role === 'system' || isPrefixSystemMessage(message.metadata);
}

interface ClaudeResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<
    | { type: 'text'; text: string }
    | {
        type: 'tool_use';
        id: string;
        name: string;
        input: Record<string, unknown>;
      }
  >;
  model: string;
  stop_reason: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

interface ClaudeStreamChunk {
  type:
    | 'message_start'
    | 'content_block_start'
    | 'content_block_delta'
    | 'content_block_stop'
    | 'message_delta'
    | 'message_stop'
    | 'ping'
    | 'error';
  message?: {
    id?: string;
    usage?: ClaudeResponse['usage'];
  };
  content_block?: {
    type: 'text' | 'tool_use';
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  };
  delta?: {
    type?: 'text_delta' | 'input_json_delta';
    text?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  index?: number;
  usage?: ClaudeResponse['usage'];
  /** error 事件：Anthropic 流式错误（invalid_request_error / authentication_error
   *  / overloaded_error 等）。旧实现完全没处理——确定性错误被当成「流干净结束但
   *  无终止信号」抛可重试错误，叠加流层无限重连永久卡死。 */
  error?: {
    type: string;
    message: string;
  };
}

interface ClaudeStreamingToolState {
  id: string;
  name: string;
  argumentsText: string;
}

function getClaudeSystemPrompt(request: IChatRequest): string {
  return request.messages
    .filter((message) => isSystemMessage(message))
    .map((message) => message.content)
    .join('\n');
}

function shouldApplyPromptCache(request: IChatRequest): boolean {
  return request.cacheControl?.type === 'session' || request.cacheControl?.type === 'ephemeral';
}

type ClaudeToolResultPart = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
};

type ClaudeToolUsePart = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
};

type ClaudeMessageBlock = ClaudeContentPart | ClaudeToolResultPart | ClaudeToolUsePart;

interface NormalizedClaudeMessage {
  role: 'user' | 'assistant';
  content: ClaudeMessageBlock[];
}

function buildClaudeMessageBlocks(
  message: IChatRequest['messages'][number]
): ClaudeMessageBlock[] {
  if (message.toolResult) {
    // 使用 message.content（MessageFactory.tool 已生成的纯文本/序列化结果）。
    // 不能对 toolResult.result 再做 sortedStringify：Agent 路径下 result 已是字符串，
    // 二次 JSON 编码会给全部内容套上引号与转义，损坏发给模型的工具结果。
    return [
      {
        type: 'tool_result',
        tool_use_id: message.toolResult.toolCallId,
        content: message.content,
      },
    ];
  }

  if (message.toolCalls) {
    const blocks: ClaudeMessageBlock[] = [];
    // Anthropic 拒绝空 text 块：工具调用回合 assistant 文本常为空，不能插入
    if (message.content) {
      blocks.push({ type: 'text', text: message.content });
    }
    for (const toolCall of message.toolCalls) {
      blocks.push({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.name,
        input: sanitizeToolCallArguments(toolCall.arguments),
      });
    }
    return blocks;
  }

  const imageContent = buildClaudeImageContent(message.content, message.images);
  if (imageContent) {
    return imageContent;
  }

  return message.content ? [{ type: 'text', text: message.content }] : [];
}

function normalizeClaudeConversationMessages(request: IChatRequest): NormalizedClaudeMessage[] {
  const normalized: NormalizedClaudeMessage[] = [];

  for (const message of request.messages) {
    if (isSystemMessage(message)) {
      continue;
    }

    const role: 'user' | 'assistant' = message.role === 'assistant' ? 'assistant' : 'user';
    const blocks = buildClaudeMessageBlocks(message);
    // Anthropic 拒绝空 content：空消息直接跳过
    if (blocks.length === 0) {
      continue;
    }

    // Anthropic 要求 user/assistant 角色严格交替。并行工具调用会产生多条
    // 连续的 tool(→user) 消息，必须合并进同一个 content 数组，否则
    // 400 "roles must alternate"。
    const last = normalized[normalized.length - 1];
    if (last && last.role === role) {
      last.content.push(...blocks);
    } else {
      normalized.push({ role, content: [...blocks] });
    }
  }

  return normalized;
}

export class ClaudeProvider extends BaseLLMProvider {
  name = 'claude';
  models = [
    'claude-opus-4-7',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
  ];

  constructor(config: ProviderConfig) {
    super({
      baseURL: 'https://api.anthropic.com/v1',
      ...config,
    });
  }

  async streamChat(
    request: IChatRequest,
    onEvent: (event: IChatStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<IChatResponse> {
    const url = `${this.config.baseURL}/messages`;
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
            'x-api-key': this.config.apiKey,
            'anthropic-version': '2023-06-01',
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
        let finishReason = 'end_turn';
        let usage: ClaudeResponse['usage'];
        let sawTermination = false;
        const toolCallStates: ClaudeStreamingToolState[] = [];

        try {
          await readSseStream(response, (payloadLine) => {
            let chunk: ClaudeStreamChunk;
            try {
              chunk = JSON.parse(payloadLine) as ClaudeStreamChunk;
            } catch {
              log.warn('SSE chunk parse failed, skipping', { payloadLine: payloadLine.slice(0, 200) });
              return;
            }
            // message_start 携带 input/cache token，message_delta 只携带
            // output_tokens：整体替换会丢掉 input/cache 统计，必须按字段合并。
            const chunkUsage = chunk.usage ?? chunk.message?.usage;
            if (chunkUsage) {
              usage = { ...usage, ...chunkUsage };
            }

            // error 事件 = 确定性 API 错误（鉴权/配置/上下文超限），不是网络
            // 断流：立即抛出并正确分类 retriable。overloaded/rate_limit 之外
            // 的类型一律不重试，避免「欠费/配置错误 → 无限重连」。
            if (chunk.type === 'error') {
              const errorType = chunk.error?.type ?? '';
              const errorMessage = chunk.error?.message ?? '未知错误';
              log.error(`${this.name} stream error event`, { errorType, errorMessage });
              throw new ProviderRequestError({
                provider: this.name,
                message: `Claude API error (${errorType}): ${errorMessage}`,
                retriable: isRetriableStreamErrorType(errorType),
              });
            }

            if (chunk.type === 'message_start') {
              responseId = chunk.message?.id ?? responseId;
              return;
            }

            // message_stop 是正常结束信号。
            if (chunk.type === 'message_stop') {
              sawTermination = true;
              return;
            }

            if (chunk.type === 'content_block_start' && chunk.content_block?.type === 'tool_use') {
              const index = chunk.index ?? 0;
              toolCallStates[index] = {
                id: chunk.content_block.id ?? `tool-call-${index}`,
                name: chunk.content_block.name ?? '',
                argumentsText:
                  chunk.content_block.input &&
                  Object.keys(chunk.content_block.input).length > 0
                    ? sortedStringify(chunk.content_block.input)
                    : '',
              };
              return;
            }

            if (chunk.type === 'content_block_delta') {
              if (chunk.delta?.type === 'text_delta' && chunk.delta.text) {
                content += chunk.delta.text;
                trackEvent({ type: 'content-delta', delta: chunk.delta.text });
                return;
              }

              if (chunk.delta?.type === 'input_json_delta') {
                const index = chunk.index ?? 0;
                const current = toolCallStates[index] ?? {
                  id: `tool-call-${index}`,
                  name: '',
                  argumentsText: '',
                };
                toolCallStates[index] = {
                  ...current,
                  argumentsText: `${current.argumentsText}${chunk.delta.partial_json ?? ''}`,
                };
              }
              return;
            }

            if (chunk.type === 'message_delta') {
              if (chunk.delta?.stop_reason) {
                finishReason = chunk.delta.stop_reason;
                sawTermination = true;
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
          // 旧实现会把任何非超时错误包成 retriable=true 的「流中断」，确定性
          // 错误被流层无限重连。
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

        // 流干净地结束但没有任何终止信号（message_stop / stop_reason）：
        // 典型是中转/网关把响应截断后直接关闭连接。此时内容不完整，绝不能当
        // 正常完成处理——抛可重试错误走流层无限重连。
        if (!sawTermination) {
          throw new ProviderRequestError({
            provider: this.name,
            message: 'Stream ended prematurely: no message_stop/stop_reason received',
            retriable: true,
          });
        }

        return {
          id: responseId,
          choices: [
            {
              message: {
                role: 'assistant',
                content,
                toolCalls:
                  toolCallStates.length > 0
                    ? toolCallStates
                        .filter(
                          (
                            toolCall
                          ): toolCall is ClaudeStreamingToolState => !!toolCall
                        )
                        .map((toolCall) => ({
                          id: toolCall.id,
                          name: toolCall.name,
                          arguments: safeParseToolArguments(toolCall.argumentsText),
                        }))
                    : undefined,
              },
              finishReason,
            },
          ],
          usage: {
            cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
            cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
            input_tokens: usage?.input_tokens ?? 0,
            output_tokens: usage?.output_tokens ?? 0,
          },
        };
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
    const url = `${this.config.baseURL}/messages`;
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
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: sortedStringify(payload),
    }, signal);

    let data: ClaudeResponse;
    try {
      data = (await response.json()) as ClaudeResponse;
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
      finishReason: data.stop_reason,
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    });
    return this.transformResponse(data);
  }

  private buildPayload(request: IChatRequest, stream: boolean = false) {
    const systemPrompt = getClaudeSystemPrompt(request);
    const applyPromptCache = shouldApplyPromptCache(request);

    return {
      model: request.model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      // Anthropic 要求 thinking 启用时 temperature 必须为 1，否则 400。
      temperature:
        request.thinking?.type === 'enabled'
          ? 1
          : (request.temperature ?? 0.7),
      top_p: request.topP ?? 0.9,
      system: systemPrompt
        ? [
            {
              type: 'text',
              text: systemPrompt,
              ...(applyPromptCache && {
                cache_control: { type: 'ephemeral' as const },
              }),
            },
          ]
        : undefined,
      messages: normalizeClaudeConversationMessages(request),
      ...(request.tools &&
        request.tools.length > 0 && {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
            ...(applyPromptCache && {
              cache_control: { type: 'ephemeral' as const },
            }),
          })),
        }),
      ...(request.thinking?.type === 'enabled' && {
        thinking: {
          type: 'enabled' as const,
          // 必须携带 budget_tokens（≥1024 且 ≤ max_tokens），且不超过本次
          // 输出预算；缺 budget_tokens 或 budget > max_tokens 都会 400。
          budget_tokens: Math.min(
            CLAUDE_THINKING_BUDGET_TOKENS,
            request.maxTokens ?? DEFAULT_MAX_TOKENS
          ),
        },
      }),
      ...(stream ? { stream: true } : {}),
    };
  }

  private transformResponse(data: ClaudeResponse): IChatResponse {
    // 提取文本内容
    const textParts = data.content
      .filter((c) => c.type === 'text')
      .map((c) => (c as { type: 'text'; text: string }).text);
    const content = textParts.join('\n');

    // 提取工具调用
    const toolCalls = data.content
      .filter((c) => c.type === 'tool_use')
      .map((c) => {
        const tu = c as {
          type: 'tool_use';
          id: string;
          name: string;
          input: Record<string, unknown>;
        };
        return {
          id: tu.id,
          name: tu.name,
          arguments: tu.input,
        } as IToolCall;
      });

    return {
      id: data.id,
      choices: [
        {
          message: {
            role: 'assistant' as const,
            content,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          },
          finishReason: data.stop_reason,
        },
      ],
      usage: {
        cache_creation_input_tokens:
          data.usage?.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: data.usage?.cache_read_input_tokens ?? 0,
        input_tokens: data.usage?.input_tokens ?? 0,
        output_tokens: data.usage?.output_tokens ?? 0,
      },
    };
  }
}
