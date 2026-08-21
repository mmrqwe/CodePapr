import type { PromptLang } from '@codepapr/core';
import type { AppInstance } from '../store/appRuntimeStore';
import { isPluginApp, readAppManifest } from './pluginSurface';
import { summarizeManifestInbox, type PaprInboxSummary } from '../tools/workspaceAppTools';

export const MAX_PUBLISH_CATALOG_TARGETS = 5;
export const MAX_PUBLISH_CATALOG_CHANNELS = 3;
export const MAX_PUBLISH_EXAMPLE_CHARS = 300;
export const MAX_PUBLISH_DESCRIPTION_CHARS = 80;

export interface PublishCatalogTarget {
  appId: string;
  title: string;
  kind: 'app' | 'plugin';
  inbox: PaprInboxSummary[];
  extraChannelCount: number;
}

export function compactPublishJson(value: unknown, maxChars: number = MAX_PUBLISH_EXAMPLE_CHARS): string | undefined {
  if (value === undefined) return undefined;
  try {
    const raw = JSON.stringify(value);
    if (raw.length <= maxChars) return raw;
    if (maxChars <= 1) return '…';
    return `${raw.slice(0, maxChars - 1)}…`;
  } catch {
    return undefined;
  }
}

export function compactPublishDescription(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= MAX_PUBLISH_DESCRIPTION_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_PUBLISH_DESCRIPTION_CHARS - 1)}…`;
}

/**
 * 只收集「可以推、值得进上下文」的目标：
 * - 已启用（pinned）且声明了 inbox 的 plugin
 * - 声明了 inbox 的全屏 app（dock 里的看板等）
 * 没有 inbox 的自刷新小组件不进目录。
 */
export function collectPublishCatalogTargets(state: {
  apps: readonly AppInstance[];
  pinnedPluginIds: readonly string[];
}): PublishCatalogTarget[] {
  const byId = new Map(state.apps.map((app) => [app.appId, app]));
  const out: PublishCatalogTarget[] = [];
  const seen = new Set<string>();

  const tryAdd = (app: AppInstance | undefined): void => {
    if (!app || seen.has(app.appId) || out.length >= MAX_PUBLISH_CATALOG_TARGETS) return;
    const inbox = summarizeManifestInbox(readAppManifest(app));
    if (!inbox || inbox.length === 0) return;
    seen.add(app.appId);
    out.push({
      appId: app.appId,
      title: app.title.trim() || app.appId,
      kind: isPluginApp(app) ? 'plugin' : 'app',
      inbox: inbox.slice(0, MAX_PUBLISH_CATALOG_CHANNELS),
      extraChannelCount: Math.max(0, inbox.length - MAX_PUBLISH_CATALOG_CHANNELS),
    });
  };

  for (const appId of state.pinnedPluginIds) {
    const app = byId.get(appId);
    if (app && isPluginApp(app)) tryAdd(app);
  }
  for (const app of state.apps) {
    if (!isPluginApp(app)) tryAdd(app);
  }
  return out;
}

export function publishCatalogSignature(targets: readonly PublishCatalogTarget[]): string {
  return JSON.stringify(
    targets.map((target) => ({
      appId: target.appId,
      inbox: target.inbox.map((channel) => ({
        channel: channel.channel,
        description: compactPublishDescription(channel.description) ?? '',
        example: compactPublishJson(channel.example) ?? '',
      })),
    })),
  );
}

export function buildPublishCatalogSection(
  targets: readonly PublishCatalogTarget[],
  lang: PromptLang = 'zh-CN',
): string {
  if (targets.length === 0) return '';

  const title =
    lang === 'en' ? '## Enabled plugins' : lang === 'zh-TW' ? '## 已啟用外掛' : '## 已启用插件';
  const intro =
    lang === 'en'
      ? 'These are the current publish targets (enabled overlays / apps that declared `inbox`). After related work, call `app_publish({ appId, channel, payload })` using the contract below. Do not publish to plugins that are not listed, and do not invent channels.'
      : lang === 'zh-TW'
        ? '以下是目前可推送目標（已啟用且宣告了 inbox 的 overlay / 應用）。相關工作結束時用 `app_publish({ appId, channel, payload })` 按契約推送。未列出的外掛不要推，也不要 invent 頻道。'
        : '以下是当前可推送目标（已启用且声明了 inbox 的 overlay / 应用）。相关工作结束时用 `app_publish({ appId, channel, payload })` 按契约推送。未列出的插件不要推，也不要 invent 频道。';
  const extraChannels =
    lang === 'en' ? 'more channels' : lang === 'zh-TW' ? '個頻道未列出' : ' 个频道未列出';
  const exampleLabel = lang === 'en' ? 'ex' : '例';

  const lines: string[] = [title, intro, ''];
  for (const target of targets) {
    lines.push(`- \`${target.appId}\`（${target.title}）`);
    for (const channel of target.inbox) {
      const description = compactPublishDescription(channel.description);
      const example = compactPublishJson(channel.example);
      const head = description ? `${channel.channel}：${description}` : channel.channel;
      lines.push(`  - ${head}`);
      if (example) lines.push(`    ${exampleLabel} ${example}`);
    }
    if (target.extraChannelCount > 0) {
      lines.push(
        lang === 'en'
          ? `  - … +${target.extraChannelCount} ${extraChannels}`
          : `  - … +${target.extraChannelCount}${extraChannels}`,
      );
    }
  }
  return lines.join('\n');
}
