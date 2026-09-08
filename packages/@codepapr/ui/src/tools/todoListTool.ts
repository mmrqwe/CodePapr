/**
 * UI 层 TodoList 工具桥接：
 *  - 注册 `todo` 工具到 ToolRegistry
 *  - 工具 handler 改注册表（纯数据，见 todoListRegistry），并把最新
 *    TodoListContext 通过返回值喂回 LLM
 *  - 清单变更经注册表监听器推进 agentStore 的 `_taskChecklists`
 *
 * 与 task 工具正交：todo 只改主 Agent 的计划，task 仍然是子代理委派。
 *
 * 持久化：每次修改 TodoList 后，同步到 project.sqlite 以便重启恢复。
 *
 * 注意：TodoListContext 的存储仓库已拆到 `todoListRegistry`（无 store 依赖），
 * worker 侧的压缩管线只依赖注册表读取，避免把整个 agentStore 图谱
 * （约 860KB）打进 worker 包。
 */
import {
  buildTodoToolDefinition,
  createEmptyTodoListContext,
  parseTodoGoal,
  parseTodoUpdatePatches,
  renderTodoListDigest,
  updateTodoList,
  writeTodoList,
  type ToolRegistry,
} from '@codepapr/core';
import type { IToolDefinition, TodoListContext } from '@codepapr/types';
import { useAgentStore } from '../store/agentStore';
import { saveCurrentProjectState } from '../store/internals/projectSnapshot';
import {
  commitTodoListContext,
  getTodoListContext,
  setTodoChecklistListener,
  setTodoListContext,
} from './todoListRegistry';

// 主线程侧把清单渲染结构推进 agentStore（worker 环境不加载本模块，
// 注册表无监听器，行为与旧实现写一份无人消费的 store 副本等价）。
setTodoChecklistListener((sessionId, checklist) => {
  useAgentStore.setState((s) => ({
    _taskChecklists: { ...s._taskChecklists, [sessionId]: checklist },
  }));
});

/**
 * 清单变更后的防抖落盘。快照保存（saveCurrentProjectState）内部自带写队列
 * 串行化，这里只做节流窗口。旧实现仅在回合边界/流式快照时落盘，主线程
 * 降级 agent 无流式快照回调，回合中途进程被杀会丢失整个回合的 todo 更新。
 */
const TODO_PERSIST_DEBOUNCE_MS = 800;
let todoPersistTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleTodoPersist(): void {
  if (todoPersistTimer !== null) return;
  todoPersistTimer = setTimeout(() => {
    todoPersistTimer = null;
    try {
      saveCurrentProjectState(useAgentStore.getState());
    } catch (err) {
      console.warn('[CodePapr] TodoList 防抖落盘失败:', err);
    }
  }, TODO_PERSIST_DEBOUNCE_MS);
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

  const commit = (ctx: TodoListContext): TodoListContext => {
    scheduleTodoPersist();
    return commitTodoListContext(sessionId, ctx);
  };

  registry.register(definition, async (args) => {
    const hasTasks = Array.isArray(args.tasks);
    const hasUpdates = Array.isArray(args.updates);
    const goal = parseTodoGoal(args.goal, defaultGoal);

    if (hasTasks) {
      // ── 全量覆盖模式 ──
      const rawTasks = args.tasks as Array<Record<string, unknown>>;
      const previous = getTodoListContext(sessionId) ?? null;
      const nextCtx = writeTodoList(previous, goal, rawTasks, maxRetries);
      return buildReturn(commit(nextCtx));
    }

    // ── 部分更新模式 ──
    const previous = getTodoListContext(sessionId);
    if (!previous) {
      // 没有已有清单时自动创建一个空的，然后应用更新。
      // 空清单先推 null（与旧实现一致），首个 updates 落地后再推渲染结构。
      const emptyCtx = createEmptyTodoListContext(goal);
      setTodoListContext(sessionId, emptyCtx, 'null');

      if (!hasUpdates) {
        return buildReturn(emptyCtx);
      }

      const rawUpdates = hasUpdates ? (args.updates as Array<Record<string, unknown>>) : [];
      const patches = parseTodoUpdatePatches(rawUpdates);
      if (patches.length === 0) {
        return buildReturn(emptyCtx);
      }

      const nextCtx = updateTodoList(emptyCtx, patches);
      return buildReturn(commit(nextCtx));
    }

    if (!hasUpdates) {
      // 无 tasks 也无 updates，仅更新 goal (如果提供)
      if (goal && goal !== previous.goal) {
        const nextCtx = { ...previous, goal, updatedAt: Date.now() };
        return buildReturn(commit(nextCtx));
      }
      return buildReturn(previous);
    }

    const rawUpdates = (args.updates as Array<Record<string, unknown>>);
    const patches = parseTodoUpdatePatches(rawUpdates);
    if (patches.length === 0) {
      return buildReturn(previous);
    }

    const nextCtx = updateTodoList(previous, patches);
    return buildReturn(commit(nextCtx));
  });

  // 如果该会话已有 TodoList（例如 Worker 重启），立刻把现状推回 store
  const existing = getTodoListContext(sessionId);
  if (existing) {
    commitTodoListContext(sessionId, existing);
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
  const existing = getTodoListContext(sessionId);
  if (!existing) {
    return;
  }
  if (!existing.goal.trim()) {
    // 仅改 goal 不推送渲染结构（与旧实现一致：rememberTodoGoal 不触发 store 写入）
    setTodoListContext(sessionId, { ...existing, goal: trimmed, updatedAt: Date.now() }, 'none');
  }
}
