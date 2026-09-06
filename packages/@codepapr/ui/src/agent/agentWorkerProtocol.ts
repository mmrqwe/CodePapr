import type { AgentDefinition, SkillDefinition } from '@codepapr/core';
import type { McpSettings } from '../utils/mcpTypes';
import type {
  ContextCompactionIntent,
  IAgentResponse,
  IChatRequest,
  IChatResponse,
  IChatStreamEvent,
  IImageContent,
  IMessage,
  IToolDefinition,
  RequestContextInsertion,
} from '@codepapr/types';
import type { ContextCheckpointPayload } from '../utils/contextCompaction';
import type { Lang } from '../utils/i18n';
import type { ThinkingPayload } from '@codepapr/types';

export type WorkerApiMode = 'deepseek' | 'custom' | 'local';
export type WorkerApiFormat = 'openai' | 'claude' | 'response';
export type WorkerProviderName = 'deepseek' | 'openai' | 'claude' | 'response';

export interface WorkerAgentSettings {
  apiMode: WorkerApiMode;
  apiFormat: WorkerApiFormat;
  provider: WorkerProviderName;
  baseURL: string;
  apiKey: string;
  model: string;
  fastModelEnabled: boolean;
  fastModel: string;
  temperature: number;
  maxTokens: number;
  maxToolRounds: number;
  thinkingEnabled: boolean;
  thinkingEffort: string;
  thinkingBudgetTokens: number;
  thinkingPayload: ThinkingPayload;
  lang?: Lang;
  mentorEnabled: boolean;
  mentorModel: string;
  mentorBaseURL: string;
  mentorApiKey: string;
  mentorApiFormat: WorkerApiFormat;
  mentorMaxTokens: number;
  mentorThinkingEnabled: boolean;
  mentorThinkingEffort: string;
  mentorThinkingBudgetTokens: number;
  mentorThinkingPayload: ThinkingPayload;
  exploreTopP: number;
  exploreMaxTokens: number;
  exploreThinkingEnabled: boolean;
  exploreTemperature: number;
  exploreMaxToolRounds: number;
  exploreMaxDepth: number;
  exploreModelTier: 'primary' | 'fast';
  scoutTopP: number;
  scoutMaxTokens: number;
  scoutThinkingEnabled: boolean;
  scoutTemperature: number;
  scoutMaxToolRounds: number;
  scoutMaxDepth: number;
  scoutModelTier: 'primary' | 'fast';
  appSubAgentModelTier: 'primary' | 'fast';
  appSubAgentThinkingEnabled: boolean;
  appSubAgentMaxToolRounds: number;
  mcp: McpSettings;
  graphToolTimeoutMs: number;
  toolIpcTimeoutMs: number;
  streamIdleTimeoutMs: number;
  multimodalEnabled: boolean;
  multimodalModelTier: 'primary' | 'fast' | 'all';
  toolOutputInterceptChars: number;
  toolOutputOffloadChars: number;
  toolOutputCeilingChars: number;
  toolOutputPreviewChars: number;
  toolOutputMiddleKeepChars: number;
  pruneOldToolResults: boolean;
  pruneProtectRounds: number;
  pruneMinChars: number;
  toolContextDefaultMode: 'full' | 'summary' | 'auto';
  toolContextOverrides: Record<string, 'full' | 'summary' | 'auto'>;
  toolContextSummaryMaxChars: number;
  toolContextAutoThresholdChars: number;
  maxContextTokens: number;
  maxConversationRounds: number;
  compactionModel: 'fast' | 'primary';
  compactionMaxTokens: number;
  compactionTemperature: number;
  searxngEnabled?: boolean;
  searxngBaseUrl?: string;
  searxngCategories?: string;
  searxngTimeRange?: string;
  searxngLanguage?: string;
  searxngSafeSearch?: number;
  searxngEngines?: string;
}

export interface WorkerAgentParameters {
  temperature: number;
  topP: number;
  maxTokens: number;
  thinkingEnabled: boolean;
  reasoningEffort: string;
  thinkingBudgetTokens?: number;
  thinkingPayload?: ThinkingPayload;
}

