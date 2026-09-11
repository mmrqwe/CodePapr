import type { IContextSnapshot, IImageContent, ISubagentToolInvocation, QuestionData, ThinkingPayload } from '@codepapr/types';
import type { WorkMode } from '../../utils/agentPrompts';
import type { TaskModelRoute } from '../../utils/modelRouting';
import type { ContextCheckpointPayload } from '../../utils/contextCompaction';
import type { ContextCheckpointPayloadV3 } from '../../utils/contextCheckpointState';
import type { McpSettings } from '../../utils/mcpTypes';
import type { AgentDefinition, AgentToolProfile, EditHistory, SkillDefinition } from '@codepapr/core';
import type { CacheValidator, RequestBuilder } from '@codepapr/api';
import type { AgentRuntimeHandle } from '../../agent/WorkerBackedAgent';
import type { ProjectDiagnosticsReport } from '../../utils/projectDiagnostics';
import type { TaskChecklist } from '../../utils/taskChecklistTypes';
import type { CustomThemeRecord } from '../../theme/types';

export type ApiMode = 'deepseek' | 'custom' | 'local';
export type ApiFormat = 'openai' | 'claude' | 'response';
export type ProviderName = 'deepseek' | ApiFormat;
export type Lang = 'zh-CN' | 'zh-TW' | 'en';
export type MultimodalModelTier = 'primary' | 'fast' | 'all';
export type { ThinkingPayload };

export interface ModeConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  fastModel: string;
  maxTokens: number;
}

export interface ModelProfile {
  id: string;
  name: string;
  apiMode: ApiMode;
  apiFormat: ApiFormat;
  baseURL: string;
  apiKey: string;
  model: string;
  /** 自定义附加请求头（企业网关私有鉴权/路由头等）。仅追加、不覆盖内置头；
   *  见 @codepapr/api ProviderConfig.extraHeaders 语义。 */
  extraHeaders?: Record<string, string>;
  maxTokens: number;
  maxContextTokens?: number;
  thinkingEnabled?: boolean;
  thinkingEffort?: string;
  thinkingBudgetTokens?: number;
  thinkingPayload?: ThinkingPayload;
  temperature?: number;
  topP?: number;
  multimodalEnabled?: boolean;
}

export interface Settings {
  // 模型配置池与插槽 (Model Profiles & Role Slots)
  modelProfiles: ModelProfile[];
  primaryProfileId: string;
  fastProfileId: string;
  mentorProfileId: string;

  apiMode: ApiMode;
  apiFormat: ApiFormat;
  provider: ProviderName;

  // Per-mode independent configs (source of truth)
  deepseek: ModeConfig;
  custom: ModeConfig;
  local: ModeConfig;

