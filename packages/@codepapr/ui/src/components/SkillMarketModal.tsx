import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAgentStore } from '../store/agentStore';
import { fetchSkillListings, listSkillTags, searchSkills } from '../tools/marketSkillApi';
import { commitSkillInstall, planSkillInstall, previewSkillMarkdown } from '../tools/marketSkillInstall';
import type { SkillMarketListing } from '../utils/marketSkillTypes';
import type { Lang } from '../utils/i18n';
import {
  buildLockEntry,
  collectDefinitionIds,
  collectOverwriteCandidates,
  collectUninstallSkillIds,
  emptySkillsLock,
  findLockEntry,
  isSkillListingInstalled,
  listExistingSkillPaths,
  loadSkillsLock,
  removeListingFromLock,
  saveSkillsLock,
  upsertLockEntry,
  type SkillsLockFile,
} from '../utils/skillsLock';

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
      noWorkspaceOpen: 'No workspace open',
      installSuccess: 'Skill installed to .CodePapr/skills/',
      tags: 'Tags',
      allTags: 'All',
      back: 'Back to results',
      pluginNoticeTitle: 'This is a Claude Code Plugin',
      pluginNoticeDesc: 'This skill is designed as a Claude Code plugin with commands, hooks, and multi-agent orchestration. CodePapr can only install the SKILL.md instruction files; full plugin features may not work correctly.',
      pluginNoticeHint: 'Installing will attempt to extract available sub-skills as best-effort.',
      tryInstallSubskills: 'Try Install (sub-skills only)',
      update: 'Update',
      uninstall: 'Uninstall',
      uninstalling: 'Uninstalling...',
      preview: 'SKILL.md preview',
      previewLoading: 'Loading preview…',
      previewEmpty: 'No SKILL.md preview available.',
      previewError: 'Failed to load preview.',
      installMany: (title: string, count: number, resources: number) =>
        resources > 0
          ? `${title}: ${count} skills + ${resources} resources installed`
          : `${title}: ${count} skills installed`,
      installWithResources: (title: string, resources: number) =>
        `${title}: SKILL.md + ${resources} resources installed`,
      uninstallSuccess: (title: string) => `${title} uninstalled`,
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
      noWorkspaceOpen: '尚未開啟工作區',
      installSuccess: 'Skill 已安裝到 .CodePapr/skills/',
      tags: '標籤',
      allTags: '全部',
      back: '返回結果',
      pluginNoticeTitle: '這是 Claude Code 外掛',
      pluginNoticeDesc: '此 Skill 設計為 Claude Code 外掛，包含指令、鉤子與多 Agent 協作。CodePapr 僅能安裝 SKILL.md 指令檔，完整外掛功能可能無法正常運作。',
      pluginNoticeHint: '安裝將盡力提取可用的子技能。',
      tryInstallSubskills: '嘗試安裝（僅子技能）',
      update: '更新',
      uninstall: '卸載',
      uninstalling: '卸載中...',
      preview: 'SKILL.md 預覽',
      previewLoading: '正在載入預覽…',
      previewEmpty: '沒有可用的 SKILL.md 預覽。',
      previewError: '預覽載入失敗。',
      installMany: (title: string, count: number, resources: number) =>
        resources > 0
          ? `${title}：已安裝 ${count} 個 Skill + ${resources} 個資源`
          : `${title}：已安裝 ${count} 個 Skill`,
      installWithResources: (title: string, resources: number) =>
        `${title}：已安裝 SKILL.md + ${resources} 個資源`,
      uninstallSuccess: (title: string) => `已卸載 ${title}`,
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
    noWorkspaceOpen: '尚未打开工作区',
    installSuccess: 'Skill 已安装到 .CodePapr/skills/',
    tags: '标签',
    allTags: '全部',
    back: '返回结果',
    pluginNoticeTitle: '这是 Claude Code 插件',
    pluginNoticeDesc: '此 Skill 设计为 Claude Code 插件，包含命令、钩子与多 Agent 协作。CodePapr 仅能安装 SKILL.md 指令文件，完整插件功能可能无法正常运行。',
    pluginNoticeHint: '安装将尽力提取可用的子技能。',
    tryInstallSubskills: '尝试安装（仅子技能）',
    update: '更新',
    uninstall: '卸载',
    uninstalling: '卸载中...',
    preview: 'SKILL.md 预览',
    previewLoading: '正在加载预览…',
    previewEmpty: '没有可用的 SKILL.md 预览。',
    previewError: '预览加载失败。',
    installMany: (title: string, count: number, resources: number) =>
      resources > 0
        ? `${title}：已安装 ${count} 个 Skill + ${resources} 个资源`
        : `${title}：已安装 ${count} 个 Skill`,
    installWithResources: (title: string, resources: number) =>
      `${title}：已安装 SKILL.md + ${resources} 个资源`,
    uninstallSuccess: (title: string) => `已卸载 ${title}`,
  };
}

