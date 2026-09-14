/**
 * ResponseProvider: OpenAI Responses API / Volcengine ARK Responses 兼容适配器
 *
 * 用于对接 POST /v1/responses（或 /responses）的 Responses API 规范服务。
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
  finalizeStreamingToolCalls,
  isRetriableStreamErrorType,
  readSseStream,
  safeParseToolArguments,
  StreamIdleTimeoutError,
  withStreamIdleRetry,
} from './streaming';
import { DEFAULT_MAX_TOKENS } from '../tokenLimits';
import { shouldSendReasoningEffort, shouldSendThinkingType } from './thinkingPayload';
import {
  applyOpencodeGatewayHeaders,
  isOpencodeGatewayBase,
  resolveOpencodeSessionId,
} from './opencodeGateway';

const log = new Logger('ResponseProvider');

export { CODEPAPR_OPENCODE_USER_AGENT } from './opencodeGateway';

interface ResponseUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
  };
  output_tokens_details?: {
    reasoning_tokens?: number;
  };
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ResponseOutputMessagePart {
  type?: 'output_text' | 'text' | 'reasoning_text' | 'reasoning' | 'summary_text' | string;
  text?: string;
}

interface ResponseReasoningSummaryPart {
  type?: string;
  text?: string;
}

interface ResponseOutputItem {
  id?: string;
  type?: 'message' | 'function_call' | 'reasoning' | 'reasoning_summary' | string;
  role?: 'assistant' | string;
  name?: string;
  call_id?: string;
  arguments?: string;
  content?: string | ResponseOutputMessagePart[];
  summary?: string | ResponseReasoningSummaryPart[];
  text?: string;
  status?: string;
}

interface ResponseObject {
  id?: string;
  object?: string;
  status?: string;
  model?: string;
  output?: ResponseOutputItem[];
  choices?: Array<{
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
  usage?: ResponseUsage;
  system_fingerprint?: string;
  error?: {
    message?: string;
    type?: string;
  };
}

interface ResponseStreamChunk {
  type?: string;
  id?: string;
  delta?: string | { text?: string; content?: string };
  text?: string;
  call_id?: string;
  item_id?: string;
  item?: ResponseOutputItem;
  part?: ResponseOutputMessagePart;
  response?: ResponseObject;
  choices?: Array<{
    index?: number;
    delta?: {
      content?: string;
      reasoning_content?: string;
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
  usage?: ResponseUsage;
  error?: {
    message?: string;
    type?: string;
  };
}

const REASONING_DELTA_EVENT_TYPES = new Set([
  'response.reasoning_text.delta',
  'response.reasoning_summary_text.delta',
  'response.reasoning.delta',
  'response.thought.delta',
  'response.reasoning_summary_part.added',
]);

const REASONING_DONE_EVENT_TYPES = new Set([
  'response.reasoning_text.done',
  'response.reasoning_summary_text.done',
]);

function getResponseCachedTokens(usage: ResponseUsage | undefined): number {
  return (
    usage?.cache_read_input_tokens ??
    usage?.input_tokens_details?.cached_tokens ??
    usage?.prompt_tokens_details?.cached_tokens ??
    0
  );
}

function getResponseCreationTokens(usage: ResponseUsage | undefined): number {
  return usage?.cache_creation_input_tokens ?? 0;
}

function hasNestedCachedTokenDetails(usage: ResponseUsage | undefined): boolean {
  return (
    typeof usage?.input_tokens_details?.cached_tokens === 'number' ||
    typeof usage?.prompt_tokens_details?.cached_tokens === 'number'
  );
}

/**
 * CacheValidator treats `input_tokens` as uncached new input, then adds
 * cache_read + cache_creation. OpenAI Responses / Chat Completions report
 * `input_tokens` / `prompt_tokens` as the inclusive prompt total and put
 * hits in nested `*_details.cached_tokens`. Subtract those hits so the
 * dashboard does not double-count. Claude-style payloads (top-level
 * cache_read_input_tokens, no nested details) already send uncached
 * input_tokens — leave them alone.
 */
