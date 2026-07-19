/**
 * Agent: 主编排类
 *
 * 通过依赖注入接受 RequestBuilder 和 CacheValidator (避免与 @codepapr/api 形成循环依赖)
 *
 * 单轮流程:
 *  1. 追加用户消息到 AppendOnlyLog
 *  2. 重置 VolatileScratch
 *  3. RequestBuilder 8 点验证 + 构造请求
 *  4. Provider 发送请求
 *  5. CacheValidator 验证响应
 *  6. 追加 assistant 消息
 *  7. 若有工具调用：执行工具 -> 追加 tool 结果 -> 递归
 *  8. 记录缓存统计
 */

import {
  ILLMProvider,
  IAgentResponse,
  IChatStreamEvent,
  IToolCall,
  ICacheStatistics,
  IChatThinking,
  IChatRequest,
  IImageContent,
  IChatResponse,
  ICacheValidation,
  IImmutablePrefix,
  IAppendOnlyLog,
  IToolDefinition,
  QuestionData,
} from '@codepapr/types';
import { Logger } from '@codepapr/common';
import { Session, mergeOptionalTokenCount } from './Session';
import { MessageFactory } from '../message/Message';

const log = new Logger('Agent');

const DEFAULT_TOOL_TIMEOUT_MS = 270_000;

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('已取消', 'AbortError'));
  }

  return new Promise<T>((resolve, reject) => {
    const state = { settled: false, timer: undefined as ReturnType<typeof setTimeout> | undefined };

    const onAbort = () => {
      if (state.timer !== undefined) clearTimeout(state.timer);
      if (!state.settled) {
        state.settled = true;
        reject(new DOMException('已取消', 'AbortError'));
      }
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    state.timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      if (!state.settled) {
        state.settled = true;
        reject(new Error(`工具执行超时 (${timeoutMs / 1000}s)`));
      }
    }, timeoutMs);

    promise.then(
      (result) => {
        if (state.timer !== undefined) clearTimeout(state.timer);
        signal?.removeEventListener('abort', onAbort);
        if (!state.settled) {
          state.settled = true;
          resolve(result);
        }
      },
      (err) => {
        if (state.timer !== undefined) clearTimeout(state.timer);
        signal?.removeEventListener('abort', onAbort);
        if (!state.settled) {
          state.settled = true;
          reject(err);
        }
      }
    );
  });
}

function buildRequestContextDebugText(request: IChatRequest, round: number): string {
  const debugPayload = {
    round,
    model: request.model,
    thinking: request.thinking,
    temperature: request.temperature,
    topP: request.topP,
    maxTokens: request.maxTokens,
    cacheControl: request.cacheControl,
    metadata: request.metadata,
    tools:
      request.tools?.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })) ?? [],
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.reasoningContent
        ? { reasoningContent: message.reasoningContent }
        : {}),
      ...(message.toolCalls
        ? {
            toolCalls: message.toolCalls.map((toolCall) => ({
              id: toolCall.id,
              name: toolCall.name,
              arguments: toolCall.arguments,
            })),
          }
        : {}),
      ...(message.toolResult
        ? {
            toolResult: {
              toolCallId: message.toolResult.toolCallId,
              result: message.toolResult.result,
              error: message.toolResult.error,
            },
          }
        : {}),
    })),
  };

  return JSON.stringify(debugPayload, null, 2);
}

function accumulateStats(
  accumulated: ICacheStatistics | undefined,
  next: ICacheStatistics
): ICacheStatistics {
  const promptCacheHitTokens = mergeOptionalTokenCount(
    accumulated?.promptCacheHitTokens,
    next.promptCacheHitTokens
  );
  const promptCacheMissTokens = mergeOptionalTokenCount(
    accumulated?.promptCacheMissTokens,
    next.promptCacheMissTokens
  );

  const merged = {
    cacheCreationTokens: (accumulated?.cacheCreationTokens ?? 0) + next.cacheCreationTokens,
    cacheReadTokens: (accumulated?.cacheReadTokens ?? 0) + next.cacheReadTokens,
    newInputTokens: (accumulated?.newInputTokens ?? 0) + next.newInputTokens,
    outputTokens: (accumulated?.outputTokens ?? 0) + next.outputTokens,
    cacheHitRate: 0,
  };
  const totalInput =
    merged.cacheCreationTokens + merged.cacheReadTokens + merged.newInputTokens;

  return {
    ...merged,
    cacheHitRate: totalInput > 0 ? merged.cacheReadTokens / totalInput : 0,
    calls: (accumulated?.calls ?? 0) + (next.calls ?? 0),
    ...(typeof promptCacheHitTokens === 'number'
      ? { promptCacheHitTokens }
      : {}),
    ...(typeof promptCacheMissTokens === 'number'
      ? { promptCacheMissTokens }
      : {}),
  };
}

