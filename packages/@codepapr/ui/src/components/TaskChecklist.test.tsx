// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskChecklist } from './TaskChecklist';
import type { TaskChecklist as TaskChecklistType } from '../utils/taskChecklistTypes';

import { ToolRegistry } from '@codepapr/core';
import { useAgentStore } from '../store/agentStore';
import { registerTodoListTools } from '../tools/todoListTool';
import { openTodoCreationWindow, resetTodoListContext } from '../tools/todoListRegistry';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function fixture(updatedAt: number, currentTaskId: string | null): TaskChecklistType {
  return {
    sessionId: 's1',
    title: '歌词 + 灵动岛',
    items: [
      { id: 'a', title: '任务 A', prompt: '', status: 'pending' },
      { id: 'b', title: '任务 B', prompt: '', status: 'pending' },
      { id: 'c', title: '任务 C', prompt: '', status: 'running' },
      { id: 'd', title: '任务 D', prompt: '', status: 'completed' },
      { id: 'e', title: '任务 E', prompt: '', status: 'failed' },
    ],
    status: 'active',
    currentTaskId,
    createdAt: 1,
    updatedAt,
  };
}

describe('TaskChecklist', () => {
  let container: HTMLDivElement;
  let root: Root;

  function iconOf(title: string): string {
    const rows = Array.from(container.querySelectorAll('div')).filter(
      (el) => el.querySelectorAll('span').length === 2 && (el.textContent ?? '').includes(title)
    );
    expect(rows).toHaveLength(1);
    return rows[0]!.querySelector('span')!.textContent ?? '';
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('回合进行中：currentTaskId 的 pending 任务按执行中显示；回合结束回落待执行', async () => {
    await act(async () => {
      root.render(<TaskChecklist checklist={fixture(1, 'a')} isLoading={false} />);
    });
    // 回合未开始：当前任务只是待执行
    expect(iconOf('任务 A')).toBe('\u25CB');

    // 新清单到达（updatedAt 变化）且回合进行中 → 当前任务显示执行中
    await act(async () => {
      root.render(<TaskChecklist checklist={fixture(2, 'a')} isLoading />);
    });
    expect(iconOf('任务 A')).toBe('\u25B6');
    expect(iconOf('任务 B')).toBe('\u25CB');
    expect(iconOf('任务 C')).toBe('\u25B6');
    expect(iconOf('任务 D')).toBe('\u2713');
    expect(iconOf('任务 E')).toBe('\u2717');

    // 回合结束：派生执行中消失，回落待执行（running 任务仍由模型显式状态决定）
    await act(async () => {
      root.render(<TaskChecklist checklist={fixture(2, 'a')} isLoading={false} />);
    });
    expect(iconOf('任务 A')).toBe('\u25CB');
    expect(iconOf('任务 C')).toBe('\u25B6');
  });

  it('模型显式 running 的任务不依赖 currentTaskId 照常显示执行中', async () => {
    await act(async () => {
      root.render(<TaskChecklist checklist={fixture(1, null)} isLoading={false} />);
    });
    await act(async () => {
      root.render(<TaskChecklist checklist={fixture(2, null)} isLoading />);
    });
    expect(iconOf('任务 C')).toBe('\u25B6');
    expect(iconOf('任务 A')).toBe('\u25CB');
  });
});

const sessionId = 'checklist-render-test';
const tasks = [{ id: 'Verify_Tests', title: 'Run the tests', description: 'Verify suites' }];

describe('TaskChecklist tool updates', () => {
  let container: HTMLDivElement;
  let root: Root;
  let registry: ToolRegistry;

  beforeEach(async () => {
    container = document.createElement('div');
    root = createRoot(container);
    registry = new ToolRegistry();
    registerTodoListTools(registry, sessionId);
    openTodoCreationWindow(sessionId, 'Test progress');
    await registry.execute('todo', { tasks });
  });

  afterEach(async () => {
    await act(() => root.unmount());
    resetTodoListContext(sessionId);
    vi.restoreAllMocks();
  });

  function render(isLoading: boolean) {
    const checklist = useAgentStore.getState()._taskChecklists[sessionId]!;
    return act(() => root.render(<TaskChecklist checklist={checklist} lang="en" isLoading={isLoading} />));
  }

  it('keeps the first checklist visible when it appears during a running turn', async () => {
    await render(true);

    expect(container.textContent).toContain('Run the tests');
    expect(container.textContent).not.toContain('Expand');
  });

  it('reopens the checklist for an actual update with the same timestamp', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    openTodoCreationWindow(sessionId);
    await registry.execute('todo', { tasks });
    await render(false);
    await render(true);
    expect(container.textContent).toContain('Expand');

    await registry.execute('todo', {
      updates: [{ id: 'Verify_Tests', status: 'running', summary: '3 suites passed' }],
    });
    await render(true);

    expect(container.textContent).toContain('Run the tests');
    expect(container.textContent).toContain('3 suites passed');
    expect(container.textContent).not.toContain('Expand');
  });

  it('displays a summary-only update while the status stays the same', async () => {
    await registry.execute('todo', { updates: [{ id: 'verify-tests', status: 'running' }] });
    await render(true);

    await registry.execute('todo', { updates: [{ id: 'verify-tests', summary: '4 suites passed' }] });
    await render(true);

    expect(container.textContent).toContain('0/1');
    expect(container.textContent).toContain('4 suites passed');
  });
});
