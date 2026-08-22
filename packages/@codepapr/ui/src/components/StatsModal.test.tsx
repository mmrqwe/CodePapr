// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./CacheStatsDashboard', () => ({
  CacheStatsDashboard: () => <div>cache-dashboard</div>,
}));

vi.mock('./ProjectStatsModal', () => ({
  ProjectStatsModal: () => <div>project-dashboard</div>,
}));

vi.mock('./ContextInspectorModal', () => ({
  ContextInspectorModal: () => <div>context-inspector</div>,
}));

import { StatsModal } from './StatsModal';
import { useAgentStore } from '../store/agentStore';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('StatsModal', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useAgentStore.setState((state) => ({
      ...state,
      activeSessionId: 'sess-1',
      computeContextSnapshot: vi.fn(async () => undefined),
      _latestContextSnapshot: {
        sessionId: 'sess-1',
        snapshot: {
          round: 1,
          model: 'test-model',
          messages: [],
          toolNames: [],
          toolsTokenEstimate: 0,
          totalTokens: 0,
          tokensByStage: {
            'stable-prefix': 0,
            'session-state': 0,
            conversation: 0,
          },
          capturedAt: Date.now(),
        },
      },
    }));
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('opens on the cache tab and switches to project stats', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <StatsModal workspacePath="/ws" lang="zh-CN" onClose={onClose} />,
      );
    });

    expect(container.textContent).toContain('缓存统计');
    expect(container.textContent).toContain('项目统计');
    expect(container.textContent).toContain('查看上下文');
    expect(container.textContent).toContain('cache-dashboard');
    expect(container.textContent).not.toContain('project-dashboard');
    expect(container.textContent).not.toContain('context-inspector');

    const projectTab = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '项目统计',
    );
    expect(projectTab).toBeDefined();
    await act(async () => {
      projectTab?.click();
    });

    expect(container.textContent).toContain('project-dashboard');
    expect(container.textContent).toContain('cache-dashboard');
  });

  it('switches to the context tab without opening a nested window', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <StatsModal workspacePath="/ws" lang="zh-CN" onClose={onClose} />,
      );
    });

    const contextTab = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '查看上下文',
    );
    expect(contextTab).toBeDefined();
    await act(async () => {
      contextTab?.click();
    });

    expect(container.textContent).toContain('context-inspector');
    expect(container.textContent).toContain('cache-dashboard');
    expect(container.querySelectorAll('[role="dialog"]').length).toBe(1);
  });

  it('closes on overlay click and Escape', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <StatsModal workspacePath="/ws" lang="zh-CN" onClose={onClose} />,
      );
    });

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    const overlay = container.firstElementChild as HTMLElement;
    act(() => {
      overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('automatically computes context snapshot and displays top header stats', async () => {
    const computeContextSnapshot = vi.fn(async () => undefined);
    useAgentStore.setState((state) => ({
      ...state,
      activeSessionId: 'sess-1',
      computeContextSnapshot,
      conversationStats: {
        ...state.conversationStats,
        primary: {
          ...state.conversationStats.primary,
          totalOutput: 627,
          modelRuntimeMs: 10000,
          toolRuntimeMs: 2000,
        },
      },
      _latestContextSnapshot: {
        sessionId: 'sess-1',
        snapshot: {
          round: 1,
          model: 'test-model',
          messages: [],
          toolNames: [],
          toolsTokenEstimate: 0,
          totalTokens: 55640,
          tokensByStage: {
            'stable-prefix': 0,
            'session-state': 0,
            conversation: 0,
          },
          capturedAt: Date.now(),
        },
      },
    }));

    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <StatsModal workspacePath="/ws" lang="zh-CN" onClose={onClose} />,
      );
    });

    expect(computeContextSnapshot).toHaveBeenCalled();
    expect(container.textContent).toContain('当前上下文');
    expect(container.textContent).toContain('~55,640 tokens');
    expect(container.textContent).toContain('模型耗时');
    expect(container.textContent).toContain('10s');
    expect(container.textContent).toContain('工具耗时');
    expect(container.textContent).toContain('2s');
    expect(container.textContent).toContain('62.7 token/s');
  });
});
