import { describe, expect, it } from 'vitest';
import type { AppInstance } from '../store/appRuntimeStore';
import {
  MAX_PUBLISH_CATALOG_CHANNELS,
  MAX_PUBLISH_CATALOG_TARGETS,
  MAX_PUBLISH_EXAMPLE_CHARS,
  buildPublishCatalogSection,
  collectPublishCatalogTargets,
  compactPublishJson,
  publishCatalogSignature,
} from './pluginPublishCatalog';

function app(partial: Partial<AppInstance> & { appId: string; manifest: unknown }): AppInstance {
  return {
    title: partial.title ?? partial.appId,
    html: '',
    filePath: `.CodePapr/apps/${partial.appId}/index.html`,
    createdAt: 1,
    updatedAt: 1,
    manifestJson: JSON.stringify(partial.manifest),
    ...partial,
  };
}

describe('pluginPublishCatalog', () => {
  it('omits enabled plugins that have no inbox', () => {
    const ticker = app({
      appId: 'stock-ticker',
      title: '股票',
      manifest: { spec: 'papr/0.1', name: '股票', kind: 'plugin' },
    });
    expect(
      collectPublishCatalogTargets({
        apps: [ticker],
        pluginChrome: { 'stock-ticker': { enabled: true } },
      }),
    ).toEqual([]);
  });

  it('includes enabled plugins with inbox even when overlay is hidden', () => {
    const canvas = app({
      appId: 'arch-canvas',
      title: '架构画布',
      manifest: {
        spec: 'papr/0.1',
        name: '架构画布',
        kind: 'plugin',
        inbox: { scene: { description: '整幅替换画布', example: { op: 'replace' } } },
      },
    });
    const hidden = app({
      appId: 'hidden-board',
      title: '隐藏看板',
      manifest: {
        spec: 'papr/0.1',
        name: '隐藏看板',
        kind: 'plugin',
        inbox: { cards: { description: '卡片' } },
      },
    });
    const targets = collectPublishCatalogTargets({
      apps: [canvas, hidden],
      pluginChrome: {
        'arch-canvas': { enabled: true },
        'hidden-board': { enabled: false },
      },
    });
    expect(targets.map((t) => t.appId)).toEqual(['arch-canvas']);
  });

  it('includes fullscreen apps with inbox even when not pinned', () => {
    const board = app({
      appId: 'team-board',
      title: '团队看板',
      manifest: {
        spec: 'papr/0.1',
        name: '团队看板',
        inbox: { cards: { description: '看板卡片', example: { op: 'add' } } },
      },
    });
    const targets = collectPublishCatalogTargets({ apps: [board] });
    expect(targets).toHaveLength(1);
    expect(targets[0]?.kind).toBe('app');
    expect(targets[0]?.inbox[0]?.channel).toBe('cards');
  });

  it('caps targets and extra channels', () => {
    const plugins = Array.from({ length: MAX_PUBLISH_CATALOG_TARGETS + 2 }, (_, i) =>
      app({
        appId: `p${i}`,
        title: `P${i}`,
        manifest: {
          spec: 'papr/0.1',
          name: `P${i}`,
          kind: 'plugin',
          inbox: Object.fromEntries(
            Array.from({ length: MAX_PUBLISH_CATALOG_CHANNELS + 2 }, (__, c) => [
              `ch${c}`,
              { description: `频道 ${c}` },
            ]),
          ),
        },
      }),
    );
    const targets = collectPublishCatalogTargets({
      apps: plugins,
      pluginChrome: Object.fromEntries(plugins.map((item) => [item.appId, { enabled: true }])),
    });
    expect(targets).toHaveLength(MAX_PUBLISH_CATALOG_TARGETS);
    expect(targets[0]?.inbox).toHaveLength(MAX_PUBLISH_CATALOG_CHANNELS);
    expect(targets[0]?.extraChannelCount).toBe(2);
  });

  it('truncates oversized examples', () => {
    const huge = { nodes: Array.from({ length: 80 }, (_, i) => ({ id: `n${i}`, label: `Node ${i}` })) };
    const compact = compactPublishJson(huge);
    expect(compact).toBeDefined();
    expect(compact!.length).toBeLessThanOrEqual(MAX_PUBLISH_EXAMPLE_CHARS);
    expect(compact!.endsWith('…')).toBe(true);
  });

  it('builds a short session section and omits empty catalogs', () => {
    expect(buildPublishCatalogSection([], 'zh-CN')).toBe('');
    const section = buildPublishCatalogSection(
      [
        {
          appId: 'arch-canvas',
          title: '架构画布',
          kind: 'plugin',
          inbox: [{ channel: 'scene', description: '整幅替换画布', example: { op: 'replace' } }],
          extraChannelCount: 0,
        },
      ],
      'zh-CN',
    );
    expect(section).toContain('## 已启用插件');
    expect(section).toContain('`arch-canvas`');
    expect(section).toContain('scene：整幅替换画布');
    expect(section).toContain('例 {"op":"replace"}');
    expect(section).not.toContain('app_list');
  });

  it('changes signature when inbox example changes', () => {
    const a: ReturnType<typeof collectPublishCatalogTargets> = [
      {
        appId: 'arch-canvas',
        title: '架构画布',
        kind: 'plugin',
        inbox: [{ channel: 'scene', example: { op: 'replace' } }],
        extraChannelCount: 0,
      },
    ];
    const b = [
      {
        ...a[0]!,
        inbox: [{ channel: 'scene', example: { op: 'patch' } }],
      },
    ];
    expect(publishCatalogSignature(a)).not.toBe(publishCatalogSignature(b));
  });
});
