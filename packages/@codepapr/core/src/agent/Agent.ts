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
  IMessage,
  ISubagentToolInvocation,
  QuestionData,
  IContextSnapshot,
  IContextMessageView,
  ContextStage,
} from '@codepapr/types';
import { Logger, estimateTokens } from '@codepapr/common';
import { Session, mergeOptionalTokenCount } from './Session';
import { MessageFactory } from '../message/Message';
import { Serializer } from '../cache/Serializer';
import {
  truncateToolOutput,
  stringifyToolResult,
  type ToolOutputTruncationOptions,
} from '../tool/toolOutputTruncation';
import {
  prepareHistorySummary,
  TOOL_SUMMARY_METADATA_KEY,
  type ToolContextConfig,
} from '../tool/toolOutputSummary';

const log = new Logger('Agent');

const DEFAULT_TOOL_TIMEOUT_MS = 270_000;

/** 输出被 max_tokens 截断（finish_reason='length'）后，单回合自动续写的上限。
 *  防止遇到中转的极小输出上限时无限续写；达到上限后以已合并内容正常收尾
 *  （绝不报错——任务在后续回合仍可继续）。 */
export const MAX_CONTINUATIONS_PER_ROUND = 12;

/** 截断续写时追加在请求尾部的指令（临时消息，不落日志）。 */
export const CONTINUATION_NUDGE =
  '你上一次的输出因达到最大输出长度而被截断。请从截断处继续输出，不要重复已经输出的内容。';

/** 模型返回空完成（无内容/无思考/无工具调用）时的退避重试延迟（毫秒）。
 *  空完成是瞬态故障，退避重发即可；绝不因空完成而静默结束回合。 */
export const EMPTY_COMPLETION_RETRY_DELAYS_MS: readonly number[] = [
  5_000, 10_000, 15_000, 20_000, 25_000, 30_000,
];

/** 连续空完成达到该次数后关闭 thinking 再试（思考输出异常是常见诱因）。 */
export const EMPTY_COMPLETION_DISABLE_THINKING_AFTER = 5;

/** Tools that can pause while waiting for a user folder-access decision. */
export const PERMISSION_WAITING_TOOL_TIMEOUTS: Readonly<Record<string, number>> = {
  read: Number.POSITIVE_INFINITY,
  list: Number.POSITIVE_INFINITY,
  read_image: Number.POSITIVE_INFINITY,
  write: Number.POSITIVE_INFINITY,
  edit: Number.POSITIVE_INFINITY,
  patch: Number.POSITIVE_INFINITY,
  bash: Number.POSITIVE_INFINITY,
  graph: Number.POSITIVE_INFINITY,
  lsp: Number.POSITIVE_INFINITY,
  diagnostics: Number.POSITIVE_INFINITY,
};

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
  onTimeout?: () => void
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

    if (Number.isFinite(timeoutMs)) {
      state.timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        if (!state.settled) {
          state.settled = true;
          // 超时 ≠ 取消底层执行：让调用方有机会把取消信号下发给正在执行
          // 的工具（如杀掉 bash 子进程），否则工具会在后台继续跑完。
          onTimeout?.();
          reject(new Error(`工具执行超时 (${timeoutMs / 1000}s)`));
        }
      }, timeoutMs);
    }

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

function classifyContextStage(message: IMessage): ContextStage {
  const metadata = message.metadata ?? {};
  if (metadata.sessionBootstrap === true) {
    return 'session-state';
  }
  if (message.role === 'system' || metadata.isPrefixSystem === true) {
    return 'stable-prefix';
  }
  return 'conversation';
}

export interface ContextSnapshotSource {
  model: string;
  messages: IMessage[];
  tools?: IToolDefinition[];
}

