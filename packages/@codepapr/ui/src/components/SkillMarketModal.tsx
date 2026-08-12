import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAgentStore } from '../store/agentStore';
import { fetchSkillListings, searchSkills } from '../tools/marketSkillApi';
import type { SkillMarketListing } from '../utils/marketSkillTypes';
import type { Lang } from '../utils/i18n';

const SKILL_BASE_URL = 'https://raw.githubusercontent.com/zerone-agent/agent-use-skills/main/awesome-skills/skills';

function copy(lang: Lang | undefined) {
  if (lang === 'en') {
    return {
      title: 'Skill Market',
      source: 'Source',
      agentuse: 'AgentUse',
      search: 'Search skills...',
      install: 'Install',
      installing: 'Installing...',
      installed: 'Installed',
      installError: 'Install failed',
      loadMore: 'Load More',
      loading: 'Loading skills...',
      empty: 'No skills found.',
      error: 'Failed to load skills.',
      retry: 'Retry',
      close: 'Close',
      detail: 'Details',
      features: 'Features',
      repository: 'Repository',
      website: 'Website',
      verified: 'Verified',
      notVerified: 'Pending',
      noWorkspace: 'Open a project workspace first to install skills.',
      installSuccess: 'Skill installed to .CodePapr/skills/',
      tags: 'Tags',
      back: 'Back to results',
      pluginNoticeTitle: 'This is a Claude Code Plugin',
      pluginNoticeDesc: 'This skill is designed as a Claude Code plugin with commands, hooks, and multi-agent orchestration. CodePapr can only install the SKILL.md instruction files; full plugin features may not work correctly.',
      pluginNoticeHint: 'Installing will attempt to extract available sub-skills as best-effort.',
      tryInstallSubskills: 'Try Install (sub-skills only)',
    };
  }
  if (lang === 'zh-TW') {
    return {
      title: 'Skill 市場',
      source: '來源',
      agentuse: 'AgentUse',
      search: '搜尋 Skill...',
      install: '安裝',
      installing: '安裝中...',
      installed: '已安裝',
      installError: '安裝失敗',
      loadMore: '載入更多',
      loading: '載入中...',
      empty: '沒有找到 Skill。',
      error: '載入失敗。',
      retry: '重試',
      close: '關閉',
      detail: '詳情',
      features: '功能',
      repository: '倉庫',
      website: '網站',
      verified: '已驗證',
      notVerified: '待驗證',
      noWorkspace: '請先開啟專案工作區再安裝 Skill。',
      installSuccess: 'Skill 已安裝到 .CodePapr/skills/',
      tags: '標籤',
      back: '返回結果',
      pluginNoticeTitle: '這是 Claude Code 外掛',
      pluginNoticeDesc: '此 Skill 設計為 Claude Code 外掛，包含指令、鉤子與多 Agent 協作。CodePapr 僅能安裝 SKILL.md 指令檔，完整外掛功能可能無法正常運作。',
      pluginNoticeHint: '安裝將盡力提取可用的子技能。',
      tryInstallSubskills: '嘗試安裝（僅子技能）',
    };
  }
  return {
    title: 'Skill 市场',
    source: '来源',
    agentuse: 'AgentUse',
    search: '搜索 Skill...',
    install: '安装',
    installing: '安装中...',
    installed: '已安装',
    installError: '安装失败',
    loadMore: '加载更多',
    loading: '加载中...',
    empty: '没有找到 Skill。',
    error: '加载失败。',
    retry: '重试',
    close: '关闭',
    detail: '详情',
    features: '功能',
    repository: '仓库',
    website: '网站',
    verified: '已验证',
    notVerified: '待验证',
    noWorkspace: '请先打开项目工作区再安装 Skill。',
    installSuccess: 'Skill 已安装到 .CodePapr/skills/',
    tags: '标签',
    back: '返回结果',
    pluginNoticeTitle: '这是 Claude Code 插件',
    pluginNoticeDesc: '此 Skill 设计为 Claude Code 插件，包含命令、钩子与多 Agent 协作。CodePapr 仅能安装 SKILL.md 指令文件，完整插件功能可能无法正常运行。',
    pluginNoticeHint: '安装将尽力提取可用的子技能。',
    tryInstallSubskills: '尝试安装（仅子技能）',
  };
}

