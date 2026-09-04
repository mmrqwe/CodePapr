import { describe, expect, it } from 'vitest';
import { buildMentionItems } from './AtMentionDropdown';
import type { AgentDefinition, SkillDefinition } from '@codepapr/core';

const agent = (
  name: string,
  mode: AgentDefinition['mode'],
  extra: Partial<AgentDefinition> = {}
): AgentDefinition => ({
  name,
  description: name,
  mode,
  prompt: name,
  ...extra,
});

describe('buildMentionItems', () => {
  it('includes subagent, all, and primary; excludes internal and disabled mentor', () => {
    const agents: AgentDefinition[] = [
      agent('explore', 'subagent'),
      agent('helper', 'all'),
      agent('reviewer', 'primary'),
      agent('verifier', 'subagent', { internal: true }),
      agent('mentor', 'subagent', { model: 'mentor' }),
    ];
    const skills: SkillDefinition[] = [];
    const items = buildMentionItems(agents, skills, 'zh-CN', false);
    expect(items.map((item) => item.name)).toEqual(['explore', 'helper', 'reviewer']);
  });

  it('mentions skills by loadable catalog id, not the frontmatter name', () => {
    const skills: SkillDefinition[] = [
      {
        name: '文章配图',
        description: '生成配图',
        prompt: 'body',
        id: 'suite/article-illustrator',
        displayName: 'article-illustrator',
        enabled: true,
      },
      { name: 'search', description: '搜索', prompt: 'body', enabled: true },
      { name: '停用', description: 'x', prompt: 'body', id: 'off-skill', enabled: false },
    ];
    const items = buildMentionItems([], skills, 'zh-CN');
    expect(items.map((item) => item.name)).toEqual(['suite/article-illustrator', 'search']);
  });
});
