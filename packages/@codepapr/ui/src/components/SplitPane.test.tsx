// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SplitPane } from './SplitPane';

describe('SplitPane', () => {
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

  it('resets the pane ratio when defaultRatio changes (no remount needed)', async () => {
    const render = async (defaultRatio: number) => {
      await act(async () => {
        root.render(
          <SplitPane
            direction="vertical"
            defaultRatio={defaultRatio}
            minFirstSize={100}
            minSecondSize={100}
            first={<div data-testid="first" />}
            second={<div data-testid="second" />}
          />
        );
      });
    };

    await render(0.7);
    const firstPane = container.querySelector('[data-testid="first"]')?.parentElement;
    expect(firstPane).toBeTruthy();
    expect(firstPane?.style.flexBasis).toContain('70');

    // defaultRatio 改变：比例必须重置（旧实现靠改 key 重挂载实现同样效果）
    await render(0.4);
    const firstPaneAfter = container.querySelector('[data-testid="first"]')?.parentElement;
    expect(firstPaneAfter?.style.flexBasis).toContain('40');
  });

  it('hides the separator and lets the second pane shrink to content when hideSeparator is true', async () => {
    await act(async () => {
      root.render(
        <SplitPane
          direction="vertical"
          defaultRatio={0.5}
          minFirstSize={100}
          minSecondSize={100}
          hideSeparator
          first={<div data-testid="first" />}
          second={<div data-testid="second" />}
        />
      );
    });

    expect(container.querySelector('[role="separator"]')).toBeNull();
    const firstPane = container.querySelector('[data-testid="first"]')?.parentElement;
    const secondPane = container.querySelector('[data-testid="second"]')?.parentElement;
    expect(firstPane?.className).toContain('flex-1');
    expect(secondPane?.className).toContain('shrink-0');

    await act(async () => {
      root.render(
        <SplitPane
          direction="vertical"
          defaultRatio={0.5}
          minFirstSize={100}
          minSecondSize={100}
          first={<div data-testid="first" />}
          second={<div data-testid="second" />}
        />
      );
    });

    expect(container.querySelector('[role="separator"]')).not.toBeNull();
    const secondPaneVisible = container.querySelector('[data-testid="second"]')?.parentElement;
    expect(secondPaneVisible?.className).toContain('flex-1');
  });
});
