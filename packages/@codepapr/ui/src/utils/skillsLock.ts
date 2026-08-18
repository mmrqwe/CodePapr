/**
 * 项目级 Skill 市场安装锁：记录 listing id → 实际写入的 Skill 路径与 SHA-256。
 *
 * 插件包的市场卡片 id 往往不等于磁盘上的子 Skill 目录名；没有这张表，
 * 「已安装」会按卡片 id 对不上，重装也会漏掉子路径上的本地修改。
 */

import { sha256 } from '@codepapr/common';

export const SKILLS_LOCK_PATH = '.CodePapr/skills-lock.json';

export interface SkillLockFileEntry {
  listingId: string;
  listingName: string;
  source: string;
  sourceType: 'github';
  sourceRepo: string;
  skillIds: string[];
  files: Record<string, string>;
  installedAt: number;
}

export interface SkillsLockFile {
  version: 1;
  skills: Record<string, SkillLockFileEntry>;
}

export interface SkillListingRef {
  id: string;
  name: string;
}

export interface SkillCatalogRef {
  id?: string;
  name?: string;
}

export interface SkillLockInvoke {
  <T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

export function emptySkillsLock(): SkillsLockFile {
  return { version: 1, skills: {} };
}

export function skillMarkdownPath(skillId: string): string {
  return `.CodePapr/skills/${skillId}/SKILL.md`;
}

export function hashSkillContent(content: string): string {
  return sha256(content);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const files: Record<string, string> = {};
  for (const [path, hash] of Object.entries(value)) {
    if (typeof hash === 'string' && hash.trim() && path.trim()) {
      files[path] = hash;
    }
  }
  return files;
}

function parseSkillIds(value: unknown, files: Record<string, string>): string[] {
  const fromField = Array.isArray(value)
    ? value.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : [];
  if (fromField.length > 0) {
    return [...new Set(fromField)];
  }
  const fromFiles: string[] = [];
  for (const path of Object.keys(files)) {
    const nested = path.match(/^\.CodePapr\/skills\/(.+)\/SKILL\.md$/i);
    if (nested?.[1]) {
      fromFiles.push(nested[1]);
      continue;
    }
    const flat = path.match(/^\.CodePapr\/skills\/([^/]+)\.md$/i);
    if (flat?.[1]) {
      fromFiles.push(flat[1]);
    }
  }
  return [...new Set(fromFiles)];
}

function parseLockEntry(key: string, value: unknown): SkillLockFileEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const listingId = typeof value.listingId === 'string' && value.listingId.trim() ? value.listingId : key;
  const listingName =
    typeof value.listingName === 'string' && value.listingName.trim() ? value.listingName : listingId;
  const sourceRepo = typeof value.sourceRepo === 'string' ? value.sourceRepo : '';
  const source =
    typeof value.source === 'string' && value.source.trim()
      ? value.source
      : sourceRepo.replace(/^https?:\/\/github\.com\//, '');
  const files = parseStringRecord(value.files);
  if (typeof value.computedHash === 'string' && typeof value.skillPath === 'string' && Object.keys(files).length === 0) {
    files[value.skillPath] = value.computedHash;
  }
  const skillIds = parseSkillIds(value.skillIds, files);
  if (!listingId || skillIds.length === 0) {
    return null;
  }
  return {
    listingId,
    listingName,
    source,
    sourceType: 'github',
    sourceRepo,
    skillIds,
    files,
    installedAt: typeof value.installedAt === 'number' ? value.installedAt : 0,
  };
}

export function parseSkillsLock(raw: string | null | undefined): SkillsLockFile {
  if (!raw?.trim()) {
    return emptySkillsLock();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.skills)) {
      return emptySkillsLock();
    }
    const skills: Record<string, SkillLockFileEntry> = {};
    for (const [key, value] of Object.entries(parsed.skills)) {
      const entry = parseLockEntry(key, value);
      if (entry) {
        skills[entry.listingId] = entry;
      }
    }
    return { version: 1, skills };
  } catch {
    return emptySkillsLock();
  }
}

export function serializeSkillsLock(lock: SkillsLockFile): string {
  return `${JSON.stringify({ version: 1, skills: lock.skills }, null, 2)}\n`;
}

export function collectDefinitionIds(skills: readonly SkillCatalogRef[]): Set<string> {
  const ids = new Set<string>();
  for (const skill of skills) {
    const id = skill.id?.trim();
    const name = skill.name?.trim();
    if (id) ids.add(id);
    if (name) ids.add(name);
  }
  return ids;
}

export function findLockEntry(
  lock: SkillsLockFile,
  listing: SkillListingRef
): SkillLockFileEntry | undefined {
  return lock.skills[listing.id] ?? lock.skills[listing.name];
}

/**
 * 卡片已安装：锁里登记的子 Skill 至少还有一条在磁盘定义中；
 * 无锁时回退到 listing.id / listing.name 与本地 Skill 对得上（旧的单包安装）。
 */
