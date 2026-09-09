import { createEmptyProjectState, type ProjectSessionMeta, type ProjectStateSnapshot } from '../../utils/projectStorage';
import { buildTaskTitle } from '../../utils/taskTitle';
import { redactImagePayloadsForTranscript, redactTranscriptOutputString } from '@codepapr/core';
import { createEmptyStats, createEmptyConversationStats } from './defaults';
import { cloneStats, cloneConversationStats, migrateCumulativeToConversationStats } from './stats';
import type { ProviderName, SessionMeta, UIMessage } from './types';

/**
 * 存量转录防御：修复前的会话把工具图片的 `__images` base64 全量嵌在
 * toolInvocations.output 里（撑爆兼容快照 20MB 上限的根因）。落盘前
 * parse → redact（data 置空，保留 mediaType/path 引用）→ 回写；非 JSON
 * 或不含图片的结果原样返回。与 core Agent 事件侧的同名投影配合，覆盖
 * 新旧数据两条链路。
 */
export function redactToolInvocationOutput<
  T extends { output?: unknown }
>(invocation: T): T {
  const output = invocation.output;
  if (typeof output === 'string') {
    const redacted = redactTranscriptOutputString(output);
    return redacted === output ? invocation : { ...invocation, output: redacted };
  }
  if (output && typeof output === 'object') {
    return { ...invocation, output: redactImagePayloadsForTranscript(output) };
  }
  return invocation;
}

/** 图片的持久化投影：只保留落盘引用（path + mediaType），base64 payload
 *  不进存储（体积大）。无 path 的图片（写盘失败/旧数据）被丢弃。 */
export function projectImagesForPersistence<T extends { mediaType: string; data: string; path?: string }>(
  images: readonly T[] | undefined
): Array<{ mediaType: string; data: string; path?: string }> | undefined {
  const withPath = (images ?? []).filter((img) => img.path);
  if (withPath.length === 0) return undefined;
  return withPath.map((img) => ({ mediaType: img.mediaType, data: '', path: img.path }));
}

/** 消息列表的持久化投影：图片字段收敛为落盘引用（撤销栈持久化用，
 *  避免大体积 base64 进入 project_meta）。 */
export function projectMessageImagesForPersistence<T extends { images?: Array<{ mediaType: string; data: string; path?: string }> }>(
  messages: T[]
): T[] {
  return messages.map((message) => {
    if (!message.images?.length) return message;
    return { ...message, images: projectImagesForPersistence(message.images) };
  });
}

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

export function sanitizeMessageForPersistence(message: UIMessage): UIMessage {
  const promptContent =
    message.role === 'user'
      ? message.promptContent
      : undefined;

  return {
    ...message,
    isStreaming: undefined,
    statusText: undefined,
    // user.promptContent is the full runtime user prompt actually sent to the
    // model — restoring it keeps rebuilt history byte-identical (prefix cache).
    promptContent,
    // 图片只持久化落盘引用（path + mediaType），base64 payload 不进 DB
    // （体积大，全量替换语义下反复读写会拖慢持久化）。无 path 的图片
    // （写盘失败/旧数据）不保留。加载后由 chatImageStore 按路径回填数据。
    // 文本附件只存 name/size（attachedFiles），随 extras 保留。
    images: message.images?.some((img) => img.path)
      ? message.images
          .filter((img) => img.path)
          .map((img) => ({ mediaType: img.mediaType, data: '', path: img.path }))
      : undefined,
    toolInvocations: message.toolInvocations?.map((ti) => redactToolInvocationOutput({
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

export function sanitizeSessionMessagesForPersistence(
  sessionMessages: Record<string, UIMessage[]>
): Record<string, UIMessage[]> {
  return Object.fromEntries(
    Object.entries(sessionMessages).map(([sessionId, messages]) => [
      sessionId,
      Array.isArray(messages)
        ? messages.map((message) => sanitizeMessageForPersistence(message))
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
  snapshot: ProjectStateSnapshot
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
      (snapshot.sessionMessages ?? {}) as Record<string, UIMessage[]>
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
