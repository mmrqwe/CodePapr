/**
 * UI 层 TodoList 工具桥接：
 *  - 在每个 Agent 会话挂一份 TodoListContext（按 sessionId 索引到 zustand store）
 *  - 注册 `todo` 工具到 ToolRegistry
 *  - 工具 handler 改 store，并把最新 TodoListContext 通过返回值喂回 LLM
 *
 * 与 task 工具正交：todo 只改主 Agent 的计划，task 仍然是子代理委派。
 *
 * 持久化：每次修改 TodoList 后，同步到 project.sqlite 以便重启恢复。
 */
import {
  buildTodoToolDefinition,
  createEmptyTodoListContext,
  renderTodoListDigest,
  updateTodoList,
  writeTodoList,
  type ToolRegistry,
  type TodoUpdatePatch,
} from '@codepapr/core';
import type { AgentTask, IToolDefinition, TodoListContext } from '@codepapr/types';
import { useAgentStore } from '../store/agentStore';
import type { TaskChecklist, TaskChecklistItem, TaskChecklistItemStatus } from '../utils/taskChecklistTypes';

/**
 * 把 core 的 TodoListContext 转成现有 TaskChecklist 渲染结构，
 * 让既有 `_taskChecklists` store 和 `TaskChecklist.tsx` 组件无需改动即可显示。
 */
