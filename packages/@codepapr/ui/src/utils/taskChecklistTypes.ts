/**
 * TaskChecklist 渲染层类型。
 * 这是 `TaskChecklist.tsx` 组件的渲染数据契约，
 * 由 todoListTool.ts 把核心层的 TodoListContext 转换得到。
 */

export type TaskChecklistItemStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface TaskChecklistItem {
  id: string;
  title: string;
  prompt: string;
  status: TaskChecklistItemStatus;
  summary?: string;
}

export type TaskChecklistStatus = 'active' | 'completed';

export interface TaskChecklist {
  sessionId: string;
  title: string;
  items: TaskChecklistItem[];
  status: TaskChecklistStatus;
  createdAt: number;
  updatedAt: number;
}
