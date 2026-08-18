// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppPermissionsTab } from './AppPermissionsTab';
import { useAppRuntimeStore } from '../store/appRuntimeStore';
import type { PaprAppSettings } from '@codepapr/types';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function makeSettings(overrides: Partial<PaprAppSettings> = {}): PaprAppSettings {
  return {
    defaultLocal: 'none',
    defaultNetwork: false,
    appOverrides: {},
    ...overrides,
  };
}

describe('AppPermissionsTab', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useAppRuntimeStore.setState({
      apps: [{
        appId: 'notes',
        title: 'Notes',
        icon: '📝',
        html: '',
        filePath: '/ws/.CodePapr/apps/notes/index.html',
        createdAt: 1,
        updatedAt: 1,
        manifestJson: JSON.stringify({ local: 'read', network: false }),
      }],
      activeAppId: 'notes',
      openedAppId: null,
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    useAppRuntimeStore.setState({ apps: [], activeAppId: null, openedAppId: null });
  });

  it('本地下拉只列出不超过声明的档位；离线 app 的网络开关禁用', () => {
    act(() => {
      root.render(
        <AppPermissionsTab lang="zh-CN" value={makeSettings()} onChange={() => {}} />,
      );
    });

    const select = container.querySelector('select');
    const options = Array.from(select?.querySelectorAll('option') ?? []).map((el) => el.getAttribute('value'));
    expect(options).toEqual(['auto', 'none', 'read']);
    expect(options).not.toContain('write');

    const networkSwitch = container.querySelector('button[role="switch"][aria-disabled="true"]');
    expect(networkSwitch).toBeTruthy();
    expect((networkSwitch as HTMLButtonElement).disabled).toBe(true);
  });
});
