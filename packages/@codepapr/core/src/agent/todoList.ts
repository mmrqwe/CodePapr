/**
 * TodoList: 主 Agent 的"短期工作记忆"。
 *
 * 运行时规则只有三条：
 *  1. **创建是回合级事件**：每条用户消息开启一次创建窗口，`tasks` 全量覆盖
 *     消耗窗口；窗口关闭后的 `tasks` 调用被拒绝（状态零变化，回传当前快照）。
 *     追加对话是否建新清单由模型判断——上一回合清单未跑完就继续用 updates。
 *  2. **回合内一切变化走 `updates`**：改状态/摘要/错误说明，幂等，不受限。
 *  3. **光标纯推导**：currentTaskId 不存储推进历史，每次返回快照时从任务
 *     状态现算（有 running 即它；否则第一个依赖满足的 pending）。
 *
 * 其他要点：
 *  - 工具执行结果总是回传完整 TodoListContext 快照 + digest，LLM 无需依赖
 *    系统提示词就能在下一轮看到当前清单。
 *  - 与 `task` 工具正交：todo 维护主 Agent 的计划，task 委派子代理执行。
 *  - 工具定义与请求应用逻辑（applyTodoToolRequest）在 core 层声明为纯函数，
 *    桌面 handler 与 headless harness 共用，避免双实现漂移。
 */

import type { AgentTask, TaskStatus, TodoListContext, IToolDefinition } from '@codepapr/types';

export const TODO_TOOL_NAME = 'todo' as const;

/** tasks 调用撞上已关闭的创建窗口时，回传给模型的说明。 */
export const TODO_CREATE_REJECTED_NOTICE =
  '[todo] 本回合的任务清单已创建过，这次 tasks 全量覆盖被拒绝：清单保持原样。'
  + '请用 updates 推进现有任务（标记进度/完成/失败）；只有用户发来新消息才会再次开启创建窗口。'
  + '如果你发现当前清单确实不再适用于目标，把它写进本轮回答或对应任务的 summary，等下一条用户消息再重排。';

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
}

function normalizeTask(raw: RawTaskInput, index: number, existing?: AgentTask): AgentTask {
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
  };
}

function computeAggregateStatus(tasks: AgentTask[]): 'active' | 'completed' {
  if (tasks.length === 0) {
    return 'active';
  }
  const allTerminal = tasks.every((task) => task.status === 'completed' || task.status === 'failed');
  return allTerminal ? 'completed' : 'active';
}

/**
 * 光标纯推导：不存储、不推进、不继承——每次返回快照时从任务状态现算。
 * 有 running 任务则光标就是它；否则取第一个「pending 且依赖已满足」的任务；
 * 都没有则为 null。旧实现把光标做成可被 updates 弄丢的持久状态，模型被迫
 * 反复用 tasks 全量覆盖来"找回"锚点，是重排风暴的直接成因。
 */
