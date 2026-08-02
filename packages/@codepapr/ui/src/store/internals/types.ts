import type { IContextSnapshot, IImageContent, ISubagentToolInvocation, QuestionData } from '@codepapr/types';
import type { WorkMode } from '../../utils/agentPrompts';
import type { TaskModelRoute } from '../../utils/modelRouting';
import type { ContextCheckpointPayload } from '../../utils/contextCompaction';
import type { McpSettings } from '../../utils/mcpTypes';
import type { AgentDefinition, EditHistory, SkillDefinition } from '@codepapr/core';
import type { CacheValidator, RequestBuilder } from '@codepapr/api';
import type { AgentRuntimeHandle } from '../../agent/WorkerBackedAgent';
import type { ProjectDiagnosticsReport } from '../../utils/projectDiagnostics';
import type { TaskChecklist } from '../../utils/taskChecklistTypes';

export type ApiMode = 'deepseek' | 'custom' | 'local';
export type ApiFormat = 'openai' | 'claude';
export type ProviderName = 'deepseek' | ApiFormat;
export type Lang = 'zh-CN' | 'zh-TW' | 'en';
export type MultimodalModelTier = 'primary' | 'fast' | 'all';

export interface ModeConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  fastModel: string;
  maxTokens: number;
}

export interface Settings {
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
  fastModelEnabled: boolean;
  systemPrompt: string;
  thinkingEnabled: boolean;
  thinkingEffort: 'high' | 'max';
  multimodalEnabled: boolean;
  multimodalModelTier: MultimodalModelTier;
  debugEnabled: boolean;
  chatBordersEnabled: boolean;
  temperature: number;
  topP: number;
  maxTokens: number;
  maxToolRounds: number;
  maxContextTokens: number;
  maxConversationRounds: number;
  compactionModel: 'fast' | 'primary';
  compactionMaxTokens: number;
  compactionTemperature: number;
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
  projectGraphMaxDepth: number;
  projectGraphMaxFiles: number;
  projectGraphMaxEdges: number;
  projectGraphMaxSymbolsPerFile: number;
  projectGraphMaxFileBytes: number;
  projectGraphMaxTreeEntries: number;
  lang?: Lang;
  recentWorkspaces: WorkspaceEntry[];
  mentorEnabled: boolean;
  mentorModel: string;
  mentorBaseURL: string;
  mentorApiKey: string;
  mentorApiFormat: ApiFormat;
  mentorMaxTokens: number;
  maxMentorConsultations: number;
  mentorThinkingEnabled: boolean;
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
  todoMaxRetries: number;
  // Goal 自主循环配置
  goalMaxIterations: number;
  goalMaxWallClockMs: number;
  goalRequireGitClean: boolean;
  // Verifier 子代理配置（默认快速模型，高级设置可切换）
  verifierModelTier: 'fast' | 'primary';
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
}

export interface UIToolInvocation {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  status: 'running' | 'success' | 'error';
  error?: string;
  statusText?: string;
  output?: string;
  /** Byte-exact tool message content appended to the log (truncated +
   *  deterministically serialized). Used to rebuild tool messages byte-identically
   *  on restore so the prefix cache is not broken. `output` is the full raw result
   *  for display. Persisted inside the tool_invocations JSON column. */
  contextContent?: string;
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
  contextCheckpoint?: ContextCheckpointPayload;
  question?: QuestionData;
  timestamp: number;
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
}

export interface ConversationStats {
  primary: ModelTierStats;
  fast: ModelTierStats;
  mentor: ModelTierStats;
}

export type ResetToMessageResult =
  | {
      ok: true;
      codeReset: 'git' | 'none';
      filesChanged: number;
      messagesRemoved: number;
      restoredInput: string;
      restoredImages?: IImageContent[];
    }
  | { ok: false; reason: 'no-checkpoint' | 'message-not-found' | 'git-failed'; error?: string };

export interface AgentState {
  settings: Settings;
  workspacePath: string;
  workspaceMutationVersion: number;
  sessions: SessionMeta[];
  activeSessionId: string | null;
  messages: UIMessage[];
  sessionMessages: Record<string, UIMessage[]>;
  skillEnabledById: Record<string, boolean>;
  conversationStats: ConversationStats;
  sessionConversationStats: Record<string, ConversationStats>;
  projectDiagnosticsReport: ProjectDiagnosticsReport | null;
  isLoading: boolean;
  projectGraphLoading: boolean;
  projectGraphPhase: null | { phase: string; current: number; total: number };
  showSettings: boolean;
  settingsLoaded: boolean;
  // 运行时（不持久化）
  _agent: AgentRuntimeHandle | null;
  _agentModel: string | null;
  _agentPromptKey: string | null;
  _requestBuilder: RequestBuilder;
  _cacheValidator: CacheValidator;
  _editHistory: EditHistory;
  _projectRulesSection: string;
  _skillDefinitions: SkillDefinition[];
  _agentDefinitions: AgentDefinition[];
  _taskChecklists: Record<string, TaskChecklist | null>;
  _messageCheckpoints: Record<string, string>;
  _gitReady: boolean;
  _gitReadyError: string | null;
  _checkpointError: string | null;
  _checkpointSeq: number;
  _pendingMemoryConsolidation: boolean;
  _latestContextSnapshot: { sessionId: string; snapshot: IContextSnapshot } | null;
  _currentMode: WorkMode;
}

export interface AgentActions {
  loadSettings: () => Promise<void>;
  setSettings: (s: Partial<Settings>) => void;
  setWorkspacePath: (path: string) => void;
  closeWorkspace: () => void;
  openWorkspace: (path: string) => Promise<void>;
  ensureDefaultWorkspace: () => Promise<string | null>;
  noteWorkspaceMutation: (paths?: string[]) => void;
  setShowSettings: (v: boolean) => void;
  setProjectGraphLoading: (
    loading: boolean,
    phase?: { phase: string; current: number; total: number },
  ) => void;
  newSession: () => void;
  selectSession: (id: string) => void;
  deleteSession: (id: string) => void;
  sendMessage: (
    input: string,
    displayContent?: string,
    mode?: WorkMode,
    projectDiagnosticsReport?: ProjectDiagnosticsReport | null,
    images?: IImageContent[]
  ) => Promise<void>;
  cancelMessage: () => void;
  clearMessages: () => void;
  resetToMessage: (messageId: string) => Promise<ResetToMessageResult>;
  setProjectDiagnosticsReport: (report: ProjectDiagnosticsReport | null) => void;
  refreshProjectDiagnostics: () => Promise<ProjectDiagnosticsReport | null>;
  setSkillEnabledState: (skillId: string, enabled: boolean | null) => void;
  computeContextSnapshot: () => Promise<void>;
  _loadProjectConfig: (path: string) => Promise<void>;
  _ensureWorkspaceGitReady: (path: string) => Promise<void>;
}

export type StoreGet = () => AgentState & AgentActions;
export type StoreSet = (
  partial: Partial<AgentState> | ((state: AgentState) => Partial<AgentState>)
) => void;
