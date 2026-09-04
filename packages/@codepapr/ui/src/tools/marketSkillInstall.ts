import { skillMarkdownPath } from '../utils/skillsLock';

const AGENTUSE_RAW = 'https://raw.githubusercontent.com/zerone-agent/agent-use-skills/main';
const SKILL_BASE_URL = `${AGENTUSE_RAW}/awesome-skills/skills`;
const PACK_RESOURCE_DIRS = ['agents', 'references', 'templates', 'scripts', 'commands'] as const;
const SKILL_DIR_PREFIXES = ['skills', '.CodePapr/skills', '.claude/skills'] as const;
const BRANCH_FALLBACKS = ['main', 'master'] as const;
const FETCH_TIMEOUT_MS = 60_000;
const BINARY_RESOURCE_PATTERN =
  /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|eot|mp[34]|wav|bin|exe|dylib|so|wasm)$/i;
const MAX_RESOURCE_DEPTH = 4;

export type PlannedFile = { relativePath: string; content: string };

export type SkillInstallPlan = {
  skillFiles: Array<{ skillId: string; relativePath: string; content: string }>;
  extraFiles: PlannedFile[];
};

export type PlanResult =
  | { ok: true; plan: SkillInstallPlan; error?: never }
  | { ok: false; plan?: never; error: string };

export type SkillInstallInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface GithubContentEntry {
  name: string;
  path: string;
  type: string;
  download_url?: string | null;
}

interface SkillFileHit {
  content: string;
  repoPath: string;
  branch: string;
  packDir: string;
  skillId: string;
}

const defaultBranchCache = new Map<string, string>();

export function extractRepoPath(urlOrPath: string): string | null {
  const match = urlOrPath.match(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/);
  return match ? match[1] : null;
}

export function rawGithubUrl(repoPath: string, branch: string, filePath: string): string {
  const trimmed = filePath.replace(/^\/+/, '');
  return `https://raw.githubusercontent.com/${repoPath}/${branch}/${trimmed}`;
}

export function isBinarySkillResource(fileName: string): boolean {
  return BINARY_RESOURCE_PATTERN.test(fileName);
}

export function packDirCandidates(skillName: string): string[] {
  const shortName = skillName.replace(/-skill$/, '');
  const names = shortName === skillName ? [skillName] : [shortName, skillName];
  const dirs: string[] = [];
  for (const prefix of SKILL_DIR_PREFIXES) {
    for (const name of names) {
      dirs.push(`${prefix}/${name}`);
    }
  }
  for (const name of names) {
    dirs.push(name);
  }
  dirs.push('');
  return dirs;
}

export function resourceDirCandidates(packDir: string): string[] {
  if (!packDir) {
    return [...PACK_RESOURCE_DIRS];
  }
  return PACK_RESOURCE_DIRS.map((dir) => `${packDir}/${dir}`);
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function tryFetchText(url: string): Promise<string | null> {
  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) return null;
    return response.text();
  } catch {
    return null;
  }
}

async function fetchGithubJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export async function resolveGithubDefaultBranch(repoPath: string): Promise<string> {
  const cached = defaultBranchCache.get(repoPath);
  if (cached) {
    return cached;
  }
  const repo = await fetchGithubJson<{ default_branch?: string }>(
    `https://api.github.com/repos/${repoPath}`
  );
  const branch = repo?.default_branch?.trim() || 'main';
  defaultBranchCache.set(repoPath, branch);
  return branch;
}

export async function candidateBranches(repoPath: string): Promise<string[]> {
  const preferred = await resolveGithubDefaultBranch(repoPath);
  return [...new Set([preferred, ...BRANCH_FALLBACKS])];
}

async function listGithubContents(
  repoPath: string,
  dirPath: string,
  branch: string
): Promise<GithubContentEntry[]> {
  const encoded = dirPath
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');
  const url = `https://api.github.com/repos/${repoPath}/contents/${encoded}?ref=${encodeURIComponent(branch)}`;
  const entries = await fetchGithubJson<GithubContentEntry[] | GithubContentEntry>(url);
  if (!entries) {
    return [];
  }
  return Array.isArray(entries) ? entries : [entries];
}

async function findExternalRepoFromInstall(name: string): Promise<string | null> {
  for (const platform of ['opencode', 'claudecode', 'cursor', 'codex']) {
    const content = await tryFetchText(`${AGENTUSE_RAW}/awesome-skills/${platform}/${name}/INSTALL-en.md`);
    if (content) {
      const match = content.match(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/);
      if (match && !match[1]!.includes('agent-use-skills')) {
        return match[1]!;
      }
    }
  }
  return null;
}