export function buildContextSnapshot(request: ContextSnapshotSource, round: number): IContextSnapshot {
  const toolCallNameById = new Map<string, string>();
  for (const message of request.messages) {
    for (const toolCall of message.toolCalls ?? []) {
      toolCallNameById.set(toolCall.id, toolCall.name);
    }
  }

  const tokensByStage: Record<ContextStage, number> = {
    'stable-prefix': 0,
    'session-state': 0,
    conversation: 0,
  };

  const messages: IContextMessageView[] = request.messages.map((message) => {
    const stage = classifyContextStage(message);
    const estimatedTokens = estimateTokens(message.content ?? '');
    tokensByStage[stage] += estimatedTokens;

    const view: IContextMessageView = {
      role: message.role,
      content: message.content ?? '',
      stage,
      estimatedTokens,
    };

    if (message.role === 'tool' && message.toolResult) {
      const toolName = toolCallNameById.get(message.toolResult.toolCallId);
      if (toolName) {
        view.toolName = toolName;
      }
    }

    if (message.toolCalls && message.toolCalls.length > 0) {
      view.toolCallNames = message.toolCalls.map((toolCall) => toolCall.name);
    }

    return view;
  });

  const toolsTokenEstimate = estimateTokens(
    Serializer.stringify(request.tools ?? [])
  );
  tokensByStage['stable-prefix'] += toolsTokenEstimate;

  const toolNames = (request.tools ?? []).map((tool) => tool.name);
  const toolDefinitions = (request.tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));

  const totalTokens =
    tokensByStage['stable-prefix'] +
    tokensByStage['session-state'] +
    tokensByStage.conversation;

  return {
    round,
    model: request.model,
    messages,
    toolNames,
    toolDefinitions,
    toolsTokenEstimate,
    totalTokens,
    tokensByStage,
    capturedAt: Date.now(),
  };
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
    /** 仅影响本次请求的临时尾部消息（不落日志）：用于 max_tokens 截断后的自动续写。 */
    suffixMessages?: IMessage[];
  }): IChatRequest;
  syncAfterPop?(appendLog: IAppendOnlyLog): void;
  resetLogTracking?(): void;
}

export interface ICacheValidator {
  validate(
    request: IChatRequest,
    response: IChatResponse,
    localPrefixHash: string,
    localLogHash: string
  ): ICacheValidation;
}

/**
 * Mid-loop context compaction (OpenCode-style "Context Epoch").
 *
 * Before each tool-loop round the Agent estimates the context size; when it
 * exceeds `maxContextTokens` the `handler` compacts the current history into a
 * checkpoint summary + retained tail, and the Agent replaces its log (a new
 * epoch) and continues. This bounds context within a single agent pass without
 * mutating the prefix on every round (which would break the prompt cache).
 */
export interface ContextCompactionConfig {
  maxContextTokens: number;
  handler: (
    messages: IMessage[]
  ) => Promise<{ messages: IMessage[]; cacheStats?: ICacheStatistics } | null>;
}

export interface AgentOptions {
  session: Session;
  provider: ILLMProvider;
  providerName: 'deepseek' | 'openai' | 'claude';
  requestBuilder: IRequestBuilder;
  cacheValidator: ICacheValidator;
  maxToolRounds?: number;
  toolTimeouts?: Record<string, number>;
  toolOutputTruncation?: ToolOutputTruncationOptions;
  toolContextConfig?: ToolContextConfig;
  contextCompaction?: ContextCompactionConfig;
  /** 空完成退避重试的延迟表（毫秒）。缺省使用 EMPTY_COMPLETION_RETRY_DELAYS_MS；
   *  测试可注入 0 跳过等待。 */
  emptyCompletionRetryDelaysMs?: readonly number[];
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
  private toolOutputTruncation?: ToolOutputTruncationOptions;
  private toolContextConfig?: ToolContextConfig;
  private contextCompaction?: ContextCompactionConfig;
  private emptyCompletionRetryDelaysMs: readonly number[];
  private abortController: AbortController | null = null;
  private cachedPrefixTokens?: number;
  private lastCompactionRound = -Infinity;
  /** 上一次压缩尝试是否失败（handler 返回 null）：失败后冷却一轮再重试，
   *  避免每轮都空试昂贵的压缩 handler。成功压缩会清除该标志——压缩成功后
   *  日志已低于预算，再次超限属于正常需求，绝不因冷却把超预算请求放行。 */
  private lastCompactionFailed = false;

