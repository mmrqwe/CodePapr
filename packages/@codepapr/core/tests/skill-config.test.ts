import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEARCH_SKILL_TEMPLATE,
  applySkillEnablement,
  buildSkillsSection,
  getDefaultSearchSkillTemplate,
  isSkillAvailableToLoad,
  parseSkillMarkdown,
  buildSkillCatalogSignature,
  resolveSkillCatalogName,
  skillRootFromPath,
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

  it('refuses loading when any same-named catalog entry is disabled', () => {
    const skills = applySkillEnablement(
      [
        { name: 'shared', description: 'a', prompt: 'p', id: 'alpha' },
        { name: 'shared', description: 'b', prompt: 'p', id: 'beta' },
      ],
      { beta: false }
    );

    // 共享 name 的两条中一条停用：按共享名查询必须拒绝，不能只看先命中的启用项。
    expect(isSkillAvailableToLoad('shared', skills)).toBe(false);
    // 精确 id 只命中启用项，仍然放行。
    expect(isSkillAvailableToLoad('alpha', skills)).toBe(true);
  });

  it('keeps indented key-like lines inside block scalars', () => {
    const skill = parseSkillMarkdown(
      'notes',
      '---\ndescription: |\n  step one\n  key: still content\nname: notes\n---\n正文。'
    );

    expect(skill.description).toBe('step one\nkey: still content');
    expect(skill.name).toBe('notes');
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

  it('localizes the default search skill template', () => {
    expect(getDefaultSearchSkillTemplate()).toBe(DEFAULT_SEARCH_SKILL_TEMPLATE);
    expect(getDefaultSearchSkillTemplate('zh-CN')).toContain('官方文档');

    const en = getDefaultSearchSkillTemplate('en');
    expect(en).toContain('name: search');
    expect(en).toContain('site:');
    expect(en).not.toMatch(/[\u4e00-\u9fff]/);

    const tw = getDefaultSearchSkillTemplate('zh-TW');
    expect(tw).toContain('name: search');
    expect(tw).toContain('搜尋');
    expect(tw).not.toContain('搜索');
  });

  it('derives the skill root the same way as the Rust host', () => {
    expect(skillRootFromPath('.CodePapr/skills/search/SKILL.md')).toBe('.CodePapr/skills/search');
    expect(skillRootFromPath('.CodePapr/skills/suite/illustrator/SKILL.md')).toBe(
      '.CodePapr/skills/suite/illustrator'
    );
    expect(skillRootFromPath('.CodePapr/skills/notes.md')).toBe('.CodePapr/skills/notes');
    // 目录名本身以 .md 结尾时不能被二次剥掉（旧实现的正则回归）。
    expect(skillRootFromPath('.CodePapr/skills/foo.md/SKILL.md')).toBe('.CodePapr/skills/foo.md');
    expect(skillRootFromPath('.CodePapr\\skills\\search\\SKILL.md')).toBe('.CodePapr/skills/search');
  });

  it('prefers the loadable id for catalog names', () => {
    expect(
      resolveSkillCatalogName({
        name: '文章配图',
        description: '',
        prompt: '',
        id: 'suite/article-illustrator',
        displayName: 'article-illustrator',
      })
    ).toBe('suite/article-illustrator');
    expect(resolveSkillCatalogName({ name: 'search', description: '', prompt: '' })).toBe('search');
  });

  it('catalog signature covers rendered fields only (prompt body / paths excluded)', () => {
    const base = {
      name: 'search',
      description: '搜索资料',
      prompt: '正文 v1',
      rootPath: '/Users/me/.CodePapr/skills/search',
    };
    const sig = buildSkillCatalogSignature([base]);
    // 正文编辑（经 skill_load 按需读取，不进 Bootstrap）不应拆缓存。
    expect(buildSkillCatalogSignature([{ ...base, prompt: '正文 v2' }])).toBe(sig);
    // 绝对路径漂移（换机器/换目录）不应拆缓存。
    expect(buildSkillCatalogSignature([{ ...base, rootPath: '/Users/you/x', sourcePath: '/other' }])).toBe(sig);
    // 描述 / 启用态 / 正文是否非空影响渲染，必须反映到签名。
    expect(buildSkillCatalogSignature([{ ...base, description: '改描述' }])).not.toBe(sig);
    expect(buildSkillCatalogSignature([{ ...base, enabled: false }])).not.toBe(sig);
    expect(buildSkillCatalogSignature([{ ...base, prompt: '  ' }])).not.toBe(sig);
    expect(buildSkillCatalogSignature([])).not.toBe(sig);
  });
});
