import { invoke } from '@tauri-apps/api/core';
import type { QuestionData } from '@codepapr/types';
import type { ProjectDiagnosticsReport } from './projectDiagnostics';
import type { ContextCheckpointPayload } from './contextCompaction';

const projectStateSaveTails = new Map<string, Promise<void>>();

interface ProjectStateStorageResult {
  stateJson: string | null;
  dbPath: string;
}

export interface SaveProjectStateOptions {
  purgeDeletedContent?: boolean;
}

export interface ProjectSessionMeta {
  id: string;
  name: string;
  provider: string;
  model: string;
  createdAt: number;
  updatedAt?: number;
}

export interface ProjectMessage {
  id: string;
  role: 'user' | 'assistant' | 'error';
  workMode?: 'agent' | 'plan' | 'ask' | 'app';
  content: string;
  promptContent?: string;
  reasoningContent?: string;
  displayReasoningContent?: string;
  /** Restored from the messages.extras column; needed to rebuild compacted
   *  history and context membership byte-identically (see db/mod.rs). */
  synthetic?: boolean;
  hidden?: boolean;
  carryForwardInContext?: boolean;
  contextCheckpoint?: ContextCheckpointPayload;
  question?: QuestionData;
  timestamp: number;
}

export interface ProjectCumulativeStats {
  totalCacheRead: number;
  totalCacheCreation: number;
  totalInput: number;
  totalOutput: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  rounds: number;
}

export interface ProjectModelTierStats {
  totalCacheRead: number;
  totalCacheCreation: number;
  totalInput: number;
  totalOutput: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  calls: number;
  rounds: number;
}

export interface ProjectConversationStats {
  primary: ProjectModelTierStats;
  fast: ProjectModelTierStats;
  mentor: ProjectModelTierStats;
}

export interface ProjectStateSnapshot {
  version: 1;
  sessions: ProjectSessionMeta[];
  activeSessionId: string | null;
  sessionMessages: Record<string, ProjectMessage[]>;
  skillEnabledById?: Record<string, boolean>;
  sessionTodoLists?: Record<string, unknown>;
  cumulativeStats?: ProjectCumulativeStats;
  sessionCumulativeStats?: Record<string, ProjectCumulativeStats>;
  conversationStats?: ProjectConversationStats;
  sessionConversationStats?: Record<string, ProjectConversationStats>;
  projectDiagnosticsReport: ProjectDiagnosticsReport | null;
  messageCheckpoints?: Record<string, string>;
  updatedAt: number;
}

const EMPTY_STATS: ProjectCumulativeStats = {
  totalCacheRead: 0,
  totalCacheCreation: 0,
  totalInput: 0,
  totalOutput: 0,
  promptCacheHitTokens: 0,
  promptCacheMissTokens: 0,
  rounds: 0,
};

const EMPTY_MODEL_TIER_STATS: ProjectModelTierStats = {
  totalCacheRead: 0,
  totalCacheCreation: 0,
  totalInput: 0,
  totalOutput: 0,
  promptCacheHitTokens: 0,
  promptCacheMissTokens: 0,
  calls: 0,
  rounds: 0,
};

const EMPTY_CONVERSATION_STATS: ProjectConversationStats = {
  primary: { ...EMPTY_MODEL_TIER_STATS },
  fast: { ...EMPTY_MODEL_TIER_STATS },
  mentor: { ...EMPTY_MODEL_TIER_STATS },
};

export function createEmptyProjectState(): ProjectStateSnapshot {
  return {
    version: 1,
    sessions: [],
    activeSessionId: null,
    sessionMessages: {},
    skillEnabledById: {},
    sessionTodoLists: {},
    cumulativeStats: { ...EMPTY_STATS },
    sessionCumulativeStats: {},
    conversationStats: { ...EMPTY_CONVERSATION_STATS },
    sessionConversationStats: {},
    projectDiagnosticsReport: null,
    messageCheckpoints: {},
    updatedAt: Date.now(),
  };
}

