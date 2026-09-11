/**
 * Shared type definitions for CodePapr
 * This package defines all core types used across the framework
 */

// ============================================================================
// Message Types
// ============================================================================

export interface IImageContent {
  /** MIME 类型，例如 image/png、image/jpeg、image/webp、image/gif */
  mediaType: string;
  /** 图片的 base64 编码数据（不含 data URI 前缀）。
   *  持久化场景下可为空（见 path，加载后回填）。 */
  data: string;
  /** 落盘引用的工作区相对路径（用户附件为 .CodePapr/chat-images/...；
   *  工具读图可为图片源文件本身的路径）。
   *  base64 体积大不直接进 DB：发送时写盘得到此路径，加载消息后
   *  凭路径回填 data。无 path 的图片不会被持久化。 */
  path?: string;
}

export interface IMessage {
  id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: number;
  reasoningContent?: string;
  toolCalls?: IToolCall[];
  toolResult?: IToolResult;
  /** 可选：assistant 消息 = 本轮 LLM 生成耗时；tool 消息 = 工具执行耗时（毫秒） */
  durationMs?: number;
  /** 可选的图片输入，仅 user 消息使用，由 Provider 映射为多模态内容 */
  images?: IImageContent[];
  metadata?: Record<string, unknown>;
}

export interface IToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface IToolResult {
  toolCallId: string;
  success: boolean;
  result: unknown;
  error?: string;
}

// ============================================================================
// Tool Types
// ============================================================================

export interface IToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler?: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface IToolRegistry {
  register(tool: IToolDefinition): void;
  get(name: string): IToolDefinition | null;
  getAll(): ReadonlyArray<IToolDefinition>;
  freeze(): void;
  isFrozen(): boolean;
}

// ============================================================================
// Cache Partition Types
// ============================================================================

export interface IModelParameters {
  temperature: number;
  topP: number;
  maxTokens?: number;
  [key: string]: unknown;
}

export interface IPrefixContent {
  systemPrompt: string;
  tools: IToolDefinition[];
  fewShots?: IMessage[];
  model: string;
  parameters: IModelParameters;
}

export interface IAppendLogEntry {
  messages: IMessage[];
  lastMessageIndex: number;
  totalBytes: number;
}

export interface ICachePartition {
  prefix: IImmutablePrefix;
  log: IAppendOnlyLog;
  scratch: IVolatileScratch;

  getPrefixHash(): string;
  getLogHash(): string;
  getLogBytes(): number;
  getLogMessageCount(): number;
  validate(): boolean;
  toMessageArray(): IMessage[];
}

// ============================================================================
// Immutable Prefix Interface
// ============================================================================

export interface IImmutablePrefix {
  getSystemPrompt(): string;
  getToolDefinitions(): ReadonlyArray<IToolDefinition>;
  getFewShots(): ReadonlyArray<IMessage>;
  getModelName(): string;
  getParameters(): Readonly<IModelParameters>;

  computeHash(): string;
  getContentBytes(): number;
  validate(): boolean;

  toJSON(): IPrefixContent;
  toMessageArray(): IMessage[];

  isFrozen(): boolean;
  getVersion(): string;
  getCreatedAt(): number;
}

// ============================================================================
// Append-Only Log Interface
// ============================================================================

/** log 的「上线口径」体量：实际会随请求发送的字节 + 图片的 vision token 计费。 */
export interface ILogWireFootprint {
  /** log 全量字节（旧口径，仅供诊断对比）。 */
  logBytes: number;
  /** 实际会随请求上线的字节（不含任何图片 base64）。 */
  wireBytes: number;
  /** 仍在线上的图片按 vision 口径计的 token。 */
  imageTokens: number;
  /** 因冻结摘要替换而不上线的字节。 */
  summarySavingsBytes: number;
  /** 因已被消费而不再上行的图片 base64 字节。 */
  offWireImageBytes: number;
  /** Session Bootstrap（memory / skills / project-graph）的上线字节。 */
  bootstrapBytes: number;
  /** 上下文检查点摘要的上线字节。 */
  checkpointBytes: number;
  /** 最后一条 user 消息的上线字节（不含图片 base64）。 */
  lastUserBytes: number;
  /** 最后一条 user 消息是否就是仍在线的那条图片消息（图片 token 归属它）。 */
  lastUserHoldsLiveImages: boolean;
}

