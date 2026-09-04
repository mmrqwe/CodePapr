import { describe, expect, it } from 'vitest';
import { sha256 } from '@codepapr/common';
import {
  buildLockEntry,
  collectDefinitionIds,
  collectOverwriteCandidates,
  collectUninstallSkillIds,
  emptySkillsLock,
  isSkillListingInstalled,
  parseSkillsLock,
  pruneSkillFromLock,
  removeListingFromLock,
  serializeSkillsLock,
  skillMarkdownPath,
  upsertLockEntry,
} from './skillsLock';

const PLUGIN_LISTING = { id: 'design-suite', name: 'design-suite' };
const SIMPLE_LISTING = { id: 'search', name: 'search' };

function pluginLock() {
  return {
    version: 1 as const,
    skills: {
      'design-suite': {
        listingId: 'design-suite',
        listingName: 'design-suite',
        source: 'acme/design-skills',
        sourceType: 'github' as const,
        sourceRepo: 'https://github.com/acme/design-skills',
        skillIds: ['illustrator', 'palette'],
        files: {
          [skillMarkdownPath('illustrator')]: 'aaa',
          [skillMarkdownPath('palette')]: 'bbb',
        },
        installedAt: 1,
      },
    },
  };
}

describe('skillsLock', () => {
  it('parses lock entries and ignores malformed cards', () => {
    const lock = parseSkillsLock(
      JSON.stringify({
        version: 1,
        skills: {
          search: {
            listingId: 'search',
            listingName: 'search',
            source: 'zerone-agent/agent-use-skills',
            sourceType: 'github',
            sourceRepo: 'https://github.com/zerone-agent/agent-use-skills',
            skillIds: ['search'],
            files: { [skillMarkdownPath('search')]: 'abc' },
            installedAt: 9,
          },
          broken: { listingId: 'broken' },
        },
      })
    );

    expect(Object.keys(lock.skills)).toEqual(['search']);
    expect(lock.skills.search?.skillIds).toEqual(['search']);
  });

  it('round-trips serialize/parse', () => {
    const entry = buildLockEntry({
      listingId: 'design-suite',
      listingName: 'design-suite',
      sourceRepo: 'https://github.com/acme/design-skills',
      skillFiles: [
        { skillId: 'illustrator', relativePath: skillMarkdownPath('illustrator'), content: '# a' },
      ],
      installedAt: 42,
    });
    const parsed = parseSkillsLock(serializeSkillsLock(upsertLockEntry(emptySkillsLock(), entry)));
    expect(parsed.skills['design-suite']?.files[skillMarkdownPath('illustrator')]).toBe(sha256('# a'));
    expect(parsed.skills['design-suite']?.source).toBe('acme/design-skills');
    expect(parsed.skills['design-suite']?.installedAt).toBe(42);
  });

  it('treats a plugin listing as installed via lock sub-skill ids, not the card id', () => {
    const definitionIds = collectDefinitionIds([
      { id: 'illustrator', name: 'illustrator' },
      { id: 'palette', name: 'palette' },
    ]);

    expect(isSkillListingInstalled(PLUGIN_LISTING, pluginLock(), definitionIds)).toBe(true);
    expect(isSkillListingInstalled(PLUGIN_LISTING, pluginLock(), new Set())).toBe(false);
    expect(isSkillListingInstalled(PLUGIN_LISTING, emptySkillsLock(), definitionIds)).toBe(false);
  });

  it('falls back to listing name when there is no lock (legacy single-pack install)', () => {
    expect(
      isSkillListingInstalled(SIMPLE_LISTING, emptySkillsLock(), collectDefinitionIds([{ id: 'search' }]))
    ).toBe(true);
    expect(
      isSkillListingInstalled(SIMPLE_LISTING, emptySkillsLock(), collectDefinitionIds([{ id: 'other' }]))
    ).toBe(false);
  });

  it('ignores frontmatter name so user-renamed skills never masquerade as market installs', () => {
    const definitionIds = collectDefinitionIds([{ id: 'my-notes', name: 'search' }]);
    expect(definitionIds.has('search')).toBe(false);
    expect(isSkillListingInstalled(SIMPLE_LISTING, emptySkillsLock(), definitionIds)).toBe(false);
  });

  it('stops showing installed after every locked sub-skill is gone', () => {
    const afterDelete = pruneSkillFromLock(
      pruneSkillFromLock(pluginLock(), 'illustrator'),
      'palette'
    );
    expect(afterDelete.skills).toEqual({});
    expect(
      isSkillListingInstalled(
        PLUGIN_LISTING,
        afterDelete,
        collectDefinitionIds([])
      )
    ).toBe(false);
  });

  it('keeps the parent listing installed while any locked sub-skill remains', () => {
    const afterOneDelete = pruneSkillFromLock(pluginLock(), 'illustrator');
    expect(afterOneDelete.skills['design-suite']?.skillIds).toEqual(['palette']);
    expect(
      isSkillListingInstalled(
        PLUGIN_LISTING,
        afterOneDelete,
        collectDefinitionIds([{ id: 'palette' }])
      )
    ).toBe(true);
  });

  it('overwrite candidates include planned sub-skill paths, not only listing.name', () => {
    const paths = collectOverwriteCandidates(PLUGIN_LISTING, emptySkillsLock(), ['illustrator', 'palette']);
    expect(paths).toContain(skillMarkdownPath('design-suite'));
    expect(paths).toContain(skillMarkdownPath('illustrator'));
    expect(paths).toContain(skillMarkdownPath('palette'));
  });

  it('overwrite candidates include previously locked files', () => {
    const paths = collectOverwriteCandidates(PLUGIN_LISTING, pluginLock(), []);
    expect(paths).toContain(skillMarkdownPath('illustrator'));
    expect(paths).toContain(skillMarkdownPath('palette'));
  });

  it('uninstall targets plugin sub-skills from the lock, not the card id', () => {
    expect(
      collectUninstallSkillIds(
        PLUGIN_LISTING,
        pluginLock(),
        collectDefinitionIds([{ id: 'illustrator' }, { id: 'palette' }])
      )
    ).toEqual(['illustrator', 'palette']);
  });

  it('uninstall falls back to listing name for a legacy single-pack install', () => {
    expect(
      collectUninstallSkillIds(
        SIMPLE_LISTING,
        emptySkillsLock(),
        collectDefinitionIds([{ id: 'search' }])
      )
    ).toEqual(['search']);
  });

  it('removeListingFromLock drops the whole plugin entry', () => {
    expect(removeListingFromLock(pluginLock(), PLUGIN_LISTING).skills).toEqual({});
  });

  it('rebuilds installed identity from current definitions instead of accumulating stale ids', () => {
    const staleIfMerged = new Set(['deleted-skill', 'search']);
    const definitionIds = collectDefinitionIds([{ id: 'search' }]);
    const installed = [...staleIfMerged].filter(
      (id) =>
        isSkillListingInstalled({ id, name: id }, emptySkillsLock(), definitionIds) ||
        definitionIds.has(id)
    );
    expect(installed).toEqual(['search']);
    expect(installed).not.toContain('deleted-skill');
  });
});
