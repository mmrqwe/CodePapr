// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { SettingsPluginsSection } from './SettingsPluginsSection';
import { useAppRuntimeStore } from '../../store/appRuntimeStore';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('SettingsPluginsSection', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useAppRuntimeStore.setState({
      apps: [
        {
          appId: 'notes',
          title: 'Notes',
          html: '',
          filePath: 'x',
          createdAt: 1,
          updatedAt: 1,
          manifestJson: JSON.stringify({ spec: 'papr/0.1', name: 'Notes', kind: 'app' }),
        },
        {
          appId: 'ticker',
          title: '股票',
          icon: '📈',
          html: '',
          filePath: 'y',
          createdAt: 1,
          updatedAt: 1,
          manifestJson: JSON.stringify({ spec: 'papr/0.1', name: '股票', kind: 'plugin' }),
        },
        {
          appId: 'kanban',
          title: '看板',
          html: '',
          filePath: 'z',
          createdAt: 1,
          updatedAt: 1,
          manifestJson: JSON.stringify({
            spec: 'papr/0.1',
            name: '看板',
            kind: 'plugin',
            inbox: { cards: { description: '卡片' } },
          }),
        },
      ],
      pinnedPluginIds: [],
      overlayLayouts: {},
      pluginChrome: {},
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('lists plugins only; enable auto-shows widgets but not inbox plugins', async () => {
    await act(async () => {
      root.render(<SettingsPluginsSection lang="zh-CN" />);
    });
    expect(container.textContent).toContain('股票');
    expect(container.textContent).toContain('看板');
    expect(container.textContent).not.toContain('Notes');

    const enableTicker = Array.from(container.querySelectorAll('button[role="switch"]')).find(
      (button) => button.getAttribute('aria-label') === '启用' && button.closest('div')?.textContent?.includes('股票'),
    ) as HTMLButtonElement;
    expect(enableTicker.getAttribute('aria-checked')).toBe('false');
    await act(async () => {
      enableTicker.click();
    });
    expect(useAppRuntimeStore.getState().pluginChrome.ticker.enabled).toBe(true);
    expect(useAppRuntimeStore.getState().pinnedPluginIds).toEqual(['ticker']);

    const enableKanban = Array.from(container.querySelectorAll('button[role="switch"]')).find(
      (button) => button.getAttribute('aria-label') === '启用' && button.closest('div')?.textContent?.includes('看板'),
    ) as HTMLButtonElement;
    await act(async () => {
      enableKanban.click();
    });
    expect(useAppRuntimeStore.getState().pluginChrome.kanban.enabled).toBe(true);
    expect(useAppRuntimeStore.getState().pluginChrome.kanban.visible).toBe(false);
    expect(useAppRuntimeStore.getState().pinnedPluginIds).toEqual(['ticker']);
  });
});