export interface IAppendOnlyLog {
  append(message: IMessage): Promise<number>;
  appendBatch(messages: IMessage[]): Promise<number[]>;

  getMessageAt(index: number): IMessage | null;
  getMessagesSince(index: number): IMessage[];
  getAllMessages(): ReadonlyArray<IMessage>;
  getLastMessage(): IMessage | null;
  length(): number;

  computeHash(): string;
  computeHashSince(index: number): string;
  getContentBytes(): number;
  /** 可选：log 的「上线口径」体量（剥离已消费图片 base64、旧工具全文按冻结摘要
   *  计，图片另按 vision 权重单独计费）。预算决策优先用它；未实现时调用方回落
   *  getContentBytes()。 */
  getWireFootprint?(): ILogWireFootprint;
  /** 可选：`from` 起新增消息的「上线口径」体量（provider 实测增量对账用）。 */
  getWireFootprintSince?(from: number): ILogWireFootprint;
  validate(): boolean;

  toMessageArray(): IMessage[];
  toJSON(): IAppendLogEntry;

  createSnapshot(): IAppendLogEntry;
  loadFromSnapshot(snapshot: IAppendLogEntry): void;
}

// ============================================================================
// Volatile Scratch Interface
// ============================================================================

export interface IVolatileScratch {
  setThinking(content: string): void;
  addIntermediatePlan(step: string): void;
  addNote(key: string, value: unknown): void;

  getThinking(): string;
  getIntermediatePlans(): string[];
  getNote(key: string): unknown | undefined;
  getAll(): Record<string, unknown>;

  reset(): void;
  markRoundStart(): void;
  markRoundEnd(): void;
  getLastRoundData(): Record<string, unknown>;

  toJSON(): null;
}

// ============================================================================
// Session & Agent Types
// ============================================================================

export interface IAgentResponse {
  role: 'assistant';
  content: string;
  reasoningContent?: string;
  toolCalls?: IToolCall[];
  cacheStats?: ICacheStatistics;
  /** Per-tier cache stats accumulated from subagent (task/explore/scout/mentor)
   *  runs, kept separate from `cacheStats` (which reflects the main agent only)
   *  so the dashboard can attribute fast vs primary vs mentor model usage
   *  correctly. */
  subagentCacheStatsByTier?: {
    primary?: ICacheStatistics;
    fast?: ICacheStatistics;
    mentor?: ICacheStatistics;
  };
  question?: QuestionData;
}