export function isSkillListingInstalled(
  listing: SkillListingRef,
  lock: SkillsLockFile,
  definitionIds: Set<string>
): boolean {
  const entry = findLockEntry(lock, listing);
  if (entry) {
    return entry.skillIds.some((id) => definitionIds.has(id));
  }
  return definitionIds.has(listing.id) || definitionIds.has(listing.name);
}

export function collectOverwriteCandidates(
  listing: SkillListingRef,
  lock: SkillsLockFile,
  plannedSkillIds: readonly string[] = []
): string[] {
  const paths = new Set<string>();
  paths.add(skillMarkdownPath(listing.name));
  if (listing.id !== listing.name) {
    paths.add(skillMarkdownPath(listing.id));
  }
  const entry = findLockEntry(lock, listing);
  if (entry) {
    for (const filePath of Object.keys(entry.files)) {
      paths.add(filePath);
    }
    for (const skillId of entry.skillIds) {
      paths.add(skillMarkdownPath(skillId));
    }
  }
  for (const skillId of plannedSkillIds) {
    paths.add(skillMarkdownPath(skillId));
  }
  return [...paths];
}

export function githubSourceFromRepo(sourceRepo: string): string {
  const match = sourceRepo.match(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/);
  if (match?.[1]) {
    return match[1];
  }
  return sourceRepo.replace(/^https?:\/\//, '');
}

export function buildLockEntry(params: {
  listingId: string;
  listingName: string;
  sourceRepo: string;
  skillFiles: Array<{ skillId: string; relativePath: string; content: string }>;
  installedAt?: number;
}): SkillLockFileEntry {
  const files: Record<string, string> = {};
  const skillIds: string[] = [];
  for (const file of params.skillFiles) {
    files[file.relativePath] = hashSkillContent(file.content);
    if (!skillIds.includes(file.skillId)) {
      skillIds.push(file.skillId);
    }
  }
  return {
    listingId: params.listingId,
    listingName: params.listingName,
    source: githubSourceFromRepo(params.sourceRepo),
    sourceType: 'github',
    sourceRepo: params.sourceRepo,
    skillIds,
    files,
    installedAt: params.installedAt ?? Date.now(),
  };
}

export function upsertLockEntry(lock: SkillsLockFile, entry: SkillLockFileEntry): SkillsLockFile {
  const skills = { ...lock.skills };
  if (entry.listingName !== entry.listingId) {
    delete skills[entry.listingName];
  }
  skills[entry.listingId] = entry;
  return { version: 1, skills };
}

export function pruneSkillFromLock(lock: SkillsLockFile, skillId: string): SkillsLockFile {
  const normalized = skillId.trim();
  if (!normalized) {
    return lock;
  }
  const skills: Record<string, SkillLockFileEntry> = {};
  const markdownPath = skillMarkdownPath(normalized);
  const dirPrefix = `.CodePapr/skills/${normalized}/`;
  const flatPath = `.CodePapr/skills/${normalized}.md`;
  let changed = false;

  for (const [key, entry] of Object.entries(lock.skills)) {
    const skillIds = entry.skillIds.filter((id) => id !== normalized);
    const files: Record<string, string> = {};
    for (const [filePath, hash] of Object.entries(entry.files)) {
      if (filePath === markdownPath || filePath === flatPath || filePath.startsWith(dirPrefix)) {
        continue;
      }
      files[filePath] = hash;
    }
    if (skillIds.length !== entry.skillIds.length || Object.keys(files).length !== Object.keys(entry.files).length) {
      changed = true;
    }
    if (skillIds.length === 0) {
      changed = true;
      continue;
    }
    skills[key] = { ...entry, skillIds, files };
  }

  return changed ? { version: 1, skills } : lock;
}

export async function loadSkillsLock(
  invoke: SkillLockInvoke,
  workspacePath: string
): Promise<SkillsLockFile> {
  try {
    const result = await invoke<{ content: string }>('read_text_file', {
      workspacePath,
      relativePath: SKILLS_LOCK_PATH,
      maxBytes: 1_000_000,
    });
    return parseSkillsLock(result.content);
  } catch {
    return emptySkillsLock();
  }
}

export async function saveSkillsLock(
  invoke: SkillLockInvoke,
  workspacePath: string,
  lock: SkillsLockFile
): Promise<void> {
  await invoke('write_text_file', {
    workspacePath,
    relativePath: SKILLS_LOCK_PATH,
    content: serializeSkillsLock(lock),
  });
}

export async function listExistingSkillPaths(
  invoke: SkillLockInvoke,
  workspacePath: string,
  candidates: readonly string[]
): Promise<string[]> {
  const unique = [...new Set(candidates.filter(Boolean))];
  const existing = await Promise.all(
    unique.map(async (relativePath) => {
      try {
        await invoke('read_text_file', {
          workspacePath,
          relativePath,
          maxBytes: 1,
        });
        return relativePath;
      } catch {
        return null;
      }
    })
  );
  return existing.filter((path): path is string => path !== null).sort();
}
