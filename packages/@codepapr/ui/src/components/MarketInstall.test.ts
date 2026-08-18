// @vitest-environment jsdom

import { describe, expect, it, vi, afterEach } from 'vitest';
import { sanitizeMcpToolPart } from '../utils/mcpTypes';
import { isListingInstalled } from './McpMarketModal';
import { confirmSkillOverwrite, confirmSkillUninstall } from './SkillMarketModal';
import type { MarketMCPListing } from '../utils/mcpMarketTypes';

function mcpListing(overrides: Partial<MarketMCPListing>): MarketMCPListing {
  return {
    id: '',
    name: '@modelcontextprotocol/server-filesystem',
    title: 'Filesystem',
    description: '',
    transport: { type: 'stdio' },
    envVars: [],
    categories: ['custom'],
    needsManualConfig: false,
    manualConfigNote: '',
    command: 'npx',
    args: '',
    url: '',
    ...overrides,
  } as MarketMCPListing;
}

describe('isListingInstalled（N20 MCP 已安装判定）', () => {
  it('含特殊字符的服务名通过同源消毒匹配（不再永远显示未安装）', () => {
    const name = '@modelcontextprotocol/server-filesystem';
    // 安装时 normalizeMcpServer 生成的 id = sanitizeMcpToolPart(name).toLowerCase()
    const installedIds = new Set([sanitizeMcpToolPart(name).toLowerCase()]);

    expect(isListingInstalled(installedIds, mcpListing({ id: '', name }))).toBe(true);
  });

  it('按 listing.id 原始值匹配', () => {
    const installedIds = new Set(['filesystem']);
    expect(isListingInstalled(installedIds, mcpListing({ id: 'filesystem' }))).toBe(true);
  });

  it('listing.id 消毒后匹配（含特殊字符的 id）', () => {
    const id = '@scope/filesystem';
    const installedIds = new Set([sanitizeMcpToolPart(id).toLowerCase()]);
    expect(isListingInstalled(installedIds, mcpListing({ id }))).toBe(true);
  });

  it('未安装时返回 false', () => {
    const installedIds = new Set(['other-server']);
    expect(isListingInstalled(installedIds, mcpListing({}))).toBe(false);
  });
});

describe('confirmSkillOverwrite（N20 Skill 重装覆盖确认）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('确认文案包含技能标题并返回用户选择', () => {
    let captured = '';
    vi.spyOn(window, 'confirm').mockImplementation((message?: string) => {
      captured = message ?? '';
      return true;
    });

    expect(confirmSkillOverwrite('zh-CN', '文章插画')).toBe(true);
    expect(captured).toContain('文章插画');
    expect(captured).toContain('覆盖本地修改');
  });

  it('用户取消时返回 false（不覆盖）', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    expect(confirmSkillOverwrite('en', 'Article Illustrator')).toBe(false);
  });
});

describe('confirmSkillUninstall', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('确认文案包含技能标题', () => {
    let captured = '';
    vi.spyOn(window, 'confirm').mockImplementation((message?: string) => {
      captured = message ?? '';
      return true;
    });
    expect(confirmSkillUninstall('zh-CN', '文章插画')).toBe(true);
    expect(captured).toContain('文章插画');
    expect(captured).toContain('卸载');
  });
});