  constructor(opts: AgentOptions) {
    this.session = opts.session;
    this.provider = opts.provider;
    this.providerName = opts.providerName;
    this.requestBuilder = opts.requestBuilder;
    this.cacheValidator = opts.cacheValidator;
    this.maxToolRounds = normalizeMaxToolRounds(opts.maxToolRounds);
    this.toolTimeouts = opts.toolTimeouts ?? {};
    this.toolOutputTruncation = opts.toolOutputTruncation;
    this.toolContextConfig = opts.toolContextConfig;
    this.contextCompaction = opts.contextCompaction;
    this.emptyCompletionRetryDelaysMs =
      opts.emptyCompletionRetryDelaysMs ?? EMPTY_COMPLETION_RETRY_DELAYS_MS;
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

  /**
   * Rough context size estimate (tokens) = prefix (system + tools, immutable so
   * cached once) + current log bytes, using the bytes/4 heuristic. Used only to
   * decide when to trigger mid-loop compaction; precision is not critical.
   */
  private estimateContextTokens(): number {
    if (this.cachedPrefixTokens === undefined) {
      this.cachedPrefixTokens = estimateTokens(
        Serializer.stringify(this.session.prefix.toJSON())
      );
    }
    return this.cachedPrefixTokens + Math.ceil(this.session.logStore.getContentBytes() / 4);
  }

  /** 可被取消的等待：空完成退避重试使用。取消立即抛 AbortError。 */
  private async sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new DOMException('已取消', 'AbortError');
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new DOMException('已取消', 'AbortError'));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
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

    let finalContent = '';
    let finalReasoningContent: string | undefined;
    let finalToolCalls: IToolCall[] | undefined;
    let aggregatedStats: ICacheStatistics | undefined;
    let question: QuestionData | undefined;