function buildDeepSeekThinking(params: Record<string, unknown>): IChatThinking {
  const type = params.thinkingEnabled === false ? 'disabled' : 'enabled';
  const reasoningEffort =
    params.reasoningEffort === 'max' || params.reasoningEffort === 'high'
      ? params.reasoningEffort
      : undefined;

  return reasoningEffort ? { type, reasoningEffort } : { type };
}

function isImageError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const error = err as Record<string, unknown>;
  if (error.status !== 400 && error.status !== '400') return false;
  const msg = typeof error.message === 'string' ? error.message : '';
  return /image|dimension|pixel/i.test(msg);
}

export interface IRequestBuilder {
  build(opts: {
    prefix: IImmutablePrefix;
    appendLog: IAppendOnlyLog;
    model: string;
    provider: 'deepseek' | 'openai' | 'claude';
    thinking?: IChatThinking;
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    tools?: IToolDefinition[];
  }): IChatRequest;
  syncAfterPop?(appendLog: IAppendOnlyLog): void;
}

export interface ICacheValidator {
  validate(
    request: IChatRequest,
    response: IChatResponse,
    localPrefixHash: string,
    localLogHash: string
  ): ICacheValidation;
}

export interface AgentOptions {
  session: Session;
  provider: ILLMProvider;
  providerName: 'deepseek' | 'openai' | 'claude';
  requestBuilder: IRequestBuilder;
  cacheValidator: ICacheValidator;
  maxToolRounds?: number;
  toolTimeouts?: Record<string, number>;
}

export const DEFAULT_AGENT_MAX_TOOL_ROUNDS = 500;

function normalizeMaxToolRounds(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_AGENT_MAX_TOOL_ROUNDS;
  }

  return Math.max(1, Math.floor(value));
}

export class Agent {
  private session: Session;
  private provider: ILLMProvider;
  private providerName: 'deepseek' | 'openai' | 'claude';
  private requestBuilder: IRequestBuilder;
  private cacheValidator: ICacheValidator;
  private maxToolRounds: number;
  private toolTimeouts: Record<string, number>;
  private abortController: AbortController | null = null;

  constructor(opts: AgentOptions) {
    this.session = opts.session;
    this.provider = opts.provider;
    this.providerName = opts.providerName;
    this.requestBuilder = opts.requestBuilder;
    this.cacheValidator = opts.cacheValidator;
    this.maxToolRounds = normalizeMaxToolRounds(opts.maxToolRounds);
    this.toolTimeouts = opts.toolTimeouts ?? {};
  }

  getSession(): Session {
    return this.session;
  }

  cancel(): void {
    this.abortController?.abort();
  }

  destroy(): void {
    this.cancel();
  }