  // Flat derivatives synced from active mode (for ease of use)
  baseURL: string;
  model: string;
  fastModel: string;
  apiKey: string;
  /** 自定义附加请求头（派生自主配置文件 primaryProfile.extraHeaders）。 */
  extraHeaders?: Record<string, string>;
  fastModelEnabled: boolean;
  systemPrompt: string;
  thinkingEnabled: boolean;
  thinkingEffort: string;
  thinkingBudgetTokens: number;
  thinkingPayload: ThinkingPayload;
  multimodalEnabled: boolean;
  multimodalModelTier: MultimodalModelTier;
  chatBordersEnabled: boolean;
  /** 实验性：主界面显示角色卡。默认关闭。 */
  experimentalCharacters: boolean;
  /** 实验性：主界面显示语音朗读。默认关闭。 */
  experimentalVoice: boolean;
  /** Agent 工具面：default=全量工具（仍按 mode 过滤）；minimal=仅 7 项核心工具。 */
  agentToolProfile: AgentToolProfile;
  temperature: number;
  topP: number;
  maxTokens: number;
  maxToolRounds: number;
  maxContextTokens: number;
  chatRenderBatchRounds: number;
  compactionModel: 'fast' | 'primary';
  compactionMaxTokens: number;
  compactionTemperature: number;
  toolOutputInterceptChars: number;
  toolOutputOffloadChars: number;
  toolOutputCeilingChars: number;
  toolOutputPreviewChars: number;
  toolOutputMiddleKeepChars: number;
  toolContextDefaultMode: 'full' | 'summary' | 'auto';
  toolContextOverrides: Record<string, 'full' | 'summary' | 'auto'>;
  toolContextSummaryMaxChars: number;
  toolContextAutoThresholdChars: number;
  projectGraphMaxDepth: number;
  projectGraphMaxFiles: number;
  projectGraphMaxEdges: number;
  projectGraphMaxSymbolsPerFile: number;
  projectGraphMaxFileBytes: number;
  projectGraphMaxTreeEntries: number;
  lang?: Lang;
  /** 浅色模式下使用的主题 id（内置或自定义）。 */
  lightTheme: string;
  /** 深色模式下使用的主题 id（内置或自定义）。 */
  darkTheme: string;
  /** 跟随系统深浅色；false 时以 themeMode 为准。 */
  followSystem: boolean;
  /** 手动模式（followSystem=false）下当前生效的深浅模式。 */
  themeMode: 'light' | 'dark';
  /** 强调色覆盖（#rgb/#rrggbb），null = 使用主题自带强调色。 */
  accent: string | null;
  /** 自定义主题（JSON token 映射导入）。 */
  customThemes: Record<string, CustomThemeRecord>;
  recentWorkspaces: WorkspaceEntry[];
  mentorEnabled: boolean;
  mentorModel: string;
  mentorBaseURL: string;
  mentorApiKey: string;
  mentorApiFormat: ApiFormat;
  mentorMaxTokens: number;
  maxMentorConsultations: number;
  mentorThinkingEnabled: boolean;
  mentorThinkingEffort: string;
  mentorThinkingBudgetTokens: number;
  mentorThinkingPayload: ThinkingPayload;
  explorePrompt: string;
  scoutPrompt: string;
  mentorPrompt: string;
  exploreModelTier: 'primary' | 'fast';
  scoutModelTier: 'primary' | 'fast';
  exploreTopP: number;
  exploreMaxTokens: number;
  exploreThinkingEnabled: boolean;
  exploreTemperature: number;
  exploreMaxToolRounds: number;
  exploreMaxDepth: number;
  scoutTopP: number;
  scoutMaxTokens: number;
  scoutThinkingEnabled: boolean;
  scoutTemperature: number;
  scoutMaxToolRounds: number;
  scoutMaxDepth: number;
  // Goal 自主循环配置
  goalMaxIterations: number;
  goalMaxWallClockMs: number;
  goalRequireGitClean: boolean;
  // Verifier 子代理配置（默认快速模型，高级设置可切换；主观目标默认升级导师模型）
  verifierModelTier: 'fast' | 'primary' | 'mentor';
  verifierMaxTokens: number;
  verifierTemperature: number;
  // App 子代理配置（papr.agent.run 调用的 Agent）
  appSubAgentModelTier: 'primary' | 'fast';
  appSubAgentThinkingEnabled: boolean;
  appSubAgentMaxToolRounds: number;
  searxngEnabled: boolean;
  searxngBaseUrl: string;
  searxngCategories: string;
  searxngTimeRange: string;
  searxngLanguage: string;
  searxngSafeSearch: number;
  searxngEngines: string;
  mcp: McpSettings;
  graphToolTimeoutMs: number;
  toolIpcTimeoutMs: number;
  streamIdleTimeoutMs: number;
  browserEngine: 'embedded' | 'headless';
  folderAccessYolo: boolean;
  /** 关闭的 LSP family。空数组 = 全部启用（默认）。 */
  lspDisabledFamilies: string[];
}

/** 压缩管线（checkpoint/剪枝）所需的最小 settings 子集：主线程传完整
 *  Settings、worker 传 WorkerAgentSettings，两者结构上均满足。 */
