/**
 * TodoList: 主 Agent 的"短期工作记忆"。
 *
 * 设计要点：
 *  - 每个 Agent 会话维护一份 TodoListContext，由 LLM 通过 `todo` 工具读写。
 *  - 工具执行结果总是回传完整 TodoListContext 快照，因此 LLM 无需依赖系统提示词
 *    就能在下一轮自然看到当前清单（绕过 ImmutablePrefix 冻结限制）。
 *  - 与 `task` 工具正交协作：todo 维护主 Agent 的计划，task 把单个 todo 分发给子代理执行。
 *  - 工具定义在 core 层声明；具体 handler 由 UI 层桥接到 zustand store，
 *    以便在主线程同步刷新 TaskChecklist 渲染。
 *  - 单工具 `todo` 替代之前的三工具（todo_write/todo_update/todo_complete）：
 *    · tasks 参数 → 全量覆盖（初始化 / re-plan）
 *    · updates 参数 → 批量部分更新（进度汇报 / 失败标记）
 *    · 标记任务 completed 时自动推进到下一个可执行任务
 */

import type { AgentTask, TaskStatus, TodoListContext, IToolDefinition } from '@codepapr/types';

export const DEFAULT_TODO_MAX_RETRIES = 3;

export const TODO_TOOL_NAME = 'todo' as const;

function normalizeId(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned || fallback;
}

function normalizeStringArray(value: unknown, max: number = 16): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, max);
}

function normalizeStatus(value: unknown): TaskStatus {
  if (value === 'pending' || value === 'running' || value === 'completed' || value === 'failed') {
    return value;
  }
  return 'pending';
}

interface RawTaskInput {
  id?: unknown;
  title?: unknown;
  description?: unknown;
  status?: unknown;
  dependsOn?: unknown;
  expectedArtifacts?: unknown;
  touchedArtifacts?: unknown;
  summary?: unknown;
  errorLog?: unknown;
  maxRetries?: unknown;
}

function normalizeTask(raw: RawTaskInput, index: number, existing?: AgentTask, defaultMaxRetries: number = DEFAULT_TODO_MAX_RETRIES): AgentTask {
  const title = typeof raw.title === 'string' ? raw.title.trim() : existing?.title ?? '';
  const description = typeof raw.description === 'string' ? raw.description.trim() : existing?.description ?? title;
  const id = normalizeId(raw.id, existing?.id ?? `task-${index + 1}`);
  const status = normalizeStatus(raw.status ?? existing?.status);
  const dependsOn = raw.dependsOn !== undefined ? normalizeStringArray(raw.dependsOn) : existing?.dependsOn ?? [];
  const expectedArtifacts = raw.expectedArtifacts !== undefined
    ? normalizeStringArray(raw.expectedArtifacts)
    : existing?.expectedArtifacts ?? [];
  const touchedArtifacts = raw.touchedArtifacts !== undefined
    ? normalizeStringArray(raw.touchedArtifacts)
    : existing?.touchedArtifacts ?? [];
  const summary = typeof raw.summary === 'string' && raw.summary.trim()
    ? raw.summary.trim()
    : existing?.summary;
  const errorLog = typeof raw.errorLog === 'string' && raw.errorLog.trim()
    ? raw.errorLog.trim()
    : existing?.errorLog;
  const maxRetries = typeof raw.maxRetries === 'number' && Number.isFinite(raw.maxRetries) && raw.maxRetries > 0
    ? Math.floor(raw.maxRetries)
    : existing?.maxRetries ?? defaultMaxRetries;

  return {
    id,
    title: title || `任务 ${index + 1}`,
    description: description || title || `任务 ${index + 1}`,
    status,
    dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
    expectedArtifacts: expectedArtifacts.length > 0 ? expectedArtifacts : undefined,
    touchedArtifacts: touchedArtifacts.length > 0 ? touchedArtifacts : undefined,
    summary,
    errorLog,
    retries: existing?.retries ?? 0,
    maxRetries,
  };
}

function computeAggregateStatus(tasks: AgentTask[]): 'active' | 'completed' {
  if (tasks.length === 0) {
    return 'active';
  }
  const allTerminal = tasks.every((task) => task.status === 'completed' || task.status === 'failed');
  return allTerminal ? 'completed' : 'active';
}

