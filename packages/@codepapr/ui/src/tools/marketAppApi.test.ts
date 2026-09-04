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

  it('D-3 脏条目过滤不炸列表；可选字段归一（tags/kind）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = {
      version: '1.0',
      name: 'X',
      description: '',
      repository: '',
      updatedAt: '',
      apps: [
        null,
        'not-an-object',
        { id: 'no-dir', version: '1.0.0', tags: [] },
        { id: 'no-version', directory: 'apps/x', tags: [] },
        { id: 'bad-kind', version: '1.0.0', directory: 'apps/k', kind: 'widget', tags: [] },
        { id: 'bad-tags', version: '1.0.0', directory: 'apps/t', tags: 'tools' },
        { id: 'bad-sha', version: '1.0.0', directory: 'apps/s', sha256: ['a'] },
        { id: 'plain-app', version: '1.0.0', directory: 'apps/p' },
        { id: 'ok', version: '2.0.0', directory: 'apps/o', tags: ['fun'] },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => registry })),
    );

    const apps = await fetchMarketAppListings({ forceRefresh: true });
    expect(apps.map((a) => a.id)).toEqual(['plain-app', 'ok']);
    expect(apps[0].tags).toEqual([]);
    expect(apps[0].kind).toBe('app');
    expect(apps[1].tags).toEqual(['fun']);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
