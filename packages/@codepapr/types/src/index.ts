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
  /** 图片的 base64 编码数据（不含 data URI 前缀） */
  data: string;
}

export interface IMessage {
  id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: number;
  reasoningContent?: string;
  toolCalls?: IToolCall[];
  toolResult?: IToolResult;
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

export interface MentorConfig {
  enabled: boolean;
  model: string;
  baseURL: string;
  apiKey: string;
  apiFormat: 'openai' | 'claude';
  maxTokens: number;
  maxConsultations: number;
  thinkingEnabled: boolean;
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
}

export type IChatStreamEvent =
  | { type: 'assistant-round-start'; round: number }
  | { type: 'request-context'; round: number; content: string; snapshot: IContextSnapshot }
  | {
      type: 'assistant-round-complete';
      round: number;
      content: string;
      reasoningContent?: string;
    }
  | { type: 'reasoning-delta'; delta: string }
  | { type: 'content-delta'; delta: string }
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
      }
  | { type: 'context-compacted'; round: number };

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
  reasoningEffort?: 'high' | 'max';
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
  /** 已重试次数 */
  retries?: number;
  /** 单条任务允许的最大重试次数；超过则进入 re-plan */
  maxRetries?: number;
}

export interface TodoListContext {
  /** 用户的终极目标 */
  goal: string;
  tasks: AgentTask[];
  /** 当前正在执行的任务 ID；空表示尚未开始或全部完成 */
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

export type PaprLevel = 0 | 1 | 2 | 3;

export interface PaprAppSettings {
  defaultLevel: PaprLevel;
  allowLevel3: boolean;
  appOverrides: Record<string, PaprLevel>;
}

export interface PaprManifest {
  spec: string;
  name: string;
  version?: string;
  entry?: string;
  permissions?: PaprPermission[];
  agents?: PaprAgentDef[];
  command?: string;
  args?: string[];
  port?: number;
  level?: PaprLevel;
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
