/**
 * TodoList 上下文的纯注册表（无 store / IPC 依赖）。
 *
 * 拆出原因：worker（agentRuntime.worker）经
 * `compactionHandler → contextCheckpoint` 只需**读取** TodoListContext，
 * 但旧实现里读取函数与 `useAgentStore` 推送混在 todoListTool.ts，导致整条
 * agentStore 图谱（约 860KB，含 i18n / sendMessage / projectStorage 等）
 * 被打进 6MB 的 worker 包。本模块不导入任何 store，worker 侧只依赖它；
 * 主线程的 todoListTool 通过 `setTodoChecklistListener` 注册 store 推送，
 * 未注册时（worker 环境）变更仅落在注册表内存、不推送渲染结构——这与旧实现
 * 在 worker 里写入一个无人消费的 agentStore 副本等价，但不再拖入整个依赖图。
 */
import type { TodoListContext } from '@codepapr/types';
import { convergeUnconfirmedRunningTasks } from '@codepapr/core';
import type { TaskChecklist, TaskChecklistItemStatus } from '../utils/taskChecklistTypes';

/**
 * 把 core 的 TodoListContext 转成现有 TaskChecklist 渲染结构，
 * 让既有 `_taskChecklists` store 和 `TaskChecklist.tsx` 组件无需改动即可显示。
 */
export function todoContextToChecklist(
  ctx: TodoListContext,
  sessionId: string
): TaskChecklist {
  const items = ctx.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    prompt: task.description,
    status: task.status as TaskChecklistItemStatus,
    summary: task.summary
      ?? (task.errorLog ? `失败: ${task.errorLog}` : undefined),
  }));

  return {
    sessionId,
    title: ctx.goal,
    items,
    status: ctx.status,
    createdAt: ctx.createdAt,
    updatedAt: ctx.updatedAt,
  };
}

/**
 * 进程级的 TodoListContext 仓库，按 sessionId 索引。
 * 因为 Worker 走 tool-request 桥回主线程执行工具，主线程持有一份足矣。
 */
const todoContexts = new Map<string, TodoListContext>();

/**
 * 创建窗口：每条用户消息发送时 open（携带用户原文作 goal 兜底），
 * 被一次 `tasks` 全量覆盖消耗后 close。窗口关闭期间到达的 tasks 调用
 * 由工具 handler 直接拒绝——「创建是回合级事件」这条纪律的强制执行点。
 */
const creationWindows = new Map<string, string>();

export function openTodoCreationWindow(sessionId: string, goalText?: string): void {
  creationWindows.set(sessionId, (goalText ?? '').trim().slice(0, 400));
}

export function closeTodoCreationWindow(sessionId: string): void {
  creationWindows.delete(sessionId);
}

export function isTodoCreationWindowOpen(sessionId: string): boolean {
  return creationWindows.has(sessionId);
}

export function getTodoCreationWindowGoal(sessionId: string): string {
  return creationWindows.get(sessionId) ?? '';
}

type ChecklistListener = (sessionId: string, checklist: TaskChecklist | null) => void;

let checklistListener: ChecklistListener | null = null;

/** 注册清单变更监听（主线程注册，把渲染结构推进 agentStore）。 */
export function setTodoChecklistListener(listener: ChecklistListener | null): void {
  checklistListener = listener;
}

function notifyChecklist(sessionId: string, checklist: TaskChecklist | null): void {
  try {
    checklistListener?.(sessionId, checklist);
  } catch (err) {
    console.warn('TodoList checklist listener failed:', err);
  }
}

export function getTodoListContext(sessionId: string): TodoListContext | null {
  return todoContexts.get(sessionId) ?? null;
}

/**
 * 写入上下文并按模式通知监听：
 * - `'rendered'`（默认）：推送渲染结构（工具提交、持久化恢复）
 * - `'null'`：推送空值（新建空清单时不渲染空卡片）
 * - `'none'`：不通知
 */
export type TodoChecklistNotification = 'rendered' | 'null' | 'none';

export function setTodoListContext(
  sessionId: string,
  ctx: TodoListContext,
  notify: TodoChecklistNotification = 'rendered'
): void {
  todoContexts.set(sessionId, ctx);
  if (notify === 'none') return;
  notifyChecklist(sessionId, notify === 'null' ? null : todoContextToChecklist(ctx, sessionId));
}

/** 提交上下文：落库 + 推送渲染结构（工具提交路径用）。 */
export function commitTodoListContext(sessionId: string, ctx: TodoListContext): TodoListContext {
  setTodoListContext(sessionId, ctx, 'rendered');
  return ctx;
}

export function resetTodoListContext(sessionId: string): void {
  todoContexts.delete(sessionId);
  creationWindows.delete(sessionId);
  notifyChecklist(sessionId, null);
}

/** 清空全部 TodoList 上下文（切换/关闭工作区时调用，防止跨项目累积）。 */
export function clearAllTodoListContexts(): void {
  for (const sessionId of todoContexts.keys()) {
    notifyChecklist(sessionId, null);
  }
  todoContexts.clear();
  creationWindows.clear();
}

/** 获取所有 TodoList 上下文，供持久化使用。 */
export function getAllTodoListContexts(): ReadonlyMap<string, TodoListContext> {
  return todoContexts;
}

/**
 * 回合结束收敛（兜底）：一次 chat 结束（成功/取消/出错）后，若清单仍 active
 * 且有 running 任务，说明模型忘了调 todo 同步——此刻不可能有在飞执行，把
 * running 退回 pending 并标记未确认（纯函数见 core convergeUnconfirmedRunningTasks）。
 * 返回是否发生了收敛（调用方据此决定要不要落盘）。
 */
export function convergeSessionTodoListAtTurnEnd(sessionId: string): boolean {
  const ctx = todoContexts.get(sessionId);
  if (!ctx) return false;
  const next = convergeUnconfirmedRunningTasks(ctx);
  if (next === ctx) return false;
  setTodoListContext(sessionId, next);
  return true;
}

/** 从持久化数据恢复 TodoList 上下文。恢复时无任何在飞回合，running 必然
 *  是上次进程存续期间未同步的残留——收敛为 pending 后再灌入。 */
export function restoreTodoListContexts(contexts: Readonly<Record<string, TodoListContext>>): void {
  for (const [sessionId, ctx] of Object.entries(contexts)) {
    if (ctx && ctx.tasks && Array.isArray(ctx.tasks) && ctx.tasks.length > 0) {
      setTodoListContext(
        sessionId,
        convergeUnconfirmedRunningTasks(ctx, '进程退出前回合未确认')
      );
    }
  }
}
