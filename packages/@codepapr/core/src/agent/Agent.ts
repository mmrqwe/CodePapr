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
  ThinkingPayload,
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
  CompactionTrigger,
  RequestContextInsertion,
} from '@codepapr/types';
import { Logger, estimateTokens } from '@codepapr/common';
import { PARALLEL_SAFE_TOOL_NAMES } from './agentConfig';
import { Session, mergeOptionalTokenCount } from './Session';
import { MessageFactory, redactTranscriptOutputString } from '../message/Message';
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
import {
  buildContextBudgetBreakdown,
  ContextBudgetRejectedError,
  decideContextBudgetAction,
  type ContextBudgetBreakdown,
} from '../context/ContextBudget';
import type { LogWireFootprint } from '../context/wireShape';

const log = new Logger('Agent');

const DEFAULT_TOOL_TIMEOUT_MS = 270_000;

/** 单个并行段内同时执行的工具调用上限：只读突发（一次发十几个 read/grep）
 *  分块并发，避免瞬时打满 IPC/Tauri 命令通道。块间串行、块内并行。 */
export const PARALLEL_TOOL_CHUNK_SIZE = 8;

/** 输出被 max_tokens 截断（finish_reason='length'）后，单回合自动续写的上限。
 *  防止遇到中转的极小输出上限时无限续写；达到上限后以已合并内容正常收尾
 *  （绝不报错——任务在后续回合仍可继续）。 */
export const MAX_CONTINUATIONS_PER_ROUND = 12;

/** 截断续写时追加在请求尾部的指令（临时消息，不落日志）。 */
export const CONTINUATION_NUDGE =
  '你上一次的输出因达到最大输出长度而被截断。请从截断处继续输出，不要重复已经输出的内容。';

/** 模型返回空完成（无内容/无工具调用；仅有思考也算——见 isEmptyCompletion）
 *  时的退避重试延迟（毫秒）。空完成是瞬态故障，退避重发即可；绝不因空完成
 *  而静默结束回合。20 档逐次递增（5s→100s），与重试上限一一对应。 */
export const EMPTY_COMPLETION_RETRY_DELAYS_MS: readonly number[] = [
  5_000, 10_000, 15_000, 20_000, 25_000, 30_000, 35_000, 40_000, 45_000, 50_000,
  55_000, 60_000, 65_000, 70_000, 75_000, 80_000, 85_000, 90_000, 95_000, 100_000,
];

/** 连续空完成达到该次数后关闭 thinking 再试（思考输出异常是常见诱因）。 */
export const EMPTY_COMPLETION_DISABLE_THINKING_AFTER = 10;

/** 单回合空完成重试上限：超过后抛错终止回合。退避表 20 档逐次递增（共约
 *  17.5 分钟），等待期间用户可随时取消。无上限时 provider 持续返回空完成
 *  （模型配置错误/中转异常）会让 chat() 永久挂起并持续烧 token。 */
export const MAX_EMPTY_COMPLETION_RETRIES_PER_ROUND = 20;

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

