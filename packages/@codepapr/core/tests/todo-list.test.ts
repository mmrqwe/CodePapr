import { describe, expect, it } from 'vitest';
import {
  createEmptyTodoListContext,
  writeTodoList,
  updateTodoList,
  completeCurrentTodo,
  renderTodoListDigest,
  buildTodoToolDefinition,
  DEFAULT_TODO_MAX_RETRIES,
  TODO_TOOL_NAME,
} from '../src/agent/todoList';
import type { TodoListContext, AgentTask } from '@codepapr/types';

describe('createEmptyTodoListContext', () => {
  it('应创建空 TodoListContext', () => {
    const ctx = createEmptyTodoListContext('修复登录 bug');
    expect(ctx.goal).toBe('修复登录 bug');
    expect(ctx.tasks).toEqual([]);
    expect(ctx.currentTaskId).toBeNull();
    expect(ctx.status).toBe('active');
    expect(ctx.createdAt).toBeGreaterThan(0);
    expect(ctx.updatedAt).toBe(ctx.createdAt);
  });
});

describe('writeTodoList', () => {
  it('应初始化 TodoList（首次创建）', () => {
    const ctx = writeTodoList(null, '实现用户注册', [
      { id: 'add-route', title: '添加路由', description: '在 router.ts 中添加 /register 路由' },
      { id: 'add-form', title: '添加表单组件', description: '创建 RegisterForm.tsx' },
    ]);

    expect(ctx.goal).toBe('实现用户注册');
    expect(ctx.tasks).toHaveLength(2);
    expect(ctx.tasks[0]!.id).toBe('add-route');
    expect(ctx.tasks[0]!.title).toBe('添加路由');
    expect(ctx.tasks[0]!.status).toBe('pending');
    expect(ctx.status).toBe('active');
  });

  it('应覆盖已有 TodoList（re-plan）', () => {
    const first = writeTodoList(null, '修复 bug', [
      { id: 'fix-1', title: '修复 bug 1', description: '' },
    ]);
    const second = writeTodoList(first, '重构模块', [
      { id: 'refactor-1', title: '重构 A', description: '' },
      { id: 'refactor-2', title: '重构 B', description: '' },
    ]);

    expect(second.goal).toBe('重构模块');
    expect(second.tasks).toHaveLength(2);
    expect(second.createdAt).toBe(first.createdAt); // 保留原创建时间
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
  });

  it('re-plan 时应保留已有任务的信息（id 匹配）', () => {
    const first = writeTodoList(null, '初始计划', [
      { id: 'task-a', title: '任务 A', description: 'desc A' },
      { id: 'task-b', title: '任务 B', description: 'desc B' },
    ]);

    const second = writeTodoList(first, '更新计划', [
      { id: 'task-a', title: '任务 A 更新', description: '新 desc', status: 'completed' as const },
      { id: 'task-c', title: '新任务 C', description: 'desc C' },
    ]);

    expect(second.tasks).toHaveLength(2);
    expect(second.tasks.find((t) => t.id === 'task-a')!.status).toBe('completed');
    expect(second.tasks.find((t) => t.id === 'task-a')!.title).toBe('任务 A 更新');
    expect(second.tasks.find((t) => t.id === 'task-c')).toBeDefined();
  });

  it('应推断当前任务（running 优先）', () => {
    const ctx = writeTodoList(null, 'test', [
      { id: 't1', title: 'T1', description: '', status: 'pending' as const },
      { id: 't2', title: 'T2', description: '', status: 'running' as const },
      { id: 't3', title: 'T3', description: '', status: 'pending' as const },
    ]);

    expect(ctx.currentTaskId).toBe('t2');
  });

  it('应正确处理依赖和预期产出', () => {
    const ctx = writeTodoList(null, '复杂任务', [
      {
        id: 'setup-db',
        title: '初始化数据库',
        description: '',
        expectedArtifacts: ['db/schema.sql'],
      },
      {
        id: 'add-api',
        title: '添加 API',
        description: '',
        dependsOn: ['setup-db'],
        expectedArtifacts: ['src/api/users.ts'],
      },
    ]);

    expect(ctx.tasks[0]!.dependsOn).toBeUndefined();
    expect(ctx.tasks[0]!.expectedArtifacts).toEqual(['db/schema.sql']);
    expect(ctx.tasks[1]!.dependsOn).toEqual(['setup-db']);
    expect(ctx.tasks[1]!.expectedArtifacts).toEqual(['src/api/users.ts']);
  });
});