  async chat(
    userInput: string,
    onStreamEvent?: (event: IChatStreamEvent) => void,
    images?: IImageContent[],
    signal?: AbortSignal
  ): Promise<IAgentResponse> {
    const effectiveSignal = signal ?? (() => {
      const controller = new AbortController();
      this.abortController = controller;
      return controller.signal;
    })();
    const userMsg = MessageFactory.user(userInput, images);
    await this.session.logStore.append(userMsg);

    this.session.scratch.reset();
    this.session.scratch.markRoundStart();

    this.session.partition.validate();

    let finalContent = '';
    let finalReasoningContent: string | undefined;
    let finalToolCalls: IToolCall[] | undefined;
    let aggregatedStats: ICacheStatistics | undefined;
    let question: QuestionData | undefined;

    for (let round = 0; round < this.maxToolRounds; round++) {
      if (effectiveSignal?.aborted) {
        break;
      }

      const roundNumber = round + 1;
      if (round > 0) {
        onStreamEvent?.({
          type: 'assistant-round-start',
          round: roundNumber,
        });
      }

      const params = this.session.prefix.getParameters();
      const request = this.requestBuilder.build({
        prefix: this.session.prefix,
        appendLog: this.session.logStore,
        model: this.session.prefix.getModelName(),
        provider: this.providerName,
        thinking:
          this.providerName === 'deepseek'
            ? buildDeepSeekThinking(params as Record<string, unknown>)
            : undefined,
        temperature: params.temperature,
        topP: params.topP,
        maxTokens: params.maxTokens,
        tools: [...this.session.prefix.getToolDefinitions()],
      });

      onStreamEvent?.({
        type: 'request-context',
        round: roundNumber,
        content: buildRequestContextDebugText(request, roundNumber),
      });

      let response: IChatResponse;
      try {
        response =
          onStreamEvent && this.provider.streamChat
            ? await this.provider.streamChat(request, onStreamEvent, effectiveSignal)
            : await this.provider.chat(request, effectiveSignal);
      } catch (err) {
        if (isImageError(err)) {
          const lastMsg = this.session.logStore.getLastMessage();
          if (lastMsg?.role === 'user' && lastMsg.images && lastMsg.images.length > 0) {
            this.session.logStore.popLastMessage();
            this.requestBuilder.syncAfterPop?.(this.session.logStore);
          }
          onStreamEvent?.({
            type: 'tool-call-end',
            toolCallId: '',
            toolName: 'multimodal',
            success: false,
            error: `Image rejected: ${(err as Error).message}`,
            output: '',
          });
          continue;
        }
        throw err;
      }

      const validation = this.cacheValidator.validate(
        request,
        response,
        this.session.prefix.computeHash(),
        this.session.logStore.computeHash()
      );

      const stats: ICacheStatistics = {
        cacheCreationTokens: validation.cacheCreationTokens,
        cacheReadTokens: validation.cacheReadTokens,
        newInputTokens: validation.newInputTokens,
        outputTokens: validation.outputTokens,
        cacheHitRate: validation.cacheHitRate,
        promptCacheHitTokens: validation.promptCacheHitTokens,
        promptCacheMissTokens: validation.promptCacheMissTokens,
        calls: 1,
      };
      this.session.recordStats(stats);
      aggregatedStats = accumulateStats(aggregatedStats, stats);

      const choice = response.choices[0];
      if (!choice) throw new Error('No choices in response');
      const assistant = choice.message;

      const assistantMsg = MessageFactory.assistant(
        assistant.content ?? '',
        assistant.toolCalls,
        assistant.reasoningContent
      );
      await this.session.logStore.append(assistantMsg);

      onStreamEvent?.({
        type: 'assistant-round-complete',
        round: roundNumber,
        content: assistant.content ?? '',
        reasoningContent: assistant.reasoningContent,
      });

      finalContent = assistant.content ?? '';
      finalReasoningContent = assistant.reasoningContent;
      finalToolCalls = assistant.toolCalls;

      if (!assistant.toolCalls || assistant.toolCalls.length === 0) {
        break;
      }

      for (const call of assistant.toolCalls) {
        if (effectiveSignal?.aborted) {
          break;
        }

        let result: unknown;
        let success = true;
        let errorMessage: string | undefined;

        onStreamEvent?.({
          type: 'tool-call-start',
          toolCallId: call.id,
          toolName: call.name,
          arguments: call.arguments,
        });

        if (call.arguments._parseError) {
          errorMessage = `工具参数 JSON 解析失败: ${call.arguments.error}. 原始参数(前500字符): ${call.arguments._raw}`;
          result = { error: errorMessage };
          success = false;
          log.error(`Tool argument parse failed: ${call.name}`, { error: errorMessage });
        } else {
          try {
            const toolTimeoutMs = this.toolTimeouts[call.name] ?? DEFAULT_TOOL_TIMEOUT_MS;
            result = await withTimeout(
              this.session.toolRegistry.execute(call.name, call.arguments),
              toolTimeoutMs,
              effectiveSignal
            );
          } catch (err) {
            errorMessage = (err as Error).message;
            result = { error: errorMessage };
            success = false;
            log.error(`Tool execution failed: ${call.name}`, { error: err });
          }
        }
        const toolMsg = MessageFactory.tool(call.id, result, success);
        await this.session.logStore.append(toolMsg);
        onStreamEvent?.({
          type: 'tool-call-end',
          toolCallId: call.id,
          toolName: call.name,
          success,
          error: errorMessage,
          output: typeof result === 'string' ? result : JSON.stringify(result),
        });

        if (result && typeof result === 'object' && '__question' in result && (result as Record<string, unknown>).__question === true) {
          const q = result as Record<string, unknown>;
          question = {
            question: (q.question as string) || '',
            header: (q.header as string) || '',
            options: Array.isArray(q.options) ? q.options as QuestionData['options'] : undefined,
            multiple: q.multiple === true,
          };
        }

        if (result && typeof result === 'object' && '__images' in result) {
          const images = (result as Record<string, unknown>).__images as IImageContent[] | undefined;
          if (images && images.length > 0) {
            const imageMsg = MessageFactory.user(
              `[Image from tool ${call.name}]`,
              images
            );
            await this.session.logStore.append(imageMsg);
          }
        }
      }

      if (question) {
        break;
      }
    }

    this.session.scratch.markRoundEnd();
    this.abortController = null;

    return {
      role: 'assistant',
      content: finalContent,
      reasoningContent: finalReasoningContent,
      toolCalls: finalToolCalls,
      cacheStats: aggregatedStats,
      question,
    };
  }
}
