import { createEmptyProjectState, type ProjectStateSnapshot } from '../../utils/projectStorage';
import { buildTaskTitle } from '../../utils/taskTitle';
import { createEmptyStats, createEmptyConversationStats } from './defaults';
import { cloneStats, cloneConversationStats, migrateCumulativeToConversationStats } from './stats';
import type { SessionMeta, UIMessage } from './types';

export function maybeApplySessionTitle(
  sessions: SessionMeta[],
  sessionId: string,
  titleSource: string,
  currentMessages: readonly UIMessage[]
): SessionMeta[] {
  if (currentMessages.length > 0) {
    return sessions;
  }

  const title = buildTaskTitle(titleSource);
  return sessions.map((session) =>
    session.id === sessionId ? { ...session, name: title } : session
  );
}

export function touchSession(
  sessions: SessionMeta[],
  sessionId: string,
  timestamp: number
): SessionMeta[] {
  const target = sessions.find((session) => session.id === sessionId);
  if (!target) {
    return sessions;
  }
  const touched: SessionMeta = { ...target, updatedAt: timestamp };
  return [touched, ...sessions.filter((session) => session.id !== sessionId)];
}

export function normalizeSessionMetaList(sessions: SessionMeta[]): SessionMeta[] {
  return [...sessions]
    .map((session) => ({
      ...session,
      updatedAt: session.updatedAt ?? session.createdAt,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
}

export function sanitizeMessageForPersistence(message: UIMessage, _debugEnabled: boolean): UIMessage {
  return {
    ...message,
    isStreaming: undefined,
    statusText: undefined,
    // promptContent is intentionally preserved: it is the full runtime user prompt
    // actually sent to the model. Restoring it (via the messages.extras column)
    // keeps rebuilt history byte-identical to the live log, protecting the prefix
    // cache. Only the short display `content` would be recovered otherwise.
    images: undefined,
    toolInvocations: message.toolInvocations?.map((ti) => ({
      ...ti,
      statusText: undefined,
      status: ti.status === 'running' ? 'error' : ti.status,
      error: ti.status === 'running' ? '未完成的工具调用' : ti.error,
    })),
  };
}

export function sanitizeSessionMessagesForPersistence(
  sessionMessages: Record<string, UIMessage[]>,
  debugEnabled: boolean
): Record<string, UIMessage[]> {
  return Object.fromEntries(
    Object.entries(sessionMessages).map(([sessionId, messages]) => [
      sessionId,
      Array.isArray(messages)
        ? messages.map((message) => sanitizeMessageForPersistence(message, debugEnabled))
        : [],
    ])
  );
}

export function normalizeSkillEnabledState(
  value: Record<string, boolean> | undefined
): Record<string, boolean> {
  if (!value) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, boolean] => typeof entry[0] === 'string' && typeof entry[1] === 'boolean'
    )
  );
}

export function normalizeProjectSnapshot(
  snapshot: ProjectStateSnapshot,
  options: { debugEnabled: boolean }
): ProjectStateSnapshot {
  const activeSessionId = snapshot.sessions.some((session) => session.id === snapshot.activeSessionId)
    ? snapshot.activeSessionId
    : null;
  const sessionCumulativeStats = Object.fromEntries(
    Object.entries(snapshot.sessionCumulativeStats ?? {}).map(([sessionId, stats]) => [
      sessionId,
      cloneStats(stats),
    ])
  );
  const conversationStats = snapshot.conversationStats
    ? cloneConversationStats(snapshot.conversationStats)
    : snapshot.cumulativeStats
      ? migrateCumulativeToConversationStats({
          ...createEmptyStats(),
          ...snapshot.cumulativeStats,
        })
      : createEmptyConversationStats();
  const sessionConversationStats = snapshot.sessionConversationStats
    ? Object.fromEntries(
        Object.entries(snapshot.sessionConversationStats).map(([sessionId, stats]) => [
          sessionId,
          cloneConversationStats(stats),
        ])
      )
    : Object.fromEntries(
        Object.entries(snapshot.sessionCumulativeStats ?? {}).map(([sessionId, stats]) => [
          sessionId,
          migrateCumulativeToConversationStats({
            ...createEmptyStats(),
            ...cloneStats(stats),
          }),
        ])
      );
  return {
    ...createEmptyProjectState(),
    ...snapshot,
    sessions: normalizeSessionMetaList(snapshot.sessions as SessionMeta[]),
    activeSessionId,
    sessionMessages: sanitizeSessionMessagesForPersistence(
      (snapshot.sessionMessages ?? {}) as Record<string, UIMessage[]>,
      options.debugEnabled
    ),
    skillEnabledById: normalizeSkillEnabledState(snapshot.skillEnabledById),
    cumulativeStats: {
      ...createEmptyStats(),
      ...(snapshot.cumulativeStats ?? {}),
    },
    sessionCumulativeStats,
    conversationStats,
    sessionConversationStats,
    projectDiagnosticsReport: snapshot.projectDiagnosticsReport ?? null,
  };
}
