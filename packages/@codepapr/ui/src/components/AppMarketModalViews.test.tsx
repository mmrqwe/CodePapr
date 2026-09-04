// @vitest-environment jsdom

import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppListingCard } from './AppMarketModalViews';
import { copy } from './AppMarketModalCopy';
import type { PaprAppListing } from '../utils/marketAppTypes';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const listing: PaprAppListing = {
  id: 'demo-app',
  name: 'Demo',
  title: '演示',
  version: '1.0.0',
  description: 'desc',
  kind: 'app',
  tags: [],
  directory: 'apps/demo-app',
};

const noop = vi.fn();

describe('AppListingCard 双作用域角标 (D-14)', () => {
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

  async function renderCard(props: Partial<ComponentProps<typeof AppListingCard>> = {}) {
    const c = copy('en');
    await act(async () => {
      root.render(
        <AppListingCard
          listing={listing}
          installedScope="workspace"
          isInstalling={false}
          isUninstalling={false}
          onSelect={noop}
          onInstall={noop}
          onUninstall={noop}
          workspaceOpen
          c={c}
          lang="en"
          {...props}
        />,
      );
    });
    return c;
  }

  it('同名双装：项目 + 全局两个角标同时呈现', async () => {
    const c = await renderCard({
      installedScopes: { global: true, workspace: true },
    });
    expect(container.textContent).toContain(c.installedGlobal);
    expect(container.textContent).toContain(c.installedWorkspace);
  });

  it('单作用域沿用单角标', async () => {
    const c = await renderCard({ installedScopes: { global: false, workspace: true } });
    expect(container.textContent).toContain(c.installedWorkspace);
    expect(container.textContent).not.toContain(c.installedGlobal);
  });

  it('可更新角标优先于作用域角标', async () => {
    const c = await renderCard({
      hasUpdate: true,
      installedScopes: { global: true, workspace: true },
    });
    expect(container.textContent).toContain(c.updateAvailable);
  });
});
