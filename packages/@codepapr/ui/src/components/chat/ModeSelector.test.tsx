// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModeSelector } from './ModeSelector';
import { getTranslation } from '../../utils/i18n';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('ModeSelector (D-5)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('中文界面显示 i18n appMode 文案而非硬编码 "App"', async () => {
    await act(async () => {
      root.render(
        <ModeSelector mode="app" setMode={() => {}} isLoading={false} lang="zh-CN" sessionLock="app" />,
      );
    });
    expect(container.textContent).toContain(getTranslation('zh-CN').appMode);
    expect(container.textContent).not.toContain('App');
  });

  it('锁定态 title 走 i18n 键；解锁态 title 展示当前模式', async () => {
    await act(async () => {
      root.render(
        <ModeSelector mode="agent" setMode={() => {}} isLoading={false} lang="en" sessionLock={null} />,
      );
    });
    const button = container.querySelector('button');
    const t = getTranslation('en');
    expect(button?.getAttribute('title')).toBe(`${t.currentMode}: ${t.agentMode}`);

    await act(async () => {
      root.render(
        <ModeSelector mode="agent" setMode={() => {}} isLoading={false} lang="en" sessionLock="coding" />,
      );
    });
    expect(container.querySelector('button')?.getAttribute('title')).toBe(t.codingModeLockedHint);
  });
});