export interface QuestionData {
  question: string;
  header: string;
  options?: QuestionOption[];
  multiple?: boolean;
  /** 附加说明（决策卡片格式携带的补充信息，question 工具不产生）。 */
  note?: string;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface ICacheStatistics {
  cacheCreationTokens: number;
  cacheReadTokens: number;
  newInputTokens: number;
  outputTokens: number;
  cacheHitRate?: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
  calls?: number;
}

/** 思考打开时请求体携带的字段组合。网关各认一套，由模型配置显式选择。 */
export type ThinkingPayload = 'reasoning' | 'thinking' | 'both';

export interface MentorConfig {
  enabled: boolean;
  model: string;
  baseURL: string;
  apiKey: string;
  apiFormat: 'openai' | 'claude' | 'response';
  maxTokens: number;
  maxConsultations: number;
  thinkingEnabled: boolean;
  thinkingEffort: string;
  thinkingBudgetTokens: number;
  thinkingPayload?: ThinkingPayload;
}

/**
 * 子代理内部工具调用记录。用于把 subagent 的 tool_invocations 持久化到父级
 * task 工具调用上，便于事后分析（不影响主代理 LLM 上下文）。
 */
export interface ISubagentToolInvocation {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  status: 'success' | 'error';
  error?: string;
  output?: string;
}

/** 上下文分区阶段：稳定前缀（系统提示词/工具/few-shot）、会话状态（引导注入）、对话历史 */
export type ContextStage = 'stable-prefix' | 'session-state' | 'conversation';

export interface IContextMessageView {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  stage: ContextStage;
  estimatedTokens: number;
  /** tool 结果消息：对应工具名 */
  toolName?: string;
  /** assistant 消息：本轮发起的工具调用概要（名称列表） */
  toolCallNames?: string[];
  /** 消息进入上下文的时间戳（用于甘特图时间线展示） */
  timestamp?: number;
  /** assistant 消息：思考模式下的思维链内容 */
  reasoningContent?: string;
  /** assistant 消息：思维链 token 估算（不含在 estimatedTokens 内） */
  reasoningTokens?: number;
  /** assistant 消息 = LLM 生成耗时；tool 消息 = 工具执行耗时（毫秒，缺省=未测量） */
  durationMs?: number;
  /** UI 注入的 assistant 消息（mode-switch 指令、carry-forward 证据等），
   *  非本轮模型生成，上下文检查器据此归入用户输入泳道 */
  uiInjected?: boolean;
}

export interface IContextSnapshot {
  round: number;
  model: string;
  messages: IContextMessageView[];
  /** 工具定义名称列表（稳定前缀的一部分） */
  toolNames: string[];
  /** 完整工具定义（含 schema），用于上下文检查器展示 */
  toolDefinitions?: Array<{ name: string; description: string; parameters: unknown }>;
  /** 工具定义（schema）的估算 token，独立于消息 */
  toolsTokenEstimate: number;
  totalTokens: number;
  tokensByStage: Record<ContextStage, number>;
  capturedAt: number;
  /** PR1（ADR-001/005）：context surface / compaction provenance 观测数据 */
  contextSurface?: {
    generation: number | null;
    nodeCount: number;
    nodeKinds: Record<string, number>;
    latestCompaction: {
      id: string;
      status: string;
      trigger: string;
      sourceGeneration: number;
      targetGeneration: number | null;
      checkpointMessageId: string | null;
      sourceStartMessageId: string | null;
      sourceEndMessageId: string | null;
      retainedTailStartMessageId: string | null;
      sourceMessageCount: number;
      retainedMessageCount: number;
      estimatedTokensBefore: number | null;
      estimatedTokensAfter: number | null;
      summaryMode: string;
      summaryModel: string | null;
      createdAt: number;
      completedAt: number | null;
    } | null;
  };
  /** PR5（ADR-009）：本会话最新一次 Recall 检索（审计观测）。 */
  memoryRecall?: {
    recallId: string;
    query: string;
    estimatedTokens: number;
    createdAt: number;
    status: string;
    items: Array<{
      title: string;
      source: string;
      confidence: string;
      score: number;
    }>;
  };
}

export type IChatStreamEvent =
  | { type: 'assistant-round-start'; round: number }
  | { type: 'request-context'; round: number; content: string; snapshot: IContextSnapshot }
  | {
      type: 'assistant-round-complete';
      round: number;
      content: string;
      reasoningContent?: string;
      /** 本轮 LLM 生成总耗时（含续写重试的请求，不含空完成退避等待），毫秒 */
      durationMs?: number;
      /** 本轮 assistant 带了 tool_calls，随后还会执行工具；UI 不得把回合标成已完成。 */
      hasToolCalls?: boolean;
    }
  | { type: 'reasoning-delta'; delta: string }
  | { type: 'content-delta'; delta: string }
  /** 流中断后整段重试即将开始：此前已推送的 reasoning/content 增量作废，
   *  消费方必须先清空已累积内容再接收新一轮增量（LLM 流无法断点续传）。
   *  maxRetries 缺省 = 无限重试（可重试故障不再终止回合）。 */
  | { type: 'stream-restart'; attempt: number; maxRetries?: number }
  /** 请求尚未建立流（连接层失败）时的自动重试：尚无任何输出可作废，
   *  消费方仅需更新状态提示。maxRetries 缺省 = 无限重试。 */
  | { type: 'request-retry'; attempt: number; maxRetries?: number }
  /** Agent 层回合级重试：模型返回空完成（empty）或输出被 max_tokens 截断后
   *  自动续写（length-continue）。消费方仅需更新状态提示，不清空已有内容
   *  （length-continue 的已输出片段保留并继续拼接）。 */
  | { type: 'round-retry'; reason: 'empty' | 'length-continue'; attempt: number }
  | {
      type: 'tool-call-start';
      toolCallId: string;
      toolName: string;
      arguments: Record<string, unknown>;
    }
  | {
      type: 'tool-call-progress';
      toolCallId?: string;
      toolName: string;
      arguments: Record<string, unknown>;
      statusText?: string;
      output?: string;
    }
    | {
        type: 'tool-call-end';
        toolCallId: string;
        toolName: string;
        success: boolean;
        error?: string;
        output?: string;
        /** Original tool call arguments. Carried by placeholder end events
         *  (skipped calls, e.g. question/cancel interruption) that have no
         *  preceding start event, so the invocation persisted from this event
         *  rebuilds byte-identically with the live log. */
        arguments?: Record<string, unknown>;
        /** Byte-exact tool message content actually appended to the log (already
         *  truncated + deterministically serialized). Persisted so a restored
         *  history rebuilds tool messages byte-identically and does not break the
         *  prefix cache. `output` stays the full raw result for UI display. */
        contextContent?: string;
        /** Frozen history summary (tool context mode). The log keeps the full
         *  content; this summary replaces older tool messages when requests are
         *  built. Persisted so rebuilt history applies the same summaries
         *  byte-identically. Absent when the tool stays full in history. */
        contextSummary?: string;
        subagentToolInvocations?: ISubagentToolInvocation[];
        /** 工具实际执行耗时（毫秒）；跳过的占位调用无此字段 */
        durationMs?: number;
      }
  | { type: 'context-compacted'; round: number }
  /** PR2：soft~hard 区间原地裁剪旧工具结果（非压缩 epoch 重置）。 */
  /** C：压缩熔断——本回合不再尝试 mid-loop 压缩（真超限由 provider overflow
   *  路径与 reject-request 兜底）。reason：
   *  - 'no-effective-shrink'：连续多次压缩后上线体量没有实质下降；
   *  - 'per-turn-limit'：单次回合的压缩次数已达上限。 */
  | {
      type: 'context-compaction-blocked';
      round: number;
      reason: 'no-effective-shrink' | 'per-turn-limit';
      attempts: number;
      estimatedTokens: number;
    };

// ============================================================================
// LLM Provider Types
// ============================================================================

export interface ILLMProvider {
  name: string;
  models: string[];