export interface CompactionSettings {
  apiMode: ApiMode;
  apiFormat: ApiFormat;
  apiKey: string;
  baseURL: string;
  streamIdleTimeoutMs: number;
  maxContextTokens: number;
  lang?: Lang;
  model: string;
  fastModelEnabled: boolean;
  fastModel: string;
  temperature: number;
  compactionModel: 'fast' | 'primary';
  compactionMaxTokens: number;
  compactionTemperature: number;
}

export interface WorkspaceEntry {
  path: string;
  name: string;
  lastOpenedAt: number;
  pinned: boolean;
}

export interface SessionMeta {
  id: string;
  name: string;
  provider: ProviderName;
  model: string;
  createdAt: number;
  updatedAt: number;
  /** Character enabled for this session only. Missing/null means no persona. */
  activeCharacterId?: string | null;
  /** Millis since epoch when archived. Missing/null means the session is active. */
  archivedAt?: number | null;
}

export interface ImagePreview extends IImageContent {
  id: string;
  /** 完整 data URI，仅用于本地预览 */
  dataUri: string;
}

export interface TextFileAttachment {
  id: string;
  name: string;
  content: string;
  size: number;
}

/** 已发送消息上展示的文本附件元数据（不含文件内容，体积小，可持久化）。 */
export interface AttachedFileMeta {
  name: string;
  size: number;
}

/** 每会话输入框状态（运行时记忆，不持久化）：模式、草稿、待发送附件。 */
export interface SessionInputState {
  mode: WorkMode;
  draft: string;
  images: ImagePreview[];
  files: TextFileAttachment[];
}

/** 同会话排队消息（运行时，不持久化）：当前回合结束后自动作为下一回合发送。
 *  payload 与 sendMessage 的参数一一对应，drain 时原样重放。 */
export interface QueuedTurnMessage {
  id: string;
  sessionId: string;
  taskText: string;
  displayText: string;
  mode: WorkMode;
  images?: IImageContent[];
  attachedFiles?: AttachedFileMeta[];
  createdAt: number;
}

/** 单会话排队上限：防止无界内存增长（图片 data URL 体积不小）。 */
export const MAX_QUEUED_TURNS = 20;

export interface UIToolInvocation {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  status: 'running' | 'success' | 'error' | 'cancelled';
  error?: string;
  statusText?: string;
  output?: string;
  /** 工具实际执行耗时（毫秒）；占位/跳过的调用无此字段 */
  durationMs?: number;
  /** Byte-exact tool message content appended to the log (truncated +
   *  deterministically serialized). Used to rebuild tool messages byte-identically
   *  on restore so the prefix cache is not broken. `output` is the full raw result
   *  for display. Persisted inside the tool_invocations JSON column. */
  contextContent?: string;
  /** Frozen history summary (tool context mode). Rebuilt tool messages carry it
   *  in metadata so applyHistoryToolSummaries behaves byte-identically to the
   *  live path. Absent when the tool stays full in history. */
  contextSummary?: string;
  subagentToolInvocations?: ISubagentToolInvocation[];
}

export interface UIMessage {
  id: string;
  role: 'user' | 'assistant' | 'error';
  workMode?: WorkMode;
  content: string;
  promptContent?: string;
  reasoningContent?: string;
  displayReasoningContent?: string;
  images?: IImageContent[];
  attachedFiles?: AttachedFileMeta[];
  modelTier?: TaskModelRoute['tier'];
  modelName?: string;
  agentStep?: number;
  isStreaming?: boolean;
  statusText?: string;
  toolInvocations?: UIToolInvocation[];
  relatedFilePaths?: string[];
  hidden?: boolean;
  synthetic?: boolean;
  carryForwardInContext?: boolean;
  /** PR3：v2（sections）与 v3（state）payload 并存；旧数据只有 v2 字段。 */
  contextCheckpoint?: ContextCheckpointPayload | ContextCheckpointPayloadV3;
  question?: QuestionData;
  /** 该消息上的 plan 问题/决策卡片是否已被用户回答（防重复作答，持久化）。 */
  questionAnswered?: boolean;
  timestamp: number;
  /** assistant 消息：本轮 LLM 生成耗时（毫秒，持久化到 messages.extras） */
  durationMs?: number;
}

