import type { SkillMarketListing } from '../utils/marketSkillTypes';
import { cacheGet, cacheSet } from '../utils/cacheStorage';

const AGENTUSE_REPO = 'zerone-agent/agent-use-skills';
const INTROS_PATH = 'awesome-skills/introductions/en';

interface GitHubFileEntry {
  name: string;
  path: string;
  sha: string;
  size: number;
  url: string;
  html_url: string;
  git_url: string;
  download_url: string | null;
  type: string;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { Accept: 'text/plain' },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.text();
}

function parseMarkdownIntro(markdown: string, filename: string): SkillMarketListing | null {
  const id = filename.replace(/\.md$/, '');
  const lines = markdown.split('\n');

  let title = '';
  let description = '';
  let sourceRepo = '';
  let websiteUrl = '';
  const tags: string[] = [];
  const features: string[] = [];
  let verified = false;
  let inFeatures = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('# ') && i === 0) {
      title = line.slice(2).trim();
      continue;
    }

    if (line.startsWith('**') && line.endsWith('**') && !title && i <= 2) {
      title = line.replace(/\*\*/g, '').trim();
      continue;
    }

    if (line.startsWith('## Tags')) {
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const tagLine = lines[j]?.trim();
        if (!tagLine) continue;
        if (tagLine.startsWith('#')) break;
        for (const part of tagLine.split('|')) {
          const cleaned = part.replace(/[|*]/g, '').replace(/[^\x20-\x7E\u4e00-\u9fff]+/g, '').trim();
          const skipWords = ['tag', 'verified', 'pending', 'verification', '✅', '🔍'];
          if (cleaned && !skipWords.some(w => cleaned.toLowerCase().includes(w))) {
            tags.push(cleaned.toLowerCase());
          }
        }
        if (tagLine.includes('✅ Verified')) verified = true;
        if (tagLine.includes('🔍 Pending') || tagLine.includes('Pending Verification')) verified = false;
      }
      continue;
    }

    if (!description && line.length > 10 && !line.startsWith('#') && !line.startsWith('**Tags') && !line.startsWith('-') && !line.startsWith('##') && !line.startsWith('|')) {
      if (line.startsWith('**') && line.endsWith('**')) {
        const inner = line.slice(2, -2).trim();
        const colonIdx = inner.indexOf(':');
        if (colonIdx > 0 && inner.slice(0, colonIdx).length < 15) {
          description = inner.slice(colonIdx + 1).trim();
        } else {
          description = inner;
        }
      } else if (description.length < 20 && line.length > 20) {
        description = line;
      }
    }

    if (line.includes('## Key Features') || line.includes('## Key Features & Workflow')) {
      inFeatures = true;
      continue;
    }
    if (inFeatures && line.startsWith('## ') && !line.includes('Key Feature')) {
      inFeatures = false;
      continue;
    }
    if (inFeatures && line.match(/^\d+\.\s+/)) {
      features.push(line.replace(/^\d+\.\s+/, '').trim());
    }

    if (line.includes('github.com/') && !line.includes('agent-use-skills')) {
      const match = line.match(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/);
      if (match) {
        sourceRepo = `https://github.com/${match[1]}`;
      }
    }

    if (line.includes('website') || line.includes('Website') || line.includes('Official')) {
      const match = line.match(/\(https?:\/\/(?!github\.com)[^)]+\)/);
      if (match) {
        websiteUrl = match[0].slice(1, -1);
      }
    }
  }

  if (!title) title = id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  const isPlugin =
    markdown.toLowerCase().includes('claude code plugin') ||
    markdown.toLowerCase().includes('plugin install') ||
    markdown.toLowerCase().includes('must be installed through the official plugin system');

  return {
    id,
    name: id,
    title,
    description: description || `${title} - AI agent skill available on AgentUse Market.`,
    tags,
    verified: verified || markdown.includes('✅ Verified'),
    sourceRepo: sourceRepo || `https://github.com/${AGENTUSE_REPO}`,
    websiteUrl,
    features,
    isPlugin,
  };
}

export async function fetchSkillListings(): Promise<SkillMarketListing[]> {
  const ck = 'codepapr.skillmarket.listings';
  const cached = await cacheGet<SkillMarketListing[]>(ck);
  if (cached) return cached;

  const apiUrl = `https://api.github.com/repos/${AGENTUSE_REPO}/contents/${INTROS_PATH}`;
  const entries = await fetchJson<GitHubFileEntry[]>(apiUrl);
  const mdFiles = entries.filter((e) => e.name.endsWith('.md'));

  const listings: SkillMarketListing[] = [];
  const fetchPromises = mdFiles.map(async (entry) => {
    try {
      if (!entry.download_url) return;
      const content = await fetchText(entry.download_url);
      const listing = parseMarkdownIntro(content, entry.name);
      if (listing) {
        listings.push(listing);
      }
    } catch {
      // skip failed fetches
    }
  });

  await Promise.all(fetchPromises);

  const sorted = listings.sort((a, b) => {
    if (a.verified !== b.verified) return a.verified ? -1 : 1;
    return a.title.localeCompare(b.title);
  });

  await cacheSet(ck, sorted, 5 * 60 * 1000);
  return sorted;
}

export function searchSkills(listings: SkillMarketListing[], query: string): SkillMarketListing[] {
  if (!query.trim()) return listings;
  const q = query.toLowerCase().trim();
  return listings.filter(
    (item) =>
      item.title.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q) ||
      item.tags.some((t) => t.includes(q)),
  );
}