  chat(request: IChatRequest, signal?: AbortSignal): Promise<IChatResponse>;
  streamChat?(
    request: IChatRequest,
    onEvent: (event: IChatStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<IChatResponse>;
  validate(): boolean;
}

export interface IChatThinking {
  type: 'enabled' | 'disabled';
  /** OpenAI 兼容推理强度（reasoning_effort）：minimal/low/medium/high/xhigh/max，
   *  第三方端点可能自定义取值，按原样透传。 */
  reasoningEffort?: string;
  /** Claude 格式思考预算（token）。Anthropic 硬约束 ≥1024 且 < max_tokens，
   *  provider 侧钳制；第三方 Claude 兼容端点可自由取值。 */
  budgetTokens?: number;
  /** 思考打开时请求体带哪些字段。缺省由 provider 按自身惯例回填。 */
  payload?: ThinkingPayload;
}

export interface IChatRequest {
  messages: IMessage[];
  model: string;
  thinking?: IChatThinking;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  tools?: IToolDefinition[];
  cacheControl?: {
    type: 'ephemeral' | 'session';
    budgetTokens?: number;
  };
  metadata?: {
    prefixHash?: string;
    logHash?: string;
    expectedPrefixHash?: string;
    requestShapeHash?: string;
  };
}

export interface IChatResponse {
  id: string;
  choices: Array<{
    message: {
      role: 'assistant';
      content: string;
      reasoningContent?: string;
      toolCalls?: IToolCall[];
    };
    finishReason: string;
  }>;
  usage?: {
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    input_tokens: number;
    output_tokens: number;
  };
  system_fingerprint?: string;
}

export interface ICacheValidation {
  prefixCached: boolean;
  prefixCreated: boolean;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  newInputTokens: number;
  outputTokens: number;
  cacheHitRate: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
}

// ============================================================================
// TodoList Types
// 主 Agent 的"短期工作记忆"，由 todo_* 工具族读写。
// 与 task 工具（子代理委派）正交协作：todo_* 维护主 Agent 自己的计划，
// task 把单个 todo 分发给子代理执行。
// ============================================================================

/**
 * 单条任务状态。沿用既有 'running'（而非 'in_progress'），避免破坏 UI/i18n。
 * - pending: 已规划，未开始
 * - running: 正在执行（同一时刻最多一条）
 * - completed: 已完成且通过验证
 * - failed: 已失败（连续重试仍未通过）
 */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface AgentTask {
  /** kebab-case 任务 ID，必须在 TodoList 内唯一 */
  id: string;
  /** 任务简述，UI 一行显示 */
  title: string;
  /** 详细完成标准（Definition of Done）。供 Agent 自检和 verify */
  description: string;
  status: TaskStatus;
  /** 依赖的前置任务 ID 列表；空表示无依赖 */
  dependsOn?: string[];
  /** 计划阶段声明的预期产出文件路径，用于 verify 阶段断言 */
  expectedArtifacts?: string[];
  /** 该任务执行过程中实际改动/新建的文件路径 */
  touchedArtifacts?: string[];
  /** 完成或失败时的简短说明，供 UI 展示 */
  summary?: string;
  /** 失败时的结构化错误日志，供 Agent 自我反思 */
  errorLog?: string;
}

export interface TodoListContext {
  /** 用户的终极目标 */
  goal: string;
  tasks: AgentTask[];
  /** 当前任务：每次快照返回时由任务状态纯推导（running 优先，否则首个可执行 pending） */
  currentTaskId: string | null;
  /** 顶层 TodoList 状态：active 表示尚有 pending/running，completed 表示全部终结 */
  status: 'active' | 'completed';
  createdAt: number;
  updatedAt: number;
}

// ============================================================================
// Goal Types
// /goal 指令的类型定义：双模型（Worker + Evaluator）自主循环
// ============================================================================

/** 单个验证条件子句 */
export interface GoalConditionClause {
  type: 'exec';
  /** 要执行的命令（不含参数解析，由 executor 拆分） */
  command: string;
  /** 命令参数列表 */
  args: string[];
  /** 可选的 stdout 正则匹配模式；存在时要求 stdout 匹配此模式 */
  matchPattern?: string;
  /** 是否取反（条件不满足才算通过） */
  negate?: boolean;
}

/** Verifier 严格度：strict=零容忍，normal=默认，loose=有明显进展即可 */
export type GoalStrictness = 'strict' | 'normal' | 'loose';

/** 完整的验证条件，多个子句 AND 在一起 */
export interface GoalCondition {
  clauses: GoalConditionClause[];
  /** 原始输入文本 */
  rawText: string;
  /** 人类可读的条件描述 */
  humanReadable: string;
  /** Verifier 严格度（默认 normal） */
  strictness: GoalStrictness;
  /** 第 1 轮是否只做规划不执行 */
  planFirst: boolean;
}

/** 单个子句的执行结果 */
export interface ConditionClauseResult {
  clauseIndex: number;
  met: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  evidence: string;
}

/** 完整条件的评估结果 */
export interface ConditionResult {
  met: boolean;
  evidence: string;
  details: ConditionClauseResult[];
}

/** Verifier 子代理的判定结果 */
export interface GoalVerdict {
  verdict: 'SATISFIED' | 'NOT_MET' | 'AMBIGUOUS';
  evidence: string;
  missing?: string;
  /** 本轮相对进展评估 0-1（0=完全没动，1=完成），用于衡量 Worker 是否在有效推进 */
  progress?: number;
  /** 失败模式分类，用于反馈给 Worker 指导下一轮策略调整 */
  failureMode?: 'no_action' | 'wrong_approach' | 'partial_fix' | 'regression' | 'unknown';
}

/** Goal 运行状态 */
export type GoalRunnerStatus =
  | 'running'
  | 'satisfied'
  | 'limit_exceeded'
  | 'interrupted'
  /** Worker 在回合中向用户提问（question 工具），循环暂停等待回答。 */
  | 'awaiting_input'
  | 'error';

/** 单轮迭代的反馈记录 */
export interface GoalIterationFeedback {
  iteration: number;
  verdict: GoalVerdict;
  conditionResult: ConditionResult;
}

/** GoalRunner 的完整运行时状态 */
export interface GoalRunnerState {
  status: GoalRunnerStatus;
  iteration: number;
  startedAt: number;
  elapsedMs: number;
  totalOutputTokens: number;
  lastVerdict: GoalVerdict | null;
  lastConditionResult: ConditionResult | null;
  feedbackHistory: GoalIterationFeedback[];
  /** Worker 在回合中通过 question 工具向用户提问（status=awaiting_input）。 */
  question?: QuestionData;
  error?: string;
}

/** GoalRunner 的限制参数 */
export interface GoalRunnerLimits {
  maxIterations: number;
  maxWallClockMs: number;
  maxCostTokens?: number;
  compactionEveryNIterations?: number;
  /** 第 1 轮是否只做规划不执行（只读探索 + 输出子计划） */
  planFirst?: boolean;
}

// ============================================================================
// Error Types
// ============================================================================

export class CacheConsistencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CacheConsistencyError';
  }
}

export class AppendOnlyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppendOnlyViolationError';
  }
}