export function todoContextToChecklist(
  ctx: TodoListContext,
  sessionId: string
): TaskChecklist {
  const items: TaskChecklistItem[] = ctx.tasks.map((task) => ({
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

export function getTodoListContext(sessionId: string): TodoListContext | null {
  return todoContexts.get(sessionId) ?? null;
}

export function resetTodoListContext(sessionId: string): void {
  todoContexts.delete(sessionId);
  pushChecklistToStore(sessionId, null);
}

/** 获取所有 TodoList 上下文，供持久化使用。 */
export function getAllTodoListContexts(): ReadonlyMap<string, TodoListContext> {
  return todoContexts;
}

/** 从持久化数据恢复 TodoList 上下文。 */
export function restoreTodoListContexts(contexts: Readonly<Record<string, TodoListContext>>): void {
  for (const [sessionId, ctx] of Object.entries(contexts)) {
    if (ctx && ctx.tasks && Array.isArray(ctx.tasks) && ctx.tasks.length > 0) {
      todoContexts.set(sessionId, ctx as TodoListContext);
      pushChecklistToStore(sessionId, todoContextToChecklist(ctx as TodoListContext, sessionId));
    }
  }
}

function pushChecklistToStore(sessionId: string, checklist: TaskChecklist | null): void {
  useAgentStore.setState((s) => ({
    _taskChecklists: { ...s._taskChecklists, [sessionId]: checklist },
  }));
}

function commit(sessionId: string, ctx: TodoListContext): TodoListContext {
  todoContexts.set(sessionId, ctx);
  pushChecklistToStore(sessionId, todoContextToChecklist(ctx, sessionId));
  return ctx;
}

interface ToolReturn {
  todoList: TodoListContext;
  digest: string;
}

function buildReturn(ctx: TodoListContext): ToolReturn {
  return { todoList: ctx, digest: renderTodoListDigest(ctx) };
}

/**
 * 注册统一的 `todo` 工具到指定 ToolRegistry。
 *
 * 两种调用模式——通过参数区分：
 *  - tasks 参数：全量覆盖（初始化 / re-plan）
 *  - updates 参数：部分更新（进度汇报 / 完成标记 / 失败报告）
 *
 * @param sessionId  会话 ID；不同会话各持一份 TodoListContext
 * @param defaultGoal 兜底目标文本
 */
export function registerTodoListTools(
  registry: ToolRegistry,
  sessionId: string,
  defaultGoal: string,
  maxRetries: number = 3
): IToolDefinition[] {
  const definition = buildTodoToolDefinition();
  if (!definition) {
    return [];
  }

  registry.register(definition, async (args) => {
    const hasTasks = Array.isArray(args.tasks);
    const hasUpdates = Array.isArray(args.updates);
    const goal = typeof args.goal === 'string' && args.goal.trim() ? args.goal.trim() : defaultGoal;

    if (hasTasks) {
      // ── 全量覆盖模式 ──
      const rawTasks = args.tasks as Array<Record<string, unknown>>;
      const previous = todoContexts.get(sessionId) ?? null;
      const nextCtx = writeTodoList(previous, goal, rawTasks, maxRetries);
      return buildReturn(commit(sessionId, nextCtx));
    }

    // ── 部分更新模式 ──
    const previous = todoContexts.get(sessionId);
    if (!previous) {
      // 没有已有清单时自动创建一个空的，然后应用更新
      const emptyCtx = createEmptyTodoListContext(goal);
      todoContexts.set(sessionId, emptyCtx);
      pushChecklistToStore(sessionId, null);

      if (!hasUpdates) {
        return buildReturn(emptyCtx);
      }

      const rawUpdates = hasUpdates ? (args.updates as Array<Record<string, unknown>>) : [];
      const patches: TodoUpdatePatch[] = rawUpdates
        .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
        .map((item) => ({
          id: typeof item.id === 'string' ? item.id.trim() : '',
          status: typeof item.status === 'string' ? (item.status as AgentTask['status']) : undefined,
          summary: typeof item.summary === 'string' ? item.summary : undefined,
          errorLog: typeof item.errorLog === 'string' ? item.errorLog : undefined,
          touchedArtifacts: Array.isArray(item.touchedArtifacts)
            ? (item.touchedArtifacts.filter((p): p is string => typeof p === 'string'))
            : undefined,
        }))
        .filter((patch) => patch.id);

      if (patches.length === 0) {
        return buildReturn(emptyCtx);
      }

      const nextCtx = updateTodoList(emptyCtx, patches);
      return buildReturn(commit(sessionId, nextCtx));
    }

    if (!hasUpdates) {
      // 无 tasks 也无 updates，仅更新 goal (如果提供)
      if (goal && goal !== previous.goal) {
        const nextCtx = { ...previous, goal, updatedAt: Date.now() };
        return buildReturn(commit(sessionId, nextCtx));
      }
      return buildReturn(previous);
    }

    const rawUpdates = (args.updates as Array<Record<string, unknown>>);
    const patches: TodoUpdatePatch[] = rawUpdates
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      .map((item) => ({
        id: typeof item.id === 'string' ? item.id.trim() : '',
        status: typeof item.status === 'string' ? (item.status as AgentTask['status']) : undefined,
        summary: typeof item.summary === 'string' ? item.summary : undefined,
        errorLog: typeof item.errorLog === 'string' ? item.errorLog : undefined,
        touchedArtifacts: Array.isArray(item.touchedArtifacts)
          ? (item.touchedArtifacts.filter((p): p is string => typeof p === 'string'))
          : undefined,
      }))
      .filter((patch) => patch.id);

    if (patches.length === 0) {
      return buildReturn(previous);
    }

    const nextCtx = updateTodoList(previous, patches);
    return buildReturn(commit(sessionId, nextCtx));
  });

  // 如果该会话已有 TodoList（例如 Worker 重启），立刻把现状推回 store
  const existing = todoContexts.get(sessionId);
  if (existing) {
    pushChecklistToStore(sessionId, todoContextToChecklist(existing, sessionId));
  }

  return [definition];
}

/**
 * 用于 Agent 主流程：在用户消息真正发送前，把 defaultGoal 记住，
 * 后续 `todo` 没显式提供 goal 时回退到它。
 */
export function rememberTodoGoal(sessionId: string, goal: string): void {
  const trimmed = goal.trim();
  if (!trimmed) return;
  const existing = todoContexts.get(sessionId);
  if (!existing) {
    return;
  }
  if (!existing.goal.trim()) {
    todoContexts.set(sessionId, { ...existing, goal: trimmed, updatedAt: Date.now() });
  }
}
