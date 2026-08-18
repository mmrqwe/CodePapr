import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEARCH_SKILL_TEMPLATE,
  applySkillEnablement,
  buildSkillsSection,
  isSkillAvailableToLoad,
  parseSkillMarkdown,
} from '../src/agent/skillConfig';

describe('skillConfig', () => {
  it('parses skill frontmatter and prompt body', () => {
    const skill = parseSkillMarkdown(
      'search',
      '---\nname 网页搜索\ndescription 搜索资料\nenabled: false\n---\n按官方文档优先。'
    );

    expect(skill).toEqual({
      name: '网页搜索',
      description: '搜索资料',
      prompt: '按官方文档优先。',
    });
  });

  it('builds a compact skill catalog for bootstrap context', () => {
    const section = buildSkillsSection(
      applySkillEnablement([
      parseSkillMarkdown('search', '---\ndescription: 搜索资料\n---\n官方优先。'),
      {
        ...parseSkillMarkdown(
          'article-illustrator',
          '---\nname: 文章配图\ndescription: 生成文章配图\n---\n生成配图流程。'
        ),
        id: 'suite/article-illustrator',
        displayName: 'article-illustrator',
      },
      {
        ...parseSkillMarkdown('release-check', '---\ndescription: 发布检查\nenabled: false\n---\n逐项验证。'),
        id: 'release-check',
      },
      ], { 'release-check': false })
    );

    expect(section).toContain('## 项目 Skills');
    expect(section).toContain('`search`: 搜索资料');
    expect(section).toContain('`suite/article-illustrator` (文章配图): 生成文章配图');
    expect(section).not.toContain('`release-check`');
    expect(section).not.toContain('官方优先。');
    expect(section).not.toContain('生成配图流程');
  });

  it('refuses skill_load for a catalog skill that is disabled', () => {
    const skills = applySkillEnablement(
      [
        {
          ...parseSkillMarkdown('search', '---\ndescription: 搜索\n---\n正文'),
          id: 'search',
          sourcePath: '.CodePapr/skills/search/SKILL.md',
        },
      ],
      { search: false }
    );

    expect(isSkillAvailableToLoad('search', skills)).toBe(false);
    expect(isSkillAvailableToLoad('.CodePapr/skills/search/SKILL.md', skills)).toBe(false);
    expect(isSkillAvailableToLoad('docs', skills)).toBe(true);
  });

  it('ships a practical default search skill', () => {
    const skill = parseSkillMarkdown('search', DEFAULT_SEARCH_SKILL_TEMPLATE);

    expect(skill.prompt).toContain('site:');
    expect(skill.prompt).toContain('GitHub issues');
    expect(skill.description).toContain('公开网页');
    expect(skill.name).toBe('search');
    expect(skill.enabled).toBeUndefined();
    expect(DEFAULT_SEARCH_SKILL_TEMPLATE).toContain('name: search');
    expect(DEFAULT_SEARCH_SKILL_TEMPLATE).not.toContain('enabled:');
  });
});