interface SkillMarketModalProps {
  onClose: () => void;
}

function SkeletonCard() {
  return (
    <div className="rounded-2xl border border-[#2a2d3a] bg-[#121722] p-4">
      <div className="flex items-start gap-3">
        <div className="h-10 w-10 flex-shrink-0 animate-pulse rounded-xl bg-[#1d2332]" />
        <div className="flex-1 space-y-2">
          <div className="h-4 w-2/3 animate-pulse rounded bg-[#1d2332]" />
          <div className="h-3 w-1/3 animate-pulse rounded bg-[#1d2332]" />
        </div>
      </div>
      <div className="mt-3 space-y-1.5">
        <div className="h-3 w-full animate-pulse rounded bg-[#1d2332]" />
        <div className="h-3 w-4/5 animate-pulse rounded bg-[#1d2332]" />
      </div>
      <div className="mt-3 flex gap-1.5">
        <div className="h-5 w-16 animate-pulse rounded-md bg-[#1d2332]" />
        <div className="h-5 w-12 animate-pulse rounded-md bg-[#1d2332]" />
      </div>
    </div>
  );
}

function ListingCard({
  listing,
  isInstalled,
  isInstalling,
  installError,
  onSelect,
  onInstall,
  c,
}: {
  listing: SkillMarketListing;
  isInstalled: boolean;
  isInstalling: boolean;
  installError?: string;
  onSelect: (listing: SkillMarketListing) => void;
  onInstall: (listing: SkillMarketListing) => void;
  c: ReturnType<typeof copy>;
}) {
  const initial = listing.title.charAt(0).toUpperCase();

  return (
    <button
      type="button"
      onClick={() => onSelect(listing)}
      className="group relative flex flex-col gap-3 rounded-2xl border border-[#2a2d3a] bg-[#121722] p-4 text-left transition-all hover:border-purple-500/40 hover:bg-[#161b27]"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-[#1d2332] text-sm font-bold text-slate-300">
          {initial}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="truncate text-sm font-semibold text-slate-100">{listing.title}</h3>
            {listing.verified ? (
              <span className="flex-shrink-0 rounded-full border border-emerald-500/30 bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-medium text-emerald-200">{c.verified}</span>
            ) : (
              <span className="flex-shrink-0 rounded-full border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-200">{c.notVerified}</span>
            )}
          </div>
          <p className="mt-0.5 truncate text-[11px] text-slate-500">{listing.sourceRepo}</p>
        </div>
        <span className="flex-shrink-0 rounded-full border border-purple-500/30 bg-purple-500/15 px-2 py-0.5 text-[9px] font-medium text-purple-200">
          {c.agentuse}
        </span>
      </div>

      <p className="line-clamp-2 text-xs leading-relaxed text-slate-400">{listing.description}</p>

      <div className="flex flex-wrap items-center gap-1.5">
        {listing.tags.slice(0, 4).map((tag) => (
          <span key={tag} className="rounded-md border border-[#2a2d3a] px-1.5 py-0.5 text-[10px] text-slate-400">
            {tag}
          </span>
        ))}
      </div>

      <div className="mt-auto flex items-center justify-between border-t border-[#2a2d3a] pt-2.5">
        <span />
        {isInstalled ? (
          <span className="rounded-lg bg-emerald-500/15 px-3 py-1.5 text-[10px] font-semibold text-emerald-200">{c.installed}</span>
        ) : isInstalling ? (
          <span className="rounded-lg bg-purple-500/20 px-3 py-1.5 text-[10px] font-semibold text-purple-200">{c.installing}</span>
        ) : installError ? (
          <span className="rounded-lg bg-red-500/15 px-3 py-1.5 text-[10px] font-semibold text-red-200">{installError}</span>
        ) : (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onInstall(listing); }}
            className="rounded-lg bg-purple-500/20 px-3 py-1.5 text-[10px] font-semibold text-purple-100 transition-colors hover:bg-purple-500/35"
          >
            {c.install}
          </button>
        )}
      </div>
    </button>
  );
}

