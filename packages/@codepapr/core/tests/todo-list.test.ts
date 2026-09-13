import { describe, expect, it, vi } from 'vitest';
import {
  TODO_CREATE_REJECTED_NOTICE,
  applyTodoToolRequest,
  buildTodoToolDefinition,
  convergeUnconfirmedRunningTasks,
  createEmptyTodoListContext,
  hasUnsettledTodoTasks,
  inferCurrentTaskId,
  renderTodoListDigest,
  updateTodoList,
  writeTodoList,
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

describe('writeTodoList（创建路径，窗口纪律由 applyTodoToolRequest 把关）', () => {
  it('应初始化 TodoList（首次创建）', () => {
    const ctx = writeTodoList(null, '实现用户注册', [
      { id: 'add-route', title: '添加路由', description: '在 router.ts 中添加 /register 路由' },
      { id: 'add-form', title: '添加表单组件', description: '创建 RegisterForm.tsx' },
    ]);

    expect(ctx.goal).toBe('实现用户注册');
    expect(ctx.tasks).toHaveLength(2);
    expect(ctx.tasks[0]!.id).toBe('add-route');
    expect(ctx.tasks[0]!.status).toBe('pending');
    expect(ctx.status).toBe('active');
    // all-pending：光标纯推导指向第一个可执行任务
    expect(ctx.currentTaskId).toBe('add-route');
  });

  it('创建时 goal 缺省回退旧清单 goal，createdAt 保留', () => {
    const first = writeTodoList(null, '修复 bug', [
      { id: 'fix-1', title: '修复 bug 1', description: '' },
    ]);
    const second = writeTodoList(first, '', [
      { id: 'fix-2', title: '修复 bug 2', description: '' },
    ]);

    expect(second.goal).toBe('修复 bug');
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('同目标续用：同 id 任务保留状态与 summary（不丢进度证据）', () => {
    const first = writeTodoList(null, '初始计划', [
      { id: 'task-a', title: '任务 A', description: 'desc A' },
    ]);
    const advanced = updateTodoList(first, [{ id: 'task-a', status: 'completed', summary: '做完了' }]);

    const recreated = writeTodoList(advanced, '初始计划', [
      { id: 'task-a', title: '任务 A 更新', description: '新 desc' },
      { id: 'task-c', title: '新任务 C', description: 'desc C' },
    ]);

    expect(recreated.tasks.find((t) => t.id === 'task-a')!.status).toBe('completed');
    expect(recreated.tasks.find((t) => t.id === 'task-a')!.summary).toBe('做完了');
    expect(recreated.tasks.find((t) => t.id === 'task-a')!.title).toBe('任务 A 更新');
    expect(recreated.tasks.find((t) => t.id === 'task-c')!.status).toBe('pending');
  });

  it('新目标创建：同 id 任务不继承状态/摘要（verify 不得开局即勾选）', () => {
    const first = writeTodoList(null, '播客目标', [
      { id: 'verify', title: '验证', description: '' },
    ]);
    const done = updateTodoList(first, [
      { id: 'verify', status: 'completed', summary: '上一轮验证完成' },
    ]);

    const recreated = writeTodoList(done, '歌词 + 灵动岛新目标', [
      { id: 'verify', title: '验证', description: '' },
    ]);

    const verify = recreated.tasks[0]!;
    expect(verify.status).toBe('pending');
    expect(verify.summary).toBeUndefined();
    expect(verify.errorLog).toBeUndefined();
    expect(recreated.currentTaskId).toBe('verify');
  });

  it('新目标创建：显式传入的 status 仍被采用（确实延续的已完成任务）', () => {
    const first = writeTodoList(null, '旧目标', [
      { id: 'verify', title: '验证', description: '' },
    ]);
    const done = updateTodoList(first, [
      { id: 'verify', status: 'completed', summary: '旧验证' },
    ]);

    const recreated = writeTodoList(done, '新目标', [
      { id: 'verify', title: '验证', description: '', status: 'completed' },
    ]);

    expect(recreated.tasks[0]!.status).toBe('completed');
    // 显式状态只带走状态本身：新目标不继承上一版的进度摘要
    expect(recreated.tasks[0]!.summary).toBeUndefined();
  });

  it('新目标创建重置 createdAt；同目标续用保留', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const first = writeTodoList(null, '旧目标', [
        { id: 'task-a', title: 'A', description: '' },
      ]);
      vi.setSystemTime(2_000);
      const fresh = writeTodoList(first, '新目标', [
        { id: 'task-a', title: 'A', description: '' },
      ]);
      expect(first.createdAt).toBe(1_000);
      expect(fresh.createdAt).toBe(2_000);

      vi.setSystemTime(3_000);
      const continued = writeTodoList(fresh, '新目标', [
        { id: 'task-a', title: 'A', description: '' },
      ]);
      expect(continued.createdAt).toBe(2_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('应正确处理依赖和预期产出', () => {
    const ctx = writeTodoList(null, '复杂任务', [
      { id: 'setup-db', title: '初始化数据库', description: '', expectedArtifacts: ['db/schema.sql'] },
      { id: 'add-api', title: '添加 API', description: '', dependsOn: ['setup-db'], expectedArtifacts: ['src/api/users.ts'] },
    ]);

    expect(ctx.tasks[0]!.dependsOn).toBeUndefined();
    expect(ctx.tasks[0]!.expectedArtifacts).toEqual(['db/schema.sql']);
    expect(ctx.tasks[1]!.dependsOn).toEqual(['setup-db']);
    expect(ctx.tasks[1]!.expectedArtifacts).toEqual(['src/api/users.ts']);
    // add-api 依赖未满足，光标落在 setup-db
    expect(ctx.currentTaskId).toBe('setup-db');
  });
});

describe('inferCurrentTaskId（光标纯推导）', () => {
  function tasks(...specs: Array<[string, AgentTask['status'], string[]?]>): AgentTask[] {
    return specs.map(([id, status, dependsOn]) => ({
      id,
      title: id,
      description: id,
      status,
      dependsOn: dependsOn && dependsOn.length > 0 ? dependsOn : undefined,
    }));
  }

  it('running 优先', () => {
    expect(inferCurrentTaskId(tasks(['a', 'completed'], ['b', 'running'], ['c', 'pending']))).toBe('b');
  });

  it('无 running：第一个依赖满足的 pending', () => {
    expect(inferCurrentTaskId(tasks(['a', 'pending'], ['b', 'pending', ['a']]))).toBe('a');
    expect(inferCurrentTaskId(tasks(['a', 'completed'], ['b', 'pending', ['a']], ['c', 'pending']))).toBe('b');
  });

  it('全终结 / 全 pending 但依赖互锁 → null', () => {
    expect(inferCurrentTaskId(tasks(['a', 'completed'], ['b', 'failed']))).toBeNull();
    expect(inferCurrentTaskId([])).toBeNull();
  });

  it('不变式：任何 running 任务存在时光标绝不可能是 null（旧事故 #342 的根因）', () => {
    const ctx = inferCurrentTaskId(
      tasks(['repro-exit-stop', 'completed'], ['fix-exit-stop', 'running'], ['verify-all', 'pending', ['fix-exit-stop']])
    );
    expect(ctx).toBe('fix-exit-stop');
  });
});

describe('updateTodoList（回合内进度通道，光标只派生不推进）', () => {
  function makeContext(taskSpecs: Array<[string, AgentTask['status'], string[]?]>): TodoListContext {
    return writeTodoList(null, 'test', taskSpecs.map(([id, status, dependsOn]) => ({
      id,
      title: id,
      description: '',
      status,
      dependsOn,
    })));
  }

  it('应更新单个任务状态', () => {
    const ctx = makeContext([['a', 'pending'], ['b', 'pending']]);
    const updated = updateTodoList(ctx, [{ id: 'a', status: 'running' }]);

    expect(updated.tasks.find((t) => t.id === 'a')!.status).toBe('running');
    expect(updated.tasks.find((t) => t.id === 'b')!.status).toBe('pending');
    // updates 置 running → 光标派生跟随（旧实现的死角落）
    expect(updated.currentTaskId).toBe('a');
  });

  it('应更新任务 summary', () => {
    const ctx = makeContext([['a', 'pending']]);
    const updated = updateTodoList(ctx, [{ id: 'a', status: 'completed', summary: '完成!' }]);

    expect(updated.tasks.find((t) => t.id === 'a')!.summary).toBe('完成!');
  });

  it('空 summary 不清除旧 summary', () => {
    const ctx = makeContext([['a', 'completed']]);
    const withSummary = updateTodoList(ctx, [{ id: 'a', summary: '已修复：三点细节' }]);
    const blank = updateTodoList(withSummary, [{ id: 'a', summary: '   ' }]);

    expect(blank.tasks.find((t) => t.id === 'a')!.summary).toBe('已修复：三点细节');
  });

  it('应更新 errorLog 与 touchedArtifacts', () => {
    const ctx = makeContext([['a', 'running']]);
    const updated = updateTodoList(ctx, [{ id: 'a', status: 'failed', errorLog: '类型错误: x is not T', touchedArtifacts: ['src/a.ts'] }]);

    const task = updated.tasks.find((t) => t.id === 'a')!;
    expect(task.status).toBe('failed');
    expect(task.errorLog).toBe('类型错误: x is not T');
    expect(task.touchedArtifacts).toEqual(['src/a.ts']);
  });

  it('failed 就停在 failed：系统不再自动降级重试', () => {
    const ctx = makeContext([['a', 'running']]);
    const updated = updateTodoList(ctx, [{ id: 'a', status: 'failed', errorLog: '又断了' }]);

    expect(updated.tasks.find((t) => t.id === 'a')!.status).toBe('failed');
    // 重开与否则是下一回合模型的事
  });

  it('completed 可以改回 pending/running（诚实重开，光标如实跟随）', () => {
    const ctx = makeContext([['a', 'completed'], ['b', 'pending', ['a']]]);
    const reopened = updateTodoList(ctx, [{ id: 'a', status: 'running' }]);

    expect(reopened.tasks.find((t) => t.id === 'a')!.status).toBe('running');
    expect(reopened.currentTaskId).toBe('a');
  });

  it('标记 completed 不再自动把下一条置 running（推进由模型声明）', () => {
    const ctx = makeContext([['a', 'running'], ['b', 'pending']]);
    const updated = updateTodoList(ctx, [{ id: 'a', status: 'completed' }]);

    expect(updated.tasks.find((t) => t.id === 'a')!.status).toBe('completed');
    expect(updated.tasks.find((t) => t.id === 'b')!.status).toBe('pending');
    expect(updated.currentTaskId).toBe('b');
  });

  it('同 patch「当前 completed + 下一个 running」光标落在 running（旧自动推进的死角）', () => {
    const ctx = makeContext([['repro', 'running'], ['fix', 'pending', ['repro']], ['verify', 'pending', ['fix']]]);
    const updated = updateTodoList(ctx, [
      { id: 'repro', status: 'completed', summary: '定位完成' },
      { id: 'fix', status: 'running' },
    ]);

    expect(updated.currentTaskId).toBe('fix');
    expect(updated.tasks.filter((t) => t.status === 'running')).toHaveLength(1);
  });

  it('所有任务终结时整体 status 收敛为 completed、光标为 null', () => {
    const ctx = makeContext([['a', 'completed'], ['b', 'running']]);
    const updated = updateTodoList(ctx, [{ id: 'b', status: 'completed' }]);

    expect(updated.status).toBe('completed');
    expect(updated.currentTaskId).toBeNull();
  });

  it('未知 id 的 patch 是 no-op（返回同引用）', () => {
    const ctx = makeContext([['a', 'pending']]);
    const result = updateTodoList(ctx, []);
    expect(result).toBe(ctx);
  });
});

describe('updates 状态别名规范化（iPod 会话 in_progress 卡单事故回放）', () => {
  function plan(): TodoListContext {
    return writeTodoList(null, 'g', [
      { id: 'a', title: 'A', description: 'a', status: 'completed' },
      { id: 'b', title: 'B', description: 'b' },
    ]);
  }

  it('in_progress 归一为 running，光标跟随、清单仍 active', () => {
    const result = applyTodoToolRequest(
      plan(),
      { updates: [{ id: 'b', status: 'in_progress', summary: '进行中' }] },
      { creationOpen: false, defaultGoal: 'g' }
    );

    const task = result.ctx.tasks.find((t) => t.id === 'b')!;
    expect(task.status).toBe('running');
    expect(task.summary).toBe('进行中');
    expect(result.ctx.currentTaskId).toBe('b');
    expect(result.ctx.status).toBe('active');
  });

  it('done/finished 等近义值归一为 completed，全部终结时清单收敛', () => {
    const result = applyTodoToolRequest(
      plan(),
      { updates: [{ id: 'b', status: 'Done', summary: '完成' }] },
      { creationOpen: false, defaultGoal: 'g' }
    );

    expect(result.ctx.tasks.find((t) => t.id === 'b')!.status).toBe('completed');
    expect(result.ctx.status).toBe('completed');
    expect(result.ctx.currentTaskId).toBeNull();
  });

  it('未知状态不写入：状态保持原样，其余字段照常生效', () => {
    const running = updateTodoList(plan(), [{ id: 'b', status: 'running' }]);
    const result = applyTodoToolRequest(
      running,
      { updates: [{ id: 'b', status: '待办中??', summary: '不能覆盖状态' }] },
      { creationOpen: false, defaultGoal: 'g' }
    );

    const task = result.ctx.tasks.find((t) => t.id === 'b')!;
    expect(task.status).toBe('running');
    expect(task.summary).toBe('不能覆盖状态');
  });

  it('创建路径同样接受别名（normalizeStatus）', () => {
    const ctx = writeTodoList(null, 'g', [
      { id: 'a', title: 'A', description: 'a', status: 'in-progress' as never },
    ]);
    expect(ctx.tasks[0]!.status).toBe('running');
  });
});

describe('applyTodoToolRequest（创建窗口闸门——本回合一次创建，其余全走 updates）', () => {
  const tasksArg = [
    { id: 'a', title: 'A', description: 'a' },
    { id: 'b', title: 'B', description: 'b' },
  ];

  it('窗口开启时 tasks 创建清单并标记消耗', () => {
    const result = applyTodoToolRequest(
      null,
      { tasks: tasksArg },
      { creationOpen: true, defaultGoal: '用户：修复退出停播' }
    );

    expect(result.created).toBe(true);
    expect(result.rejected).toBe(false);
    expect(result.ctx.tasks.map((t) => t.id)).toEqual(['a', 'b']);
    // 创建时 goal 缺省注入用户消息文本（旧事故里 goal 永远是「未设置」）
    expect(result.ctx.goal).toBe('用户：修复退出停播');
  });

  it('显式 goal 覆盖兜底文本', () => {
    const result = applyTodoToolRequest(
      null,
      { goal: '自定义目标', tasks: tasksArg },
      { creationOpen: true, defaultGoal: '用户消息兜底' }
    );
    expect(result.ctx.goal).toBe('自定义目标');
  });

  it('窗口关闭后的 tasks 调用被拒绝：状态零变化（同引用）', () => {
    const created = applyTodoToolRequest(
      null,
      { tasks: tasksArg },
      { creationOpen: true, defaultGoal: 'g' }
    );
    const advanced = updateTodoList(created.ctx, [{ id: 'a', status: 'completed', summary: 'done' }]);

    const dup = applyTodoToolRequest(
      advanced,
      { tasks: tasksArg },
      { creationOpen: false, defaultGoal: 'g' }
    );

    expect(dup.rejected).toBe(true);
    expect(dup.created).toBe(false);
    expect(dup.ctx).toBe(advanced);
  });

  it('拒绝时模型仍拿到当前快照（digest 可见）', () => {
    const created = applyTodoToolRequest(null, { tasks: tasksArg }, { creationOpen: true, defaultGoal: 'g' });
    const dup = applyTodoToolRequest(created.ctx, { tasks: tasksArg }, { creationOpen: false, defaultGoal: 'g' });

    expect(TODO_CREATE_REJECTED_NOTICE).toContain('updates');
    expect(renderTodoListDigest(dup.ctx)).toContain('← current');
  });

  it('无清单时窗口关闭 + tasks：返回空清单且拒绝（不凭空建立）', () => {
    const result = applyTodoToolRequest(
      null,
      { tasks: tasksArg },
      { creationOpen: false, defaultGoal: 'g' }
    );
    expect(result.rejected).toBe(true);
    expect(result.ctx.tasks).toHaveLength(0);
    expect(result.ctx.goal).toBe('g');
  });

  it('updates 不受窗口约束：窗口关闭后依然可以推进', () => {
    const created = applyTodoToolRequest(null, { tasks: tasksArg }, { creationOpen: true, defaultGoal: 'g' });
    const updated = applyTodoToolRequest(
      created.ctx,
      { updates: [{ id: 'a', status: 'completed', summary: 'ok' }] },
      { creationOpen: false, defaultGoal: 'g' }
    );

    expect(updated.rejected).toBe(false);
    expect(updated.ctx.tasks.find((t) => t.id === 'a')!.status).toBe('completed');
    expect(updated.ctx.currentTaskId).toBe('b');
  });

  it('updates 不能凭空造清单：无清单时返回空清单并引导创建', () => {
    const result = applyTodoToolRequest(
      null,
      { updates: [{ id: 'ghost', status: 'running' }] },
      { creationOpen: false, defaultGoal: 'g' }
    );

    expect(result.ctx.tasks).toHaveLength(0);
    expect(result.rejected).toBe(false);
    expect(renderTodoListDigest(result.ctx)).toContain('空');
  });

  it('goal-only 调用：改 goal，不动任务', () => {
    const created = applyTodoToolRequest(null, { tasks: tasksArg }, { creationOpen: true, defaultGoal: 'g' });
    const goalOnly = applyTodoToolRequest(
      created.ctx,
      { goal: '新目标描述' },
      { creationOpen: false, defaultGoal: 'g' }
    );

    expect(goalOnly.ctx.goal).toBe('新目标描述');
    expect(goalOnly.ctx.tasks).toEqual(created.ctx.tasks);
  });

  it('空参数调用返回同引用（no-op）', () => {
    const created = applyTodoToolRequest(null, { tasks: tasksArg }, { creationOpen: true, defaultGoal: 'g' });
    const noop = applyTodoToolRequest(created.ctx, {}, { creationOpen: false, defaultGoal: '' });

    expect(noop.ctx).toBe(created.ctx);
    expect(noop.created).toBe(false);
    expect(noop.rejected).toBe(false);
  });
});

describe('新目标创建不继承旧进度（iPod 会话 verify 事故回放）', () => {
  it('新用户消息 + 复用 verify id：不得继承上一轮的 completed', () => {
    const oldPlan = applyTodoToolRequest(
      null,
      {
        tasks: [
          { id: 'podcast-ui', title: '播客菜单', description: '' },
          { id: 'verify', title: '编译与实跑验证', description: '' },
        ],
      },
      { creationOpen: true, defaultGoal: '主界面当前播放 + 播客' }
    ).ctx;
    const oldDone = updateTodoList(oldPlan, [
      { id: 'podcast-ui', status: 'completed' },
      { id: 'verify', status: 'completed', summary: '上一轮完成' },
    ]);

    // 下一条用户消息（新目标）开启新的创建窗口
    const next = applyTodoToolRequest(
      oldDone,
      {
        tasks: [
          { id: 'island-row', title: '灵动岛那一行纳入显示屏', description: '' },
          { id: 'lyrics-core', title: '歌词解析核心', description: '' },
          { id: 'verify', title: '验证', description: '' },
        ],
      },
      { creationOpen: true, defaultGoal: '1、能不能显示歌词？\n2、灵动岛那一行纳入显示屏？' }
    );

    expect(next.created).toBe(true);
    expect(next.ctx.tasks.find((t) => t.id === 'verify')!.status).toBe('pending');
    const digest = renderTodoListDigest(next.ctx);
    expect(digest).toContain('○ verify');
    expect(digest).not.toContain('✓ verify');
  });
});

describe('renderTodoListDigest', () => {
  it('空清单应提示初始化', () => {
    const ctx = createEmptyTodoListContext('test');
    expect(renderTodoListDigest(ctx)).toContain('空');
    expect(renderTodoListDigest(ctx)).toContain('创建窗口');
  });

  it('应渲染完整摘要与 current 标记', () => {
    const ctx = writeTodoList(null, '添加用户注册功能', [
      { id: 'add-route', title: '添加注册路由', description: 'POST /register', status: 'running' },
      { id: 'add-form', title: '添加注册表单', description: 'RegisterForm.tsx', dependsOn: ['add-route'] },
    ]);
    const digest = renderTodoListDigest(ctx);

    expect(digest).toContain('添加用户注册功能');
    expect(digest).toContain('▶ add-route');
    expect(digest).toContain('← current');
    expect(digest).toContain('○ add-form');
    expect(digest).not.toContain('retry');
  });

  it('应渲染失败任务的错误日志', () => {
    const ctx = writeTodoList(null, 'g', [
      { id: 'a', title: 'A', description: 'a', status: 'running' },
    ]);
    const failed = updateTodoList(ctx, [{ id: 'a', status: 'failed', errorLog: '类型错误: 参数不匹配' }]);
    const digest = renderTodoListDigest(failed);

    expect(digest).toContain('✗');
    expect(digest).toContain('类型错误');
  });
});

describe('buildTodoToolDefinition', () => {
  it('应生成单个 todo 工具定义', () => {
    const def = buildTodoToolDefinition();

    expect(def.name).toBe(TODO_TOOL_NAME);
    expect(def.parameters.type).toBe('object');
    expect(def.parameters.properties).toHaveProperty('tasks');
    expect(def.parameters.properties).toHaveProperty('updates');
    expect(def.parameters.properties).toHaveProperty('goal');
  });

  it('schema 不再暴露重试语义', () => {
    const def = buildTodoToolDefinition();
    const text = JSON.stringify(def);

    expect(text).not.toContain('maxRetries');
    expect(text).not.toContain('bumpRetry');
  });

  it('描述明确「每用户回合至多一次创建 + 二次 tasks 被拒」', () => {
    const def = buildTodoToolDefinition();
    const text = JSON.stringify(def);

    expect(text).toContain('至多一次');
    expect(text).toContain('拒绝');
  });
});

describe('hasUnsettledTodoTasks', () => {
  it('null / 空清单 / 已全终结 均为 false', () => {
    expect(hasUnsettledTodoTasks(null)).toBe(false);
    expect(hasUnsettledTodoTasks(undefined)).toBe(false);
    expect(hasUnsettledTodoTasks(createEmptyTodoListContext('goal'))).toBe(false);

    const done = writeTodoList(null, 'goal', [
      { id: 'a', title: 'A', description: 'a', status: 'completed' },
      { id: 'b', title: 'B', description: 'b', status: 'failed' },
    ]);
    expect(hasUnsettledTodoTasks(done)).toBe(false);
  });

  it('存在 pending 或 running 时为 true', () => {
    const ctx = writeTodoList(null, 'goal', [
      { id: 'a', title: 'A', description: 'a', status: 'running' },
    ]);
    expect(hasUnsettledTodoTasks(ctx)).toBe(true);
  });
});

describe('convergeUnconfirmedRunningTasks（未确认 running 收敛）', () => {
  function planWithRunning(): TodoListContext {
    return writeTodoList(null, 'goal', [
      { id: 'add-route', title: '路由', description: 'r', status: 'completed' },
      { id: 'add-form', title: '表单', description: 'f', status: 'running', dependsOn: ['add-route'] },
      { id: 'validate', title: '校验', description: 'v', dependsOn: ['add-form'] },
    ]);
  }

  it('running 任务退回 pending 并写 errorLog，光标重算指向第一个可执行 pending', () => {
    const ctx = planWithRunning();
    const next = convergeUnconfirmedRunningTasks(ctx);

    expect(next).not.toBe(ctx);
    const form = next.tasks.find((t) => t.id === 'add-form')!;
    expect(form.status).toBe('pending');
    expect(form.errorLog).toBe('回合结束未确认');
    expect(next.tasks.find((t) => t.id === 'add-route')!.status).toBe('completed');
    expect(next.currentTaskId).toBe('add-form');
    expect(next.status).toBe('active');
  });

  it('无 running 任务时返回同一引用（no-op，含全 pending 与全 failed）', () => {
    const allPending = writeTodoList(null, 'goal', [
      { id: 'a', title: 'A', description: 'a' },
      { id: 'b', title: 'B', description: 'b' },
    ]);
    expect(convergeUnconfirmedRunningTasks(allPending)).toBe(allPending);

    const failed = writeTodoList(null, 'goal', [
      { id: 'a', title: 'A', description: 'a', status: 'failed' },
    ]);
    expect(convergeUnconfirmedRunningTasks(failed)).toBe(failed);
  });

  it('支持自定义原因（恢复钩子用）', () => {
    const next = convergeUnconfirmedRunningTasks(planWithRunning(), '进程退出前回合未确认');
    expect(next.tasks.find((t) => t.id === 'add-form')!.errorLog).toBe('进程退出前回合未确认');
  });

  it('历史非规范状态（in_progress）也收敛回 pending 并写 errorLog', () => {
    const legacy = {
      goal: 'g',
      tasks: [
        { id: 'a', title: 'A', description: 'a', status: 'completed' },
        { id: 'b', title: 'B', description: 'b', status: 'in_progress' },
      ],
      currentTaskId: null,
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    } as unknown as TodoListContext;

    const next = convergeUnconfirmedRunningTasks(legacy);
    const task = next.tasks.find((t) => t.id === 'b')!;
    expect(task.status).toBe('pending');
    expect(task.errorLog).toBe('回合结束未确认');
    expect(next.currentTaskId).toBe('b');
    // 非法状态不能再让清单永久卡在 active：收敛后仍是可继续推进的 pending
    expect(next.status).toBe('active');
    expect(convergeUnconfirmedRunningTasks(next)).toBe(next);
  });

  it('hasUnsettledTodoTasks 对历史非规范状态同样返回 true', () => {
    const legacy = {
      goal: 'g',
      tasks: [{ id: 'a', title: 'A', description: 'a', status: 'in_progress' }],
      currentTaskId: null,
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    } as unknown as TodoListContext;

    expect(hasUnsettledTodoTasks(legacy)).toBe(true);
  });
});

describe('旧持久化数据兼容（retries/maxRetries/replanCount 残留字段）', () => {
  it('带历史字段的 context 仍可 updates 推进且 digest 不再显示重试', () => {
    const legacy = {
      goal: 'legacy',
      tasks: [
        { id: 'a', title: 'A', description: 'a', status: 'running', retries: 2, maxRetries: 3 },
      ],
      currentTaskId: 'a',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
      replanCount: 11,
    } as unknown as TodoListContext;

    const next = updateTodoList(legacy, [{ id: 'a', status: 'completed', summary: 'ok' }]);
    expect(next.tasks.find((t) => t.id === 'a')!.status).toBe('completed');
    // 系统不再维护重试计数：completed 时残留字段随 patch 展开保留为旧值，
    // 但运行时逻辑与渲染均忽略之。
    expect(renderTodoListDigest(next)).not.toContain('retry');

    const viaRequest = applyTodoToolRequest(legacy, { tasks: [{ id: 'a', title: 'A', description: 'a' }] }, { creationOpen: true, defaultGoal: '' });
    expect(viaRequest.created).toBe(true);
    expect(viaRequest.ctx.replanCount).toBeUndefined();
  });
});

describe('事故回放：iPod 会话 #342→#347（updates/tasks 振荡）', () => {
  it('创建被消耗后，任何后续 tasks 全量覆盖全部被短路拒绝', () => {
    const goal = '修改完后再检查退出当前歌曲界面就不播放问题，目前依然存在。';
    let ctx = applyTodoToolRequest(null, {
      tasks: [
        { id: 'repro-exit-stop', title: '复现与定位退出停播', description: '定位根因' },
        { id: 'fix-exit-stop', title: '修复退出停播', description: 'menu 只拆 UI 不断音频' },
        { id: 'verify-all', title: '验证', description: '构建+诊断' },
      ],
    }, { creationOpen: true, defaultGoal: goal }).ctx;
    // 创建即消耗窗口（模拟 UI handler 的 closeTodoCreationWindow）

    // #342：同 patch 完成 + 启动下一条 → 光标如实跟随 running
    ctx = updateTodoList(ctx, [
      { id: 'fix-exit-stop', status: 'completed', summary: '已修复：Timer 跳过 scroll、wheelrelease 显式回 play' },
      { id: 'verify-all', status: 'running' },
    ]);
    expect(ctx.currentTaskId).toBe('verify-all');
    expect(renderTodoListDigest(ctx)).toContain('verify-all: 验证 ← current');

    // #344：模型把已完成任务改回 pending/running（诚实重开）→ 光标跟 running
    ctx = updateTodoList(ctx, [
      { id: 'repro-exit-stop', status: 'running', summary: '复现退出停播：重走链路' },
      { id: 'fix-exit-stop', status: 'pending' },
      { id: 'verify-all', status: 'pending' },
    ]);
    expect(ctx.currentTaskId).toBe('repro-exit-stop');

    // #345→#347：模型改投 tasks 全量覆盖「找回」锚点 → 现在被闸门拒绝
    const rewrite = {
      tasks: [
        { id: 'repro-exit-stop', title: '复现与定位退出停播', description: '定位调用链' },
        { id: 'fix-exit-stop', title: '修复退出停播', description: '只拆 UI 不断音频' },
        { id: 'verify-all', title: '验证', description: '构建+诊断' },
      ],
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = applyTodoToolRequest(ctx, rewrite, { creationOpen: false, defaultGoal: goal });
      expect(result.rejected).toBe(true);
      expect(result.ctx).toBe(ctx);
    }
    // 状态与光标在拒绝中纹丝不动
    expect(ctx.currentTaskId).toBe('repro-exit-stop');
    expect(ctx.tasks.find((t) => t.id === 'fix-exit-stop')!.summary).toBe('已修复：Timer 跳过 scroll、wheelrelease 显式回 play');
  });
});