export interface CumulativeStats {
  totalCacheRead: number;
  totalCacheCreation: number;
  totalInput: number;
  totalOutput: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  rounds: number;
}

export interface ModelTierStats {
  totalCacheRead: number;
  totalCacheCreation: number;
  totalInput: number;
  totalOutput: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  calls: number;
  rounds: number;
  /** 模型实际生成耗时（LLM 请求墙钟，不含工具执行与空完成退避），毫秒。
   *  undefined 表示旧数据/该 tier 从未产生过测量值。 */
  modelRuntimeMs?: number;
  /** 工具实际执行耗时（毫秒），undefined 同上。 */
  toolRuntimeMs?: number;
}

export interface ConversationStats {
  primary: ModelTierStats;
  fast: ModelTierStats;
  mentor: ModelTierStats;
  /** Agent 实际执行时长（墙钟，毫秒）：Σ(回合结束时刻 − 用户发送时刻)。
   *  undefined 表示旧数据尚未回填（backfill 以此为幂等判据）。 */
  runtimeMs?: number;
}

export type ResetToMessageResult =
  | {
      ok: true;
      /** 'git'：执行了代码回滚；'none'：该消息无 checkpoint 锚点，仅截断对话。 */
      codeReset: 'git' | 'none';
      filesChanged: number;
      messagesRemoved: number;
      restoredInput: string;
      restoredImages?: IImageContent[];
    }
  | {
      ok: false;
      reason: 'message-not-found' | 'git-failed' | 'turn-running';
      error?: string;
    };

/** N8：最近一次对话重置/代码回退的撤销信息（重置时备份，撤销时回放）。 */
export interface PendingRestoreUndo {
  workspacePath: string;
  /** 被重置的会话；null 表示纯文件回退（无对话影响）。 */
  sessionId: string | null;
  /** 被截掉的尾部消息（撤销时按 id 去重后追加回会话）。 */
  truncatedMessages: UIMessage[];
  /** 被移除的 checkpoint 锚点（撤销时恢复，保证后续 resetToMessage 可用）。 */
  removedCheckpoints: Record<string, { sha: string; sessionId: string }>;
  /** 重置是否执行了文件回滚（true 时撤销需先 restore_undo）。 */
  filesRestored: boolean;
  /** 重置时创建的备份快照 SHA。BACKUP_REF 是所有破坏性操作共用的单一引用，
   *  撤销时用它校验备份未被后续操作覆盖，避免恢复到错误状态。 */
  backupSha: string | null;
}

export interface UndoConversationResetResult {
  ok: boolean;
  message?: string;
}

