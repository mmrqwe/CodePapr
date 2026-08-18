import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isBinarySkillResource,
  packDirCandidates,
  previewSkillMarkdown,
  rawGithubUrl,
  resourceDirCandidates,
} from './marketSkillInstall';

describe('marketSkillInstall paths', () => {
  it('builds pack dir candidates that include skills/ and .CodePapr/skills/', () => {
    const dirs = packDirCandidates('article-illustrator');
    expect(dirs).toContain('skills/article-illustrator');
    expect(dirs).toContain('.CodePapr/skills/article-illustrator');
    expect(dirs).toContain('.claude/skills/article-illustrator');
    expect(dirs).toContain('article-illustrator');
  });

  it('looks up resources under the same pack dir as SKILL.md', () => {
    expect(resourceDirCandidates('skills/search')).toEqual([
      'skills/search/agents',
      'skills/search/references',
      'skills/search/templates',
      'skills/search/scripts',
    ]);
  });

  it('skips binary pack resources that write_text_file cannot store', () => {
    expect(isBinarySkillResource('icon.png')).toBe(true);
    expect(isBinarySkillResource('render.py')).toBe(false);
    expect(isBinarySkillResource('schema.json')).toBe(false);
  });

  it('points raw URLs at the resolved branch instead of always main', () => {
    expect(rawGithubUrl('acme/skills', 'develop', 'skills/foo/SKILL.md')).toBe(
      'https://raw.githubusercontent.com/acme/skills/develop/skills/foo/SKILL.md'
    );
  });
});

describe('previewSkillMarkdown', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a truncated SKILL.md preview from the catalog', async () => {
    const body = `# Search\n\n${'x'.repeat(9_000)}`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: String(url).includes('awesome-skills/skills/search/SKILL.md'),
        text: async () => body,
      }))
    );

    const preview = await previewSkillMarkdown('search', '');
    expect(preview?.startsWith('# Search')).toBe(true);
    expect(preview?.endsWith('…')).toBe(true);
    expect(preview?.length).toBeLessThan(body.length);
  });
});
