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
  // 兜底：没有任何 running 任务时，把指针放到第一个「pending 且依赖已满足」的
  // 任务上。旧实现只认 running，all-pending 初始化后 currentTaskId 永远是 null，
  // 导致「标记 completed 自动推进」的链路永远走不到（死代码）。
  const completedIds = new Set(
    tasks.filter((task) => task.status === 'completed').map((task) => task.id)
  );
  const firstRunnable = tasks.find((task) => {
    if (task.status !== 'pending') return false;
    if (!task.dependsOn || task.dependsOn.length === 0) return true;
    return task.dependsOn.every((depId) => completedIds.has(depId));
  });
  return firstRunnable ? firstRunnable.id : null;
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

/** 一次 tasks 全量覆盖相对旧清单的「进度影响」评估（护栏与诊断用）。 */
export interface TodoReplanImpact {
  /** 是否为重建（旧清单存在且有任务）。false = 首次初始化。 */
  isReplan: boolean;
  /** 新清单里按 id 延续下来的旧任务。 */
  keptIds: string[];
  /** 被丢弃的已完成任务（进度证据就此消失）。 */
  droppedCompleted: AgentTask[];
  /** 被丢弃的未终结任务（running/pending/failed）。 */
  droppedUnsettled: number;
  /** 与旧清单毫无 id 交集的重建（最可疑：多半是压缩后模型丢了计划又重排）。 */
  isFullReset: boolean;
}

export function evaluateTodoReplan(
  previous: TodoListContext | null,
  rawTasks: readonly RawTaskInput[]
): TodoReplanImpact {
  const empty: TodoReplanImpact = {
    isReplan: false,
    keptIds: [],
    droppedCompleted: [],
    droppedUnsettled: 0,
    isFullReset: false,
  };
  if (!previous || previous.tasks.length === 0) return empty;

  const nextIds = new Set(
    rawTasks
      .map((raw) => (typeof raw.id === 'string' ? normalizeId(raw.id, '') : ''))
      .filter(Boolean)
  );
  const keptIds = previous.tasks
    .filter((task) => nextIds.has(task.id))
    .map((task) => task.id);
  const dropped = previous.tasks.filter((task) => !nextIds.has(task.id));
  const droppedCompleted = dropped.filter((task) => task.status === 'completed');
  const droppedUnsettled = dropped.filter(
    (task) => task.status !== 'completed' && task.status !== 'failed'
  ).length;

  return {
    isReplan: true,
    keptIds,
    droppedCompleted,
    droppedUnsettled,
    isFullReset: keptIds.length === 0,
  };
}

