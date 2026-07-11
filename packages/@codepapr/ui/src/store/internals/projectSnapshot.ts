import {
  saveProjectState,
  saveProjectStateWithPurge,
  type ProjectStateSnapshot,
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
    messageCheckpoints: { ...state._messageCheckpoints },
    updatedAt: Date.now(),
  };
}

export function saveCurrentProjectState(
  state: AgentState,
  options?: { purgeDeletedContent?: boolean }
): void {
  if (!state.workspacePath) return;
  const save = options?.purgeDeletedContent ? saveProjectStateWithPurge : saveProjectState;
  void save(state.workspacePath, toProjectSnapshot(state));
}
