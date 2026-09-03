import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchMarketAppListings,
  fetchMarketAppRegistry,
  OFFICIAL_APPS_REGISTRY_URL,
} from './marketAppApi';

describe('marketAppApi', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches registry and returns apps listing', async () => {
    const mockRegistry = {
      version: '1.0',
      name: 'Test Market',
      description: 'Desc',
      repository: 'https://github.com/mmrqwe/codepapr-apps',
      updatedAt: '2026-08-30T00:00:00Z',
      apps: [
        {
          id: 'weather-hud',
          name: 'Weather HUD',
          title: '天气小组件',
          version: '0.1.1',
          description: '悬浮天气插件',
          kind: 'plugin',
          tags: ['tools', 'weather'],
          directory: 'apps/weather-hud',
          entry: 'index.html',
        },
      ],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toBe(OFFICIAL_APPS_REGISTRY_URL);
        return {
          ok: true,
          status: 200,
          json: async () => mockRegistry,
        };
      })
    );

    const registry = await fetchMarketAppRegistry({ forceRefresh: true });
    expect(registry.version).toBe('1.0');
    expect(registry.apps.length).toBe(1);

    const apps = await fetchMarketAppListings({ forceRefresh: true });
    expect(apps[0].id).toBe('weather-hud');
    expect(apps[0].kind).toBe('plugin');
  });
});