function SkillDetail({
  listing,
  isInstalled,
  isInstalling,
  installError,
  onInstall,
  onClose,
  onCloseModal,
  c,
}: {
  listing: SkillMarketListing;
  isInstalled: boolean;
  isInstalling: boolean;
  installError?: string;
  onInstall: (listing: SkillMarketListing) => void;
  onClose: () => void;
  onCloseModal: () => void;
  c: ReturnType<typeof copy>;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-[#2a2d3a] px-6 py-4">
        <button
          type="button"
          onClick={onClose}
          className="flex items-center gap-2 text-xs text-slate-400 transition-colors hover:text-slate-200"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          {c.back}
        </button>
        <div className="flex items-center gap-2">
          <span className={`rounded-full border px-2.5 py-0.5 text-[10px] font-medium ${listing.verified ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-200' : 'border-amber-500/30 bg-amber-500/15 text-amber-200'}`}>
            {listing.verified ? c.verified : c.notVerified}
          </span>
          <button onClick={onCloseModal} title={c.close} className="text-2xl leading-none text-slate-500 hover:text-slate-300">×</button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="flex items-start gap-4">
          <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-2xl bg-[#1d2332] text-xl font-bold text-slate-300">
            {listing.title.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold text-slate-100">{listing.title}</h2>
            <p className="mt-0.5 text-xs text-slate-500">{listing.id}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {listing.tags.map((tag) => (
                <span key={tag} className="rounded-md border border-[#2a2d3a] px-2 py-0.5 text-[10px] text-slate-400">
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </div>

        <p className="mt-5 text-sm leading-relaxed text-slate-300">{listing.description}</p>

        {listing.features.length > 0 && (
          <div className="mt-5">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{c.features}</h3>
            <ul className="space-y-2">
              {listing.features.map((feat, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-slate-400">
                  <span className="mt-0.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-purple-400" />
                  {feat}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-5 rounded-2xl border border-[#2a2d3a] bg-[#0f1117] p-4">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">{c.repository}</h3>
          <code className="mt-2 block truncate text-[11px] text-slate-400">{listing.sourceRepo}</code>
        </div>

        {listing.isPlugin && (
          <div className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
            <div className="flex items-start gap-2.5">
              <svg className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-amber-300">{c.pluginNoticeTitle}</p>
                <p className="mt-1 text-[11px] leading-relaxed text-amber-200/70">{c.pluginNoticeDesc}</p>
                <p className="mt-2 text-[11px] text-amber-200/60">{c.pluginNoticeHint}</p>
              </div>
            </div>
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          {listing.sourceRepo && (
            <a
              href={listing.sourceRepo}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg border border-[#2a2d3a] px-3 py-1.5 text-[10px] font-medium text-slate-400 transition-colors hover:border-purple-500/40 hover:text-purple-200"
            >
              {c.repository}
            </a>
          )}
          {listing.websiteUrl && (
            <a
              href={listing.websiteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg border border-[#2a2d3a] px-3 py-1.5 text-[10px] font-medium text-slate-400 transition-colors hover:border-purple-500/40 hover:text-purple-200"
            >
              {c.website}
            </a>
          )}
        </div>
      </div>

      <div className="border-t border-[#2a2d3a] px-6 py-4">
        {isInstalled ? (
          <span className="inline-flex w-full items-center justify-center rounded-xl bg-emerald-500/15 py-3 text-sm font-semibold text-emerald-200">
            <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
            </svg>
            {c.installed}
          </span>
        ) : isInstalling ? (
          <span className="inline-flex w-full items-center justify-center rounded-xl bg-purple-500/20 py-3 text-sm font-semibold text-purple-200">
            {c.installing}
          </span>
        ) : installError ? (
          <div className="text-center">
            <span className="text-xs text-red-400">{installError}</span>
            <button
              type="button"
              onClick={() => onInstall(listing)}
              className="mt-2 flex w-full items-center justify-center rounded-xl border border-purple-500/50 bg-purple-500/15 py-3 text-sm font-semibold text-purple-100 transition-colors hover:bg-purple-500/25"
            >
              {c.retry}
            </button>
          </div>
        ) : listing.isPlugin ? (
          <button
            type="button"
            onClick={() => onInstall(listing)}
            className="flex w-full items-center justify-center rounded-xl border border-amber-500/40 bg-amber-500/10 py-3 text-sm font-semibold text-amber-200 transition-colors hover:bg-amber-500/20"
          >
            {c.tryInstallSubskills}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onInstall(listing)}
            className="flex w-full items-center justify-center rounded-xl border border-purple-500/50 bg-purple-500/15 py-3 text-sm font-semibold text-purple-100 transition-colors hover:bg-purple-500/25"
          >
            {c.install}
          </button>
        )}
      </div>
    </div>
  );
}

function buildCanonicalUrl(name: string): string {
  return `${SKILL_BASE_URL}/${name}/SKILL.md`;
}

function extractRepoPath(urlOrPath: string): string | null {
  const match = urlOrPath.match(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/);
  return match ? match[1] : null;
}

function buildExternalCandidates(externalRepo: string, name: string): string[] {
  const shortName = name.replace(/-skill$/, '');
  const base = `https://raw.githubusercontent.com/${externalRepo}/main`;
  return [
    `${base}/.CodePapr/skills/${shortName}/SKILL.md`,
    `${base}/.CodePapr/skills/${name}/SKILL.md`,
    `${base}/.claude/skills/${shortName}/SKILL.md`,
    `${base}/.claude/skills/${name}/SKILL.md`,
    `${base}/${shortName}/SKILL.md`,
    `${base}/SKILL.md`,
  ];
}

async function tryFetchText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return response.text();
  } catch {
    return null;
  }
}

async function findExternalRepoFromInstall(name: string): Promise<string | null> {
  const baseUrl = 'https://raw.githubusercontent.com/zerone-agent/agent-use-skills/main/awesome-skills';
  for (const platform of ['opencode', 'claudecode', 'cursor', 'codex']) {
    const content = await tryFetchText(`${baseUrl}/${platform}/${name}/INSTALL-en.md`);
    if (content) {
      const match = content.match(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/);
      if (match && !match[1].includes('agent-use-skills')) {
        return match[1];
      }
    }
  }
  return null;
}

async function discoverRepoSkills(repoPath: string): Promise<string[]> {
  try {
    const response = await fetch(`https://api.github.com/repos/${repoPath}/contents/skills`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return [];
    const entries: Array<{ name: string; type: string }> = await response.json();
    return entries.filter((e) => e.type === 'dir' || e.type === 'symlink').map((e) => e.name);
  } catch {
    return [];
  }
}

async function downloadSubSkillMarkdown(repoPath: string, subSkill: string): Promise<string | null> {
  const urls = [
    `https://raw.githubusercontent.com/${repoPath}/main/skills/${subSkill}/SKILL.md`,
    `https://raw.githubusercontent.com/${repoPath}/main/${subSkill}/SKILL.md`,
  ];
  for (const url of urls) {
    const content = await tryFetchText(url);
    if (content) return content;
  }
  return null;
}

async function discoverRepoDirFiles(repoPath: string, dirPath: string): Promise<string[]> {
  try {
    const response = await fetch(`https://api.github.com/repos/${repoPath}/contents/${dirPath}`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return [];
    const entries: Array<{ name: string; type: string }> = await response.json();
    return entries.filter((e) => e.type === 'file' && e.name.endsWith('.md')).map((e) => e.name);
  } catch {
    return [];
  }
}

async function downloadDirToWorkspace(
  repoPath: string,
  repoDir: string,
  targetDir: string,
  invokeFn: typeof invoke,
  workspacePath: string,
): Promise<number> {
  const files = await discoverRepoDirFiles(repoPath, repoDir);
  let count = 0;
  for (const file of files) {
    const content = await tryFetchText(
      `https://raw.githubusercontent.com/${repoPath}/main/${repoDir}/${file}`
    );
    if (!content) continue;
    try {
      await invokeFn('write_text_file', {
        workspacePath,
        relativePath: `${targetDir}/${file}`,
        content,
      });
      count++;
    } catch {
      // skip failed file
    }
  }
  return count;
}

const PACK_RESOURCE_DIRS = ['agents', 'references', 'templates'] as const;

async function downloadSkillPackResources(
  repoPath: string,
  subSkill: string,
  workspacePath: string,
  invokeFn: typeof invoke,
): Promise<number> {
  let total = 0;
  for (const dir of PACK_RESOURCE_DIRS) {
    const repoDir = `${subSkill}/${dir}`;
    const targetDir = `.CodePapr/skills/${subSkill}/${dir}`;
    total += await downloadDirToWorkspace(repoPath, repoDir, targetDir, invokeFn, workspacePath);
  }
  return total;
}

async function downloadSkillMarkdown(name: string, sourceRepo?: string): Promise<string | null> {
  // 1. Try canonical location first
  let content = await tryFetchText(buildCanonicalUrl(name));
  if (content) return content;

  // 2. Try sourceRepo (external GitHub repo)
  if (sourceRepo) {
    const repoPath = extractRepoPath(sourceRepo);
    if (repoPath && !repoPath.includes('agent-use-skills')) {
      for (const url of buildExternalCandidates(repoPath, name)) {
        content = await tryFetchText(url);
        if (content) return content;
      }
    }
  }

  // 3. Detect external repo from INSTALL file in agent-use-skills
  const externalRepo = await findExternalRepoFromInstall(name);
  if (externalRepo) {
    for (const url of buildExternalCandidates(externalRepo, name)) {
      content = await tryFetchText(url);
      if (content) return content;
    }
  }

  return null;
}

type InstallResult =
  | { ok: true; installed: string[]; resources: number; error?: never }
  | { ok: false; installed: string[]; resources: number; error: string };

/** N20：重装会覆盖本地 SKILL.md（用户可能改过 frontmatter/正文）——
 *  必须弹确认，绝不静默覆盖。返回用户是否同意。 */
export function confirmSkillOverwrite(lang: string | undefined, title: string): boolean {
  const confirmText =
    lang === 'en'
      ? `"${title}" is already installed. Reinstalling will overwrite your local changes (including edits to its SKILL.md). Continue?`
      : lang === 'zh-TW'
        ? `「${title}」已安裝。重新安裝將覆蓋本地修改（包括對 SKILL.md 的編輯）。繼續？`
        : `「${title}」已安装。重新安装将覆盖本地修改（包括对 SKILL.md 的编辑）。继续？`;
  return typeof window !== 'undefined' && window.confirm(confirmText);
}

async function installSkillToWorkspace(
  name: string,
  workspacePath: string,
  sourceRepo: string,
  invokeFn: typeof invoke,
): Promise<InstallResult> {
  const content = await downloadSkillMarkdown(name, sourceRepo);
  if (content) {
    const relativePath = `.CodePapr/skills/${name}/SKILL.md`;
    try {
      await invokeFn('write_text_file', {
        workspacePath,
        relativePath,
        content,
      });
      const repoPath = extractRepoPath(sourceRepo);
      let resources = 0;
      if (repoPath && !repoPath.includes('agent-use-skills')) {
        resources = await downloadSkillPackResources(repoPath, name, workspacePath, invokeFn);
      }
      return { ok: true, installed: [name], resources };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, installed: [], resources: 0, error: `写入失败: ${msg}` };
    }
  }

  const repoPath = extractRepoPath(sourceRepo);
  if (repoPath && !repoPath.includes('agent-use-skills')) {
    const subSkills = await discoverRepoSkills(repoPath);
    if (subSkills.length > 0) {
      const installed: string[] = [];
      let resources = 0;
      for (const subSkill of subSkills) {
        const subContent = await downloadSubSkillMarkdown(repoPath, subSkill);
        if (!subContent) continue;
        const relativePath = `.CodePapr/skills/${subSkill}/SKILL.md`;
        try {
          await invokeFn('write_text_file', {
            workspacePath,
            relativePath,
            content: subContent,
          });
          installed.push(subSkill);
          resources += await downloadSkillPackResources(repoPath, subSkill, workspacePath, invokeFn);
        } catch {
          // skip failed sub-skill
        }
      }
      if (installed.length > 0) {
        const cmdCount = await downloadDirToWorkspace(
          repoPath, 'commands', `.CodePapr/skills/${name}/commands`, invokeFn, workspacePath
        );
        resources += cmdCount;
        return { ok: true, installed, resources };
      }
      return {
        ok: false,
        installed: [],
        resources: 0,
        error: `发现 ${subSkills.length} 个子技能但全部下载失败`,
      };
    }
  }

  return {
    ok: false,
    installed: [],
    resources: 0,
    error: '无法下载 SKILL.md：请检查网络或确认该 Skill 是否支持 CodePapr',
  };
}

async function refreshSkills(workspacePath: string) {
  try {
    const store = useAgentStore.getState();
    void (store as unknown as { _loadProjectConfig(path: string): Promise<void> })._loadProjectConfig(workspacePath);
  } catch {
    // silently fail
  }
}

export function SkillMarketModal({ onClose }: SkillMarketModalProps) {
  const settings = useAgentStore((s) => s.settings);
  const workspacePath = useAgentStore((s) => s.workspacePath);
  const skillDefinitions = useAgentStore((s) => s._skillDefinitions);
  const c = copy(settings.lang);
  const [listings, setListings] = useState<SkillMarketListing[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedListing, setSelectedListing] = useState<SkillMarketListing | null>(null);
  const [installingIds, setInstallingIds] = useState<Set<string>>(new Set());
  const [installErrors, setInstallErrors] = useState<Record<string, string>>({});
  const [installedIds, setInstalledIds] = useState<Set<string>>(new Set());
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // N20：已安装状态与本地 .CodePapr/skills 同步（含嵌套 skill 目录），
  // 安装/刷新后 _skillDefinitions 更新，标记随之更新。
  useEffect(() => {
    setInstalledIds((prev) => {
      const next = new Set(prev);
      for (const skill of skillDefinitions) {
        const key = skill.id || skill.name;
        if (key) next.add(key);
      }
      return next;
    });
  }, [skillDefinitions]);

  const isSkillInstalled = useCallback(
    (listing: SkillMarketListing): boolean =>
      installedIds.has(listing.id) || installedIds.has(listing.name),
    [installedIds]
  );

  useEffect(() => {
    setIsLoading(true);
    setError(null);
    fetchSkillListings()
      .then((result) => {
        setListings(result);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, []);

  const handleRetry = useCallback(() => {
    setIsLoading(true);
    setError(null);
    fetchSkillListings()
      .then((result) => {
        setListings(result);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, []);

  const handleInstall = useCallback(async (listing: SkillMarketListing) => {
    if (!workspacePath) {
      setToastMessage(c.noWorkspace);
      setTimeout(() => setToastMessage(null), 3000);
      return;
    }

    // N20：重装会覆盖本地 SKILL.md（用户可能改过 frontmatter/正文）——
    // 先确认本地是否已存在，再要求用户明确确认，绝不静默覆盖。
    let localExists = false;
    try {
      await invoke<{ content: string }>('read_text_file', {
        workspacePath,
        relativePath: `.CodePapr/skills/${listing.name}/SKILL.md`,
        maxBytes: 1024,
      });
      localExists = true;
    } catch {
      localExists = false;
    }
    if (localExists) {
      if (!confirmSkillOverwrite(settings.lang, listing.title)) {
        return;
      }
    }

    setInstallingIds((prev) => new Set(prev).add(listing.id));
    setInstallErrors((prev) => { const n = { ...prev }; delete n[listing.id]; return n; });

    const result = await installSkillToWorkspace(listing.name, workspacePath, listing.sourceRepo, invoke);

    if (result.ok) {
      setInstalledIds((prev) => {
        const next = new Set(prev).add(listing.id);
        for (const sub of result.installed) {
          next.add(sub);
        }
        return next;
      });
      if (result.installed.length > 1) {
        const resInfo = result.resources > 0 ? ` + ${result.resources} resources` : '';
        setToastMessage(`${listing.title}: ${result.installed.length} skills${resInfo} installed`);
      } else if (result.resources > 0) {
        setToastMessage(`${listing.title}: SKILL.md + ${result.resources} resources installed`);
      } else {
        setToastMessage(`${listing.title} ${c.installSuccess}`);
      }
      await refreshSkills(workspacePath);
    } else {
      setInstallErrors((prev) => ({ ...prev, [listing.id]: result.error || c.installError }));
    }

    setInstallingIds((prev) => {
      const next = new Set(prev);
      next.delete(listing.id);
      return next;
    });

    if (toastMessage) {
      setTimeout(() => setToastMessage(null), 3000);
    }
  }, [workspacePath, c, toastMessage]);

  const filteredListings = useMemo(() => {
    return searchSkills(listings, searchQuery);
  }, [listings, searchQuery]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="flex h-[90vh] w-[min(96vw,1100px)] flex-col rounded-3xl border border-[#2a2d3a] bg-[#1a1d27] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#2a2d3a] px-6 py-4">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-slate-100">{c.title}</h2>
            <span className="rounded-lg border border-purple-500/30 bg-purple-500/10 px-2 py-1 text-[10px] font-semibold text-purple-200">{c.agentuse}</span>
            {!workspacePath && (
              <span className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-300">No workspace open</span>
            )}
          </div>
          <button onClick={onClose} title={c.close} className="text-2xl leading-none text-slate-500 hover:text-slate-300">×</button>
        </div>

        {/* Search */}
        <div className="border-b border-[#2a2d3a] px-6 py-3">
          <div className="relative">
            <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              ref={searchRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={c.search}
              className="w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] py-2 pl-9 pr-3 text-sm text-slate-200 placeholder-slate-600 focus:border-purple-500/60 focus:outline-none"
            />
          </div>
        </div>

        {/* Content */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div className={`h-full overflow-y-auto px-6 py-5 transition-all ${selectedListing ? 'pr-[420px]' : ''}`}>
            {isLoading && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {Array.from({ length: 12 }).map((_, i) => (
                  <SkeletonCard key={i} />
                ))}
              </div>
            )}

            {error && (
              <div className="flex h-64 flex-col items-center justify-center gap-4">
                <p className="text-sm text-red-400">{c.error}</p>
                <p className="text-xs text-slate-600">{error}</p>
                <button
                  type="button"
                  onClick={handleRetry}
                  className="rounded-xl border border-red-500/30 px-4 py-2 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/10"
                >
                  {c.retry}
                </button>
              </div>
            )}

            {!isLoading && !error && filteredListings.length === 0 && (
              <div className="flex h-64 items-center justify-center">
                <p className="text-sm text-slate-500">{c.empty}</p>
              </div>
            )}

            {filteredListings.length > 0 && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {filteredListings.map((listing) => (
                  <ListingCard
                    key={listing.id}
                    listing={listing}
                    isInstalled={isSkillInstalled(listing)}
                    isInstalling={installingIds.has(listing.id)}
                    installError={installErrors[listing.id]}
                    onSelect={setSelectedListing}
                    onInstall={handleInstall}
                    c={c}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Detail slide-out */}
          {selectedListing && (
            <div className="absolute right-0 top-0 h-full w-[400px] border-l border-[#2a2d3a] bg-[#161922]">
              <SkillDetail
                listing={selectedListing}
                isInstalled={isSkillInstalled(selectedListing)}
                isInstalling={installingIds.has(selectedListing.id)}
                installError={installErrors[selectedListing.id]}
                onInstall={handleInstall}
                onClose={() => setSelectedListing(null)}
                onCloseModal={onClose}
                c={c}
              />
            </div>
          )}
        </div>

        {/* Toast */}
        {toastMessage && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-2xl border border-purple-500/30 bg-purple-500/15 px-5 py-3 text-sm text-purple-100 shadow-lg backdrop-blur">
            {toastMessage}
          </div>
        )}
      </div>
    </div>
  );
}