async function collectTreeFiles(
  repoPath: string,
  repoDir: string,
  targetDir: string,
  branch: string,
  depth = 0
): Promise<PlannedFile[]> {
  if (depth > MAX_RESOURCE_DEPTH || !repoDir) {
    return [];
  }
  const entries = await listGithubContents(repoPath, repoDir, branch);
  const planned: PlannedFile[] = [];
  for (const entry of entries) {
    if (entry.type === 'dir') {
      planned.push(
        ...(await collectTreeFiles(
          repoPath,
          `${repoDir}/${entry.name}`,
          `${targetDir}/${entry.name}`,
          branch,
          depth + 1
        ))
      );
      continue;
    }
    if (entry.type !== 'file' || isBinarySkillResource(entry.name)) {
      continue;
    }
    const content = await tryFetchText(
      entry.download_url || rawGithubUrl(repoPath, branch, `${repoDir}/${entry.name}`)
    );
    if (!content) continue;
    planned.push({ relativePath: `${targetDir}/${entry.name}`, content });
  }
  return planned;
}

export async function collectSkillPackResources(params: {
  repoPath: string;
  packDir: string;
  skillId: string;
  branch: string;
}): Promise<PlannedFile[]> {
  const planned: PlannedFile[] = [];
  const prefixes = params.packDir ? [params.packDir, ...packDirCandidates(params.skillId)] : packDirCandidates(params.skillId);
  const seen = new Set<string>();
  for (const prefix of prefixes) {
    for (const repoDir of resourceDirCandidates(prefix)) {
      if (seen.has(repoDir)) continue;
      seen.add(repoDir);
      const dirName = repoDir.split('/').filter(Boolean).pop() ?? repoDir;
      const targetDir = `.CodePapr/skills/${params.skillId}/${dirName}`;
      const files = await collectTreeFiles(params.repoPath, repoDir, targetDir, params.branch);
      if (files.length > 0) {
        planned.push(...files);
      }
    }
    if (planned.length > 0 && params.packDir) {
      break;
    }
  }
  return planned;
}

async function findSkillMarkdown(
  repoPath: string,
  skillName: string,
  allowRootFallback = true
): Promise<SkillFileHit | null> {
  const branches = await candidateBranches(repoPath);
  for (const branch of branches) {
    for (const packDir of packDirCandidates(skillName)) {
      if (!packDir && !allowRootFallback) {
        // 多技能发现时子目录（如 assets/）没有 SKILL.md，不能拿仓库根的
        // SKILL.md 冒充该子技能的内容。
        continue;
      }
      const filePath = packDir ? `${packDir}/SKILL.md` : 'SKILL.md';
      const content = await tryFetchText(rawGithubUrl(repoPath, branch, filePath));
      if (content) {
        return {
          content,
          repoPath,
          branch,
          packDir,
          skillId: skillName,
        };
      }
    }
  }
  return null;
}

async function downloadSkillMarkdown(name: string, sourceRepo?: string): Promise<SkillFileHit | null> {
  const canonical = await tryFetchText(`${SKILL_BASE_URL}/${name}/SKILL.md`);
  if (canonical) {
    const repoPath = sourceRepo ? extractRepoPath(sourceRepo) : null;
    if (repoPath && !repoPath.includes('agent-use-skills')) {
      const hit = await findSkillMarkdown(repoPath, name);
      if (hit) {
        return hit;
      }
    }
    return {
      content: canonical,
      repoPath: 'zerone-agent/agent-use-skills',
      branch: 'main',
      packDir: `awesome-skills/skills/${name}`,
      skillId: name,
    };
  }

  if (sourceRepo) {
    const repoPath = extractRepoPath(sourceRepo);
    if (repoPath && !repoPath.includes('agent-use-skills')) {
      const hit = await findSkillMarkdown(repoPath, name);
      if (hit) return hit;
    }
  }

  const externalRepo = await findExternalRepoFromInstall(name);
  if (externalRepo) {
    return findSkillMarkdown(externalRepo, name);
  }

  return null;
}

const SKILL_PREVIEW_MAX_CHARS = 8_000;

export async function previewSkillMarkdown(
  name: string,
  sourceRepo: string
): Promise<string | null> {
  const hit = await downloadSkillMarkdown(name, sourceRepo);
  if (!hit) {
    return null;
  }
  if (hit.content.length <= SKILL_PREVIEW_MAX_CHARS) {
    return hit.content;
  }
  return `${hit.content.slice(0, SKILL_PREVIEW_MAX_CHARS)}\n\n…`;
}