function inferCurrentTaskId(tasks: AgentTask[], previous: string | null): string | null {
  const running = tasks.find((task) => task.status === 'running');
  if (running) {
    return running.id;
  }
  if (previous && tasks.some((task) => task.id === previous && task.status !== 'completed' && task.status !== 'failed')) {
    return previous;
  }
  return null;
}

export function createEmptyTodoListContext(goal: string): TodoListContext {
  const now = Date.now();
  return {
    goal,
    tasks: [],
    currentTaskId: null,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 用一组完整的任务定义覆盖 / 初始化 TodoList。
 */
export function writeTodoList(
  previous: TodoListContext | null,
  goal: string,
  rawTasks: readonly RawTaskInput[],
  defaultMaxRetries: number = DEFAULT_TODO_MAX_RETRIES
): TodoListContext {
  const tasks = rawTasks.map((raw, index) => {
    const existing = previous?.tasks.find((task) =>
      typeof raw.id === 'string' && task.id === normalizeId(raw.id, '')
    );
    return normalizeTask(raw, index, existing, defaultMaxRetries);
  });

  return {
    goal: goal.trim() || previous?.goal || '',
    tasks,
    currentTaskId: inferCurrentTaskId(tasks, previous?.currentTaskId ?? null),
    status: computeAggregateStatus(tasks),
    createdAt: previous?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };
}

export interface TodoUpdatePatch {
  id: string;
  status?: TaskStatus;
  summary?: string;
  errorLog?: string;
  touchedArtifacts?: string[];
  /** 显式 +1 retries；用于 LLM 主动声明"我又试了一次"。 */
  bumpRetry?: boolean;
}

/**
 * 部分更新若干任务，标记 completed 时自动推进到下一个可执行任务。
 */
export function updateTodoList(
  previous: TodoListContext,
  patches: readonly TodoUpdatePatch[]
): TodoListContext {
  const tasks = previous.tasks.map((task) => {
    const patch = patches.find((p) => p.id === task.id);
    if (!patch) return task;

    let nextStatus = patch.status ?? task.status;
    let retries = task.retries ?? 0;
    let errorLog = task.errorLog;

    if (patch.bumpRetry === true) {
      retries += 1;
    }
    if (nextStatus === 'failed' && (task.status === 'running' || task.status === 'pending')) {
      retries += 1;
      const limit = task.maxRetries ?? DEFAULT_TODO_MAX_RETRIES;
      if (retries < limit) {
        nextStatus = 'pending';
      }
    }
    if (typeof patch.errorLog === 'string' && patch.errorLog.trim()) {
      errorLog = patch.errorLog.trim();
    }

    const touched = patch.touchedArtifacts !== undefined
      ? normalizeStringArray(patch.touchedArtifacts)
      : task.touchedArtifacts;

    return {
      ...task,
      status: nextStatus,
      summary: typeof patch.summary === 'string' && patch.summary.trim() ? patch.summary.trim() : task.summary,
      errorLog,
      touchedArtifacts: touched && touched.length > 0 ? touched : undefined,
      retries,
    };
  });

  // 自动推进：如果当前任务被标记为 completed，选择下一个 pending 且依赖已满足的任务
  const completedIds = new Set(
    tasks.filter((task) => task.status === 'completed').map((task) => task.id)
  );
  const newCurrentId = previous.currentTaskId
    && (
      tasks.some((task) => task.id === previous.currentTaskId && task.status === 'completed')
      || patches.some((p) => p.id === previous.currentTaskId)
    )
    ? inferNextTaskId(tasks, completedIds)
    : previous.currentTaskId;

  // 确保被自动推进选中的任务置为 running
  const finalTasks = newCurrentId !== previous.currentTaskId && newCurrentId
    ? tasks.map((task) =>
        task.id === newCurrentId ? { ...task, status: 'running' as TaskStatus } : task
      )
    : tasks;

  return {
    ...previous,
    tasks: finalTasks,
    currentTaskId: newCurrentId,
    status: computeAggregateStatus(finalTasks),
    updatedAt: Date.now(),
  };
}

function inferNextTaskId(tasks: AgentTask[], completedIds: Set<string>): string | null {
  const next = tasks.find((task) => {
    if (task.status !== 'pending') return false;
    if (!task.dependsOn || task.dependsOn.length === 0) return true;
    return task.dependsOn.every((depId) => completedIds.has(depId));
  });
  return next ? next.id : null;
}

/**
 * 标记当前任务完成并自动推进到下一条 pending（依赖已满足的）任务。
 * 保留此函数供测试兼容和外部调用。
 */
export function completeCurrentTodo(
  previous: TodoListContext,
  summary?: string,
  touchedArtifacts?: readonly string[]
): TodoListContext {
  const currentId = previous.currentTaskId;
  if (!currentId) {
    return previous;
  }
  return updateTodoList(previous, [
    {
      id: currentId,
      status: 'completed',
      summary,
      touchedArtifacts: touchedArtifacts ? [...touchedArtifacts] : undefined,
    },
  ]);
}

/**
 * 渲染 TodoList 摘要文本，作为工具返回值的一部分喂给 LLM。
 */
export function renderTodoListDigest(ctx: TodoListContext): string {
  if (ctx.tasks.length === 0) {
    return '[TodoList] 空。请用 todo 工具初始化计划（提供 tasks 参数进行全量覆盖）。';
  }
  const lines = [`[TodoList] 目标: ${ctx.goal || '(未设置)'}`];
  for (const task of ctx.tasks) {
    const flag =
      task.status === 'completed' ? '✓' :
      task.status === 'failed' ? '✗' :
      task.status === 'running' ? '▶' : '○';
    const retry = task.retries && task.retries > 0 ? ` (retry ${task.retries}/${task.maxRetries ?? DEFAULT_TODO_MAX_RETRIES})` : '';
    const focus = task.id === ctx.currentTaskId ? ' ← current' : '';
    lines.push(`  ${flag} ${task.id}: ${task.title}${retry}${focus}`);
    if (task.status === 'failed' && task.errorLog) {
      lines.push(`     err: ${task.errorLog.slice(0, 200)}`);
    }
  }
  return lines.join('\n');
}

// ── 统一 todo 工具定义 ──────────────────────────────────────────

export function buildTodoToolDefinition(): IToolDefinition {
  return {
    name: 'todo',
    description:
      '管理主 Agent 的任务清单（短期工作记忆），用于多步任务的规划、进度汇报和重规划。\n\n'
      + '两种调用模式（二选一）：\n'
      + '1. 提供 tasks 参数 → 全量覆盖任务列表（初始化或 re-plan）\n'
      + '2. 提供 updates 参数 → 部分更新一条或多条任务（标记进度/失败/完成）\n\n'
      + '自动推进：标记任务为 completed 时，系统自动将下一个 pending（依赖已满足）的任务置为 running。\n'
      + '与 task 工具的协作：todo 维护主 Agent 自己的计划；要委派给子代理执行，仍然调用 task。\n\n'
      + '每次调用返回完整 TodoList 快照，无需担心遗忘。',
    parameters: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: '（可选）更新用户目标描述。',
        },
        tasks: {
          type: 'array',
          description: '全量任务列表，覆盖整个 TodoList。用于初始化新计划或重新规划（re-plan）。每次调用会完全替换旧清单。与 updates 参数互斥。',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'kebab-case 唯一 ID，例如 add-auth-router。' },
              title: { type: 'string', description: '一行简述。' },
              description: { type: 'string', description: '完成标准（Definition of Done），尽量具体到文件或验证命令。' },
              dependsOn: {
                type: 'array',
                items: { type: 'string' },
                description: '依赖的前置任务 ID 列表；空表示无依赖。',
              },
              expectedArtifacts: {
                type: 'array',
                items: { type: 'string' },
                description: '预期产出文件路径，用于验证。',
              },
              maxRetries: {
                type: 'number',
                description: '允许的最大重试次数，默认 3。破坏性写入可调小。',
              },
            },
            required: ['title', 'description'],
          },
        },
        updates: {
          type: 'array',
          description: '部分更新一条或多条任务，不覆盖整个清单。常用：改 status（pending→running→completed/failed）、写 summary/errorLog、汇报 touchedArtifacts。标记完成时自动推进到下一个可执行任务。与 tasks 参数互斥。',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '要更新的任务 ID。' },
              status: {
                type: 'string',
                enum: ['pending', 'running', 'completed', 'failed'],
                description: '新状态。设为 completed 会自动推进到下一条任务。',
              },
              summary: { type: 'string', description: '完成或进展摘要。' },
              errorLog: { type: 'string', description: '失败时的错误说明，供后续 re-plan 参考。' },
              touchedArtifacts: {
                type: 'array',
                items: { type: 'string' },
                description: '该任务实际改动/新建的文件路径。',
              },
            },
            required: ['id'],
          },
        },
      },
    },
  };
}