function getResponseInputTokens(usage: ResponseUsage | undefined): number {
  if (typeof usage?.input_tokens === 'number') {
    if (hasNestedCachedTokenDetails(usage)) {
      return Math.max(0, usage.input_tokens - getResponseCachedTokens(usage));
    }
    return usage.input_tokens;
  }
  const totalPromptTokens = usage?.prompt_tokens ?? 0;
  return Math.max(0, totalPromptTokens - getResponseCachedTokens(usage));
}

function getResponseOutputTokens(usage: ResponseUsage | undefined): number {
  return usage?.output_tokens ?? usage?.completion_tokens ?? 0;
}

/**
 * Responses reasoning.effort：用户选什么/填什么就发什么。
 * 未填才回退 medium（开思考时必须带 effort 字段）。
 */
function resolveResponsesReasoningEffort(effort: string | undefined): string {
  const trimmed = effort?.trim();
  return trimmed || 'medium';
}

function toResponsesAssistantMessage(content: string): {
  type: 'message';
  role: 'assistant';
  content: Array<{ type: 'output_text'; text: string }>;
} {
  return {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: content }],
  };
}

function extractStreamText(chunk: ResponseStreamChunk): string {
  if (typeof chunk.delta === 'string') return chunk.delta;
  if (chunk.delta && typeof chunk.delta === 'object') {
    if (typeof chunk.delta.text === 'string') return chunk.delta.text;
    if (typeof chunk.delta.content === 'string') return chunk.delta.content;
  }
  if (typeof chunk.text === 'string') return chunk.text;
  if (typeof chunk.part?.text === 'string') return chunk.part.text;
  return '';
}

function extractReasoningFromOutputItem(item: ResponseOutputItem): string {
  let text = '';
  if (typeof item.summary === 'string') {
    text += item.summary;
  } else if (Array.isArray(item.summary)) {
    for (const part of item.summary) {
      if (typeof part?.text === 'string') text += part.text;
    }
  }
  if (typeof item.text === 'string') {
    text += item.text;
  }
  if (Array.isArray(item.content)) {
    for (const part of item.content) {
      if (
        part.type === 'reasoning_text' ||
        part.type === 'reasoning' ||
        part.type === 'summary_text'
      ) {
        text += part.text ?? '';
      }
    }
  }
  return text;
}

function appendReasoningDelta(
  current: string,
  delta: string,
  onEvent: (event: IChatStreamEvent) => void
): string {
  if (!delta) return current;
  onEvent({ type: 'reasoning-delta', delta });
  return current + delta;
}

/** Responses 把同一 function_call 拆成 output item id（fc_…）和 call_id（call_…）。 */
interface ResponsesToolCallState {
  id: string;
  itemId?: string;
  name: string;
  argumentsText: string;
  announced: boolean;
}

function findResponsesToolCall(
  states: ResponsesToolCallState[],
  callId?: string,
  itemId?: string,
): ResponsesToolCallState | undefined {
  const call = callId?.trim();
  const item = itemId?.trim();
  if (call) {
    const hit = states.find((state) => state.id === call || state.itemId === call);
    if (hit) return hit;
  }
  if (item) {
    const hit = states.find((state) => state.id === item || state.itemId === item);
    if (hit) return hit;
  }
  return undefined;
}