export function enqueueProjectStateSave(
  workspacePath: string,
  writer: () => Promise<void>
): Promise<void> {
  const previous = projectStateSaveTails.get(workspacePath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(writer);

  projectStateSaveTails.set(workspacePath, next);
  void next.then(
    () => {
      if (projectStateSaveTails.get(workspacePath) === next) {
        projectStateSaveTails.delete(workspacePath);
      }
    },
    () => {
      if (projectStateSaveTails.get(workspacePath) === next) {
        projectStateSaveTails.delete(workspacePath);
      }
    }
  );

  return next;
}

async function waitForPendingProjectStateSave(workspacePath: string): Promise<void> {
  const pending = projectStateSaveTails.get(workspacePath);
  if (!pending) {
    return;
  }

  await pending.catch(() => undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function parseSkillEnabledById(value: unknown): Record<string, boolean> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, boolean] => typeof entry[0] === 'string' && typeof entry[1] === 'boolean'
    )
  );
}

function parseProjectDiagnosticsReport(value: unknown): ProjectDiagnosticsReport | null {
  if (!isRecord(value)) {
    return null;
  }

  const overallStatus = value.overallStatus;
  const packageManager = value.packageManager;
  if (
    typeof value.available !== 'boolean' ||
    (packageManager !== 'npm' &&
      packageManager !== 'pnpm' &&
      packageManager !== 'yarn' &&
      packageManager !== 'bun') ||
    typeof value.packageJsonPath !== 'string' ||
    typeof value.ranAt !== 'number' ||
    (overallStatus !== 'passed' &&
      overallStatus !== 'failed' &&
      overallStatus !== 'unavailable') ||
    !Array.isArray(value.stages)
  ) {
    return null;
  }

  const stages = value.stages.filter((stage): stage is ProjectDiagnosticsReport['stages'][number] => {
    if (!isRecord(stage)) {
      return false;
    }

    return (
      (stage.id === 'lint' || stage.id === 'typecheck') &&
      typeof stage.scriptName === 'string' &&
      typeof stage.label === 'string' &&
      typeof stage.command === 'string' &&
      isStringArray(stage.args) &&
      typeof stage.fallback === 'boolean' &&
      typeof stage.success === 'boolean' &&
      (typeof stage.status === 'number' || stage.status === null) &&
      typeof stage.timedOut === 'boolean' &&
      typeof stage.stdout === 'string' &&
      typeof stage.stderr === 'string' &&
      typeof stage.excerpt === 'string'
    );
  });

  return {
    available: value.available,
    packageManager,
    packageJsonPath: value.packageJsonPath,
    stages,
    ranAt: value.ranAt,
    overallStatus,
    message: typeof value.message === 'string' ? value.message : undefined,
  };
}

function parseModelTierStats(value: unknown): ProjectModelTierStats {
  if (!isRecord(value)) return { ...EMPTY_MODEL_TIER_STATS };
  return {
    totalCacheRead: typeof value.totalCacheRead === 'number' ? value.totalCacheRead : 0,
    totalCacheCreation: typeof value.totalCacheCreation === 'number' ? value.totalCacheCreation : 0,
    totalInput: typeof value.totalInput === 'number' ? value.totalInput : 0,
    totalOutput: typeof value.totalOutput === 'number' ? value.totalOutput : 0,
    promptCacheHitTokens: typeof value.promptCacheHitTokens === 'number' ? value.promptCacheHitTokens : 0,
    promptCacheMissTokens: typeof value.promptCacheMissTokens === 'number' ? value.promptCacheMissTokens : 0,
    calls: typeof value.calls === 'number' ? value.calls : 0,
    rounds: typeof value.rounds === 'number' ? value.rounds : 0,
  };
}