export function inferCurrentTaskId(tasks: AgentTask[]): string | null {
  const running = tasks.find((task) => task.status === 'running');
  if (running) {
    return running.id;
  }
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

/**
 * 用一组完整的任务定义覆盖 / 初始化 TodoList。
 * 仅由 applyTodoToolRequest 在创建窗口开启时调用（每个用户回合至多一次）。
 *
 * 继承边界：只有**目标未变**（同一计划的续用 / 重排）才沿用同 id 任务的
 * 状态与 summary；目标已变（新用户消息带来新目标）＝ 全新清单，全部从
 * pending 起步、createdAt 重算。否则上一轮的 `✓ verify` 会原样出现在新
 * 目标的清单里（iPod 会话事故：新目标创建时末项验证已打勾，模型数分钟后
 * 才手动改回 pending）。新目标下确需保留完成态的任务，显式传 status。
 */
export function writeTodoList(
  previous: TodoListContext | null,
  goal: string,
  rawTasks: readonly RawTaskInput[]
): TodoListContext {
  const resolvedGoal = goal.trim() || previous?.goal || '';
  const inheritable = previous && resolvedGoal === previous.goal ? previous : null;
  const tasks = rawTasks.map((raw, index) => {
    const existing = inheritable?.tasks.find((task) =>
      typeof raw.id === 'string' && task.id === normalizeId(raw.id, '')
    );
    return normalizeTask(raw, index, existing);
  });

  return {
    goal: resolvedGoal,
    tasks,
    currentTaskId: inferCurrentTaskId(tasks),
    status: computeAggregateStatus(tasks),
    createdAt: inheritable ? inheritable.createdAt : Date.now(),
    updatedAt: Date.now(),
  };
}

export interface TodoUpdatePatch {
  id: string;
  status?: TaskStatus;
  summary?: string;
  errorLog?: string;
  touchedArtifacts?: string[];
}

/**
 * 解析 LLM 传入的 todo 工具参数（桌面 handler 与 headless harness 共用）。
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
 * 部分更新若干任务。状态字段完全由模型声明（允许把 completed 改回
 * pending/running 表示重开工作——这是诚实汇报，不是需要系统兜底的异常）。
 * 光标在返回前纯推导，不做任何"自动推进"。
 */
export function updateTodoList(
  previous: TodoListContext,
  patches: readonly TodoUpdatePatch[]
): TodoListContext {
  if (patches.length === 0) {
    return previous;
  }
  const tasks = previous.tasks.map((task) => {
    const patch = patches.find((p) => p.id === task.id);
    if (!patch) return task;

    const touched = patch.touchedArtifacts !== undefined
      ? normalizeStringArray(patch.touchedArtifacts)
      : task.touchedArtifacts;

    return {
      ...task,
      status: patch.status ?? task.status,
      summary: typeof patch.summary === 'string' && patch.summary.trim() ? patch.summary.trim() : task.summary,
      errorLog: typeof patch.errorLog === 'string' && patch.errorLog.trim() ? patch.errorLog.trim() : task.errorLog,
      touchedArtifacts: touched && touched.length > 0 ? touched : undefined,
    };
  });

  return {
    ...previous,
    tasks,
    currentTaskId: inferCurrentTaskId(tasks),
    status: computeAggregateStatus(tasks),
    updatedAt: Date.now(),
  };
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
    currentTaskId: inferCurrentTaskId(tasks),
    status: computeAggregateStatus(tasks),
    updatedAt: Date.now(),
  };
}

/**
 * 清单是否仍有未终结任务——压缩检查点决定是否携带「权威状态」分区的判定条件。
 * null / 空清单 / 已 completed 均返回 false。
 */
export function hasUnsettledTodoTasks(ctx: TodoListContext | null | undefined): boolean {
  if (!ctx || ctx.status !== 'active') return false;
  return ctx.tasks.some((task) => task.status === 'running' || task.status === 'pending');
}

/**
 * 渲染 TodoList 摘要文本，作为工具返回值的一部分喂给 LLM。
 */
