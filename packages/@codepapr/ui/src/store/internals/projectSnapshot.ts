import {
  saveProjectStateDirect,
  saveSession,
  saveMessageBatch,
  deleteSessionById,
  saveProjectMeta,
  enqueueProjectStateSave,
  loadSessions,
  type ProjectStateSnapshot,
  type ProjectMessage,
} from '../../utils/projectStorage';
import { getAllTodoListContexts } from '../../tools/todoListTool';
import { sanitizeSessionMessagesForPersistence } from './persistence';
import type { AgentState } from './types';

export function toProjectSnapshot(state: AgentState): ProjectStateSnapshot {
  const todoContexts = getAllTodoListContexts();
  const sessionTodoLists: Record<string, unknown> = {};
  for (const [sessionId, ctx] of todoContexts) {
    if (ctx.tasks.length > 0) {
      sessionTodoLists[sessionId] = ctx;
    }
  }

  return {
    version: 1,
    sessions: state.sessions,
    activeSessionId: state.activeSessionId,
    sessionMessages: sanitizeSessionMessagesForPersistence(
      state.sessionMessages,
      state.settings.debugEnabled
    ),
    skillEnabledById: { ...state.skillEnabledById },
    sessionTodoLists,
    conversationStats: state.conversationStats,
    sessionConversationStats: state.sessionConversationStats,
    projectDiagnosticsReport: state.projectDiagnosticsReport,
    updatedAt: Date.now(),
  };
}

async function saveProjectStateNormalized(
  state: AgentState,
  options?: { purgeDeletedContent?: boolean }
): Promise<void> {
  if (!state.workspacePath) return;

  const path = state.workspacePath;
  const sanitizedMessages = sanitizeSessionMessagesForPersistence(
    state.sessionMessages,
    state.settings.debugEnabled
  );

  const knownSessionIds = new Set<string>();

  for (const session of state.sessions) {
    knownSessionIds.add(session.id);
    try {
      await saveSession(path, session);
    } catch (err) {
      console.warn('[CodePapr] 保存会话失败:', err instanceof Error ? err.message : err);
    }
  }

  for (const [sessionId, messages] of Object.entries(sanitizedMessages)) {
    if (!knownSessionIds.has(sessionId)) continue;
    // 读取失败的会话内存中是空/残缺视图：全量替换语义下回写会抹掉 DB 里
    // 该会话的全部消息。跳过回写，等重载成功后才允许持久化。
    if (state._messageLoadFailedSessions?.[sessionId]) continue;
    try {
      await saveMessageBatch(path, sessionId, messages as ProjectMessage[]);
    } catch (err) {
      console.warn('[CodePapr] 保存消息失败:', err instanceof Error ? err.message : err);
    }
  }

  if (options?.purgeDeletedContent) {
    try {
      const persisted = await loadSessions(path);
      for (const persistedSession of persisted) {
        if (!knownSessionIds.has(persistedSession.id)) {
          await deleteSessionById(path, persistedSession.id);
        }
      }
    } catch (err) {
      console.warn('[CodePapr] 清理已删除会话失败:', err instanceof Error ? err.message : err);
    }
  }

  const todoContexts = getAllTodoListContexts();
  const sessionTodoLists: Record<string, unknown> = {};
  for (const [sessionId, ctx] of todoContexts) {
    if (ctx.tasks.length > 0) {
      sessionTodoLists[sessionId] = ctx;
    }
  }

  const metaPairs: [string, unknown][] = [
    ['active_session_id', state.activeSessionId],
    ['conversation_stats', state.conversationStats],
    ['session_conversation_stats', state.sessionConversationStats],
    ['session_todo_lists', sessionTodoLists],
    ['skill_enabled_by_id', state.skillEnabledById],
    ['project_diagnostics_report', state.projectDiagnosticsReport],
  ];

  for (const [key, value] of metaPairs) {
    try {
      await saveProjectMeta(path, key, value);
    } catch (err) {
      console.warn('[CodePapr] 保存元数据失败:', err instanceof Error ? err.message : err);
    }
  }
}

export function saveCurrentProjectState(
  state: AgentState,
  options?: { purgeDeletedContent?: boolean }
): void {
  if (!state.workspacePath) return;

  const workspacePath = state.workspacePath;

  enqueueProjectStateSave(workspacePath, async () => {
    // Use saveProjectStateDirect (no nested enqueueProjectStateSave) to avoid
    // a circular promise dependency that would deadlock the save queue and
    // prevent any data from ever reaching disk.
    try {
      await saveProjectStateDirect(workspacePath, toProjectSnapshot(state), {
        purgeDeletedContent: options?.purgeDeletedContent ?? false,
      });
    } catch (err) {
      console.warn('[CodePapr] 保存项目状态(兼容)失败:', err instanceof Error ? err.message : err);
    }

    await saveProjectStateNormalized(state, options);
  }).catch((err) => {
    console.warn('[CodePapr] 保存项目状态失败:', err instanceof Error ? err.message : err);
  });
}