export interface WorkerAgentRuntimeConfig {
  rulesSection?: string;
  customPrompt?: string;
  memorySection?: string;
  lang?: Lang;
  /** 当前工作模式：ask/plan 会在注册层屏蔽变更类工具。缺省 agent。 */
  mode?: 'ask' | 'plan' | 'agent' | 'app';
  skillDefinitions?: SkillDefinition[];
  agentDefinitions?: AgentDefinition[];
  mcpToolDefinitions?: IToolDefinition[];
  mcpToolMappings?: Array<{ serverId: string; toolName: string; displayName: string }>;
}

export interface AgentWorkerChatPayload {
  requestId: string;
  sessionId: string;
  workspacePath: string;
  messages: IMessage[];
  /** When set, the worker reuses its cached log for `sessionId` instead of
   *  rebuilding from `messages` — avoiding a full-log structured clone each
   *  turn. `messages` is then empty. Absent => full sync from `messages`.
   *
   * 增量追赶（5.0.1）：缓存长度与 `expectedBaseLength` 不一致时（回合中道
   * 取消/出错残留尾部，或中途压缩/裁剪改写了 worker 日志），先按
   *  `prefixHash`（主线程日志前 `expectedBaseLength` 条消息的级联哈希，
   *  `AppendOnlyLog.computeHashUpTo` 按前缀长度记忆化）校验公共前缀；
   *  一致则把缓存裁剪/追赶到 `expectedBaseLength` 后追加 `newMessages`，
   *  不一致则向主线程发 `sync-mismatch` 换取完整消息、原地重建后继续。 */
  incrementalSync?: {
    expectedBaseLength: number;
    newMessages: IMessage[];
    prefixHash: string;
  };
  userInput: string;
  /**
   * 当前回合 canonical user 消息的 ID（主线程生成，贯穿 store 与 worker log）。
   * ADR-009：Recall 的 anchor 依赖此 ID 稳定；PR1 落地 ID 管线改造。
   */
  userMessageId?: string;
  /**
   * Request-only 上下文插入（ADR-009 B3）：RequestBuilder 编译时锚定插入，
   * 不进 log / archive / surface。PR5 接线。
   */
  contextInsertions?: RequestContextInsertion[];
  images?: IImageContent[];
  settings: WorkerAgentSettings;
  providerName: WorkerProviderName;
  model: string;
  systemPrompt: string;
  parameters: WorkerAgentParameters;
  toolDefinitions: IToolDefinition[];
  runtime: WorkerAgentRuntimeConfig;
}

/** Warms the worker's cached settings/tools/workspace/runtime before any chat
 *  turn runs. App agents (`run-app-agent`) rely on these caches and must work
 *  even when the user has not sent a chat message yet. */
export interface AgentWorkerInitPayload {
  settings: WorkerAgentSettings;
  toolDefinitions: IToolDefinition[];
  workspacePath: string;
  runtime: WorkerAgentRuntimeConfig;
}

export interface AgentWorkerToolResponse {
  requestId: string;
  toolRequestId: string;
  success: boolean;
  result?: unknown;
  error?: string;
  /** PR5（ADR-009 第11条）：memory_search 触发的 re-recall 插入（order 递增，
   *  追加在旧 insertion 之后）。worker 收到后 push 进本回合 Agent 的
   *  contextInsertions，每 turn 至多一次。 */
  reRecallInsertion?: RequestContextInsertion;
}

// ── Harness（外部 CLI / 评测机）协议 ────────────────────────────────
// 桌面路径（init/chat）保持不变；harness/* 帧仅在 sidecar 的 mediator
// 里消费，mediator 再把这些请求翻译成与桌面逐字节同构的 init/chat 帧喂
// 给同一个 Agent 循环。协议版本化，缺帧能力时 CLI 侧硬失败（不降级）。

export const HARNESS_PROTOCOL_VERSION = 1 as const;