export interface AgentState {
  settings: Settings;
  workspacePath: string;
  workspaceMutationVersion: number;
  /** N8：待撤销的对话重置栈（见 PendingRestoreUndo）。栈顶（最后一个元素）
   *  是最近一次重置；支持连续多次重置逐级撤销。撤销/放弃只作用于栈顶。 */
  _pendingRestoreUndos: PendingRestoreUndo[];
  sessions: SessionMeta[];
  /** Workspace-scoped archived sessions, loaded on demand (Settings). Not a settings field. */
  archivedSessions: SessionMeta[];
  activeSessionId: string | null;
  messages: UIMessage[];
  sessionMessages: Record<string, UIMessage[]>;
  skillEnabledById: Record<string, boolean>;
  conversationStats: ConversationStats;
  sessionConversationStats: Record<string, ConversationStats>;
  /** True while the active session's messages are being loaded on demand. */
  sessionMessagesLoading: boolean;
  projectDiagnosticsReport: ProjectDiagnosticsReport | null;
  isLoading: boolean;
  /** 当前正在执行回合的会话 ID（单执行模型下至多一个）。与 isLoading 同步置位/清除。 */
  loadingSessionId: string | null;
  /** 同会话待发送队列（sessionId → 排队消息）。仅在该会话回合结束（isLoading
   *  true→false 且 loadingSessionId 命中）时逐条 drain；运行时状态，不持久化。 */
  queuedMessages: Record<string, QueuedTurnMessage[]>;
  projectGraphLoading: boolean;
  projectGraphPhase: null | { phase: string; current: number; total: number };
  showSettings: boolean;
  settingsLoaded: boolean;
  /**
   * 设置是否成功从磁盘加载过。加载失败时内存中是默认设置，
   * 此时禁止任何自动回写（否则会用默认值覆盖磁盘上的真实配置，
   * 空 apiKey 还会被 vault 解释为"清除密钥"）。仅用户显式修改设置时才允许写入。
   */
  _settingsPersistable: boolean;
  /**
   * 消息加载失败的会话（sessionId → true）。"读取失败"与"会话为空"必须区分：
   * 读失败被当作空会话后，全量替换语义的 save_message_batch 会把 DB 中该会话
   * 的全部消息抹掉。对此集合中的会话：禁止回写消息、发送前必须先重载成功。
   */
  _messageLoadFailedSessions: Record<string, boolean>;
  // 运行时（不持久化）
  _agent: AgentRuntimeHandle | null;
  _agentModel: string | null;
  _agentPromptKey: string | null;
  /** _agent 绑定的会话 ID；复用 agent 前必须校验与当前会话一致。 */
  _agentSessionId: string | null;
  /** App 模式 `papr.agent.run` 专用 Worker，与聊天 `_agent` 隔离。 */
  _appAgent: AgentRuntimeHandle | null;
  _sessionInputState: Record<string, SessionInputState>;
  _requestBuilder: RequestBuilder;
  _cacheValidator: CacheValidator;
  _editHistory: EditHistory;
  _projectRulesSection: string;
  _skillDefinitions: SkillDefinition[];
  _agentDefinitions: AgentDefinition[];
  _taskChecklists: Record<string, TaskChecklist | null>;
  /** 消息 checkpoint 锚点：messageId → { sha, 所属会话 }。记录归属会话后
   *  clearMessages 只清当前会话的锚点，不再误删其他会话的历史锚点。 */
  _messageCheckpoints: Record<string, { sha: string; sessionId: string }>;
  _gitReady: boolean;
  _gitReadyError: string | null;
  _checkpointError: string | null;
  /** 持久化失败提示（设置保存/checkpoint 记录/项目状态落盘失败时置位，
   *  供 UI 提示"内存状态与磁盘分叉"；成功落盘或下次保存成功后清空）。 */
  _persistenceError: string | null;
  _checkpointSeq: number;
  /** 单调递增的回合序号。sendMessage 启动时自增并捕获；异步收尾（取消/崩溃
   *  的 catch）只有在序号未变时才允许复位 isLoading——否则取消 ACK 晚于新回合
   *  启动到达时，旧回合的收尾会踩掉新回合的 loading 态，破坏单执行模型。 */
  _turnSeq: number;
  /** N11：停止请求序号。cancelMessage 置位（+1）——覆盖 agent 创建前的
   *  前置 await 阶段（MCP 发现/图缓存等），此时没有在飞的 agent 请求可取消，
   *  sendMessage 的前置 await 检查到序号变化即抛 AbortError 终止回合。
   *  运行时字段，不持久化。 */
  _stopRequestedSeq: number;
  _latestContextSnapshot: { sessionId: string; snapshot: IContextSnapshot } | null;
  _currentMode: WorkMode;
  /** LRU order (most recently used first) of sessions whose messages may live
   *  in the in-memory cache. Runtime-only; rebuilt on workspace open. */
  _sessionLru: string[];
  /** Pending request to bring a message into view in the chat pane. The chat
   *  panel renders history in batches, so jumping to an unloaded message first
   *  widens the render window. `seq` re-triggers repeated requests for the same
   *  message. Runtime-only. */
  _pendingChatJump: { messageId: string; seq: number } | null;
  /** Pending request to open a workspace file from settings / overlays. */
  _pendingSelectPath: string | null;
}

