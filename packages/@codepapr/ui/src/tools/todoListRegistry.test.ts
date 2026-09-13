import { describe, expect, it } from 'vitest';
import type { TodoListContext } from '@codepapr/types';
import { todoContextToChecklist } from './todoListRegistry';

function makeContext(overrides: Partial<TodoListContext> = {}): TodoListContext {
  return {
    goal: '把歌词页做出来',
    tasks: [
      { id: 'a', title: '原生取数', description: '桥新增 lyrics.get', status: 'completed', summary: '拿到了' },
      { id: 'b', title: '解析核心', description: 'LRC 解析', status: 'pending' },
      { id: 'c', title: '歌词页', description: '跟随高亮', status: 'failed', errorLog: '布局崩了' },
    ],
    currentTaskId: 'b',
    status: 'active',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe('todoContextToChecklist', () => {
  it('透传 currentTaskId / status / 时间戳，任务字段完整映射', () => {
    const checklist = todoContextToChecklist(makeContext(), 's1');

    expect(checklist.sessionId).toBe('s1');
    expect(checklist.title).toBe('把歌词页做出来');
    expect(checklist.currentTaskId).toBe('b');
    expect(checklist.status).toBe('active');
    expect(checklist.createdAt).toBe(1);
    expect(checklist.updatedAt).toBe(2);

    expect(checklist.items.map((item) => item.status)).toEqual(['completed', 'pending', 'failed']);
    expect(checklist.items[0]!.summary).toBe('拿到了');
    expect(checklist.items[1]!.prompt).toBe('LRC 解析');
    // 失败任务把 errorLog 映射成渲染层摘要
    expect(checklist.items[2]!.summary).toBe('失败: 布局崩了');
  });

  it('currentTaskId 为 null 时原样透传（全终结清单无当前任务）', () => {
    const checklist = todoContextToChecklist(makeContext({ currentTaskId: null }), 's2');
    expect(checklist.currentTaskId).toBeNull();
  });
});