function upsertResponsesToolCall(
  states: ResponsesToolCallState[],
  patch: {
    callId?: string;
    itemId?: string;
    name?: string;
    argumentsText?: string;
    appendArguments?: string;
  },
): ResponsesToolCallState {
  let state = findResponsesToolCall(states, patch.callId, patch.itemId);
  if (!state) {
    const id = (patch.callId || patch.itemId || `call-${states.length}`).trim() || `call-${states.length}`;
    state = {
      id,
      itemId: patch.itemId?.trim() || undefined,
      name: '',
      argumentsText: '',
      announced: false,
    };
    states.push(state);
  }
  const callId = patch.callId?.trim();
  if (callId) state.id = callId;
  if (patch.itemId?.trim()) state.itemId = patch.itemId.trim();
  if (patch.name?.trim()) state.name = patch.name.trim();
  if (typeof patch.argumentsText === 'string' && patch.argumentsText.length > 0) {
    state.argumentsText = patch.argumentsText;
  }
  if (patch.appendArguments) {
    state.argumentsText += patch.appendArguments;
  }
  return state;
}

function announceToolCallStart(
  state: ResponsesToolCallState,
  onEvent: (event: IChatStreamEvent) => void,
): void {
  if (state.announced) return;
  const name = state.name.trim();
  if (!name) return;
  state.announced = true;
  onEvent({
    type: 'tool-call-start',
    toolCallId: state.id,
    toolName: name,
    arguments: safeParseToolArguments(state.argumentsText.trim() || '{}'),
  });
}

function extractAssistantTextFromOutputItem(item: ResponseOutputItem): string {
  if (typeof item.content === 'string') return item.content;
  if (!Array.isArray(item.content)) return '';
  let text = '';
  for (const part of item.content) {
    if (part.type === 'output_text' || part.type === 'text' || !part.type) {
      text += part.text ?? '';
    }
  }
  return text;
}

function appendUniqueText(
  current: string,
  incoming: string,
  onDelta: (delta: string) => void,
): string {
  if (!incoming) return current;
  if (!current) {
    onDelta(incoming);
    return incoming;
  }
  if (incoming === current || current.includes(incoming)) return current;
  if (incoming.startsWith(current)) {
    const remainder = incoming.slice(current.length);
    if (remainder) onDelta(remainder);
    return incoming;
  }
  return current;
}

function finalizeNamedResponsesToolCalls(
  states: ResponsesToolCallState[],
): IToolCall[] | undefined {
  const named = states.filter((state) => state.name.trim().length > 0);
  return finalizeStreamingToolCalls(named);
}