    try {
      // 注意：append/validate 等状态变更必须在 try 内——它们抛错时
      // finally 才能复位 scratch 与 abortController（旧实现把它们放在
      // try 之前，抛错会跳过复位，与 finally 的注释自相矛盾）。
      await this.session.logStore.append(userMsg);

      this.session.scratch.reset();
      this.session.scratch.markRoundStart();
      // round 每次 chat() 从 0 重新计数，压缩冷却也必须随之重置：否则上一次
      // chat 在 round N 压缩过，本次 chat 前 N+2 轮即使超预算也无法压缩。
      this.lastCompactionRound = -Infinity;
      this.lastCompactionFailed = false;

      this.session.partition.validate();

    roundLoop: for (let round = 0; round < this.maxToolRounds; round++) {
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

      // Mid-loop context compaction (round-start check): if the context exceeds
      // the budget, compact into a new epoch BEFORE building this round's
      // request, so no request is ever sent with an over-limit context. This
      // catches overflow produced by the previous round's tool results.
      // 冷却语义（旧实现 round - lastCompactionRound >= 2）会在「刚压缩过」的
      // 下一轮把超预算请求照发出去，与上面注释「任何请求都不超限」矛盾——
      // 压缩成功后日志已低于预算，重试压缩不会抖动；只有压缩失败（handler 返回
      // null）时下一轮才可能再次超限，此时空试无意义，冷却一轮再重试。
      if (
        this.contextCompaction &&
        this.estimateContextTokens() > this.contextCompaction.maxContextTokens &&
        !(this.lastCompactionFailed && round === this.lastCompactionRound + 1)
      ) {
        const compacted = await this.contextCompaction.handler(
          this.session.logStore.getAllMessages().slice()
        );
        this.lastCompactionRound = round;
        if (compacted && compacted.messages.length > 0) {
          this.lastCompactionFailed = false;
          this.session.replaceLog(compacted.messages);
          this.requestBuilder.resetLogTracking?.();
          if (compacted.cacheStats) {
            this.session.recordStats(compacted.cacheStats);
            aggregatedStats = accumulateStats(aggregatedStats, compacted.cacheStats);
          }
          onStreamEvent?.({ type: 'context-compacted', round: roundNumber });
        } else {
          // 无法压缩：本次请求只能超预算发出（别无选择），记录失败状态，
          // 下一轮冷却（不重复空试），再之后重试。
          this.lastCompactionFailed = true;
        }
      }

      const params = this.session.prefix.getParameters();
      const baseThinking =
        this.providerName === 'deepseek'
          ? buildDeepSeekThinking(params as Record<string, unknown>)
          : undefined;

      // ── 回合完成质量守卫 ──────────────────────────────────────────────
      // 目标：只要 LLM 还能连上，回合就必须产出有效结果，绝不静默结束。
      //  - finish_reason='length'（max_tokens 耗尽，常见于思考过长）：片段不
      //    落日志，内存合并后关闭 thinking，用临时 suffix（部分输出 + 续写
      //    指令）从截断处续写，直到某段正常结束再整体落日志。
      //  - 空完成（无内容/无思考/无工具调用）：退避重试，连续多次后关闭
      //    thinking 再试。
      let continuationAttempt = 0;
      let emptyAttempt = 0;
      let mergedContent = '';
      let mergedReasoning = '';
      let roundThinking = baseThinking;
      // DeepSeek 省略 thinking 字段时默认开启思考，必须显式 disabled 才算关闭。
      const thinkingDisabled: IChatThinking | undefined =
        this.providerName === 'deepseek' ? { type: 'disabled' } : undefined;
      let request!: IChatRequest;
      let assistant!: IChatResponse['choices'][number]['message'];

      for (;;) {
        if (effectiveSignal?.aborted) {
          break roundLoop;
        }

        // 续写尾部：已合并的部分输出（assistant）+ 续写指令（user）。仅存在于
        // 本次请求，不写入日志；reasoning 不回填（续写已关 thinking，且截断的
        // 思考对续写无价值，回填还可能触发 round-trip 校验问题）。
        const suffixMessages: IMessage[] | undefined =
          continuationAttempt > 0
            ? [
                {
                  id: `continuation-partial-r${roundNumber}-${continuationAttempt}`,
                  role: 'assistant',
                  content: mergedContent,
                  timestamp: Date.now(),
                },
                {
                  id: `continuation-nudge-r${roundNumber}-${continuationAttempt}`,
                  role: 'user',
                  content: CONTINUATION_NUDGE,
                  timestamp: Date.now(),
                },
              ]
            : undefined;

        request = this.requestBuilder.build({
          prefix: this.session.prefix,
          appendLog: this.session.logStore,
          model: this.session.prefix.getModelName(),
          provider: this.providerName,
          thinking: roundThinking,
          temperature: params.temperature,
          topP: params.topP,
          maxTokens: params.maxTokens,
          tools: [...this.session.prefix.getToolDefinitions()],
          suffixMessages,
        });

        onStreamEvent?.({
          type: 'request-context',
          round: roundNumber,
          content: buildRequestContextDebugText(request, roundNumber),
          snapshot: buildContextSnapshot(request, roundNumber),
        });

        let response: IChatResponse;
        try {
          response =
            onStreamEvent && this.provider.streamChat
              ? await this.provider.streamChat(request, onStreamEvent, effectiveSignal)
              : await this.provider.chat(request, effectiveSignal);
        } catch (err) {
          if (isImageError(err)) {
            // 被拒绝的图片可能位于任意一条 user 消息（工具 __images 会在日志中段
            // 插入图片消息），而不只是最后一条；且必须保留消息文本（旧实现整条
            // pop 会丢掉用户输入）。找不到任何可剥离的图片时必须抛出——否则
            // 会反复重发完全相同的请求，循环到 maxToolRounds。
            const messages = this.session.logStore.getAllMessages();
            let strippedImages = false;
            const stripped = messages.map((message) => {
              if (!(message.role === 'user' && message.images && message.images.length > 0)) {
                return message;
              }
              strippedImages = true;
              const next: IMessage = { ...message };
              delete next.images;
              return next;
            });
            if (!strippedImages) {
              throw err;
            }
            this.session.replaceLog(stripped);
            this.requestBuilder.resetLogTracking?.();
            onStreamEvent?.({
              type: 'tool-call-end',
              toolCallId: '',
              toolName: 'multimodal',
              success: false,
              error: `Image rejected: ${(err as Error).message}`,
              output: '',
            });
            continue roundLoop;
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
        const segment = choice.message;

        if (choice.finishReason === 'length') {
          // 输出预算耗尽（思考 token 通常计入 max_tokens）：此段的 toolCalls
          // JSON 大概率被截断，绝不能执行；合并已输出内容，关 thinking 续写。
          mergedContent += segment.content ?? '';
          if (segment.reasoningContent) {
            mergedReasoning += segment.reasoningContent;
          }
          continuationAttempt += 1;
          if (continuationAttempt > MAX_CONTINUATIONS_PER_ROUND) {
            // 安全阀（如中转输出上限极小）：以已合并内容正常收尾，不报错。
            log.warn('Max continuations reached; ending round with merged partial content', {
              round: roundNumber,
              continuations: continuationAttempt - 1,
            });
            assistant = { ...segment, content: '', toolCalls: undefined, reasoningContent: undefined };
            break;
          }
          onStreamEvent?.({
            type: 'round-retry',
            reason: 'length-continue',
            attempt: continuationAttempt,
          });
          log.warn('Output truncated by max_tokens; continuing without thinking', {
            round: roundNumber,
            attempt: continuationAttempt,
          });
          roundThinking = thinkingDisabled;
          continue;
        }

        const isEmptyCompletion =
          !(segment.content ?? '') &&
          !segment.reasoningContent &&
          (!segment.toolCalls || segment.toolCalls.length === 0);
        if (isEmptyCompletion) {
          emptyAttempt += 1;
          onStreamEvent?.({ type: 'round-retry', reason: 'empty', attempt: emptyAttempt });
          if (emptyAttempt >= EMPTY_COMPLETION_DISABLE_THINKING_AFTER) {
            roundThinking = thinkingDisabled;
          }
          const delays = this.emptyCompletionRetryDelaysMs;
          const delayMs = delays[Math.min(emptyAttempt, delays.length) - 1] ?? 30_000;
          log.warn('Empty completion; retrying round after backoff', {
            round: roundNumber,
            attempt: emptyAttempt,
            delayMs,
          });
          await this.sleepAbortable(delayMs, effectiveSignal);
          continue;
        }

        assistant = segment;
        break;
      }

      // 合并续写片段后整体落日志（日志中每回合仍只有一条 assistant 消息）。
      const roundContent = mergedContent + (assistant.content ?? '');
      const roundReasoning = mergedReasoning
        ? mergedReasoning + (assistant.reasoningContent ?? '')
        : assistant.reasoningContent;

      const assistantMsg = MessageFactory.assistant(
        roundContent,
        assistant.toolCalls,
        roundReasoning
      );
      await this.session.logStore.append(assistantMsg);

      onStreamEvent?.({
        type: 'assistant-round-complete',
        round: roundNumber,
        content: roundContent,
        reasoningContent: roundReasoning,
      });

      finalContent = roundContent;
      finalReasoningContent = roundReasoning;
      finalToolCalls = assistant.toolCalls;

      if (!assistant.toolCalls || assistant.toolCalls.length === 0) {
        break;
      }

      let executedToolCalls = 0;
      for (const call of assistant.toolCalls) {
        if (effectiveSignal?.aborted) {
          break;
        }
        // 检测到 question 后立即终止本轮剩余的 tool call：plan 模式模型可能
        // 在提问前先发了变更类工具，必须保证提问一旦发生就不再执行后续调用。
        if (question) {
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
          // 每个工具调用独立 AbortController：主会话取消或工具超时都会
          // abort 它，并通过 ToolExecutionContext.signal 下发给工具实现
          // （bash 杀进程、task 取消子代理等）。旧实现 withTimeout 只抛弃
          // promise，工具继续在后台跑完并滞后落地副作用。
          const callController = new AbortController();
          const propagateAbort = (): void => callController.abort();
          if (effectiveSignal?.aborted) {
            callController.abort();
          } else {
            effectiveSignal?.addEventListener('abort', propagateAbort, { once: true });
          }
          try {
            const toolTimeoutMs = this.toolTimeouts[call.name] ?? DEFAULT_TOOL_TIMEOUT_MS;
            result = await withTimeout(
              this.session.toolRegistry.execute(call.name, call.arguments, {
                toolCallId: call.id,
                signal: callController.signal,
              }),
              toolTimeoutMs,
              effectiveSignal,
              () => callController.abort()
            );
          } catch (err) {
            errorMessage = (err as Error).message;
            result = { error: errorMessage };
            success = false;
            log.error(`Tool execution failed: ${call.name}`, { error: err });
          } finally {
            effectiveSignal?.removeEventListener('abort', propagateAbort);
          }
        }
        let contextResult: unknown = result;
        let subagentToolInvocations: ISubagentToolInvocation[] | undefined;
        if (result && typeof result === 'object' && '__subagentToolInvocations' in result) {
          const record = result as Record<string, unknown>;
          subagentToolInvocations = record.__subagentToolInvocations as ISubagentToolInvocation[];
          const stripped = { ...record };
          delete stripped.__subagentToolInvocations;
          contextResult = stripped;
        }
        const toolMsg = await this.buildToolMessage(call, contextResult, success);
        await this.session.logStore.append(toolMsg);
        executedToolCalls += 1;
        onStreamEvent?.({
          type: 'tool-call-end',
          toolCallId: call.id,
          toolName: call.name,
          success,
          error: errorMessage,
          output: typeof contextResult === 'string' ? contextResult : JSON.stringify(contextResult),
          contextContent: toolMsg.content,
          contextSummary:
            typeof toolMsg.metadata?.[TOOL_SUMMARY_METADATA_KEY] === 'string'
              ? (toolMsg.metadata[TOOL_SUMMARY_METADATA_KEY] as string)
              : undefined,
          ...(subagentToolInvocations ? { subagentToolInvocations } : {}),
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

      // 为被跳过的 tool call 补占位结果：OpenAI/DeepSeek 要求每个 tool_call 都有
      // 配对的 tool 消息、Claude 要求每个 tool_use 后必须跟 tool_result，否则下一
      // 轮请求被 400 拒绝。question 中断与取消中断都会留下同批未执行的调用——
      // 不补占位会污染日志，用户回答 question 后的第一个请求即失败。
      if (executedToolCalls < assistant.toolCalls.length) {
        const skipReason = question
          ? '该工具调用被跳过：会话已进入提问流程'
          : '该工具调用未执行：会话已取消';
        for (const skipped of assistant.toolCalls.slice(executedToolCalls)) {
          const placeholder = await this.buildToolMessage(
            skipped,
            { error: skipReason },
            false
          );
          await this.session.logStore.append(placeholder);
          onStreamEvent?.({
            type: 'tool-call-end',
            toolCallId: skipped.id,
            toolName: skipped.name,
            success: false,
            error: skipReason,
            output: JSON.stringify({ error: skipReason }),
            // 携带原始参数：该事件没有对应的 start 事件，UI 侧从 end 事件新建
            // invocation 时需要真实参数，否则重建上下文与活日志字节不一致。
            arguments: skipped.arguments,
            contextContent: placeholder.content,
            contextSummary:
              typeof placeholder.metadata?.[TOOL_SUMMARY_METADATA_KEY] === 'string'
                ? (placeholder.metadata[TOOL_SUMMARY_METADATA_KEY] as string)
                : undefined,
          });
        }
      }

      if (question) {
        break;
      }
    }
    } finally {
      // 错误路径同样要复位：旧实现抛错时跳过这两步，后续 cancel() 会 abort
      // 一个陈旧的 controller，scratch 也会一直停在「回合进行中」。
      this.session.scratch.markRoundEnd();
      this.abortController = null;
    }

    return {
      role: 'assistant',
      content: finalContent,
      reasoningContent: finalReasoningContent,
      toolCalls: finalToolCalls,
      cacheStats: aggregatedStats,
      question,
    };
  }

  private async buildToolMessage(call: IToolCall, result: unknown, success: boolean) {
    let content: string;
    let originalChars: number;
    let spilledPath: string | undefined;
    if (this.toolOutputTruncation) {
      const truncated = await truncateToolOutput(result, call.name, this.toolOutputTruncation);
      content = truncated.content;
      originalChars = truncated.originalChars;
      spilledPath = truncated.spilledPath;
    } else {
      content = stringifyToolResult(result);
      originalChars = content.length;
    }

    let metadata: Record<string, unknown> | undefined;
    if (this.toolContextConfig) {
      const summary = prepareHistorySummary(
        {
          toolName: call.name,
          args: call.arguments,
          result,
          success,
          originalChars,
          spilledPath,
        },
        this.toolContextConfig
      );
      if (summary) {
        metadata = { [TOOL_SUMMARY_METADATA_KEY]: summary };
      }
    }

    return MessageFactory.tool(call.id, content, success, metadata);
  }
}