export function buildRequestContextDebugText(request: IChatRequest, round: number): string {
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
    // ADR-009：Recall 是 request-only，不得随 debug 快照持久化进 promptContent。
    messages: request.messages
      .filter((message) => message.metadata?.requestOnly !== true)
      .map((message) => ({
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
      timestamp: message.timestamp,
    };

    if (typeof message.durationMs === 'number' && message.durationMs > 0) {
      view.durationMs = message.durationMs;
    }

    if (message.metadata?.uiInjected === true) {
      view.uiInjected = true;
    }

    if (message.reasoningContent) {
      view.reasoningContent = message.reasoningContent;
      view.reasoningTokens = estimateTokens(message.reasoningContent);
    }

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

/**
 * 由统一参数构建 thinking 字段（主代理与子代理共用）：
 * - thinkingEnabled 缺省视为开启；显式 false 时，DeepSeek 必须发
 *   {type:'disabled'}（省略字段默认开思考），OpenAI/Claude 格式直接省略字段
 *   （缺省即不思考，且避免第三方端点对未知 thinking 字段返回 400）。
 * - reasoningEffort 任意非空字符串透传（OpenAI 兼容生态取值各异）。
 * - budgetTokens 仅 Claude 格式使用，provider 侧按 API 硬约束钳制。
 * - thinkingPayload 决定请求体带 thinking / reasoning / 两者；缺省 DeepSeek
 *   用 thinking，其余用 reasoning。
 */
export function buildThinking(
  params: Record<string, unknown>,
  providerName: 'deepseek' | 'openai' | 'claude' | 'response',
): IChatThinking | undefined {
  const enabled = params.thinkingEnabled !== false;
  if (!enabled) {
    return providerName === 'deepseek' ? { type: 'disabled' } : undefined;
  }
  const reasoningEffort =
    typeof params.reasoningEffort === 'string' && params.reasoningEffort.trim()
      ? params.reasoningEffort.trim()
      : undefined;
  const budgetTokens =
    typeof params.thinkingBudgetTokens === 'number' && Number.isFinite(params.thinkingBudgetTokens)
      ? Math.floor(params.thinkingBudgetTokens)
      : undefined;
  const payload = resolveThinkingPayloadParam(params.thinkingPayload, providerName);
  if (!reasoningEffort && !budgetTokens) {
    return { type: 'enabled', payload };
  }
  return {
    type: 'enabled',
    payload,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(budgetTokens ? { budgetTokens } : {}),
  };
}

function resolveThinkingPayloadParam(
  raw: unknown,
  providerName: 'deepseek' | 'openai' | 'claude' | 'response',
): ThinkingPayload {
  if (raw === 'reasoning' || raw === 'thinking' || raw === 'both') {
    return raw;
  }
  return providerName === 'deepseek' ? 'thinking' : 'reasoning';
}

function isImageError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const error = err as Record<string, unknown>;
  if (error.status !== 400 && error.status !== '400') return false;
  const msg = typeof error.message === 'string' ? error.message : '';
  return /image|dimension|pixel|multimodal|vision|expected a string|content is an array|array of content parts|image_url/i.test(
    msg
  );
}

/**
 * PR3：provider 上下文溢出检测。确定性错误（流层已不重试），特征为
 * `retriable === false` 且错误文本携带 context 超限签名。用鸭子类型检测
 * （core 不依赖 api 包），仅凭 message/retriable 两个公开字段。
 *
 * 各上游的真实文案：
 * - OpenAI/DeepSeek：context_length_exceeded、maximum context length、
 *   request_too_large
 * - Anthropic：`prompt is too long: N tokens > M maximum`（400）
 * - 通用/中转：context window、"too long ... maximum"
 */
function isProviderContextOverflowError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const error = err as Record<string, unknown>;
  if (error.retriable === true) return false;
  const msg = typeof error.message === 'string' ? error.message : '';
  return /context_length_exceeded|request_too_large|maximum context|context window|prompt is too long|too long.*maximum|超出.*上下文|上下文.*超/i.test(
    msg
  );
}

export interface IRequestBuilder {
  build(opts: {
    prefix: IImmutablePrefix;
    appendLog: IAppendOnlyLog;
    model: string;
    provider: 'deepseek' | 'openai' | 'claude' | 'response';
    thinking?: IChatThinking;
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    tools?: IToolDefinition[];
    /** 仅影响本次请求的临时尾部消息（不落日志）：用于 max_tokens 截断后的自动续写。 */
    suffixMessages?: IMessage[];
    /** PR5（ADR-009 B3）：request-only 锚定插入（Recall Block），不落日志。 */
    contextInsertions?: RequestContextInsertion[];
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
    messages: IMessage[],
    /** 压缩触发来源（token-limit / manual / provider-overflow）。 */
    trigger?: CompactionTrigger
  ) => Promise<{ messages: IMessage[]; cacheStats?: ICacheStatistics } | null>;
}

export interface AgentOptions {
  session: Session;
  provider: ILLMProvider;
  providerName: 'deepseek' | 'openai' | 'claude' | 'response';
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

/**
 * C：mid-loop 压缩熔断阈值。压缩很贵（可能再花一次 LLM 调用），而历史上出现过
 * 「压缩成功 → 下一轮仍然超限 → 再压缩」的死循环（估算把不再上线的图片 base64
 * 计入时必然发生：压缩看不见那部分，永远缩不到预算以下；实测 2.7 小时里毁了 31
 * 个上下文纪元，每次都把计划打断）。任一信号命中即本回合停止压缩：
 *  - 单次 chat() 的压缩尝试次数上限；
 *  - 连续 N 次压缩后 wire 体量降幅不足（无效缩容）。
 */
export const MAX_COMPACTIONS_PER_CHAT = 6;
export const MAX_INEFFECTIVE_COMPACTIONS = 2;
/** 压缩后仍 ≥ 压缩前 × 该比例即视为「无效缩容」。 */
export const EFFECTIVE_SHRINK_RATIO = 0.9;

function normalizeMaxToolRounds(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_AGENT_MAX_TOOL_ROUNDS;
  }

  return Math.max(1, Math.floor(value));
}

function safeStringifyOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export class Agent {
  private session: Session;
  private provider: ILLMProvider;
  private providerName: 'deepseek' | 'openai' | 'claude' | 'response';
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
  /** PR3：provider 上下文溢出的 emergency-compact 至多一次（溢出重试 ≤1）。 */
  private overflowCompactionAttempted = false;
  /** C：本回合压缩尝试次数 / 连续无效缩容次数 / 熔断已上报（每次 chat() 重置）。 */
  private compactionsThisChat = 0;
  private ineffectiveCompactions = 0;
  private compactionBlockedReported = false;
  /** PR5（ADR-009 B3）：本回合 request-only 锚定插入（Recall Block）。 */
  private contextInsertions: RequestContextInsertion[] = [];
  /** 主线程 fallback 路径：memory_search 的 re-recall 每 chat 至多 push 一次
   *  （与 worker 侧 `reRecallPushedThisChat` 对齐）。 */
  private reRecallPushedThisChat = false;
  /** PR2：provider 实测的**入站总量**（usage.input_tokens + cache read +
   *  cache creation——各家 provider 的 input_tokens 都只报未命中缓存的新输入，
   *  直接当总量会低估一个数量级）与测量时的 log 长度。log 只在其后追加时用于
   *  「实测 + 增量」对账；replaceLog / 截断后失效。 */
  private lastProviderUsage: {
    measuredTotalTokens: number;
    logLength: number;
  } | null = null;

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

  /**
   * PR5（ADR-009 第11条）：re-recall 追加插入——memory_search 触发的受控
   * 例外，新 block 追加在旧 insertion 之后、user 消息之前（order 递增由
   * 调用方控制，每 turn 至多一次由 worker 侧守卫）。request-only，不落日志。
   */
  pushContextInsertions(insertions: RequestContextInsertion[]): void {
    this.contextInsertions.push(...insertions);
  }

  /**
   * 剥离工具结果里的 request-only / UI 侧信道，避免进入 log。
   * 主线程 fallback 在此注入 re-recall（worker 路径由 tool-response 注入，
   * 到达此处时 reRecallInsertion 已被剥离，本方法是 no-op）。
   */
  private consumeToolResultSideChannels(result: unknown): {
    contextResult: unknown;
    subagentToolInvocations?: ISubagentToolInvocation[];
  } {
    if (!result || typeof result !== 'object') {
      return { contextResult: result };
    }
    const record = { ...(result as Record<string, unknown>) };
    const insertion = record.reRecallInsertion as RequestContextInsertion | undefined;
    if (insertion && !this.reRecallPushedThisChat) {
      this.reRecallPushedThisChat = true;
      this.pushContextInsertions([insertion]);
    }
    delete record.reRecallInsertion;

    let subagentToolInvocations: ISubagentToolInvocation[] | undefined;
    if ('__subagentToolInvocations' in record) {
      subagentToolInvocations = record.__subagentToolInvocations as ISubagentToolInvocation[];
      delete record.__subagentToolInvocations;
    }
    return { contextResult: record, subagentToolInvocations };
  }

  cancel(): void {
    this.abortController?.abort();
  }

  destroy(): void {
    this.cancel();
  }

  /**
   * Rough context size estimate (tokens) = prefix (system + tools, immutable so
   * cached once) + **上线口径**的 log 体量，用 bytes/4 heuristic + 图片 vision
   * 权重。仅用于决定何时触发 mid-loop 压缩；精度不重要，重要的是**不能把已经不
   * 会随请求发送的字节算进来**：
   *
   * log 的 totalBytes 永久包含 ①已被 stripConsumedImages 剥离的历史图片 base64
   * （一张截图就是数百 KB → /4 ≈ 十万「伪 token」）②已被 applyHistoryToolSummaries
   * 换成摘要的旧工具全文。按全量字节估算会系统性高估一个数量级，导致每轮都判定
   * 超硬预算 → 压缩风暴（而压缩计划本身看不见图片，纸面缩容通过后立刻再触发）。
   *
   * ADR-009 第15条：request-only 插入（Recall Block）不进 log 但随每次请求
   * 发送，必须计入估算，否则预算决策会系统性低估。
   */
  private estimateContextTokens(): number {
    if (this.cachedPrefixTokens === undefined) {
      this.cachedPrefixTokens = estimateTokens(
        Serializer.stringify(this.session.prefix.toJSON())
      );
    }
    return this.cachedPrefixTokens + this.logWireTokens() + this.estimateInsertionTokens();
  }

  /** log 的上线口径 token（无 wire 计量能力时回落全量字节）。 */
  private logWireFootprint(): LogWireFootprint {
    const footprint = this.session.logStore.getWireFootprint?.();
    if (footprint) return footprint;
    // 鸭子类型的测试 log 没有 wire 计量：只能按全量字节估，阶段全部摊进
    // retainedTail（分工不细，但总量与 decideContextBudgetAction 一致）。
    const bytes = this.session.logStore.getContentBytes();
    return {
      logBytes: bytes,
      wireBytes: bytes,
      imageTokens: 0,
      summarySavingsBytes: 0,
      offWireImageBytes: 0,
      bootstrapBytes: 0,
      checkpointBytes: 0,
      lastUserBytes: 0,
      lastUserHoldsLiveImages: false,
    };
  }

  private logWireTokens(): number {
    const footprint = this.logWireFootprint();
    return Math.ceil(footprint.wireBytes / 4) + footprint.imageTokens;
  }

  /** C：本回合是否已不应再尝试压缩（熔断）。null = 可以继续。 */
  private compactionBlockReason(): 'no-effective-shrink' | 'per-turn-limit' | null {
    if (this.ineffectiveCompactions >= MAX_INEFFECTIVE_COMPACTIONS) {
      return 'no-effective-shrink';
    }
    if (this.compactionsThisChat >= MAX_COMPACTIONS_PER_CHAT) {
      return 'per-turn-limit';
    }
    return null;
  }

  /** C：记录一次压缩的结果（前后均为 wire 口径 token），驱动熔断判定。 */
  private recordCompactionOutcome(tokensBefore: number, tokensAfter: number): void {
    this.compactionsThisChat++;
    const shrunk =
      tokensBefore <= 0 || tokensAfter < tokensBefore * EFFECTIVE_SHRINK_RATIO;
    this.ineffectiveCompactions = shrunk ? 0 : this.ineffectiveCompactions + 1;
    if (!shrunk) {
      log.warn('Compaction produced no effective shrink', {
        tokensBefore,
        tokensAfter,
        ineffectiveAttempts: this.ineffectiveCompactions,
      });
    }
  }

  /** ADR-009 第15条：request-only 插入（Recall Block）的 token 估算。 */
  private estimateInsertionTokens(): number {
    if (this.contextInsertions.length === 0) return 0;
    return this.contextInsertions.reduce(
      (sum, insertion) => sum + estimateTokens(insertion.content),
      0
    );
  }

  /**
   * PR2：请求形态的 7 阶段 token 分解（heuristic，供 decideContextBudgetAction）。
   *
   * 阶段划分与最终请求结构对齐，全部取自 AppendOnlyLog 的 wire 计量（append 时
   * 一次算好）：
   * - stablePrefixTokens = systemPrompt + fewShots（工具 schema 单独计）；
   * - bootstrapTokens / checkpointTokens = log 中 sessionBootstrap / checkpoint
   *   消息（memory.md / skills / project-graph、压缩摘要）；
   * - currentUserInputTokens = 最后一条 user 消息（图片按 vision 权重计）；
   * - retainedTailTokens = 其余 log 内容（tool 结果 / 历史对话）；
   * - suffixTokens = 续写 suffix（本次请求临时尾部）。
   *
   * 这里刻意不再 getAllMessages()：那会对整个 log（含历史图片 base64）做一遍
   * JSON 深拷贝，每轮一次；wire 计量把同样的信息在 append 时就摊平了。
   */
  private computeBudgetBreakdown(suffixTokens: number): ContextBudgetBreakdown {
    const prefix = this.session.prefix;
    const fewShots = prefix.getFewShots();
    const stablePrefixTokens = estimateTokens(
      prefix.getSystemPrompt() +
        (fewShots.length > 0 ? Serializer.stringify({ fewShots }) : '')
    );
    const toolsTokens = estimateTokens(
      Serializer.stringify({ tools: prefix.getToolDefinitions() })
    );

    const footprint = this.logWireFootprint();
    const bootstrapTokens = Math.ceil(footprint.bootstrapBytes / 4);
    const checkpointTokens = Math.ceil(footprint.checkpointBytes / 4);
    const currentUserInputTokens =
      Math.ceil(footprint.lastUserBytes / 4) +
      (footprint.lastUserHoldsLiveImages ? footprint.imageTokens : 0);

    const totalLogTokens = Math.ceil(footprint.wireBytes / 4) + footprint.imageTokens;
    const retainedTailTokens = Math.max(
      0,
      totalLogTokens - bootstrapTokens - checkpointTokens - currentUserInputTokens
    );

    return buildContextBudgetBreakdown(
      {
        stablePrefixTokens,
        bootstrapTokens,
        toolsTokens,
        checkpointTokens,
        retainedTailTokens,
        currentUserInputTokens,
        suffixTokens,
        // ADR-009 第15条：request-only 插入（Recall Block）计入预算分解。
        insertionTokens: this.estimateInsertionTokens(),
      },
      // 输出侧预留：请求的 max_tokens 是真实会占用的窗口额度，恒传 0 会让
      // 「输入刚好、输出撑爆」的形态一路放行到 provider 侧才溢出。
      this.outputReserveTokens()
    );
  }

  /** 本次会话参数里声明的输出额度（未声明则不预留）。 */
  private outputReserveTokens(): number {
    const params = this.session.prefix.getParameters() as { maxTokens?: unknown };
    const maxTokens = typeof params.maxTokens === 'number' ? params.maxTokens : 0;
    return Math.max(0, Math.floor(maxTokens));
  }

  /**
   * PR3：provider 上下文溢出后的 emergency-compact（每回合至多一次，由
   * overflowCompactionAttempted 保证）。成功返回 true（调用方 continue
   * roundLoop 重试同一轮请求），失败返回 false（调用方按原始错误上抛）。
   */
  private async tryEmergencyCompact(
    roundNumber: number,
    onStreamEvent?: (event: IChatStreamEvent) => void
  ): Promise<boolean> {
    if (!this.contextCompaction) return false;
    try {
      const tokensBefore = this.logWireTokens();
      const compacted = await this.contextCompaction.handler(
        this.session.logStore.getAllMessages().slice(),
        'provider-overflow'
      );
      if (!compacted || compacted.messages.length === 0) {
        this.compactionsThisChat++;
        return false;
      }
      this.lastCompactionFailed = false;
      this.session.replaceLog(compacted.messages);
      this.lastProviderUsage = null;
      this.requestBuilder.resetLogTracking?.();
      this.recordCompactionOutcome(tokensBefore, this.logWireTokens());
      if (compacted.cacheStats) {
        this.session.recordStats(compacted.cacheStats);
      }
      onStreamEvent?.({ type: 'context-compacted', round: roundNumber });
      return true;
    } catch {
      // 压缩失败：不吞掉原始 provider 错误，由调用方按原错误处理。
      return false;
    }
  }

  /**
   * PR2：provider 实测对账——上次成功响应的**入站总量**（input + cache read +
   * cache creation）。两种有效场景：
   *  - log 与测量时完全一致（续写/空完成重试：suffix 是临时消息）→ 直接用实测；
   *  - log 只在测量之后追加（工具结果 / 图片消息，即每个工具轮的常态）→
   *    实测 + 追加部分的 wire 口径增量。旧实现对任何增长都直接放弃实测，等于
   *    把预算决策永久交给被图片 base64 抬高的 heuristic，这是压缩风暴的另一半
   *    根因（压缩/prune 后 lastProviderUsage 被清空，实测再也赶不上）。
   *  log 变短（replaceLog / truncateTo / pop）时实测作废，回落 heuristic。
   */
  private currentProviderMeasuredTokens(): number | undefined {
    const usage = this.lastProviderUsage;
    if (!usage) return undefined;
    const logLength = this.session.logStore.length();
    if (logLength < usage.logLength) return undefined;
    if (logLength === usage.logLength) return usage.measuredTotalTokens;
    const appended = this.session.logStore.getWireFootprintSince?.(usage.logLength);
    if (!appended) return undefined;
    return (
      usage.measuredTotalTokens +
      Math.ceil(appended.wireBytes / 4) +
      appended.imageTokens
    );
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
    signal?: AbortSignal,
    /** PR1：主线程生成的 canonical user 消息 ID（ADR-009 前置）。 */
    userMessageId?: string,
    /** PR5（ADR-009 B3）：本回合 request-only 锚定插入（Recall Block），
     *  tool loop 内字节稳定；mid-loop replaceLog 后仍存活（存 Agent 字段，
     *  不进 log）。 */
    contextInsertions?: RequestContextInsertion[]
  ): Promise<IAgentResponse> {
    const controller = new AbortController();
    this.abortController = controller;
    const onExternalAbort = (): void => {
      controller.abort(signal?.reason);
    };
    if (signal) {
      if (signal.aborted) {
        controller.abort(signal.reason);
      } else {
        signal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }
    const effectiveSignal = controller.signal;
    const userMsg = MessageFactory.user(userInput, images, userMessageId);
    // PR5（ADR-009 B3）：turn-scoped 插入挂在 Agent 字段上（不进 log），
    // 本回合所有 request build 复用；replaceLog（mid-loop 压缩）不清除。
    this.contextInsertions = contextInsertions ?? [];
    this.reRecallPushedThisChat = false;

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
      this.overflowCompactionAttempted = false;
      this.compactionsThisChat = 0;
      this.ineffectiveCompactions = 0;
      this.compactionBlockedReported = false;

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

      // Mid-loop context budget decision (round-start check, v4 单层触发)：
      // 7 阶段 token 分解 → decideContextBudgetAction，动作在发请求前执行，保证
      // 任何请求都不超限：
      //  - none：放行；
      //  - compact / emergency-compact：走压缩 handler 换 epoch；
      //  - reject-request：紧急压缩已尝试仍超限 → 抛结构化错误终止回合。
      // 冷却语义（旧实现 round - lastCompactionRound >= 2）会在「刚压缩过」的
      // 下一轮把超预算请求照发出去，与上面注释「任何请求都不超限」矛盾——
      // 压缩成功后日志已低于预算，重试压缩不会抖动；只有压缩失败（handler 返回
      // null）时下一轮才可能再次超限，此时空试无意义，冷却一轮再重试。
      if (this.contextCompaction) {
        const breakdown = this.computeBudgetBreakdown(0);
        const decision = decideContextBudgetAction({
          breakdown,
          hardBudgetTokens: this.contextCompaction.maxContextTokens,
          // PR2：provider 实测对账——log 未回退时覆盖 heuristic（实测 + 追加
          // 增量的 wire 口径）。
          providerMeasuredTotalTokens: this.currentProviderMeasuredTokens(),
          estimateSource: 'heuristic',
        });

        if (decision.action === 'reject-request') {
          throw new ContextBudgetRejectedError(
            decision.overHardBy,
            decision.estimateSource
          );
        }

        if (decision.action === 'compact' || decision.action === 'emergency-compact') {
          const blockedReason = this.compactionBlockReason();
          if (blockedReason) {
            // 熔断：本回合不再尝试压缩（见 compactionBlockReason）。请求照发，
            // 真超限由 provider overflow 的 emergency 路径与 reject-request 兜底。
            if (!this.compactionBlockedReported) {
              this.compactionBlockedReported = true;
              log.warn('Mid-loop compaction circuit opened; skipping further compaction this turn', {
                reason: blockedReason,
                attempts: this.compactionsThisChat,
                ineffectiveAttempts: this.ineffectiveCompactions,
                estimatedTokens: this.logWireTokens(),
                hardBudgetTokens: this.contextCompaction.maxContextTokens,
              });
              onStreamEvent?.({
                type: 'context-compaction-blocked',
                round: roundNumber,
                reason: blockedReason,
                attempts: this.compactionsThisChat,
                estimatedTokens: this.logWireTokens(),
              });
            }
          } else if (!(this.lastCompactionFailed && round === this.lastCompactionRound + 1)) {
            const tokensBefore = this.logWireTokens();
            const compacted = await this.contextCompaction.handler(
              this.session.logStore.getAllMessages().slice(),
              'token-limit'
            );
            this.lastCompactionRound = round;
            if (compacted && compacted.messages.length > 0) {
              this.lastCompactionFailed = false;
              this.session.replaceLog(compacted.messages);
              this.lastProviderUsage = null;
              this.requestBuilder.resetLogTracking?.();
              if (compacted.cacheStats) {
                this.session.recordStats(compacted.cacheStats);
                aggregatedStats = accumulateStats(aggregatedStats, compacted.cacheStats);
              }
              this.recordCompactionOutcome(tokensBefore, this.logWireTokens());
              onStreamEvent?.({ type: 'context-compacted', round: roundNumber });
            } else {
              // 无法压缩：本次请求只能超预算发出（别无选择），记录失败状态，
              // 下一轮冷却（不重复空试），再之后重试。
              this.lastCompactionFailed = true;
              this.compactionsThisChat++;
            }
          }
        }
      }

      const params = this.session.prefix.getParameters();
      const baseThinking = buildThinking(
        params as Record<string, unknown>,
        this.providerName,
      );

      // ── 回合完成质量守卫 ──────────────────────────────────────────────
      // 目标：只要 LLM 还能连上，回合就必须产出有效结果，绝不静默结束。
      //  - finish_reason='length'（max_tokens 耗尽，常见于思考过长）：片段不
      //    落日志，内存合并后关闭 thinking，用临时 suffix（部分输出 + 续写
      //    指令）从截断处续写，直到某段正常结束再整体落日志。
      //  - 空完成（无内容/无工具调用）：退避重试，连续多次后关闭 thinking
      //    再试。仅有思考的响应同样是空完成——正常结束必然携带回复文本或
      //    工具调用；实测模型会把历史中的 reasoning 占位符鹦鹉学舌成唯一
      //    输出（"Called X to proceed."），若因思考非空放行，回合会静默终止。
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
      // 本轮 LLM 实际生成耗时：只累计 provider 请求本身的墙钟（含续写重试的
      // 额外请求），不含空完成退避等待——那是等待而非生成。
      let roundModelMs = 0;

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

        // PR2：provider 实测对账——续写请求的 log 与上次测量时完全一致
        // （suffix 是临时消息），用 usage.input_tokens 决策；只做
        // reject-request（compact 会替换 log，使已合并的部分输出相对新
        // epoch 失效）。
        if (continuationAttempt > 0 && this.contextCompaction) {
          const measured = this.currentProviderMeasuredTokens();
          if (measured !== undefined) {
            const decision = decideContextBudgetAction({
              breakdown: this.computeBudgetBreakdown(0),
              hardBudgetTokens: this.contextCompaction.maxContextTokens,
              providerMeasuredTotalTokens: measured,
              estimateSource: 'heuristic',
            });
            if (decision.action === 'reject-request') {
              throw new ContextBudgetRejectedError(
                decision.overHardBy,
                decision.estimateSource
              );
            }
          }
        }

        const requestLogLength = this.session.logStore.length();
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
          contextInsertions: this.contextInsertions,
        });

        onStreamEvent?.({
          type: 'request-context',
          round: roundNumber,
          content: buildRequestContextDebugText(request, roundNumber),
          snapshot: buildContextSnapshot(request, roundNumber),
        });

        let response: IChatResponse;
        const requestStartedAt = Date.now();
        try {
          response =
            onStreamEvent && this.provider.streamChat
              ? await this.provider.streamChat(request, onStreamEvent, effectiveSignal)
              : await this.provider.chat(request, effectiveSignal);
          // PR2：provider 实测记录（**入站总量** = input_tokens + cache read +
          // cache creation；各家 provider 的 input_tokens 只报未命中缓存的新输入）
          // + 测量时 log 长度，供后续请求对账覆盖 heuristic 估算。
          const usage = response.usage;
          if (typeof usage?.input_tokens === 'number') {
            this.lastProviderUsage = {
              measuredTotalTokens:
                usage.input_tokens +
                (usage.cache_read_input_tokens ?? 0) +
                (usage.cache_creation_input_tokens ?? 0),
              logLength: requestLogLength,
            };
          }
        } catch (err) {
          // PR3：provider 上下文溢出 → emergency-compact 后重试一次。
          // 与流层重连（overloaded/rate_limit 无限重连）完全正交：溢出是
          // 确定性错误（流层不重试），这里在 request boundary 恢复。
          if (
            this.contextCompaction &&
            !this.overflowCompactionAttempted &&
            isProviderContextOverflowError(err)
          ) {
            this.overflowCompactionAttempted = true;
            const recovered = await this.tryEmergencyCompact(roundNumber, onStreamEvent);
            if (recovered) {
              continue roundLoop;
            }
          }
          // PR2：emergency-compact 已尝试仍溢出 → 结构化 reject-request 错误
          // （替代 raw provider error 上抛，供主线程给用户可读提示）。
          if (
            this.overflowCompactionAttempted &&
            isProviderContextOverflowError(err)
          ) {
            const breakdown = this.computeBudgetBreakdown(0);
            const decision = decideContextBudgetAction({
              breakdown,
              hardBudgetTokens: this.contextCompaction?.maxContextTokens ?? 0,
              providerOverflowDetected: true,
              emergencyAlreadyAttempted: true,
              estimateSource: 'heuristic',
            });
            throw new ContextBudgetRejectedError(
              decision.overHardBy,
              decision.estimateSource
            );
          }
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
            this.lastProviderUsage = null;
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
        roundModelMs += Date.now() - requestStartedAt;

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

        // 空完成 = 无内容且无工具调用。reasoningContent 不参与判定：仅有
        // 思考的响应没有任何可执行载荷，与空响应等价（见守卫头部注释）。
        const isEmptyCompletion =
          !(segment.content ?? '') &&
          (!segment.toolCalls || segment.toolCalls.length === 0);
        if (isEmptyCompletion) {
          emptyAttempt += 1;
          if (emptyAttempt > MAX_EMPTY_COMPLETION_RETRIES_PER_ROUND) {
            // 安全阀（与 length 截断的 MAX_CONTINUATIONS_PER_ROUND 对齐）：
            // 持续空完成说明 provider/模型配置异常，抛错终止而不是无限重试。
            log.error('Empty completion retry limit exceeded; aborting round', {
              round: roundNumber,
              attempts: emptyAttempt - 1,
            });
            throw new Error(
              `模型连续 ${MAX_EMPTY_COMPLETION_RETRIES_PER_ROUND} 次返回空完成，回合终止（请检查模型配置或中转服务是否正常）`
            );
          }
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
        roundReasoning,
        roundModelMs
      );
      await this.session.logStore.append(assistantMsg);

      const hasToolCalls = Boolean(assistant.toolCalls?.length);
      onStreamEvent?.({
        type: 'assistant-round-complete',
        round: roundNumber,
        content: roundContent,
        reasoningContent: roundReasoning,
        hasToolCalls,
        ...(roundModelMs > 0 ? { durationMs: Math.round(roundModelMs) } : {}),
      });

      finalContent = roundContent;
      finalReasoningContent = roundReasoning;
      finalToolCalls = assistant.toolCalls;

      if (!assistant.toolCalls || assistant.toolCalls.length === 0) {
        // 回合自然收尾。清单同步完全交给模型自己（回合末 running 残留由
        // convergeUnconfirmedRunningTasks 兜底回 pending），不再注入提醒
        // 续跑——nudge 是"额外 todo 调用"的制造机，与回合级创建闸门相抵。
        break;
      }

      // ── 分段执行：并行安全工具并行，其余串行 ──────────────────────────
      // 连续命中 PARALLEL_SAFE_TOOL_NAMES 的调用合并为一个并行段并发执行
      // （墙钟从 sum 降到 max）；变更/交互类工具（question/bash/git 等）
      // 各自成串行段，保留 question 短路等原语义。task 在并行名单内，由
      // handler 侧 withTaskSlot 限制同时进行的子会话数。全部结果按原始
      // 调用顺序落账——日志字节顺序与串行执行一致。
      interface ToolCallRecord {
        call: IToolCall;
        result: unknown;
        success: boolean;
        errorMessage?: string;
        toolDurationMs?: number;
      }

      const executeOne = async (call: IToolCall): Promise<ToolCallRecord> => {
        if (call.arguments._parseError) {
          const parseErrorMessage = `工具参数 JSON 解析失败: ${call.arguments.error}. 原始参数(前500字符): ${call.arguments._raw}`;
          log.error(`Tool argument parse failed: ${call.name}`, { error: parseErrorMessage });
          return { call, result: { error: parseErrorMessage }, success: false, errorMessage: parseErrorMessage };
        }
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
        const toolStartedAt = Date.now();
        try {
          const toolTimeoutMs = this.toolTimeouts[call.name] ?? DEFAULT_TOOL_TIMEOUT_MS;
          const result = await withTimeout(
            this.session.toolRegistry.execute(call.name, call.arguments, {
              toolCallId: call.id,
              signal: callController.signal,
            }),
            toolTimeoutMs,
            effectiveSignal,
            () => callController.abort()
          );
          return { call, result, success: true, toolDurationMs: Math.round(Date.now() - toolStartedAt) };
        } catch (err) {
          const errorMessage = (err as Error).message;
          log.error(`Tool execution failed: ${call.name}`, { error: err });
          return {
            call,
            result: { error: errorMessage },
            success: false,
            errorMessage,
            toolDurationMs: Math.round(Date.now() - toolStartedAt),
          };
        } finally {
          effectiveSignal?.removeEventListener('abort', propagateAbort);
        }
      };

      const records: ToolCallRecord[] = [];
      const isParallelSafe = (call: IToolCall): boolean =>
        PARALLEL_SAFE_TOOL_NAMES.has(call.name) && !call.arguments._parseError;
      let cursor = 0;
      while (cursor < assistant.toolCalls.length) {
        if (effectiveSignal?.aborted || question) {
          break;
        }
        const head = assistant.toolCalls[cursor];

        if (!isParallelSafe(head)) {
          // 串行段：question 短路依赖执行后立即提取 __question
          onStreamEvent?.({
            type: 'tool-call-start',
            toolCallId: head.id,
            toolName: head.name,
            arguments: head.arguments,
          });
          const record = await executeOne(head);
          records.push(record);
          if (
            record.result &&
            typeof record.result === 'object' &&
            '__question' in record.result &&
            (record.result as Record<string, unknown>).__question === true
          ) {
            const q = record.result as Record<string, unknown>;
            question = {
              question: (q.question as string) || '',
              header: (q.header as string) || '',
              options: Array.isArray(q.options) ? q.options as QuestionData['options'] : undefined,
              multiple: q.multiple === true,
            };
          }
          cursor += 1;
          continue;
        }

        // 并行段：合并连续安全调用，全段先发 start，再按块并发执行
        const group: IToolCall[] = [head];
        let next = cursor + 1;
        while (next < assistant.toolCalls.length && isParallelSafe(assistant.toolCalls[next])) {
          group.push(assistant.toolCalls[next]);
          next += 1;
        }
        for (const call of group) {
          onStreamEvent?.({
            type: 'tool-call-start',
            toolCallId: call.id,
            toolName: call.name,
            arguments: call.arguments,
          });
        }
        for (let chunkStart = 0; chunkStart < group.length; chunkStart += PARALLEL_TOOL_CHUNK_SIZE) {
          if (effectiveSignal?.aborted) {
            // 段内取消：尚未发出的块不再执行，稍后补占位结果
            break;
          }
          const chunk = group.slice(chunkStart, chunkStart + PARALLEL_TOOL_CHUNK_SIZE);
          const chunkRecords = await Promise.all(chunk.map((call) => executeOne(call)));
          records.push(...chunkRecords);
        }
        cursor = next;
      }

      // 按原始调用顺序落账：tool 消息 + end 事件 + __images 提取。顺序与
      // 串行执行一致，日志字节、缓存哈希与下游管线不受影响。
      for (const record of records) {
        const { call, result, success, errorMessage, toolDurationMs } = record;
        const consumed = this.consumeToolResultSideChannels(result);
        const contextResult = consumed.contextResult;
        const subagentToolInvocations = consumed.subagentToolInvocations;
        const toolMsg = await this.buildToolMessage(call, contextResult, success, toolDurationMs);
        await this.session.logStore.append(toolMsg);
        onStreamEvent?.({
          type: 'tool-call-end',
          toolCallId: call.id,
          toolName: call.name,
          success,
          error: errorMessage,
          // 转录投影只留图片引用（data 置空）：事件输出会进 UI store 并被
          // 持久化，base64 曾把兼容快照撑爆 20MB 上限（保存失败根因）。
          output: redactTranscriptOutputString(safeStringifyOutput(contextResult)),
          contextContent: toolMsg.content,
          contextSummary:
            typeof toolMsg.metadata?.[TOOL_SUMMARY_METADATA_KEY] === 'string'
              ? (toolMsg.metadata[TOOL_SUMMARY_METADATA_KEY] as string)
              : undefined,
          ...(subagentToolInvocations ? { subagentToolInvocations } : {}),
          ...(toolDurationMs !== undefined ? { durationMs: toolDurationMs } : {}),
        });

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

      const executedToolCalls = records.length;

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
      if (signal) {
        signal.removeEventListener('abort', onExternalAbort);
      }
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

  private async buildToolMessage(
    call: IToolCall,
    result: unknown,
    success: boolean,
    durationMs?: number
  ) {
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

    return MessageFactory.tool(call.id, content, success, metadata, durationMs);
  }
}
