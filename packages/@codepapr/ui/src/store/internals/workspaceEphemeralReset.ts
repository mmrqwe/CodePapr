/**
 * 切工作区时清掉「不属于 agentStore、也不按 workspace 分区」的进程级状态。
 *
 * ChatPanel / GoalBanner / 权限与 MCP 弹窗都挂在 App 上不卸载，模块单例
 * 不清就会把上一项目的折叠块、Goal 条、确认框带进新对话。
 */
import { resetSubagentProgress } from '../../utils/subagentProgress';
import { clearAllTodoListContexts } from '../../tools/todoListRegistry';
import { clearLanguageIntelligenceWorkspace } from '../../utils/languageIntelligence';
import { clearAppPosters } from '../../papr/appChannelHub';
import { useGoalStore } from '../goalStore';
import { cancelPendingMcpConfirms } from '../mcpConfirmStore';
import { cancelExternalAccessRequests } from '../permissionStore';
import { usePreviewStore } from '../previewStore';
import { useBrowserViewStore } from '../browserViewStore';
import { forgetContextSurfacesForWorkspace } from './contextSurfaceStore';
import { cancelBackgroundWorkspaceWork } from './backgroundDiagnostics';

export function resetWorkspaceEphemeralState(previousWorkspacePath: string): void {
  resetSubagentProgress();
  clearAllTodoListContexts();
  useGoalStore.getState().clearGoal();
  cancelPendingMcpConfirms();
  cancelExternalAccessRequests();
  usePreviewStore.getState().closePreviewSession();
  useBrowserViewStore.getState().setPageSession(null);
  useBrowserViewStore.getState().closePanel();
  cancelBackgroundWorkspaceWork();
  clearAppPosters();
  if (previousWorkspacePath) {
    forgetContextSurfacesForWorkspace(previousWorkspacePath);
    clearLanguageIntelligenceWorkspace(previousWorkspacePath);
  }
}
