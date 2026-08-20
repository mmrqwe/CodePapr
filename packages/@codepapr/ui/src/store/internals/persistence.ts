import { createEmptyProjectState, type ProjectSessionMeta, type ProjectStateSnapshot } from '../../utils/projectStorage';
import { buildTaskTitle } from '../../utils/taskTitle';
import { createEmptyStats, createEmptyConversationStats } from './defaults';
import { cloneStats, cloneConversationStats, migrateCumulativeToConversationStats } from './stats';
import type { ProviderName, SessionMeta, UIMessage } from './types';

/** DB 以 string 存 provider；归一化到合法 ProviderName，非法值回退应用默认
 *  deepseek（历史/损坏数据兜底）。合法值原样通过，运行期恒等。 */
export function normalizeSessionProvider(value: string): ProviderName {
  return value === 'openai' || value === 'claude' ? value : 'deepseek';
}

export function maybeApplySessionTitle(
  sessions: SessionMeta[],
  sessionId: string,
  titleSource: string,
  currentMessages: readonly UIMessage[],
  lang?: import('../../utils/i18n').Lang
): SessionMeta[] {
  if (currentMessages.length > 0) {
    return sessions;
  }

  const title = buildTaskTitle(titleSource, lang);
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

export function normalizeSessionMetaList(sessions: ProjectSessionMeta[]): SessionMeta[] {
  return [...sessions]
    .map((session) => ({
      ...session,
      provider: normalizeSessionProvider(session.provider),
      updatedAt: session.updatedAt ?? session.createdAt,
      activeCharacterId: session.activeCharacterId ?? null,
      archivedAt: typeof session.archivedAt === 'number' ? session.archivedAt : null,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
}

export function sanitizeMessageForPersistence(message: UIMessage, debugEnabled: boolean): UIMessage {
  const promptContent =
    message.role === 'user'
      ? message.promptContent
      : debugEnabled
        ? redactRecallFromDebugPrompt(message.promptContent)
        : undefined;

  return {
    ...message,
    isStreaming: undefined,
    statusText: undefined,
    // user.promptContent is the full runtime user prompt actually sent to the
    // model — restoring it keeps rebuilt history byte-identical (prefix cache).
    // assistant.promptContent is a debug dump of the compiled request: only
    // persist when debug is on, and never persist request-only Recall (ADR-009).
    promptContent,
    // 图片 payload 是 base64，不落盘。文本附件只存 name/size（attachedFiles），随 extras 保留。
    images: undefined,
    toolInvocations: message.toolInvocations?.map((ti) => ({
      ...ti,
      statusText: undefined,
      status: ti.status === 'running' ? 'error' : ti.status,
      error: ti.status === 'running' ? '未完成的工具调用' : ti.error,
      // output 缺失（中断的调用）会让 toCoreTailMessages 重建出 content 为
      // undefined 的 tool 消息，导致 AppendOnlyLog.loadFromSnapshot 校验失败。
      output: ti.output ?? '',
    })),
  };
}

/** Strip request-only Recall blocks from a debug compiled-request dump. */
export function redactRecallFromDebugPrompt(promptContent: string | undefined): string | undefined {
  if (typeof promptContent !== 'string' || !promptContent.trim()) return undefined;
  try {
    const parsed = JSON.parse(promptContent) as {
      messages?: Array<{ content?: string; metadata?: Record<string, unknown> }>;
    };
    if (!Array.isArray(parsed.messages)) return promptContent;
    const next = parsed.messages.filter((entry) => {
      if (entry.metadata?.requestOnly === true) return false;
      return typeof entry.content !== 'string' || !entry.content.includes('## Relevant Project Memory');
    });
    if (next.length === parsed.messages.length) return promptContent;
    return JSON.stringify({ ...parsed, messages: next }, null, 2);
  } catch {
    if (!promptContent.includes('## Relevant Project Memory')) return promptContent;
    return promptContent.replace(/## Relevant Project Memory[\s\S]*?(?=\n## |\n {2}"role":|$)/g, '');
  }
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
    sessions: normalizeSessionMetaList(snapshot.sessions),
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
