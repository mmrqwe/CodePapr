import { describe, expect, it } from 'vitest';
import type { SkillMarketListing } from '../utils/marketSkillTypes';
import { listSkillTags, searchSkills } from './marketSkillApi';

function listing(overrides: Partial<SkillMarketListing>): SkillMarketListing {
  return {
    id: 'search',
    name: 'search',
    title: 'Search',
    description: 'Look things up',
    tags: ['productivity'],
    verified: true,
    sourceRepo: 'https://github.com/acme/search',
    websiteUrl: '',
    features: [],
    isPlugin: false,
    ...overrides,
  };
}

describe('searchSkills', () => {
  const listings = [
    listing({ id: 'search', title: 'Search', tags: ['productivity'] }),
    listing({
      id: 'illustrator',
      name: 'illustrator',
      title: 'Article Illustrator',
      description: 'Draw cover art',
      tags: ['design', 'documents'],
    }),
  ];

  it('filters by a tag that is actually present on listings', () => {
    expect(searchSkills(listings, '', 'design').map((item) => item.id)).toEqual(['illustrator']);
  });

  it('combines text query with tag filter', () => {
    expect(searchSkills(listings, 'article', 'design')).toHaveLength(1);
    expect(searchSkills(listings, 'article', 'productivity')).toHaveLength(0);
  });

  it('lists unique tags from the catalog, not a fixed enum', () => {
    expect(listSkillTags(listings)).toEqual(['design', 'documents', 'productivity']);
  });
});
