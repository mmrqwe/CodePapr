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

import { StatsModal } from './StatsModal';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('StatsModal', () => {
  let container: HTMLDivElement;
  let root: Root;

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

  it('opens on the cache tab and switches to project stats', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <StatsModal workspacePath="/ws" lang="zh-CN" onClose={onClose} />,
      );
    });

    expect(container.textContent).toContain('缓存统计');
    expect(container.textContent).toContain('项目统计');
    expect(container.textContent).toContain('cache-dashboard');
    expect(container.textContent).not.toContain('project-dashboard');

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
});