async function discoverRepoSkills(
  repoPath: string,
  branch: string
): Promise<Array<{ name: string; packDir: string }>> {
  for (const prefix of SKILL_DIR_PREFIXES) {
    const entries = await listGithubContents(repoPath, prefix, branch);
    const dirs = entries.filter((entry) => entry.type === 'dir' || entry.type === 'symlink');
    if (dirs.length > 0) {
      return dirs.map((entry) => ({ name: entry.name, packDir: `${prefix}/${entry.name}` }));
    }
  }
  return [];
}

export async function planSkillInstall(name: string, sourceRepo: string): Promise<PlanResult> {
  const hit = await downloadSkillMarkdown(name, sourceRepo);
  if (hit) {
    const extraFiles =
      hit.repoPath.includes('agent-use-skills')
        ? []
        : await collectSkillPackResources({
            repoPath: hit.repoPath,
            packDir: hit.packDir,
            skillId: name,
            branch: hit.branch,
          });
    return {
      ok: true,
      plan: {
        skillFiles: [{ skillId: name, relativePath: skillMarkdownPath(name), content: hit.content }],
        extraFiles,
      },
    };
  }

  const repoPath = extractRepoPath(sourceRepo);
  if (repoPath && !repoPath.includes('agent-use-skills')) {
    const branches = await candidateBranches(repoPath);
    let discovered: Array<{ name: string; packDir: string }> = [];
    let branch = branches[0] ?? 'main';
    for (const candidate of branches) {
      discovered = await discoverRepoSkills(repoPath, candidate);
      if (discovered.length > 0) {
        branch = candidate;
        break;
      }
    }
    if (discovered.length > 0) {
      const skillFiles: SkillInstallPlan['skillFiles'] = [];
      const extraFiles: PlannedFile[] = [];
      for (const subSkill of discovered) {
        const subHit = await findSkillMarkdown(repoPath, subSkill.name, false);
        const content =
          subHit?.content ??
          (await tryFetchText(rawGithubUrl(repoPath, branch, `${subSkill.packDir}/SKILL.md`)));
        if (!content) continue;
        skillFiles.push({
          skillId: subSkill.name,
          relativePath: skillMarkdownPath(subSkill.name),
          content,
        });
        extraFiles.push(
          ...(await collectSkillPackResources({
            repoPath,
            packDir: subHit?.packDir ?? subSkill.packDir,
            skillId: subSkill.name,
            branch: subHit?.branch ?? branch,
          }))
        );
      }
      if (skillFiles.length > 0) {
        const rootCommands = await collectTreeFiles(
          repoPath,
          'commands',
          `.CodePapr/skills/${name}/commands`,
          branch
        );
        if (rootCommands.length > 0 && !skillFiles.some((file) => file.skillId === name)) {
          const packSkill = await tryFetchText(rawGithubUrl(repoPath, branch, 'SKILL.md'));
          if (packSkill) {
            skillFiles.push({
              skillId: name,
              relativePath: skillMarkdownPath(name),
              content: packSkill,
            });
          }
        }
        // 根 commands 只有在对应 skill 根（<name>/SKILL.md）存在时才落盘，
        // 否则它会成为没有任何 Skill 引用得到的孤儿目录。
        if (rootCommands.length > 0 && skillFiles.some((file) => file.skillId === name)) {
          extraFiles.push(...rootCommands);
        }
        return { ok: true, plan: { skillFiles, extraFiles } };
      }
      return {
        ok: false,
        error: `发现 ${discovered.length} 个子技能但全部下载失败`,
      };
    }
  }

  return {
    ok: false,
    error: '无法下载 SKILL.md：请检查网络或确认该 Skill 是否支持 CodePapr',
  };
}

export async function commitSkillInstall(
  plan: SkillInstallPlan,
  workspacePath: string,
  invokeFn: SkillInstallInvoke
): Promise<{ ok: true; installed: string[]; resources: number } | { ok: false; error: string }> {
  try {
    for (const file of [...plan.skillFiles, ...plan.extraFiles]) {
      await invokeFn('write_text_file', {
        workspacePath,
        relativePath: file.relativePath,
        content: file.content,
      });
    }
    return {
      ok: true,
      installed: plan.skillFiles.map((file) => file.skillId),
      resources: plan.extraFiles.length,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `写入失败: ${msg}` };
  }
}
