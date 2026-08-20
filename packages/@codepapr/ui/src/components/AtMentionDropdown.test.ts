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
});