interface SkillMarketModalProps {
  onClose: () => void;
}

function SkeletonCard() {
  return (
    <div className="rounded-2xl border border-line bg-base p-4">
      <div className="flex items-start gap-3">
        <div className="h-10 w-10 flex-shrink-0 animate-pulse rounded-xl bg-raised" />
        <div className="flex-1 space-y-2">
          <div className="h-4 w-2/3 animate-pulse rounded bg-raised" />
          <div className="h-3 w-1/3 animate-pulse rounded bg-raised" />
        </div>
      </div>
      <div className="mt-3 space-y-1.5">
        <div className="h-3 w-full animate-pulse rounded bg-raised" />
        <div className="h-3 w-4/5 animate-pulse rounded bg-raised" />
      </div>
      <div className="mt-3 flex gap-1.5">
        <div className="h-5 w-16 animate-pulse rounded-md bg-raised" />
        <div className="h-5 w-12 animate-pulse rounded-md bg-raised" />
      </div>
    </div>
  );
}

function ListingCard({
  listing,
  isInstalled,
  isInstalling,
  isUninstalling,
  installError,
  onSelect,
  onInstall,
  onUninstall,
  onRetryInstall,
  c,
}: {
  listing: SkillMarketListing;
  isInstalled: boolean;
  isInstalling: boolean;
  isUninstalling: boolean;
  installError?: string;
  onSelect: (listing: SkillMarketListing) => void;
  onInstall: (listing: SkillMarketListing) => void;
  onUninstall: (listing: SkillMarketListing) => void;
  onRetryInstall: (listing: SkillMarketListing) => void;
  c: ReturnType<typeof copy>;
}) {
  const initial = listing.title.charAt(0).toUpperCase();

  return (
    <button
      type="button"
      onClick={() => onSelect(listing)}
      className="group relative flex flex-col gap-3 rounded-2xl border border-line bg-base p-4 text-left transition-all hover:border-purple-500/40 hover:bg-base"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-raised text-sm font-bold text-fg-soft">
          {initial}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="truncate text-sm font-semibold text-fg">{listing.title}</h3>
            {listing.verified ? (
              <span className="flex-shrink-0 rounded-full border border-ok-bg bg-ok-bg px-1.5 py-0.5 text-[9px] font-medium text-ok">{c.verified}</span>
            ) : (
              <span className="flex-shrink-0 rounded-full border border-warn-bg bg-warn-bg px-1.5 py-0.5 text-[9px] font-medium text-warn">{c.notVerified}</span>
            )}
          </div>
          <p className="mt-0.5 truncate text-[11px] text-fg-muted">{listing.sourceRepo}</p>
        </div>
        <span className="flex-shrink-0 rounded-full border border-purple-500/30 bg-purple-500/15 px-2 py-0.5 text-[9px] font-medium text-purple-200">
          {c.agentuse}
        </span>
      </div>

      <p className="line-clamp-2 text-xs leading-relaxed text-fg-muted">{listing.description}</p>

      <div className="flex flex-wrap items-center gap-1.5">
        {listing.tags.slice(0, 4).map((tag) => (
          <span key={tag} className="rounded-md border border-line px-1.5 py-0.5 text-[10px] text-fg-muted">
            {tag}
          </span>
        ))}
      </div>

      <div className="mt-auto flex items-center justify-between border-t border-line pt-2.5">
        <span />
        {isUninstalling ? (
          <span className="rounded-lg bg-danger-bg px-3 py-1.5 text-[10px] font-semibold text-danger">{c.uninstalling}</span>
        ) : isInstalling ? (
          <span className="rounded-lg bg-purple-500/20 px-3 py-1.5 text-[10px] font-semibold text-purple-200">{c.installing}</span>
        ) : isInstalled ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onInstall(listing); }}
              className="rounded-lg bg-purple-500/20 px-3 py-1.5 text-[10px] font-semibold text-purple-100 transition-colors hover:bg-purple-500/35"
            >
              {c.update}
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onUninstall(listing); }}
              className="rounded-lg bg-danger-bg px-3 py-1.5 text-[10px] font-semibold text-danger transition-colors hover:bg-danger-bg"
            >
              {c.uninstall}
            </button>
          </div>
        ) : installError ? (
          // #19：失败时除错误信息外提供「重试」按钮——旧实现只有错误徽标，
          // 只能进详情页重试，卡片上无法直接重来。
          <div className="flex items-center gap-2">
            <span className="max-w-[180px] truncate rounded-lg bg-danger-bg px-3 py-1.5 text-[10px] font-semibold text-danger" title={installError}>
              {installError}
            </span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onRetryInstall(listing); }}
              className="shrink-0 rounded-lg bg-danger-bg px-3 py-1.5 text-[10px] font-semibold text-danger transition-colors hover:bg-danger-bg"
            >
              {c.retry}
            </button>
          </div>
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
  isUninstalling,
  installError,
  onInstall,
  onUninstall,
  onClose,
  onCloseModal,
  c,
}: {
  listing: SkillMarketListing;
  isInstalled: boolean;
  isInstalling: boolean;
  isUninstalling: boolean;
  installError?: string;
  onInstall: (listing: SkillMarketListing) => void;
  onUninstall: (listing: SkillMarketListing) => void;
  onClose: () => void;
  onCloseModal: () => void;
  c: ReturnType<typeof copy>;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const [previewState, setPreviewState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setPreviewState('loading');
    void previewSkillMarkdown(listing.name, listing.sourceRepo)
      .then((content) => {
        if (cancelled) return;
        if (content?.trim()) {
          setPreview(content);
          setPreviewState('ready');
        } else {
          setPreview(null);
          setPreviewState('empty');
        }
      })
      .catch(() => {
        if (cancelled) return;
        setPreview(null);
        setPreviewState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [listing.id, listing.name, listing.sourceRepo]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-line px-6 py-4">
        <button
          type="button"
          onClick={onClose}
          className="flex items-center gap-2 text-xs text-fg-muted transition-colors hover:text-fg"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          {c.back}
        </button>
        <div className="flex items-center gap-2">
          <span className={`rounded-full border px-2.5 py-0.5 text-[10px] font-medium ${listing.verified ? 'border-ok-bg bg-ok-bg text-ok' : 'border-warn-bg bg-warn-bg text-warn'}`}>
            {listing.verified ? c.verified : c.notVerified}
          </span>
          <button onClick={onCloseModal} title={c.close} className="text-2xl leading-none text-fg-muted hover:text-fg-soft">×</button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="flex items-start gap-4">
          <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-2xl bg-raised text-xl font-bold text-fg-soft">
            {listing.title.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold text-fg">{listing.title}</h2>
            <p className="mt-0.5 text-xs text-fg-muted">{listing.id}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {listing.tags.map((tag) => (
                <span key={tag} className="rounded-md border border-line px-2 py-0.5 text-[10px] text-fg-muted">
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </div>

        <p className="mt-5 text-sm leading-relaxed text-fg-soft">{listing.description}</p>

        {listing.features.length > 0 && (
          <div className="mt-5">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">{c.features}</h3>
            <ul className="space-y-2">
              {listing.features.map((feat, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-fg-muted">
                  <span className="mt-0.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-purple-400" />
                  {feat}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-5">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">{c.preview}</h3>
          {previewState === 'loading' && (
            <p className="text-xs text-fg-muted">{c.previewLoading}</p>
          )}
          {previewState === 'error' && (
            <p className="text-xs text-danger">{c.previewError}</p>
          )}
          {previewState === 'empty' && (
            <p className="text-xs text-fg-muted">{c.previewEmpty}</p>
          )}
          {previewState === 'ready' && preview && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-2xl border border-line bg-base p-3 text-[11px] leading-relaxed text-fg-muted">
              {preview}
            </pre>
          )}
        </div>

        <div className="mt-5 rounded-2xl border border-line bg-base p-4">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fg-muted">{c.repository}</h3>
          <code className="mt-2 block truncate text-[11px] text-fg-muted">{listing.sourceRepo}</code>
        </div>

        {listing.isPlugin && (
          <div className="mt-4 rounded-2xl border border-warn-bg bg-warn-bg p-4">
            <div className="flex items-start gap-2.5">
              <svg className="mt-0.5 h-4 w-4 flex-shrink-0 text-warn" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-warn">{c.pluginNoticeTitle}</p>
                <p className="mt-1 text-[11px] leading-relaxed text-warn">{c.pluginNoticeDesc}</p>
                <p className="mt-2 text-[11px] text-warn">{c.pluginNoticeHint}</p>
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
              className="rounded-lg border border-line px-3 py-1.5 text-[10px] font-medium text-fg-muted transition-colors hover:border-purple-500/40 hover:text-purple-200"
            >
              {c.repository}
            </a>
          )}
          {listing.websiteUrl && (
            <a
              href={listing.websiteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg border border-line px-3 py-1.5 text-[10px] font-medium text-fg-muted transition-colors hover:border-purple-500/40 hover:text-purple-200"
            >
              {c.website}
            </a>
          )}
        </div>
      </div>

      <div className="border-t border-line px-6 py-4">
        {isUninstalling ? (
          <span className="inline-flex w-full items-center justify-center rounded-xl bg-danger-bg py-3 text-sm font-semibold text-danger">
            {c.uninstalling}
          </span>
        ) : isInstalling ? (
          <span className="inline-flex w-full items-center justify-center rounded-xl bg-purple-500/20 py-3 text-sm font-semibold text-purple-200">
            {c.installing}
          </span>
        ) : isInstalled ? (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onInstall(listing)}
              className="flex flex-1 items-center justify-center rounded-xl border border-purple-500/50 bg-purple-500/15 py-3 text-sm font-semibold text-purple-100 transition-colors hover:bg-purple-500/25"
            >
              {c.update}
            </button>
            <button
              type="button"
              onClick={() => onUninstall(listing)}
              className="flex flex-1 items-center justify-center rounded-xl border border-danger-bg bg-danger-bg py-3 text-sm font-semibold text-danger transition-colors hover:bg-danger-bg"
            >
              {c.uninstall}
            </button>
          </div>
        ) : installError ? (
          <div className="text-center">
            <span className="text-xs text-danger">{installError}</span>
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
            className="flex w-full items-center justify-center rounded-xl border border-warn-bg bg-warn-bg py-3 text-sm font-semibold text-warn transition-colors hover:bg-warn-bg"
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

export function confirmSkillUninstall(lang: string | undefined, title: string): boolean {
  const confirmText =
    lang === 'en'
      ? `Uninstall "${title}"? Local skill files will be deleted. This cannot be undone.`
      : lang === 'zh-TW'
        ? `卸載「${title}」？將刪除本地 Skill 檔案，此操作無法撤銷。`
        : `卸载「${title}」？将删除本地 Skill 文件，此操作无法撤销。`;
  return typeof window !== 'undefined' && window.confirm(confirmText);
}

async function refreshSkills(workspacePath: string) {
  try {
    await useAgentStore.getState()._loadProjectConfig(workspacePath);
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
  const [uninstallingIds, setUninstallingIds] = useState<Set<string>>(new Set());
  const [installErrors, setInstallErrors] = useState<Record<string, string>>({});
  const [lock, setLock] = useState<SkillsLockFile>(emptySkillsLock);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // #19：toast 定时清除统一入口。旧实现用闭包里的 toastMessage 判断是否
  // 安排清除——首次安装时闭包值为 null，永远不安排 → toast 常驻不消失；
  // 连续安装时还会出现旧定时器提前清掉新 toast 的竞态。
  const showToast = useCallback((message: string) => {
    setToastMessage(message);
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = setTimeout(() => {
      toastTimerRef.current = null;
      setToastMessage(null);
    }, 3_000);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!workspacePath) {
      setLock(emptySkillsLock());
      return;
    }
    let cancelled = false;
    void loadSkillsLock(invoke, workspacePath).then((next) => {
      if (!cancelled) {
        setLock(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [workspacePath]);

  const definitionIds = useMemo(
    () => collectDefinitionIds(skillDefinitions),
    [skillDefinitions]
  );

  const isSkillInstalled = useCallback(
    (listing: SkillMarketListing): boolean =>
      isSkillListingInstalled(listing, lock, definitionIds),
    [lock, definitionIds]
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
    fetchSkillListings({ forceRefresh: true })
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
      showToast(c.noWorkspace);
      return;
    }

    setInstallingIds((prev) => new Set(prev).add(listing.id));
    setInstallErrors((prev) => { const n = { ...prev }; delete n[listing.id]; return n; });

    const finish = () => {
      setInstallingIds((prev) => {
        const next = new Set(prev);
        next.delete(listing.id);
        return next;
      });
    };

    try {
      const currentLock = await loadSkillsLock(invoke, workspacePath);
      const planned = await planSkillInstall(listing.name, listing.sourceRepo);
      if (!planned.ok) {
        setInstallErrors((prev) => ({ ...prev, [listing.id]: planned.error || c.installError }));
        return;
      }

      const plannedIds = planned.plan.skillFiles.map((file) => file.skillId);
      const candidates = collectOverwriteCandidates(listing, currentLock, plannedIds);
      const existing = await listExistingSkillPaths(invoke, workspacePath, candidates);
      if (existing.length > 0 && !confirmSkillOverwrite(settings.lang, listing.title)) {
        return;
      }

      // 更新时旧锁条目里、新方案已不再包含的子技能要一并删掉，
      // 否则它们会以孤儿目录的形式留在磁盘上、脱离锁的管理。
      const prevEntry = findLockEntry(currentLock, listing);
      const staleSkillIds = prevEntry
        ? prevEntry.skillIds.filter((id) => !plannedIds.includes(id))
        : [];

      const result = await commitSkillInstall(planned.plan, workspacePath, invoke);
      if (!result.ok) {
        setInstallErrors((prev) => ({ ...prev, [listing.id]: result.error || c.installError }));
        return;
      }

      const { setSkillEnabledState } = useAgentStore.getState();
      for (const staleId of staleSkillIds) {
        try {
          await invoke('delete_workspace_dir', {
            workspacePath,
            relativePath: `.CodePapr/skills/${staleId}`,
          });
        } catch {
          try {
            await invoke('delete_workspace_file', {
              workspacePath,
              relativePath: `.CodePapr/skills/${staleId}.md`,
            });
          } catch {
            // 旧子技能可能已被手动删除
          }
        }
        setSkillEnabledState(staleId, null);
      }

      const nextLock = upsertLockEntry(
        currentLock,
        buildLockEntry({
          listingId: listing.id,
          listingName: listing.name,
          sourceRepo: listing.sourceRepo,
          skillFiles: planned.plan.skillFiles,
        })
      );
      await saveSkillsLock(invoke, workspacePath, nextLock);
      setLock(nextLock);

      if (result.installed.length > 1) {
        showToast(c.installMany(listing.title, result.installed.length, result.resources));
      } else if (result.resources > 0) {
        showToast(c.installWithResources(listing.title, result.resources));
      } else {
        showToast(`${listing.title} ${c.installSuccess}`);
      }
      await refreshSkills(workspacePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setInstallErrors((prev) => ({ ...prev, [listing.id]: msg || c.installError }));
    } finally {
      finish();
    }
  }, [workspacePath, c, showToast, settings.lang]);

  const handleRetryInstall = useCallback(
    (listing: SkillMarketListing) => {
      setInstallErrors((prev) => {
        const next = { ...prev };
        delete next[listing.id];
        return next;
      });
      void handleInstall(listing);
    },
    [handleInstall]
  );

  const handleUninstall = useCallback(async (listing: SkillMarketListing) => {
    if (!workspacePath) {
      showToast(c.noWorkspace);
      return;
    }
    if (!confirmSkillUninstall(settings.lang, listing.title)) {
      return;
    }

    setUninstallingIds((prev) => new Set(prev).add(listing.id));
    setInstallErrors((prev) => {
      const next = { ...prev };
      delete next[listing.id];
      return next;
    });

    const finish = () => {
      setUninstallingIds((prev) => {
        const next = new Set(prev);
        next.delete(listing.id);
        return next;
      });
    };

    try {
      const currentLock = await loadSkillsLock(invoke, workspacePath);
      const skillIds = collectUninstallSkillIds(listing, currentLock, definitionIds);
      const { setSkillEnabledState } = useAgentStore.getState();
      for (const skillId of skillIds) {
        try {
          await invoke('delete_workspace_dir', {
            workspacePath,
            relativePath: `.CodePapr/skills/${skillId}`,
          });
        } catch {
          try {
            await invoke('delete_workspace_file', {
              workspacePath,
              relativePath: `.CodePapr/skills/${skillId}.md`,
            });
          } catch {
            // 目录或扁平文件可能已经不在磁盘上
          }
        }
        // 停用状态若不清理，重装同名 Skill 会静默保持禁用、不出现在目录里。
        setSkillEnabledState(skillId, null);
      }

      const nextLock = removeListingFromLock(currentLock, listing);
      await saveSkillsLock(invoke, workspacePath, nextLock);
      setLock(nextLock);
      showToast(c.uninstallSuccess(listing.title));
      await refreshSkills(workspacePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setInstallErrors((prev) => ({ ...prev, [listing.id]: msg || c.installError }));
    } finally {
      finish();
    }
  }, [workspacePath, c, showToast, settings.lang, definitionIds]);

  const availableTags = useMemo(() => listSkillTags(listings), [listings]);

  const filteredListings = useMemo(() => {
    return searchSkills(listings, searchQuery, selectedTag);
  }, [listings, searchQuery, selectedTag]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-overlay backdrop-blur-sm">
      <div className="flex h-[90vh] w-[min(96vw,1100px)] flex-col rounded-3xl border border-line bg-raised shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-fg">{c.title}</h2>
            <span className="rounded-lg border border-purple-500/30 bg-purple-500/10 px-2 py-1 text-[10px] font-semibold text-purple-200">{c.agentuse}</span>
            {!workspacePath && (
              <span className="rounded-lg border border-warn-bg bg-warn-bg px-2 py-1 text-[10px] text-warn">{c.noWorkspaceOpen}</span>
            )}
          </div>
          <button onClick={onClose} title={c.close} className="text-2xl leading-none text-fg-muted hover:text-fg-soft">×</button>
        </div>

        {/* Search */}
        <div className="border-b border-line px-6 py-3">
          <div className="relative">
            <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              ref={searchRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={c.search}
              className="w-full rounded-xl border border-line bg-base py-2 pl-9 pr-3 text-sm text-fg placeholder-slate-600 focus:border-purple-500/60 focus:outline-none"
            />
          </div>
          {availableTags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setSelectedTag(null)}
                className={`rounded-md border px-2 py-0.5 text-[10px] ${
                  selectedTag === null
                    ? 'border-purple-500/50 bg-purple-500/15 text-purple-100'
                    : 'border-line text-fg-muted hover:border-purple-500/40'
                }`}
              >
                {c.allTags}
              </button>
              {availableTags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => setSelectedTag((current) => (current === tag ? null : tag))}
                  className={`rounded-md border px-2 py-0.5 text-[10px] ${
                    selectedTag === tag
                      ? 'border-purple-500/50 bg-purple-500/15 text-purple-100'
                      : 'border-line text-fg-muted hover:border-purple-500/40'
                  }`}
                >
                  {tag}
                </button>
              ))}
            </div>
          )}
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
                <p className="text-sm text-danger">{c.error}</p>
                <p className="text-xs text-fg-dim">{error}</p>
                <button
                  type="button"
                  onClick={handleRetry}
                  className="rounded-xl border border-danger-bg px-4 py-2 text-xs font-medium text-danger transition-colors hover:bg-danger-bg"
                >
                  {c.retry}
                </button>
              </div>
            )}

            {!isLoading && !error && filteredListings.length === 0 && (
              <div className="flex h-64 items-center justify-center">
                <p className="text-sm text-fg-muted">{c.empty}</p>
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
                    isUninstalling={uninstallingIds.has(listing.id)}
                    installError={installErrors[listing.id]}
                    onSelect={setSelectedListing}
                    onInstall={handleInstall}
                    onUninstall={handleUninstall}
                    onRetryInstall={handleRetryInstall}
                    c={c}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Detail slide-out */}
          {selectedListing && (
            <div className="absolute right-0 top-0 h-full w-[400px] border-l border-line bg-base">
              <SkillDetail
                listing={selectedListing}
                isInstalled={isSkillInstalled(selectedListing)}
                isInstalling={installingIds.has(selectedListing.id)}
                isUninstalling={uninstallingIds.has(selectedListing.id)}
                installError={installErrors[selectedListing.id]}
                onInstall={handleInstall}
                onUninstall={handleUninstall}
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