export class ResponseProvider extends BaseLLMProvider {
  name = 'response';
  models = ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'doubao-seed-2-1-pro-260628'];

  private readonly opencodeSessionId: string;

  constructor(config: ProviderConfig) {
    super({
      baseURL: 'https://api.openai.com/v1',
      ...config,
    });
    this.opencodeSessionId = resolveOpencodeSessionId(config.sessionId);
  }

  /** OpenCode 网关强制要求会话路由头（缺失 → 400 MissingSessionID），
   *  并要求客户端以专属 User-Agent 标识自己（而非通用 HTTP 库默认值）。
   *  其余 Responses 兼容网关不注入任何额外头。 */
  private requestHeaders(): Record<string, string> {
    return applyOpencodeGatewayHeaders(
      {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      {
        baseURL: this.config.baseURL,
        sessionId: this.opencodeSessionId,
        sessionClient: this.config.sessionClient,
      }
    );
  }

  private getEndpointUrl(): string {
    const base = (this.config.baseURL ?? 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
    if (base.endsWith('/responses')) {
      return base;
    }
    return `${base}/responses`;
  }

  async streamChat(
    request: IChatRequest,
    onEvent: (event: IChatStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<IChatResponse> {
    const url = this.getEndpointUrl();
    const payload = this.buildPayload(request, true);

    log.info('LLM Responses API request started', {
      model: payload.model,
      stream: true,
      inputCount: payload.input.length,
    });

    return withStreamIdleRetry(
      async () => {
        const response = await this.fetchWithRetry(
          url,
          {
            method: 'POST',
            headers: this.requestHeaders(),
            body: sortedStringify(payload),
          },
          signal,
          (attempt, maxRetries, err) => {
            onEvent({
              type: 'request-retry',
              attempt,
              maxRetries,
            });
            log.warn('LLM Responses API request failed, retrying', {
              model: payload.model,
              attempt,
              maxRetries,
              error: err.message,
            });
          }
        );

        let responseId = '';
        let content = '';
        let reasoningContent = '';
        let finishReason = 'stop';
        let usage: ResponseUsage | undefined;
        let sawDone = false;
        let sawFinishReason = false;
        // response.completed/done 事件携带的最终状态('completed'/'incomplete'/'failed')。
        // 网关截断时可能缺失——缺失时靠 usage 输出 token 达顶作为截断证据。
        let responseStatus: string | undefined;
        const toolCallStates: ResponsesToolCallState[] = [];

        try {
          await readSseStream(response, (rawData) => {
            // 进度协议：只有真实输出（content/reasoning/tool-call）才续命空闲
            // 超时；心跳/usage/response.created 等元数据不算（心跳不续命）。
            let progress = false;
            const emit = (event: IChatStreamEvent): void => {
              if (
                event.type === 'content-delta' ||
                event.type === 'reasoning-delta' ||
                event.type === 'tool-call-start'
              ) {
                progress = true;
              }
              onEvent(event);
            };
            if (rawData === '[DONE]') {
              sawDone = true;
              return false;
            }

            let chunk: ResponseStreamChunk;
            try {
              chunk = JSON.parse(rawData) as ResponseStreamChunk;
            } catch (err) {
              log.warn('Failed to parse SSE line from Responses API', {
                rawData: rawData.slice(0, 200),
                error: (err as Error).message,
              });
              return false;
            }

            if (chunk.error) {
              const msg = chunk.error.message || 'Responses API stream error';
              const isRetriable = isRetriableStreamErrorType(chunk.error.type);
              throw new ProviderRequestError({
                provider: this.name,
                message: msg,
                retriable: isRetriable,
              });
            }

            // 1. Response metadata
            if (chunk.id) {
              responseId = chunk.id;
            }
            if (chunk.response?.id) {
              responseId = chunk.response.id;
            }

            const eventType = chunk.type ?? '';

            // 2. Output item tracking
            if (
              (eventType === 'response.output_item.added' || eventType === 'response.output_item.done') &&
              chunk.item
            ) {
              if (chunk.item.type === 'function_call') {
                const state = upsertResponsesToolCall(toolCallStates, {
                  callId: chunk.item.call_id,
                  itemId: chunk.item.id,
                  name: chunk.item.name,
                  argumentsText: chunk.item.arguments,
                });
                announceToolCallStart(state, emit);
              } else if (chunk.item.type === 'reasoning' || chunk.item.type === 'reasoning_summary') {
                reasoningContent = appendUniqueText(
                  reasoningContent,
                  extractReasoningFromOutputItem(chunk.item),
                  (delta) => emit({ type: 'reasoning-delta', delta }),
                );
              } else if (chunk.item.type === 'message' || chunk.item.role === 'assistant') {
                content = appendUniqueText(
                  content,
                  extractAssistantTextFromOutputItem(chunk.item),
                  (delta) => emit({ type: 'content-delta', delta }),
                );
              }
            }

            // 3. Text delta
            if (
              eventType === 'response.output_text.delta' ||
              eventType === 'response.text.delta'
            ) {
              const delta = extractStreamText(chunk);
              if (delta) {
                content += delta;
                emit({ type: 'content-delta', delta });
              }
            }

            // 4. Reasoning delta / done
            if (REASONING_DELTA_EVENT_TYPES.has(eventType)) {
              reasoningContent = appendReasoningDelta(reasoningContent, extractStreamText(chunk), emit);
            } else if (REASONING_DONE_EVENT_TYPES.has(eventType)) {
              const fullText = extractStreamText(chunk);
              if (fullText && !reasoningContent.includes(fullText)) {
                const remainder = fullText.startsWith(reasoningContent)
                  ? fullText.slice(reasoningContent.length)
                  : reasoningContent
                    ? ''
                    : fullText;
                if (remainder) {
                  reasoningContent = appendReasoningDelta(reasoningContent, remainder, emit);
                } else if (!reasoningContent) {
                  reasoningContent = appendReasoningDelta(reasoningContent, fullText, emit);
                }
              }
            }

            // 5. Function call arguments delta
            if (
              eventType === 'response.function_call_arguments.delta' ||
              eventType === 'response.function_call.delta'
            ) {
              const delta = extractStreamText(chunk);
              if (delta) {
                if (chunk.call_id || chunk.item_id) {
                  const state = upsertResponsesToolCall(toolCallStates, {
                    callId: chunk.call_id,
                    itemId: chunk.item_id,
                    appendArguments: delta,
                  });
                  announceToolCallStart(state, emit);
                } else if (toolCallStates.length > 0) {
                  const state = toolCallStates[toolCallStates.length - 1];
                  state.argumentsText += delta;
                  announceToolCallStart(state, emit);
                }
              }
            }

            // 6. Response completion
            if (
              eventType === 'response.completed' ||
              eventType === 'response.done'
            ) {
              sawDone = true;
              // 终止信号以 response.status 为准（'incomplete' = 输出达到
              // max_output_tokens 上限被截断）。不在此处置 sawFinishReason——
              // 那是 choices 兼容路径 finish_reason 的专用标志。
              if (chunk.response?.status) {
                responseStatus = chunk.response.status;
              }
              if (chunk.response?.usage) {
                usage = chunk.response.usage;
              } else if (chunk.usage) {
                usage = chunk.usage;
              }
              if (Array.isArray(chunk.response?.output)) {
                for (const item of chunk.response.output) {
                  if (item.type === 'reasoning' || item.type === 'reasoning_summary') {
                    reasoningContent = appendUniqueText(
                      reasoningContent,
                      extractReasoningFromOutputItem(item),
                      (delta) => emit({ type: 'reasoning-delta', delta }),
                    );
                  } else if (item.type === 'message' || item.role === 'assistant') {
                    content = appendUniqueText(
                      content,
                      extractAssistantTextFromOutputItem(item),
                      (delta) => emit({ type: 'content-delta', delta }),
                    );
                  } else if (item.type === 'function_call') {
                    const state = upsertResponsesToolCall(toolCallStates, {
                      callId: item.call_id,
                      itemId: item.id,
                      name: item.name,
                      argumentsText: item.arguments,
                    });
                    announceToolCallStart(state, emit);
                  }
                }
              }
            }

            // 7. Compatible choices fallback
            if (chunk.choices?.length) {
              for (const choice of chunk.choices) {
                const delta = choice.delta;
                if (!delta) continue;

                if (delta.content) {
                  content += delta.content;
                  emit({ type: 'content-delta', delta: delta.content });
                }

                const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
                if (reasoningDelta) {
                  reasoningContent += reasoningDelta;
                  emit({ type: 'reasoning-delta', delta: reasoningDelta });
                }

                if (delta.tool_calls?.length) {
                  for (const tc of delta.tool_calls) {
                    const state = upsertResponsesToolCall(toolCallStates, {
                      callId: tc.id,
                      name: tc.function?.name,
                      appendArguments: tc.function?.arguments,
                    });
                    announceToolCallStart(state, emit);
                  }
                }

                if (choice.finish_reason) {
                  finishReason = choice.finish_reason;
                  sawFinishReason = true;
                }
              }
            }

            if (chunk.usage) {
              usage = chunk.usage;
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
          if (err instanceof ProviderRequestError) {
            throw err;
          }
          throw new ProviderRequestError({
            provider: this.name,
            message: `Stream interrupted: ${err instanceof Error ? err.message : String(err)}`,
            retriable: true,
          });
        }

        // 流干净地结束但没有任何终止信号（response.completed/done 或 choices
        // finish_reason）：典型是中转/网关截断后直接关连接。即使已发出部分内容
        // 也绝不能当正常完成处理——抛可重试错误走流层重试（部分内容由
        // stream-restart 流程丢弃）。usage 不算终止信号：截断流常常先发 usage。
        if (!sawDone && !sawFinishReason) {
          throw new ProviderRequestError({
            provider: this.name,
            message: 'Stream ended prematurely: no completion event or finish_reason received',
            retriable: true,
          });
        }

        if (responseStatus === 'failed' || responseStatus === 'cancelled') {
          throw new ProviderRequestError({
            provider: this.name,
            message: `Responses API stream ended with status '${responseStatus}'`,
            retriable: true,
          });
        }

        const effectiveToolCalls = finalizeNamedResponsesToolCalls(toolCallStates);
        const outputTokensSeen = getResponseOutputTokens(usage);
        const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;

        let effectiveFinishReason: string;
        if (responseStatus === 'incomplete') {
          // 输出达到 max_output_tokens 被截断：映射 'length' 走 Agent 续写守卫。
          // 优先于 tool_calls——截断的 tool call JSON 绝不能执行。
          effectiveFinishReason = 'length';
        } else if (effectiveToolCalls && effectiveToolCalls.length > 0) {
          effectiveFinishReason = 'tool_calls';
        } else if (responseStatus === 'completed') {
          effectiveFinishReason = sawFinishReason ? finishReason : 'stop';
        } else {
          // 收到终止信号但无最终状态（部分中转只发 response.done/[DONE]）：
          // 与 OpenAIProvider 对齐——绝不默认伪装 'stop'，以输出 token 达顶作
          // 截断证据降级 'length'，否则显式标记 'unknown'。
          effectiveFinishReason = sawFinishReason
            ? finishReason
            : outputTokensSeen >= maxTokens
              ? 'length'
              : 'unknown';
        }

        const result: IChatResponse = {
          id: responseId,
          choices: [
            {
              message: {
                role: 'assistant',
                content,
                reasoningContent: reasoningContent || undefined,
                toolCalls: effectiveToolCalls,
              },
              finishReason: effectiveFinishReason,
            },
          ],
          usage: {
            cache_read_input_tokens: getResponseCachedTokens(usage),
            cache_creation_input_tokens: getResponseCreationTokens(usage),
            input_tokens: getResponseInputTokens(usage),
            output_tokens: getResponseOutputTokens(usage),
          },
        };

        log.info('LLM Responses API request completed', {
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
        maxRetries: this.config.streamMaxRetries,
        retryDelayMs: this.config.streamRetryDelayMs,
        onRetry: (attempt, err) => {
          onEvent({ type: 'stream-restart', attempt, maxRetries: this.config.streamMaxRetries });
          log.warn('LLM Responses stream interrupted, retrying', {
            model: payload.model,
            attempt,
            error: err.message,
          });
        },
      }
    );
  }

  async chat(request: IChatRequest, signal?: AbortSignal): Promise<IChatResponse> {
    const url = this.getEndpointUrl();
    const payload = this.buildPayload(request, false);

    log.info('LLM Responses API non-streaming request started', {
      inputCount: payload.input.length,
      model: payload.model,
      stream: false,
    });

    const protection: { release: () => void } = { release: () => undefined };
    const response = await this.fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: this.requestHeaders(),
        body: sortedStringify(payload),
      },
      signal,
      undefined,
      protection
    );

    let data: ResponseObject;
    try {
      data = (await response.json()) as ResponseObject;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      throw new ProviderRequestError({
        provider: this.name,
        message: `响应不是合法 JSON: ${(err as Error).message}`,
        retriable: false,
      });
    } finally {
      protection.release();
    }

    log.info('LLM Responses API non-streaming request completed', {
      model: payload.model,
      stream: false,
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    });

    return this.transformResponse(data);
  }

  private transformResponse(data: ResponseObject): IChatResponse {
    let content = '';
    let reasoningContent = '';
    const toolCalls: IToolCall[] = [];

    if (Array.isArray(data.output)) {
      for (const item of data.output) {
        if (item.type === 'message' || item.role === 'assistant') {
          if (typeof item.content === 'string') {
            content += item.content;
          } else if (Array.isArray(item.content)) {
            for (const part of item.content) {
              if (part.type === 'output_text' || part.type === 'text' || !part.type) {
                content += part.text ?? '';
              } else if (part.type === 'reasoning_text' || part.type === 'reasoning') {
                reasoningContent += part.text ?? '';
              }
            }
          }
        } else if (item.type === 'reasoning' || item.type === 'reasoning_summary') {
          reasoningContent += extractReasoningFromOutputItem(item);
        } else if (item.type === 'function_call') {
          toolCalls.push({
            id: item.call_id || item.id || `call-${toolCalls.length}`,
            name: item.name || '',
            arguments: safeParseToolArguments(item.arguments || '{}'),
          });
        }
      }
    } else if (data.choices?.length) {
      const choice = data.choices[0];
      if (typeof choice.message.content === 'string') {
        content = choice.message.content;
      } else if (Array.isArray(choice.message.content)) {
        content = choice.message.content.map((p) => p.text ?? '').join('');
      }
      if (choice.message.reasoning_content) {
        reasoningContent = choice.message.reasoning_content;
      }
      if (choice.message.tool_calls?.length) {
        for (const tc of choice.message.tool_calls) {
          toolCalls.push({
            id: tc.id,
            name: tc.function.name,
            arguments: safeParseToolArguments(tc.function.arguments),
          });
        }
      }
    }

    if (data.status === 'failed' || data.status === 'cancelled') {
      throw new ProviderRequestError({
        provider: this.name,
        message: data.error?.message || `Responses API response ended with status '${data.status}'`,
        retriable: true,
      });
    }

    let finishReason: string;
    if (data.status === 'incomplete') {
      // 输出达到 max_output_tokens 被截断：映射 'length' 走 Agent 续写守卫，
      // 且优先于 tool_calls——截断的 tool call JSON 绝不能执行。
      finishReason = 'length';
    } else if (toolCalls.length > 0) {
      finishReason = 'tool_calls';
    } else if (data.status === 'completed') {
      finishReason = 'stop';
    } else {
      // 无 status 字段的中转响应：不伪装成模型主动停止。
      finishReason = 'unknown';
    }

    return {
      id: data.id || '',
      choices: [
        {
          message: {
            role: 'assistant',
            content,
            reasoningContent: reasoningContent || undefined,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          },
          finishReason,
        },
      ],
      usage: {
        cache_read_input_tokens: getResponseCachedTokens(data.usage),
        cache_creation_input_tokens: getResponseCreationTokens(data.usage),
        input_tokens: getResponseInputTokens(data.usage),
        output_tokens: getResponseOutputTokens(data.usage),
      },
      system_fingerprint: data.system_fingerprint,
    };
  }

  private buildPayload(request: IChatRequest, stream: boolean = false): {
    model: string;
    input: unknown[];
    stream: boolean;
    max_output_tokens: number;
    temperature?: number;
    top_p?: number;
    tools?: Array<{
      type: 'function';
      name: string;
      description: string;
      parameters: unknown;
      function?: { name: string; description: string; parameters: unknown };
    }>;
    thinking?: { type: string };
    reasoning?: { effort: string; summary?: string };
  } {
    const inputItems: unknown[] = [];

    for (const msg of request.messages) {
      if (msg.role === 'system') {
        inputItems.push({
          role: 'system',
          content: msg.content,
        });
      } else if (msg.role === 'user') {
        // 空 data 的图片（落盘引用未回填成功）跳过，避免构造出非法 image_url。
        const usableImages = (msg.images ?? []).filter((img) => Boolean(img.data));
        if (usableImages.length > 0) {
          const contentParts: Array<{ type: string; text?: string; image_url?: string }> = [];
          if (msg.content) {
            contentParts.push({ type: 'input_text', text: msg.content });
          }
          for (const img of usableImages) {
            contentParts.push({
              type: 'input_image',
              image_url: `data:${img.mediaType};base64,${img.data}`,
            });
          }
          inputItems.push({ role: 'user', content: contentParts });
        } else {
          inputItems.push({ role: 'user', content: msg.content });
        }
      } else if (msg.role === 'assistant') {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          if (msg.content) {
            inputItems.push(toResponsesAssistantMessage(msg.content));
          }
          for (const tc of msg.toolCalls) {
            const rawArgs = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments);
            const callName = typeof tc.name === 'string' && tc.name.trim().length > 0 ? tc.name.trim() : 'tool';
            inputItems.push({
              type: 'function_call',
              call_id: tc.id || `call-${inputItems.length}`,
              name: callName,
              arguments: rawArgs,
            });
          }
        } else {
          inputItems.push(toResponsesAssistantMessage(msg.content ?? ''));
        }
      } else if (msg.role === 'tool') {
        const callId = msg.toolResult?.toolCallId || (msg.metadata?.toolCallId as string) || `call-${inputItems.length}`;
        const toolName = msg.metadata?.toolName || (msg.toolResult as { toolName?: string })?.toolName;
        inputItems.push({
          type: 'function_call_output',
          call_id: callId,
          ...(typeof toolName === 'string' && toolName.trim().length > 0 ? { name: toolName.trim() } : {}),
          output: msg.content,
        });
      }
    }

    const payload: {
      model: string;
      input: unknown[];
      stream: boolean;
      max_output_tokens: number;
      temperature?: number;
      top_p?: number;
      tools?: Array<{
        type: 'function';
        name: string;
        description: string;
        parameters: unknown;
        function?: { name: string; description: string; parameters: unknown };
      }>;
      thinking?: { type: string };
      reasoning?: { effort: string; summary?: string };
    } = {
      model: request.model,
      input: inputItems,
      stream,
      max_output_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    };

    if (request.tools && request.tools.length > 0) {
      payload.tools = request.tools
        .filter((t) => typeof t?.name === 'string' && t.name.trim().length > 0)
        .map((t) => {
          const name = t.name.trim();
          const description = t.description || '';
          const parameters = t.parameters || { type: 'object', properties: {} };
          // Responses API 规范为扁平结构 { type: 'function', name, description,
          // parameters }——与 Chat Completions 的 function 包装相反。额外嵌套的
          // function 字段属非标准,严格网关可能 400,且会白白增大序列化体积。
          return {
            type: 'function' as const,
            name,
            description,
            parameters,
          };
        });
    }

    if (typeof request.temperature === 'number') {
      payload.temperature = request.temperature;
    }
    if (typeof request.topP === 'number') {
      payload.top_p = request.topP;
    }

    // 思考字段由模型配置的 thinkingPayload 决定，不再按域名猜测。
    if (request.thinking) {
      const thinkingType = request.thinking.type || 'enabled';
      if (shouldSendThinkingType(request)) {
        payload.thinking = { type: thinkingType };
      }
      if (shouldSendReasoningEffort(request)) {
        payload.reasoning = {
          effort: resolveResponsesReasoningEffort(request.thinking.reasoningEffort),
          summary: 'auto',
        };
      }
    }

    // OpenCode Go 网关：开启会话级缓存路由、关闭服务端存储（与 x-opencode-* 头配套）。
    const extra: Record<string, unknown> = {};
    if (isOpencodeGatewayBase(this.config.baseURL)) {
      extra.prompt_cache_key = true;
      extra.store = false;
    }

    return { ...payload, ...extra };
  }
}