export class PrefixModificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrefixModificationError';
  }
}

// ============================================================================
// Papr App Types
// ============================================================================

export interface PaprAgentDef {
  name: string;
  model?: string;
  systemPrompt?: string;
  tools?: string[];
  maxToolRounds?: number;
  inheritContext?: {
    skills?: boolean;
    projectRules?: boolean;
    projectMemory?: boolean;
    customPrompt?: boolean;
  };
}

export type PaprPermission =
  | 'storage:read'
  | 'storage:write'
  | 'http:get'
  | 'http:post'
  | 'fs:read'
  | 'fs:write'
  | 'workspace:read'
  | 'workspace:write'
  | 'workspace:exec'
  | `agent:run:${string}`;

/** 两轴权限模型：本地（工作区）访问轴。 */
export type PaprLocalAccess = 'none' | 'read' | 'write';

/** 两轴权限：local（无/只读/读写执行）× network（关/开）。 */
export interface PaprAccess {
  local: PaprLocalAccess;
  network: boolean;
}

/** 工具桥接携带的 app 沙箱访问档：主线程执行 bash 等工具时按此构建沙箱。 */
export interface AppSandboxAccess {
  network: boolean;
  workspaceWrite: boolean;
  /** App 模式 / 应用内 Agent：放行 `.CodePapr/apps`。默认 false。 */
  allowCodepaprApps?: boolean;
}