function parseConversationStats(value: unknown): ProjectConversationStats {
  if (!isRecord(value)) return { ...EMPTY_CONVERSATION_STATS };
  return {
    primary: parseModelTierStats(value.primary),
    fast: parseModelTierStats(value.fast),
    mentor: parseModelTierStats(value.mentor),
  };
}

function migrateCumulativeToConversationStats(cumulative: ProjectCumulativeStats): ProjectConversationStats {
  return {
    primary: {
      totalCacheRead: cumulative.totalCacheRead,
      totalCacheCreation: cumulative.totalCacheCreation,
      totalInput: cumulative.totalInput,
      totalOutput: cumulative.totalOutput,
      promptCacheHitTokens: cumulative.promptCacheHitTokens,
      promptCacheMissTokens: cumulative.promptCacheMissTokens,
      calls: cumulative.rounds,
      rounds: cumulative.rounds,
    },
    fast: { ...EMPTY_MODEL_TIER_STATS },
    mentor: { ...EMPTY_MODEL_TIER_STATS },
  };
}

function parseSessionConversationStats(
  newFormat: unknown,
  oldFormat: unknown
): Record<string, ProjectConversationStats> {
  if (newFormat && typeof newFormat === 'object' && !Array.isArray(newFormat)) {
    return Object.fromEntries(
      Object.entries(newFormat as Record<string, unknown>).map(([sessionId, value]) => [
        sessionId,
        parseConversationStats(value),
      ])
    );
  }

  if (oldFormat && typeof oldFormat === 'object' && !Array.isArray(oldFormat)) {
    return Object.fromEntries(
      Object.entries(oldFormat as Record<string, unknown>).map(([sessionId, value]) => [
        sessionId,
        migrateCumulativeToConversationStats({
          ...EMPTY_STATS,
          ...(typeof value === 'object' && value ? value : {}),
        }),
      ])
    );
  }

  return {};
}

function parseConversationStatsField(
  parsed: Partial<ProjectStateSnapshot>
): ProjectConversationStats {
  if (parsed.conversationStats) {
    return parseConversationStats(parsed.conversationStats);
  }
  const cumulative = parsed.cumulativeStats;
  if (cumulative) {
    return migrateCumulativeToConversationStats({
      ...EMPTY_STATS,
      ...cumulative,
    });
  }
  return { ...EMPTY_CONVERSATION_STATS };
}