export interface HeadlessQuestionPolicy {
  /** auto-default：question 工具即时以默认项应答（options[0].label 或
   *  answers 预置值）；skip：返回工具错误并记 question.skipped 事件。 */
  mode: 'auto-default' | 'skip';
  /** 可选答案表（CLI 侧解析 --question-answers 后传入）：
   *  key 为 question 文本，value 为应答文本。未命中回落 options[0]。 */
  answers?: Record<string, string>;
}

export interface HarnessInitPayload {
  requestId: string;
  workspacePath: string;
  mode: 'ask' | 'plan' | 'agent';
  /** 完整 WorkerAgentSettings 的部分覆盖，装配基于桌面 DEFAULT_SETTINGS。 */
  settingsOverride?: Partial<WorkerAgentSettings>;
  /** 覆盖自定义系统提示词段（bootstrap 的 customPromptSection）。 */
  systemPromptOverride?: string;
  rulesSection?: string;
  policy?: {
    question?: HeadlessQuestionPolicy;
  };
}

export interface HarnessRunPayload {
  requestId: string;
  sessionId: string;
  prompt: string;
  userMessageId?: string;
}

export type HarnessEventName =
  | 'run.ready'
  | 'question.answered'
  | 'question.skipped'
  | 'tool.unsupported'
  | 'tool.blocked'
  | 'todo.updated';

export interface HarnessEventFrame {
  type: 'harness-event';
  requestId: string;
  sessionId: string;
  name: HarnessEventName;
  payload: Record<string, unknown>;
}

/**
 * 压缩提交协议（ADR-005）：worker mid-loop 产出 intent，主线程校验并
 * 单事务持久化后应答。worker 仅在 success 后 replaceLog。
 *
 * materializedMessages 不由主线程回填：主线程 archive 没有 worker-only
 * 本回合 assistant/tool 尾，runtime 继续使用 worker 本地压缩后的 log；
 * 下一次 agent 重建按 committed surface hydrate。
 */
export interface CommitContextCompactionRequest {
  requestId: string;
  intent: ContextCompactionIntent;
  commit: MidLoopCompactionCommit;
}

export interface CommitContextCompactionResponse {
  requestId: string;
  success: boolean;
  generation?: number;
  compactionId?: string;
  materializedMessages?: IMessage[];
  error?: string;
}

/**
 * mid-loop 压缩的提交数据（ADR-005）：worker 只产出该结构，主线程 Store
 * 校验并单事务持久化（contextSurfaceStore.commitContextCheckpoint）。
 * provenance 全部来自 checkpoint payload（message.contextCheckpoint）。
 */
export interface MidLoopCompactionCommit {
  checkpointMessageId: string;
  /** UI 形状的 checkpoint 消息（含完整 payload），主线程插入 sessionMessages。 */
  checkpointMessage: {
    id: string;
    role: 'assistant';
    content: string;
    timestamp: number;
    synthetic?: boolean;
    hidden?: boolean;
    contextCheckpoint?: ContextCheckpointPayload;
  };
  /** 相对 worker contextMessages 的插入位置（仅作诊断参考；主线程按 ID 定位）。 */
  insertIndex: number;
  sourceMessageIds: string[];
  retainedMessageIds: string[];
  /**
   * 本回合锚点（ADR-009 第14条的延伸）：retained 起点落在 worker-only 区域
   * （本回合 assistant/tool 消息 ID 由 worker 生成、不在 archive）时，主线程
   * 用 user 消息 ID + source 区间内本回合 assistant 回合数做回合映射定位边界。
   */
  turnUserMessageId?: string;
  sourceAssistantRoundsInTurn?: number;
}

