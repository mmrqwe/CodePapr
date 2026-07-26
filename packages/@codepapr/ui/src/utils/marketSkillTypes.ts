export type SkillMarketTag = 'design' | 'documents' | 'dev' | 'testing' | 'automation' | 'productivity';

export interface SkillMarketListing {
  id: string;
  name: string;
  title: string;
  description: string;
  tags: string[];
  verified: boolean;
  sourceRepo: string;
  websiteUrl: string;
  features: string[];
  isPlugin: boolean;
}

export interface SkillMarketFetchResult {
  listings: SkillMarketListing[];
  error?: string;
}