/** 把重建影响写成一行给模型看的告警；无需告警时返回 undefined。 */
export function describeTodoReplanImpact(impact: TodoReplanImpact): string | undefined {
  if (!impact.isReplan) return undefined;
  const parts: string[] = [];
  if (impact.droppedCompleted.length > 0) {
    const ids = impact.droppedCompleted.map((task) => task.id).slice(0, 8).join(', ');
    parts.push(
      `丢弃了 ${impact.droppedCompleted.length} 项已完成任务的进度（${ids}）`
    );
  }
  if (impact.droppedUnsettled > 0) {
    parts.push(`丢弃了 ${impact.droppedUnsettled} 项仍在进行的任务`);
  }
  if (impact.isFullReset) {
    parts.push('新清单与旧清单没有任何 id 交集（完全重排）');
  }
  if (parts.length === 0) return undefined;
  return (
    `[re-plan 警告] 本次 tasks 全量覆盖${parts.join('；')}。` +
    '如果目标没有变化（例如只是上下文被压缩、你没看到旧清单），' +
    '请不要重建计划：用同一批 id 重新提交 tasks，或改用 updates 继续推进原清单。'
  );
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

  const impact = evaluateTodoReplan(previous, rawTasks);
  const dropsProgress =
    impact.isReplan && (impact.droppedCompleted.length > 0 || impact.droppedUnsettled > 0);

  return {
    goal: goal.trim() || previous?.goal || '',
    tasks,
    currentTaskId: inferCurrentTaskId(tasks, previous?.currentTaskId ?? null),
    status: computeAggregateStatus(tasks),
    createdAt: previous?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    // 只有真的丢掉进度才计数（首次初始化、以及只改措辞的同 id 重排不计），
    // 供 UI/eval 观察「一个回合内反复重排」这类失控模式。
    ...(dropsProgress
      ? { replanCount: (previous?.replanCount ?? 0) + 1 }
      : previous?.replanCount !== undefined
        ? { replanCount: previous.replanCount }
        : {}),
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
 * 解析 LLM 传入的 todo 工具参数（桌面 handler 与 headless harness 共用）。
 * 语义与 todoListTool 的旧内联实现一致：仅接受非空 id 的 patch。
 */
export function parseTodoUpdatePatches(rawUpdates: unknown): TodoUpdatePatch[] {
  if (!Array.isArray(rawUpdates)) return [];
  return rawUpdates
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .map((item) => ({
      id: typeof item.id === 'string' ? item.id.trim() : '',
      status: typeof item.status === 'string' ? (item.status as TaskStatus) : undefined,
      summary: typeof item.summary === 'string' ? item.summary : undefined,
      errorLog: typeof item.errorLog === 'string' ? item.errorLog : undefined,
      touchedArtifacts: Array.isArray(item.touchedArtifacts)
        ? (item.touchedArtifacts.filter((p): p is string => typeof p === 'string'))
        : undefined,
    }))
    .filter((patch) => patch.id);
}

export function parseTodoGoal(rawGoal: unknown, defaultGoal: string): string {
  return typeof rawGoal === 'string' && rawGoal.trim() ? rawGoal.trim() : defaultGoal;
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

    // 同一次更新里 bumpRetry 与 failed 转换只计一次重试：旧实现两者同时出现
    // 会 +2，提前耗尽 maxRetries。
    const failedTransition =
      nextStatus === 'failed' && (task.status === 'running' || task.status === 'pending');
    if (patch.bumpRetry === true || failedTransition) {
      retries += 1;
    }
    if (failedTransition) {
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

  // 自动推进：仅当「当前任务被标记为 completed」时才选择下一个 pending
  // （依赖已满足）的任务。旧实现加了 `|| patches.some(p => p.id ===
  // previous.currentTaskId)`：任何触及当前任务的 patch（哪怕只是汇报进度、
  // 状态仍为 running）都会触发推进——产生两个 running 任务，且指针跳到
  // 尚未开始的工作上。
  const completedIds = new Set(
    tasks.filter((task) => task.status === 'completed').map((task) => task.id)
  );
  const newCurrentId = previous.currentTaskId &&
    tasks.some((task) => task.id === previous.currentTaskId && task.status === 'completed')
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
 * 回合结束兜底提醒（临时 user 消息注入 Agent 日志，仅用于促使模型在收尾前
 * 同步任务清单；不进入主线程持久化的转录）。
 */
export const TODO_GUARD_NUDGE =
  '你正试图结束回合，但任务清单仍有未进入终态的任务（running/pending）。'
  + '请立即调用 todo 工具（updates）同步清单：实际已完成的任务改 completed 并附 summary；'
  + '确认放弃的改 failed 并附 errorLog；确实仍在进行的保持不动并简述原因。'
  + '清单与真实进度脱节会让后续回合误判工作状态。';

/**
 * 清单是否仍有未终结任务——回合结束前 guard 的判定条件。
 * null / 空清单 / 已 completed 均返回 false。
 */
export function hasUnsettledTodoTasks(ctx: TodoListContext | null | undefined): boolean {
  if (!ctx || ctx.status !== 'active') return false;
  return ctx.tasks.some((task) => task.status === 'running' || task.status === 'pending');
}

/**
 * 收敛未确认的 running 任务：回合结束（正常/取消/出错）或会话恢复时，若清单
 * 仍 active 且有 running 任务，说明模型忘了调用 todo 工具同步——running 是
 * "正在执行"的承诺，而没有在飞回合就不可能"正在执行"。诚实策略：退回
 * pending 并写 errorLog 标记未确认，绝不伪造 completed（完成与否交由下一
 * 回合的模型或用户根据 digest 核对）。无 running 任务时原样返回（同引用）。
 */
export function convergeUnconfirmedRunningTasks(
  ctx: TodoListContext,
  reason: string = '回合结束未确认'
): TodoListContext {
  if (!ctx.tasks.some((task) => task.status === 'running')) {
    return ctx;
  }
  const tasks = ctx.tasks.map((task) =>
    task.status === 'running'
      ? { ...task, status: 'pending' as TaskStatus, errorLog: reason }
      : task
  );
  return {
    ...ctx,
    tasks,
    currentTaskId: inferCurrentTaskId(tasks, ctx.currentTaskId),
    status: computeAggregateStatus(tasks),
    updatedAt: Date.now(),
  };
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
      + 're-plan 纪律：一个目标只规划一次。看到「当前任务清单（权威状态）」分区时，那就是仍在生效的计划，'
      + '请沿用其中的 id 用 updates 推进；只有用户目标改变时才用 tasks 重建。\n\n'
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
          description:
            '全量任务列表，覆盖整个 TodoList。用于初始化新计划，或**用户目标真的变了**时的重新规划（re-plan）。'
            + '每次调用会完全替换旧清单：未在新清单里复现的 id，其已完成/进行中进度会丢失'
            + '（沿用同 id 的任务会保留状态与 summary）。上下文被压缩过、你只是看不到旧清单时'
            + '**不要**重建计划——按检查点里的「当前任务清单（权威状态）」用 updates 继续推进。'
            + '与 updates 参数互斥。',
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