export type MainToAgentWorkerMessage =
  | {
      type: 'init';
      payload: AgentWorkerInitPayload;
    }
  | {
      type: 'chat';
      payload: AgentWorkerChatPayload;
    }
  | {
      type: 'tool-response';
      payload: AgentWorkerToolResponse;
    }
  | {
      type: 'permission-wait';
      waiting: boolean;
    }
  | {
      type: 'proxy-chat-response';
      proxyChatId: string;
      success: boolean;
      result?: IChatResponse;
      error?: string;
    }
  | {
      type: 'refresh-bootstrap-response';
      bootstrapRequestId: string;
      success: boolean;
      bootstrap?: string | null;
      error?: string;
    }
  | {
      type: 'commit-context-compaction-response';
      requestId: string;
      success: boolean;
      generation?: number;
      compactionId?: string;
      error?: string;
    }
  | {
      /** `sync-mismatch` 的应答：该会话当前完整日志，worker 用它重建缓存后
       *  继续挂起的回合（重建结果已含全部消息，无需再追加增量）。 */
      type: 'full-sync-response';
      requestId: string;
      sessionId: string;
      messages: IMessage[];
    }
  | {
      type: 'fetch-response-start';
      fetchId: string;
      status: number;
      statusText: string;
      headers: Array<[string, string]>;
    }
  | {
      type: 'fetch-response-chunk';
      fetchId: string;
      chunk: Uint8Array;
    }
  | {
      type: 'fetch-response-end';
      fetchId: string;
    }
  | {
      type: 'fetch-response-error';
      fetchId: string;
      error: string;
    }
  | {
      type: 'cancel-session';
      requestId: string;
    }
  | {
      type: 'harness/ping';
    }
  | {
      type: 'harness/init';
      payload: HarnessInitPayload;
    }
  | {
      type: 'harness/run';
      payload: HarnessRunPayload;
    }
  | {
      type: 'run-app-agent';
      requestId: string;
      payload: AppAgentPayload;
    }
  | {
      type: 'cancel-app-agent';
      requestId: string;
    }
  | {
      type: 'ping';
    };

export interface AgentWorkerProxyChatConfig {
  apiKey: string;
  baseURL?: string;
  format: WorkerApiFormat;
}

/** Base idle window for app-agent runs. Both the worker (withIdleTimeout) and
 *  the main thread (armAppAgentIdleTimer) must use the same effective value,
 *  otherwise one side kills a run the other still considers healthy. */
export const APP_AGENT_BASE_IDLE_TIMEOUT_MS = 300_000;

/** A single tool call is legitimate activity: when the configured tool IPC
 *  timeout exceeds the base idle window, extend the window so one slow tool
 *  (e.g. a long bash run) is not killed mid-flight by the idle watchdog. */
export function resolveAppAgentIdleTimeoutMs(toolIpcTimeoutMs: number | undefined): number {
  return Math.max(APP_AGENT_BASE_IDLE_TIMEOUT_MS, (toolIpcTimeoutMs ?? 120_000) + 30_000);
}

export interface AppAgentPayload {
  appId: string;
  agentName: string;
  systemPrompt?: string;
  model?: string;
  task: string;
  tools?: string[];
  maxToolRounds?: number;
  workspacePath?: string;
  /** 两轴访问：本地（工作区）访问轴 */
  local?: 'none' | 'read' | 'write';
  /** 两轴访问：网络开关 */
  network?: boolean;
  /** 旧等级（兼容）；有 local/network 时忽略 */
  level?: number;
  inheritContext?: {
    skills?: boolean;
    projectRules?: boolean;
    projectMemory?: boolean;
    customPrompt?: boolean;
  };
}

export interface AppAgentResult {
  content: string;
  reasoningContent?: string;
  steps?: Array<{ name: string; status: string; summary?: string }>;
}