export function renderTodoListDigest(ctx: TodoListContext): string {
  if (ctx.tasks.length === 0) {
    return '[TodoList] 空。请在本回合的创建窗口内用 todo 工具的 tasks 参数初始化计划。';
  }
  const lines = [`[TodoList] 目标: ${ctx.goal || '(未设置)'}`];
  for (const task of ctx.tasks) {
    const flag =
      task.status === 'completed' ? '✓' :
      task.status === 'failed' ? '✗' :
      task.status === 'running' ? '▶' : '○';
    const focus = task.id === ctx.currentTaskId ? ' ← current' : '';
    lines.push(`  ${flag} ${task.id}: ${task.title}${focus}`);
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
      '管理主 Agent 的任务清单（短期工作记忆）。\n\n'
      + '两种调用模式（二选一）：\n'
      + '1. tasks 参数 → 创建任务清单（全量覆盖）。**每个用户回合至多一次**：'
      + '本回合已经创建过（或旧清单仍然有效）时，再发 tasks 会被直接拒绝，清单保持原样。\n'
      + '2. updates 参数 → 部分更新已有任务（进度/完成/失败/重开），回合内不限次数。\n\n'
      + '纪律：新消息带来全新目标时才创建清单；同一目标继续推进时沿用现有清单的 id，'
      + '用 updates 更新状态（completed 可改回 pending/running 表示重开工作，这是允许的诚实汇报）。'
      + '任务状态变化后 current 标记由系统自动重算，无需（也无法）手动设置。'
      + '与 task 工具正交：todo 维护主 Agent 自己的计划；委派子代理执行调用 task。\n\n'
      + '每次调用返回完整 TodoList 快照 + digest，无需担心遗忘，更不要为了"确认状态"重复调用。',
    parameters: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: '（可选）本回合目标描述；创建时缺省用用户消息填充。',
        },
        tasks: {
          type: 'array',
          description:
            '创建任务清单（全量覆盖），每个用户回合至多一次。目标与上一版清单相同（续用/重排'
            + '同一计划）时，同 id 任务保留其状态与 summary；目标已变化（新用户消息＝新目标）'
            + '时全部从 pending 起步，需要保留完成态的任务请显式传 status。与 updates 参数互斥。',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'kebab-case 唯一 ID，例如 add-auth-router。' },
              title: { type: 'string', description: '一行简述。' },
              description: { type: 'string', description: '完成标准（Definition of Done），尽量具体到文件或验证命令。' },
              status: {
                type: 'string',
                enum: ['pending', 'running', 'completed', 'failed'],
                description: '（可选，一般不填）显式初始状态；新目标创建时只有这里声明的状态会被采用。',
              },
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
            },
            required: ['title', 'description'],
          },
        },
        updates: {
          type: 'array',
          description:
            '部分更新一条或多条已有任务，不增删任务、不覆盖清单。'
            + '常用：改 status（pending/running/completed/failed）、写 summary/errorLog、汇报 touchedArtifacts。'
            + '与 tasks 参数互斥。',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '要更新的任务 ID。' },
              status: {
                type: 'string',
                enum: ['pending', 'running', 'completed', 'failed'],
                description: '新状态（如实反映即可，current 由系统派生）。',
              },
              summary: { type: 'string', description: '完成或进展摘要。' },
              errorLog: { type: 'string', description: '失败或重开的说明，供后续回合参考。' },
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

// ── 请求应用（桌面 handler 与 headless harness 共用的唯一实现）────

export interface TodoToolRequestResult {
  /** 处理后的清单快照。rejected 时为原样返回（引用不变或空清单）。 */
  ctx: TodoListContext;
  /** 本次调用创建（全量覆盖）了清单，已消耗本回合创建窗口。 */
  created: boolean;
  /** 本次 tasks 调用因创建窗口已关闭而被拒绝。 */
  rejected: boolean;
}

/**
 * 应用一次 todo 工具请求（纯函数，不产生副作用）。
 *
 * @param previous 当前清单（可为 null）
 * @param args     模型传入的工具参数（goal / tasks / updates）
 * @param opts.creationOpen 本用户回合的创建窗口是否尚未被消耗
 * @param opts.defaultGoal  创建时 goal 缺省的兜底文本（通常是本条用户消息）
 */
export function applyTodoToolRequest(
  previous: TodoListContext | null,
  args: Record<string, unknown>,
  opts: { creationOpen: boolean; defaultGoal: string }
): TodoToolRequestResult {
  const goal = parseTodoGoal(args.goal, opts.defaultGoal);

  if (Array.isArray(args.tasks)) {
    if (!opts.creationOpen) {
      return {
        ctx: previous ?? createEmptyTodoListContext(goal),
        created: false,
        rejected: true,
      };
    }
    const next = writeTodoList(previous, goal, args.tasks as RawTaskInput[]);
    return { ctx: next, created: true, rejected: false };
  }

  if (Array.isArray(args.updates)) {
    if (!previous) {
      // updates 不能凭空造清单——引导模型走创建路径。
      return { ctx: createEmptyTodoListContext(goal), created: false, rejected: false };
    }
    const patches = parseTodoUpdatePatches(args.updates);
    let next = patches.length > 0 ? updateTodoList(previous, patches) : previous;
    if (goal && goal !== next.goal) {
      next = { ...next, goal, updatedAt: Date.now() };
    }
    return { ctx: next, created: false, rejected: false };
  }

  // 无 tasks 无 updates：仅更新 goal（若提供）。
  if (previous) {
    if (goal && goal !== previous.goal) {
      return {
        ctx: { ...previous, goal, updatedAt: Date.now() },
        created: false,
        rejected: false,
      };
    }
    return { ctx: previous, created: false, rejected: false };
  }
  return { ctx: createEmptyTodoListContext(goal), created: false, rejected: false };
}
