/**
 * UI 层 TodoList 工具桥接：
 *  - 注册 `todo` 工具到 ToolRegistry
 *  - 工具 handler 走 core 的 applyTodoToolRequest 纯函数（与 headless 同源），
 *    在这里叠加两件事：创建窗口闸门（回合级一次创建）与主线程副作用
 *    （注册表写入 → zustand 渲染推送 → 防抖落盘）
 *
 * 与 task 工具正交：todo 只改主 Agent 的计划，task 仍然是子代理委派。
 *
 * 注意：TodoListContext 的存储仓库已拆到 `todoListRegistry`（无 store 依赖），
 * worker 侧的压缩管线只依赖注册表读取，避免把整个 agentStore 图谱
 * （约 860KB）打进 worker 包。
 */
import {
  TODO_CREATE_REJECTED_NOTICE,
  buildTodoToolDefinition,
  renderTodoListDigest,
  applyTodoToolRequest,
  type ToolRegistry,
} from '@codepapr/core';
import type { IToolDefinition, TodoListContext } from '@codepapr/types';
import { useAgentStore } from '../store/agentStore';
import { saveCurrentProjectState } from '../store/internals/projectSnapshot';
import {
  closeTodoCreationWindow,
  commitTodoListContext,
  getTodoCreationWindowGoal,
  getTodoListContext,
  isTodoCreationWindowOpen,
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
  /** 创建窗口已关闭时 tasks 被拒的系统说明（模型可见）。 */
  notice?: string;
}

function buildReturn(ctx: TodoListContext, notice?: string): ToolReturn {
  return {
    todoList: ctx,
    digest: renderTodoListDigest(ctx),
    ...(notice ? { notice } : {}),
  };
}

/**
 * 注册统一的 `todo` 工具到指定 ToolRegistry。
 *
 * 运行时纪律（core applyTodoToolRequest 执行语义，这里供给窗口与副作用）：
 *  - tasks 全量覆盖 = 创建，每个用户回合至多一次（创建窗口 open 于用户
 *    消息发送时，首次成功创建即消耗）；窗口已关的 tasks 调用被拒绝，
 *    状态零变化，仅回传当前快照 + 说明。
 *  - updates 是回合内一切进度变化的唯一通道，不限次数。
 *
 * @param sessionId 会话 ID；不同会话各持一份 TodoListContext
 */
export function registerTodoListTools(
  registry: ToolRegistry,
  sessionId: string
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
    const previous = getTodoListContext(sessionId) ?? null;
    const creationOpen = isTodoCreationWindowOpen(sessionId);
    const defaultGoal = creationOpen
      ? getTodoCreationWindowGoal(sessionId) || previous?.goal || ''
      : previous?.goal || '';
    const result = applyTodoToolRequest(
      previous,
      args as Record<string, unknown>,
      { creationOpen, defaultGoal }
    );

    if (result.rejected) {
      // 状态零变化：不落盘、不推渲染，只把当前快照和拒绝说明回传给模型。
      return buildReturn(result.ctx, TODO_CREATE_REJECTED_NOTICE);
    }
    if (result.created) {
      closeTodoCreationWindow(sessionId);
    }
    if (result.ctx === previous) {
      return buildReturn(result.ctx);
    }
    if (!previous && result.ctx.tasks.length === 0) {
      // 空清单不推渲染卡片（与旧实现一致），也不值得落盘。
      setTodoListContext(sessionId, result.ctx, 'null');
      return buildReturn(result.ctx);
    }
    return buildReturn(commit(result.ctx));
  });

  // 如果该会话已有 TodoList（例如 Worker 重启），立刻把现状推回 store
  const existing = getTodoListContext(sessionId);
  if (existing) {
    commitTodoListContext(sessionId, existing);
  }

  return [definition];
}
