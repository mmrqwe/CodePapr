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
import { BaseLLMProvider, ProviderConfig } from './ILLMProvider';
import {
  readSseStream,
  safeParseToolArguments,
  sanitizeToolCallArguments,
  withStreamIdleRetry,
} from './streaming';
import { buildClaudeImageContent } from './imageContent';
import { DEFAULT_MAX_TOKENS } from '../tokenLimits';

const log = new Logger('ClaudeProvider');

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

function normalizeClaudeConversationMessages(request: IChatRequest) {
  return request.messages
    .filter((message) => !isSystemMessage(message))
    .map((message) => ({
      role: message.role === 'tool' ? 'user' : message.role,
      content: message.toolResult
        ? [
            {
              type: 'tool_result' as const,
              tool_use_id: message.toolResult.toolCallId,
              content: sortedStringify(message.toolResult.result),
            },
          ]
        : message.toolCalls
        ? [
            { type: 'text' as const, text: message.content },
            ...message.toolCalls.map((toolCall) => ({
              type: 'tool_use' as const,
              id: toolCall.id,
              name: toolCall.name,
              input: sanitizeToolCallArguments(toolCall.arguments),
            })),
          ]
        : buildClaudeImageContent(message.content, message.images) ?? message.content,
    }));
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
        }, signal);

        let responseId = '';
        let content = '';
        let finishReason = 'end_turn';
        let usage: ClaudeResponse['usage'];
        const toolCallStates: ClaudeStreamingToolState[] = [];

        await readSseStream(response, (payloadLine) => {
          const chunk = JSON.parse(payloadLine) as ClaudeStreamChunk;
          usage = chunk.usage ?? chunk.message?.usage ?? usage;

          if (chunk.type === 'message_start') {
            responseId = chunk.message?.id ?? responseId;
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
            finishReason = chunk.delta?.stop_reason ?? finishReason;
          }
        }, signal);

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
        hasEmitted: () => emitted,
        onRetry: (attempt, err) =>
          log.warn('LLM stream idle timeout, retrying', {
            model: payload.model,
            attempt,
            error: err.message,
          }),
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

    const data = (await response.json()) as ClaudeResponse;
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
      temperature: request.temperature ?? 0.7,
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