export interface AgentActions {
  loadSettings: () => Promise<void>;
  setSettings: (
    s: Partial<Settings>,
    options?: { preserveAgent?: boolean },
  ) => void;
  setWorkspacePath: (path: string) => void;
  closeWorkspace: () => void;
  openWorkspace: (path: string) => Promise<void>;
  ensureDefaultWorkspace: () => Promise<string | null>;
  noteWorkspaceMutation: (
    paths?: string[],
    options?: { scheduleDiagnostics?: boolean; autoRepair?: boolean },
  ) => void;
  setShowSettings: (v: boolean) => void;
  setProjectGraphLoading: (
    loading: boolean,
    phase?: { phase: string; current: number; total: number },
  ) => void;
  newSession: () => void;
  selectSession: (id: string) => void;
  archiveSession: (id: string) => void;
  loadArchivedSessions: () => Promise<void>;
  restoreArchivedSession: (id: string) => Promise<void>;
  deleteArchivedSession: (id: string) => void;
  deleteSession: (id: string) => void;
  sendMessage: (
    input: string,
    displayContent?: string,
    mode?: WorkMode,
    images?: IImageContent[],
    attachedFiles?: AttachedFileMeta[]
  ) => Promise<boolean>;
  cancelMessage: () => void;
  /** 将消息排入指定会话的待发送队列（当前回合结束后自动 drain）。队列满
   *  （MAX_QUEUED_TURNS）返回 false，调用方据此提示且不草稿。 */
  queueMessage: (
    sessionId: string,
    taskText: string,
    displayText: string,
    mode: WorkMode,
    images?: IImageContent[],
    attachedFiles?: AttachedFileMeta[]
  ) => boolean;
  removeQueuedMessage: (queuedId: string) => void;
  clearQueuedMessages: (sessionId: string) => void;
  clearMessages: () => void;
  resetToMessage: (messageId: string) => Promise<ResetToMessageResult>;
  undoConversationReset: () => Promise<UndoConversationResetResult>;
  dismissRestoreUndo: () => void;
  /** N16：重试加载当前会话的消息（会话历史加载失败后的 UI 恢复入口）。 */
  retryLoadSessionMessages: () => Promise<boolean>;
  setProjectDiagnosticsReport: (report: ProjectDiagnosticsReport | null) => void;
  setPersistenceError: (message: string | null) => void;
  refreshProjectDiagnostics: () => Promise<ProjectDiagnosticsReport | null>;
  setSkillEnabledState: (skillId: string, enabled: boolean | null) => void;
  setSessionInputState: (sessionId: string, state: SessionInputState) => void;
  computeContextSnapshot: () => Promise<void>;
  /** Ask the chat pane to scroll a message into view (expanding the render
   *  window when the message is not loaded yet). */
  requestChatScrollToMessage: (messageId: string) => void;
  requestSelectWorkspaceFile: (path: string) => void;
  /** 确保存在可用 Agent（App Agent 依赖聊天 Agent 的 Worker）。用户从未发过
   *  消息时按需创建，供 papr://agent.run 使用；并发调用共享同一次创建。 */
  ensureAgentForApp: () => Promise<AgentRuntimeHandle>;
  _loadProjectConfig: (path: string) => Promise<void>;
  _ensureWorkspaceGitReady: (path: string) => Promise<void>;
}

export type StoreGet = () => AgentState & AgentActions;
export type StoreSet = (
  partial: Partial<AgentState> | ((state: AgentState) => Partial<AgentState>)
) => void;