function parseProjectState(raw: string | null): ProjectStateSnapshot {
  if (!raw) return createEmptyProjectState();

  try {
    const parsed = JSON.parse(raw) as Partial<ProjectStateSnapshot>;
    return {
      version: 1,
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      activeSessionId: typeof parsed.activeSessionId === 'string' ? parsed.activeSessionId : null,
      sessionMessages:
        parsed.sessionMessages && typeof parsed.sessionMessages === 'object'
          ? Object.fromEntries(
              Object.entries(parsed.sessionMessages).filter(
                (entry): entry is [string, ProjectMessage[]] =>
                  typeof entry[0] === 'string' &&
                  Array.isArray(entry[1]) &&
                  entry[1].every((msg) => msg && typeof msg === 'object' && typeof msg.role === 'string' && typeof msg.content === 'string')
              )
            )
          : {},
      skillEnabledById: parseSkillEnabledById(parsed.skillEnabledById),
      sessionTodoLists:
        parsed.sessionTodoLists && typeof parsed.sessionTodoLists === 'object' && !Array.isArray(parsed.sessionTodoLists)
          ? parsed.sessionTodoLists as Record<string, unknown>
          : {},
      cumulativeStats: {
        ...EMPTY_STATS,
        ...(parsed.cumulativeStats ?? {}),
      },
      sessionCumulativeStats:
        parsed.sessionCumulativeStats && typeof parsed.sessionCumulativeStats === 'object'
          ? Object.fromEntries(
              Object.entries(parsed.sessionCumulativeStats).map(([sessionId, value]) => [
                sessionId,
                {
                  ...EMPTY_STATS,
                  ...(typeof value === 'object' && value ? value : {}),
                },
              ])
            )
          : {},
      conversationStats: parseConversationStatsField(parsed),
      sessionConversationStats: parseSessionConversationStats(
        parsed.sessionConversationStats,
        parsed.sessionCumulativeStats
      ),
      projectDiagnosticsReport: parseProjectDiagnosticsReport(parsed.projectDiagnosticsReport),
      messageCheckpoints:
        parsed.messageCheckpoints && typeof parsed.messageCheckpoints === 'object' && !Array.isArray(parsed.messageCheckpoints)
          ? Object.fromEntries(
              Object.entries(parsed.messageCheckpoints).filter(
                (entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string'
              )
            )
          : {},
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    };
  } catch (err) {
    console.warn(
      'Project state JSON is corrupted, resetting to empty state.',
      err instanceof Error ? err.message : err
    );
    return createEmptyProjectState();
  }
}

export async function ensureProjectStorage(workspacePath: string): Promise<void> {
  const normalizedWorkspacePath = workspacePath.trim();
  if (!normalizedWorkspacePath) return;

  await invoke<ProjectStateStorageResult>('load_project_state', {
    workspacePath: normalizedWorkspacePath,
  });
}

export async function loadProjectState(workspacePath: string): Promise<ProjectStateSnapshot> {
  const normalizedWorkspacePath = workspacePath.trim();
  await waitForPendingProjectStateSave(normalizedWorkspacePath);
  const result = await invoke<ProjectStateStorageResult>('load_project_state', {
    workspacePath: normalizedWorkspacePath,
  });
  return parseProjectState(result.stateJson);
}

export async function saveProjectState(workspacePath: string, state: ProjectStateSnapshot): Promise<void> {
  return saveProjectStateWithOptions(workspacePath, state);
}

async function saveProjectStateWithOptions(
  workspacePath: string,
  state: ProjectStateSnapshot,
  options: SaveProjectStateOptions = {}
): Promise<void> {
  const normalizedWorkspacePath = workspacePath.trim();
  if (!normalizedWorkspacePath) return;

  const serializedState = serializeProjectState(state);

  await enqueueProjectStateSave(normalizedWorkspacePath, async () => {
    await invokeProjectStateSave(normalizedWorkspacePath, serializedState, options);
  });
}

function serializeProjectState(state: ProjectStateSnapshot): string {
  return JSON.stringify(
    {
      ...state,
      version: 1,
      updatedAt: Date.now(),
    },
    null,
    2
  );
}

async function invokeProjectStateSave(
  workspacePath: string,
  serializedState: string,
  options: SaveProjectStateOptions
): Promise<void> {
  await invoke<ProjectStateStorageResult>('save_project_state', {
    workspacePath,
    stateJson: serializedState,
    purgeDeletedContent: options.purgeDeletedContent ?? false,
  });
}

export async function saveProjectStateWithPurge(
  workspacePath: string,
  state: ProjectStateSnapshot
): Promise<void> {
  await saveProjectStateWithOptions(workspacePath, state, { purgeDeletedContent: true });
}

export async function saveProjectStateDirect(
  workspacePath: string,
  state: ProjectStateSnapshot,
  options: SaveProjectStateOptions = {}
): Promise<void> {
  const normalizedWorkspacePath = workspacePath.trim();
  if (!normalizedWorkspacePath) return;
  const serializedState = serializeProjectState(state);
  await invokeProjectStateSave(normalizedWorkspacePath, serializedState, options);
}

export async function saveSession(workspacePath: string, session: ProjectSessionMeta): Promise<void> {
  await invoke('save_session', {
    workspacePath: workspacePath.trim(),
    sessionJson: JSON.stringify(session),
  });
}

interface SessionListResult {
  sessionsJson: string;
}

export async function loadSessions(workspacePath: string): Promise<ProjectSessionMeta[]> {
  const result = await invoke<SessionListResult>('load_sessions', {
    workspacePath: workspacePath.trim(),
  });
  const parsed: unknown = JSON.parse(result.sessionsJson);
  if (!Array.isArray(parsed)) return [];
  return parsed as ProjectSessionMeta[];
}

export async function deleteSessionById(workspacePath: string, sessionId: string): Promise<void> {
  await invoke('delete_session', {
    workspacePath: workspacePath.trim(),
    sessionId,
  });
}

export async function saveMessageBatch(
  workspacePath: string,
  sessionId: string,
  messages: ProjectMessage[]
): Promise<void> {
  if (messages.length === 0) return;
  await invoke('save_message_batch', {
    workspacePath: workspacePath.trim(),
    sessionId,
    messagesJson: JSON.stringify(messages),
  });
}

interface MessageListResult {
  messagesJson: string;
}

export async function loadSessionMessages(
  workspacePath: string,
  sessionId: string
): Promise<ProjectMessage[]> {
  const result = await invoke<MessageListResult>('load_session_messages', {
    workspacePath: workspacePath.trim(),
    sessionId,
  });
  const parsed: unknown = JSON.parse(result.messagesJson);
  if (!Array.isArray(parsed)) return [];
  return parsed as ProjectMessage[];
}

interface AllMessagesResult {
  messagesBySessionJson: string;
}

/** Load every session's messages in one IPC round-trip (vs. one per session).
 *  Returns a map of sessionId → messages. */
export async function loadAllSessionMessages(
  workspacePath: string
): Promise<Record<string, ProjectMessage[]>> {
  const result = await invoke<AllMessagesResult>('load_all_session_messages', {
    workspacePath: workspacePath.trim(),
  });
  const parsed: unknown = JSON.parse(result.messagesBySessionJson);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as Record<string, ProjectMessage[]>;
}

export interface ToolUsageEntry {
  name: string;
  count: number;
  success: number;
  error: number;
}

interface ToolUsageResult {
  usageJson: string;
}

/** Aggregate tool invocation stats across all sessions in the backend (SQL
 *  scan of the tool_invocations column), so the UI does not need every
 *  session's messages resident in memory. */
export async function aggregateToolUsageInDb(
  workspacePath: string
): Promise<ToolUsageEntry[]> {
  const result = await invoke<ToolUsageResult>('aggregate_tool_usage', {
    workspacePath: workspacePath.trim(),
  });
  const parsed: unknown = JSON.parse(result.usageJson);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is ToolUsageEntry =>
      !!entry &&
      typeof entry === 'object' &&
      typeof (entry as ToolUsageEntry).name === 'string' &&
      typeof (entry as ToolUsageEntry).count === 'number'
  );
}

export async function saveProjectMeta(workspacePath: string, key: string, value: unknown): Promise<void> {
  await invoke('save_project_meta', {
    workspacePath: workspacePath.trim(),
    key,
    value: JSON.stringify(value),
  });
}

export async function loadProjectMeta(workspacePath: string, key: string): Promise<unknown | null> {
  const result = await invoke<string | null>('load_project_meta', {
    workspacePath: workspacePath.trim(),
    key,
  });
  if (!result) return null;
  try {
    return JSON.parse(result);
  } catch {
    return null;
  }
}

interface ProjectMetaResult {
  metaJson: string;
}

export async function loadAllProjectMeta(workspacePath: string): Promise<Record<string, unknown>> {
  const result = await invoke<ProjectMetaResult>('load_all_project_meta', {
    workspacePath: workspacePath.trim(),
  });
  const parsed: unknown = JSON.parse(result.metaJson);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed as Record<string, string>).map(([k, v]) => {
      try {
        return [k, JSON.parse(v)];
      } catch {
        return [k, v];
      }
    })
  );
}