describe('updateTodoList', () => {
  function makeContext(tasks: Array<{ id: string; status: AgentTask['status'] }>, goal?: string): TodoListContext {
    return writeTodoList(null, goal ?? 'test', tasks.map((t) => ({
      id: t.id,
      title: t.id,
      description: '',
      status: t.status,
    })));
  }

  it('应更新单个任务状态', () => {
    const ctx = makeContext([{ id: 'a', status: 'pending' }, { id: 'b', status: 'pending' }]);
    const updated = updateTodoList(ctx, [{ id: 'a', status: 'running' }]);

    expect(updated.tasks.find((t) => t.id === 'a')!.status).toBe('running');
    expect(updated.tasks.find((t) => t.id === 'b')!.status).toBe('pending');
  });

  it('应更新任务 summary', () => {
    const ctx = makeContext([{ id: 'a', status: 'pending' }]);
    const updated = updateTodoList(ctx, [{ id: 'a', status: 'completed', summary: '完成!' }]);

    expect(updated.tasks.find((t) => t.id === 'a')!.summary).toBe('完成!');
  });

  it('应更新 errorLog', () => {
    const ctx = makeContext([{ id: 'a', status: 'running' }]);
    const updated = updateTodoList(ctx, [{ id: 'a', status: 'failed', errorLog: '类型错误: x is not T' }]);

    const task = updated.tasks.find((t) => t.id === 'a')!;
    expect(task.errorLog).toBe('类型错误: x is not T');
  });

  it('应更新 touchedArtifacts', () => {
    const ctx = makeContext([{ id: 'a', status: 'running' }]);
    const updated = updateTodoList(ctx, [{ id: 'a', touchedArtifacts: ['src/a.ts', 'src/b.ts'] }]);

    expect(updated.tasks.find((t) => t.id === 'a')!.touchedArtifacts).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('标记 completed 应自动推进到下一个 pending（无依赖）', () => {
    const ctx = makeContext([
      { id: 'a', status: 'running' },
      { id: 'b', status: 'pending' },
      { id: 'c', status: 'pending' },
    ]);
    const updated = updateTodoList(ctx, [{ id: 'a', status: 'completed' }]);

    expect(updated.tasks.find((t) => t.id === 'a')!.status).toBe('completed');
    expect(updated.tasks.find((t) => t.id === 'b')!.status).toBe('running');
    expect(updated.currentTaskId).toBe('b');
  });

  it('标记 completed 时应跳过依赖未满足的任务', () => {
    const ctx = writeTodoList(null, 'test', [
      { id: 'a', title: 'A', description: '', status: 'running' as const },
      { id: 'b', title: 'B', description: '', status: 'pending' as const, dependsOn: ['c'] },
      { id: 'c', title: 'C', description: '', status: 'pending' as const },
    ]);
    const updated = updateTodoList(ctx, [{ id: 'a', status: 'completed' as const }]);

    // B 依赖 C（C 未完成），应跳过 B，选择 C
    expect(updated.currentTaskId).toBe('c');
    expect(updated.tasks.find((t) => t.id === 'c')!.status).toBe('running');
    expect(updated.tasks.find((t) => t.id === 'b')!.status).toBe('pending');
  });

  it('所有任务完成时应置 status 为 completed', () => {
    const ctx = writeTodoList(null, 'test', [
      { id: 'a', title: 'A', description: '', status: 'completed' as const },
      { id: 'b', title: 'B', description: '', status: 'running' as const },
    ]);
    const updated = updateTodoList(ctx, [{ id: 'b', status: 'completed' as const }]);

    expect(updated.status).toBe('completed');
    expect(updated.currentTaskId).toBeNull();
  });

  it('失败任务应自动重试（retries 计数）', () => {
    const ctx = makeContext([{ id: 'a', status: 'running' }]);
    const updated = updateTodoList(ctx, [{ id: 'a', status: 'failed' }]);

    const task = updated.tasks.find((t) => t.id === 'a')!;
    expect(task.status).toBe('pending'); // 降级为 pending 允许重试
    expect(task.retries).toBe(1);
  });

  it('达到 maxRetries 后应真正 failed', () => {
    let ctx = makeContext([{ id: 'a', status: 'running' }]);
    // 手动设置 retries 接近上限（2 次失败，下次触发上限 3）
    ctx = {
      ...ctx,
      tasks: ctx.tasks.map((t) => (t.id === 'a' ? { ...t, retries: 2, maxRetries: 3 } : t)),
    };
    const updated = updateTodoList(ctx, [{ id: 'a', status: 'failed' }]);

    const task = updated.tasks.find((t) => t.id === 'a')!;
    // retries: 2 → +1 = 3, maxRetries = 3, 3 < 3 → false → 真正 failed
    expect(task.status).toBe('failed');
    expect(task.retries).toBe(3);
  });

  it('同时更新多条任务', () => {
    const ctx = makeContext([{ id: 'a', status: 'pending' }, { id: 'b', status: 'pending' }]);
    const updated = updateTodoList(ctx, [
      { id: 'a', status: 'running' },
      { id: 'b', status: 'completed' },
    ]);

    expect(updated.tasks.find((t) => t.id === 'a')!.status).toBe('running');
    expect(updated.tasks.find((t) => t.id === 'b')!.status).toBe('completed');
  });
});

describe('completeCurrentTodo', () => {
  it('应标记当前任务完成并自动推进', () => {
    const ctx = createInitialPlan();
    const completed = completeCurrentTodo(ctx, '路由添加完成');

    const routeTask = completed.tasks.find((t) => t.id === 'add-route')!;
    expect(routeTask.status).toBe('completed');
    expect(routeTask.summary).toBe('路由添加完成');
    expect(completed.currentTaskId).toBe('add-form');
    expect(completed.tasks.find((t) => t.id === 'add-form')!.status).toBe('running');
  });

  it('无 currentTaskId 时应返回原 context', () => {
    const ctx = createEmptyTodoListContext('test');
    const result = completeCurrentTodo(ctx);
    expect(result).toBe(ctx);
  });
});

describe('renderTodoListDigest', () => {
  it('空清单应提示初始化', () => {
    const ctx = createEmptyTodoListContext('test');
    expect(renderTodoListDigest(ctx)).toContain('空');
    expect(renderTodoListDigest(ctx)).toContain('todo');
  });

  it('应渲染完整摘要', () => {
    const ctx = createInitialPlan();
    const digest = renderTodoListDigest(ctx);

    expect(digest).toContain('添加用户注册功能');
    expect(digest).toContain('add-route');
    expect(digest).toContain('add-form');
    expect(digest).toContain('○'); // pending 标记
    expect(digest).toContain('current'); // add-route 应为当前
  });

  it('应渲染失败任务的错误日志', () => {
    const ctx = createFailedPlan();
    const digest = renderTodoListDigest(ctx);

    expect(digest).toContain('✗');
    expect(digest).toContain('类型错误');
  });
});

describe('buildTodoToolDefinition', () => {
  it('应生成单个 todo 工具定义', () => {
    const def = buildTodoToolDefinition();

    expect(def.name).toBe(TODO_TOOL_NAME);
    expect(def).toHaveProperty('description');
    expect(def).toHaveProperty('parameters');
    expect(def.parameters.type).toBe('object');
    expect(def.parameters.properties).toHaveProperty('tasks');
    expect(def.parameters.properties).toHaveProperty('updates');
    expect(def.parameters.properties).toHaveProperty('goal');
  });

  it('tasks 数组的 required 字段应包含 title 和 description', () => {
    const def = buildTodoToolDefinition();
    const tasksSchema = def.parameters.properties.tasks;

    expect(tasksSchema.type).toBe('array');
    const tasksItems = (tasksSchema as { items: { required: string[] } }).items;
    expect(tasksItems.required).toContain('title');
    expect(tasksItems.required).toContain('description');
  });

  it('updates 数组的 required 字段应包含 id', () => {
    const def = buildTodoToolDefinition();
    const updatesSchema = def.parameters.properties.updates;

    expect(updatesSchema.type).toBe('array');
    const updatesItems = (updatesSchema as { items: { required: string[] } }).items;
    expect(updatesItems.required).toContain('id');
  });
});

describe('DEFAULT_TODO_MAX_RETRIES', () => {
  it('默认最大重试次数应为 3', () => {
    expect(DEFAULT_TODO_MAX_RETRIES).toBe(3);
  });
});

// ── Helpers ──────────────────────────────────────────────────────

function createInitialPlan(): TodoListContext {
  return writeTodoList(null, '添加用户注册功能', [
    {
      id: 'add-route',
      title: '添加注册路由',
      description: '在 router.ts 中添加 POST /register',
      status: 'running' as const,
    },
    {
      id: 'add-form',
      title: '添加注册表单',
      description: '创建 RegisterForm.tsx 组件',
      dependsOn: ['add-route'],
    },
    {
      id: 'validate-input',
      title: '添加输入校验',
      description: '在 RegisterForm 中添加邮箱和密码校验',
      dependsOn: ['add-form'],
    },
  ]);
}

function createFailedPlan(): TodoListContext {
  const ctx = createInitialPlan();
  // 手动标记第一个任务为失败且已耗尽重试
  let updated = updateTodoList(ctx, [
    {
      id: 'add-route',
      status: 'failed',
      errorLog: '类型错误: route handler 参数不匹配',
    },
  ]);
  // 再失败两次使其耗尽重试（默认 maxRetries=3）
  updated = updateTodoList(updated, [{ id: 'add-route', status: 'failed' }]);
  updated = updateTodoList(updated, [{ id: 'add-route', status: 'failed' }]);
  return updated;
}