/** 旧四档等级（仅用于老 manifest 迁移，新代码使用 PaprLocalAccess）。 */
export type PaprLevel = 0 | 1 | 2 | 3;

export interface PaprAppSettings {
  defaultLocal: PaprLocalAccess;
  defaultNetwork: boolean;
  appOverrides: Record<string, PaprAccess>;
}

/** .papr 产物形态：app 全屏独占；plugin 主窗口内 overlay，与工作台共存。 */
export type PaprKind = 'app' | 'plugin';

export type PaprOverlayPosition = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';

export type PaprSurfaceType = 'overlay' | 'panel';

/**
 * 插件表面。overlay = 主窗口浮卡；panel = 停靠右侧栏（对标 Cursor canvas）。
 * width/height/position 只对 overlay 有意义。
 */
export interface PaprSurface {
  type?: PaprSurfaceType;
  width?: number;
  height?: number;
  position?: PaprOverlayPosition;
  alwaysOnTop?: boolean;
  transparent?: boolean;
  decorations?: boolean;
  resizable?: boolean;
}

/** 插件 overlay 出现策略。缺省：声明了 inbox → onDemand，否则 always。 */
export type PaprPluginShow = 'always' | 'onDemand' | 'never';

export interface PaprLifecycle {
  /** 工作区发现时是否自动启用（进入 agent 目录）。默认 true。不表示自动显示 overlay。 */
  autostart?: boolean;
  persistPosition?: boolean;
  /** 仅 plugin：启用后 overlay 何时出现。 */
  show?: PaprPluginShow;
}

/**
 * manifest inbox 频道声明：agent 通过 app_publish 向频道推送内容，
 * app/plugin 用 papr.events.on(channel, cb) 实时接收。
 * 声明 inbox 后，app_publish 只允许已声明的频道（传错即报错并列出可用频道）。
 */
export interface PaprInboxChannel {
  description?: string;
  example?: unknown;
}

export interface PaprManifest {
  spec: string;
  name: string;
  version?: string;
  entry?: string;
  icon?: string;
  kind?: PaprKind;
  surface?: PaprSurface;
  lifecycle?: PaprLifecycle;
  permissions?: PaprPermission[];
  agents?: PaprAgentDef[];
  inbox?: Record<string, PaprInboxChannel>;
  command?: string;
  args?: string[];
  port?: number;
  level?: PaprLevel;
  local?: PaprLocalAccess;
  network?: boolean;
}

/** app_publish 推送给 app/plugin 的事件信封（papr.events.on 的回调参数）。 */
export interface PaprAppEvent {
  channel: string;
  seq: number;
  ts: number;
  payload: unknown;
}

export interface PaprIPCRequest {
  __papr: true;
  reqId: string;
  type: string;
  payload?: unknown;
}

export interface PaprIPCResponse {
  __papr: true;
  reqId: string;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

export * from "./contextSurface";