export type AgentWorkerToMainMessage =
  | {
      type: 'stream';
      requestId: string;
      event: IChatStreamEvent;
    }
  | {
      type: 'harness-pong';
      protocolVersion: typeof HARNESS_PROTOCOL_VERSION;
    }
  | {
      type: 'harness-ready';
      requestId: string;
      protocolVersion: typeof HARNESS_PROTOCOL_VERSION;
      mode: 'ask' | 'plan' | 'agent';
      toolNames: string[];
    }
  | HarnessEventFrame
  | {
      type: 'tool-request';
      requestId: string;
      toolRequestId: string;
      toolName: string;
      arguments: Record<string, unknown>;
      /** Assistant tool-call id this execution fulfills; preferred for matching
       *  the pending call over name+arguments (robust for identical calls). */
      toolCallId?: string;
      /** PR5（ADR-009 第11条）：当前回合 canonical user message id，仅
       *  memory_search 等需要 recall anchor 的工具随请求下发。 */
      userMessageId?: string;
      /** app agent 专属：该 app 的两轴访问档，主线程据此构建 bash 等工具的沙箱 */
      appAccess?: { network: boolean; workspaceWrite: boolean; allowCodepaprApps?: boolean };
    }
  | {
      /** 父级（Agent 回合取消 / 工具超时）已放弃等待该工具：主线程必须中止
       *  正在执行的工具（如杀 bash 进程），否则工具在后台继续跑完、副作用
       *  滞后落地。 */
      type: 'cancel-tool-request';
      requestId: string;
      toolRequestId: string;
    }
  | {
      /** P1: Rust hosted a tool; UI tracks inflight for the idle watchdog only. */
      type: 'tool-host-activity';
      requestId: string;
      toolRequestId: string;
      phase: 'start' | 'end';
    }
  | {
      type: 'proxy-chat';
      requestId: string;
      proxyChatId: string;
      config: AgentWorkerProxyChatConfig;
      chatRequest: IChatRequest;
    }
  | {
      type: 'refresh-bootstrap-request';
      requestId: string;
      bootstrapRequestId: string;
    }
  | {
      type: 'commit-context-compaction';
      chatRequestId: string;
      request: CommitContextCompactionRequest;
    }
  | {
      /** 增量同步校验失败（缓存前缀哈希与主线程不一致，或缓存落后无法
       *  原地追赶）：请求主线程回传该会话的完整消息以原地重建缓存。
       *  见 `full-sync-response`。 */
      type: 'sync-mismatch';
      requestId: string;
      sessionId: string;
    }
  | {
      type: 'fetch-request';
      fetchId: string;
      url: string;
      method: string;
      headers: Array<[string, string]>;
      body: Uint8Array | null;
    }
  | {
      type: 'fetch-cancel';
      fetchId: string;
    }
    | {
        type: 'result';
        requestId: string;
        response: IAgentResponse;
        deltaMessages: IMessage[];
        /** Total length of the worker's authoritative log after this turn; the
         *  main thread records it to decide incremental vs full sync next turn. */
        logLength: number;
        /** True when mid-loop compaction or prune-only replaceLog rewrote the
         *  worker log this turn. The main thread must then replace its
         *  authoritative log with `fullMessages` instead of appending
         *  `deltaMessages` (indices no longer line up after replaceLog).
         *  Prune-only must use the same path: otherwise the next full sync
         *  would resurrect unpruned tool results from the main-thread mirror. */
        compacted?: boolean;
        fullMessages?: IMessage[];
      }
  | {
      type: 'error';
      requestId: string;
      error: string;
      errorName?: string;
      errorDetails?: {
        provider?: string;
        status?: number;
        requestId?: string;
        responseBody?: string;
        retriable?: boolean;
      };
    }
  | {
      type: 'cancelled';
      requestId: string;
    }
  | {
      type: 'app-agent-result';
      requestId: string;
      content: string;
      reasoningContent?: string;
      steps?: Array<{ name: string; status: string; summary?: string }>;
    }
  | {
      type: 'app-agent-error';
      requestId: string;
      error: string;
      errorName?: string;
    }
  | {
      type: 'app-agent-stream';
      requestId: string;
      event: IChatStreamEvent;
    }
  | {
      type: 'pong';
    }
  | {
      type: 'subagent-progress';
      requestId: string;
      action: 'start' | 'step' | 'complete';
      runId: string;
      agent?: string;
      prompt?: string;
      step?: { name: string; status: 'success' | 'error'; summary: string };
      content?: string;
    }
  | {
      /** Best-effort diagnostic emitted by the worker before it dies (global
       *  error / unhandled rejection) or when a message handler fails. */
      type: 'worker-diagnostic';
      message: string;
      detail?: string;
    };
