import { useState } from 'react';
import { useAgentStore } from '../store/agentStore';
import { aggregateProjectStats } from '../store/internals/stats';
import type { ConversationStats, ModelTierStats } from '../store/internals/types';
import { getTranslation, type Lang } from '../utils/i18n';

interface DeepSeekPriceTier {
  cacheReadPerMillionRmb: number;
  cacheMissInputPerMillionRmb: number;
  outputPerMillionRmb: number;
}

interface DeepSeekPricing {
  modelLabel: string;
  offPeak: DeepSeekPriceTier;
  peak: DeepSeekPriceTier;
}

const PRIMARY_PRICING: DeepSeekPricing = {
  modelLabel: 'deepseek-v4-pro',
  offPeak: {
    cacheReadPerMillionRmb: 0.15,
    cacheMissInputPerMillionRmb: 4.5,
    outputPerMillionRmb: 13.5,
  },
  peak: {
    cacheReadPerMillionRmb: 0.3,
    cacheMissInputPerMillionRmb: 9,
    outputPerMillionRmb: 27,
  },
};

const FAST_PRICING: DeepSeekPricing = {
  modelLabel: 'deepseek-v4-flash',
  offPeak: {
    cacheReadPerMillionRmb: 0.05,
    cacheMissInputPerMillionRmb: 1.5,
    outputPerMillionRmb: 4.5,
  },
  peak: {
    cacheReadPerMillionRmb: 0.1,
    cacheMissInputPerMillionRmb: 3,
    outputPerMillionRmb: 9,
  },
};

function formatRmb(value: number): string {
  return `¥${value.toFixed(5)}`;
}

function tierCost(
  cacheRead: number,
  cacheMissInput: number,
  output: number,
  tier: DeepSeekPriceTier
): number {
  return (
    (cacheRead * tier.cacheReadPerMillionRmb +
      cacheMissInput * tier.cacheMissInputPerMillionRmb +
      output * tier.outputPerMillionRmb) /
    1_000_000
  );
}

function formatDuration(ms: number | undefined): string {
  if (!ms || ms <= 0) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatTokenThroughput(
  outputTokens: number,
  modelRuntimeMs: number | undefined,
  unit: string,
): string {
  if (!modelRuntimeMs || modelRuntimeMs <= 0 || outputTokens <= 0) return '—';
  const rate = (outputTokens * 1000) / modelRuntimeMs;
  const formatted = rate >= 100 ? `${Math.round(rate)}` : rate >= 10 ? rate.toFixed(1) : rate.toFixed(2);
  return `${formatted} ${unit}`;
}

function throughputFromStats(stats: ModelTierStats, unit: string): string {
  return formatTokenThroughput(stats.totalOutput, stats.modelRuntimeMs, unit);
}

function aggregateThroughput(stats: ConversationStats, unit: string): string {
  let output = 0;
  let runtime = 0;
  for (const tier of [stats.primary, stats.fast, stats.mentor]) {
    if (typeof tier.modelRuntimeMs === 'number' && tier.modelRuntimeMs > 0) {
      output += tier.totalOutput;
      runtime += tier.modelRuntimeMs;
    }
  }
  return formatTokenThroughput(output, runtime > 0 ? runtime : undefined, unit);
}

/** 跨 tier 汇总耗时字段；所有 tier 都未测量时返回 undefined（显示 —）。 */
function sumRuntimeAcrossTiers(
  stats: ConversationStats,
  field: 'modelRuntimeMs' | 'toolRuntimeMs'
): number | undefined {
  let total: number | undefined;
  for (const tier of [stats.primary, stats.fast, stats.mentor]) {
    if (typeof tier[field] === 'number') {
      total = (total ?? 0) + tier[field];
    }
  }
  return total;
}

function StatRow({ label, value, color = 'text-fg-soft' }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="flex justify-between items-center py-1.5">
      <span className="text-xs text-fg-muted">{label}</span>
      <span className={`text-xs font-mono font-medium ${color}`}>{value}</span>
    </div>
  );
}

interface ModelStatsBlockProps {
  title: string;
  stats: ModelTierStats;
  pricing?: DeepSeekPricing;
  t: Record<string, string>;
  showsDeepSeekPromptMiss: boolean;
  showCost?: boolean;
  footnote?: string;
  /** 弹窗宽屏模式：卡片内命中率/token 明细、耗时/费用改为左右并排。 */
  wide?: boolean;
}

function ModelStatsBlock({ title, stats, pricing, t, showsDeepSeekPromptMiss, showCost = true, footnote, wide = false }: ModelStatsBlockProps) {
  const { totalCacheRead, totalCacheCreation, totalInput, totalOutput, calls, rounds } = stats;

  const totalTokens = totalCacheRead + totalCacheCreation + totalInput;
  const totalCacheMissInput = totalCacheCreation + totalInput;
  const hitRate = totalTokens > 0 ? totalCacheRead / totalTokens : 0;

  const costWithCacheOffPeak = pricing
    ? tierCost(totalCacheRead, totalCacheMissInput, totalOutput, pricing.offPeak)
    : 0;
  const costWithCachePeak = pricing
    ? tierCost(totalCacheRead, totalCacheMissInput, totalOutput, pricing.peak)
    : 0;
  const costWithoutCacheOffPeak = pricing
    ? tierCost(0, totalTokens, totalOutput, pricing.offPeak)
    : 0;
  const costWithoutCachePeak = pricing
    ? tierCost(0, totalTokens, totalOutput, pricing.peak)
    : 0;
  const savings = costWithoutCacheOffPeak > 0 ? 1 - costWithCacheOffPeak / costWithoutCacheOffPeak : 0;

  const hitColor =
    hitRate >= 0.8 ? 'text-green-400' : hitRate >= 0.5 ? 'text-yellow-400' : 'text-fg-muted';

  return (
    <div className="rounded-xl border border-line bg-raised p-3">
      <p className="mb-3 text-xs font-semibold text-accent">{title}</p>

      {/* wide 模式下视口足够宽（xl，卡片约 600px）时，命中率概览与
          token/耗时/费用明细左右并排；视口较窄仍纵向堆叠。 */}
      <div className={wide ? 'xl:grid xl:grid-cols-[220px_minmax(0,1fr)] xl:items-start xl:gap-4' : ''}>
        <div className={`rounded-lg border border-line bg-base p-3 text-center ${wide ? 'mb-3 xl:mb-0' : 'mb-3'}`}>
          <p className="mb-1 text-[11px] text-fg-muted">{t.cacheHitRate}</p>
          <p className={`text-2xl font-bold font-mono ${hitColor}`}>
            {(hitRate * 100).toFixed(1)}%
          </p>
          <div className="mt-2 flex justify-center gap-4">
            <span className="text-[11px] text-fg-dim">{t.callCount}: {calls.toLocaleString()}</span>
            <span className="text-[11px] text-fg-dim">{t.roundsLabel}: {rounds.toLocaleString()}</span>
          </div>
          <p className="mt-2 font-mono text-sm font-semibold text-accent-text" title={t.tokenThroughputTip}>
            {throughputFromStats(stats, t.tokenThroughputUnit)}
          </p>
        </div>

        <div className={wide ? 'min-w-0' : ''}>
          <div className="mb-3">
            <p className="mb-2 text-[11px] font-medium text-fg-muted">{t.tokenUsage}</p>
            <StatRow label={t.cacheRead} value={totalCacheRead.toLocaleString()} color="text-green-400" />
            {showsDeepSeekPromptMiss ? (
              <StatRow label={t.cacheMissInput} value={totalInput.toLocaleString()} color="text-yellow-400" />
            ) : (
              <>
                <StatRow label={t.cacheCreated} value={totalCacheCreation.toLocaleString()} color="text-yellow-400" />
                <StatRow label={t.newInput} value={totalInput.toLocaleString()} />
              </>
            )}
            <StatRow label={t.output} value={totalOutput.toLocaleString()} />
          </div>

          {(stats.modelRuntimeMs !== undefined || stats.toolRuntimeMs !== undefined) && (
            <div className="mb-3">
              <p className="mb-2 text-[11px] font-medium text-fg-muted">{t.runtimeBreakdown}</p>
              <StatRow
                label={t.modelRuntimeLabel}
                value={formatDuration(stats.modelRuntimeMs)}
                color="text-accent-text"
              />
              <StatRow
                label={t.toolRuntimeLabel}
                value={formatDuration(stats.toolRuntimeMs)}
                color="text-fg-soft"
              />
            </div>
          )}

          {showCost && pricing && (
            <div>
              <p className="mb-2 text-[11px] font-medium text-fg-muted">{t.costEstimation}</p>
              <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-1.5">
                <span />
                <span className="text-right text-[10px] text-fg-dim">{t.offPeakLabel}</span>
                <span className="text-right text-[10px] text-fg-dim">{t.peakLabel}</span>

                <span className="text-xs text-fg-muted">{t.actualCost}</span>
                <span className="text-right font-mono text-xs font-medium text-accent">
                  {formatRmb(costWithCacheOffPeak)}
                </span>
                <span className="text-right font-mono text-xs font-medium text-accent">
                  {formatRmb(costWithCachePeak)}
                </span>

                <span className="text-xs text-fg-muted">{t.withoutCache}</span>
                <span className="text-right font-mono text-xs text-fg-muted">
                  {formatRmb(costWithoutCacheOffPeak)}
                </span>
                <span className="text-right font-mono text-xs text-fg-muted">
                  {formatRmb(costWithoutCachePeak)}
                </span>
              </div>
              <div className="mt-2 border-t border-line pt-2">
                <StatRow
                  label={t.savings}
                  value={`${(savings * 100).toFixed(1)}%`}
                  color={savings > 0.5 ? 'text-green-400' : 'text-fg-muted'}
                />
              </div>
              <p className="mt-2 text-[10px] leading-relaxed text-fg-dim">{t.priceNotice}</p>
            </div>
          )}
        </div>
      </div>

      {footnote && (
        <p className="mt-2 text-[10px] leading-relaxed text-fg-dim">{footnote}</p>
      )}
    </div>
  );
}

export interface CacheStatsDashboardProps {
  lang?: Lang;
  collapsible?: boolean;
  /** 弹窗等宽容器模式：模型卡片分列展示，充分利用横向空间。 */
  wide?: boolean;
}

export function CacheStatsDashboard({ lang, collapsible = true, wide = false }: CacheStatsDashboardProps) {
  const settings = useAgentStore((state) => state.settings);
  const sessions = useAgentStore((state) => state.sessions);
  const activeSessionId = useAgentStore((state) => state.activeSessionId);
  const conversationStats = useAgentStore((state) => state.conversationStats);
  const sessionConversationStats = useAgentStore((state) => state.sessionConversationStats);
  const latestContextSnapshot = useAgentStore((state) => state._latestContextSnapshot);
  const [collapsed, setCollapsed] = useState(collapsible);
  const [viewMode, setViewMode] = useState<'conversation' | 'project'>('conversation');
  const t = getTranslation(lang ?? settings.lang);
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;

  const contextSnapshot =
    latestContextSnapshot && latestContextSnapshot.sessionId === activeSessionId
      ? latestContextSnapshot.snapshot
      : null;

  const normalizedProvider = settings.provider?.trim().toLowerCase() ?? '';
  const normalizedModel = settings.model?.trim().toLowerCase() ?? '';

  const displayedStats: ConversationStats =
    viewMode === 'project'
      ? aggregateProjectStats(sessionConversationStats)
      : conversationStats;

  // Derive the flag from the stats actually being displayed so the "Entire
  // Project" view doesn't reflect the current conversation's primary tier.
  const showsDeepSeekPromptMiss =
    (normalizedProvider === 'deepseek' || normalizedModel.includes('deepseek')) &&
    displayedStats.primary.totalCacheCreation === 0 &&
    displayedStats.primary.promptCacheMissTokens > 0;

  const showContent = !collapsible || !collapsed;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {collapsible && (
        <div className="flex items-center justify-between px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-fg-soft">{t.cacheStatsTitle}</h2>
            {activeSession && (
              <p className="truncate text-[11px] text-fg-muted">
                {t.session}: {activeSession.name}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            className="rounded-md border border-line px-2 py-1 text-[10px] font-medium text-fg-muted transition-colors hover:border-accent-soft hover:text-fg"
          >
            {collapsed ? t.expand : t.collapse}
          </button>
        </div>
      )}

      {showContent && (
        <div className={`min-h-0 flex-1 space-y-4 overflow-y-scroll scrollbar-thin ${collapsible ? 'border-t border-line px-4 py-4' : 'px-4 py-4'}`}>
          <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-raised px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-[11px] text-fg-muted">{t.currentContextLength}</p>
              <p className="font-mono text-sm font-semibold text-accent-text">
                {contextSnapshot
                  ? `~${contextSnapshot.totalTokens.toLocaleString()} ${t.tokensUnit}`
                  : '—'}
              </p>
            </div>
            <div className="min-w-0" title={t.modelRuntimeTip}>
              <p className="text-[11px] text-fg-muted">{t.modelRuntimeLabel}</p>
              <p className="font-mono text-sm font-semibold text-accent-text">
                {formatDuration(sumRuntimeAcrossTiers(displayedStats, 'modelRuntimeMs'))}
              </p>
              <p className="font-mono text-[10px] text-fg-dim">
                {t.toolRuntimeLabel}{' '}
                {formatDuration(sumRuntimeAcrossTiers(displayedStats, 'toolRuntimeMs'))}
              </p>
              <p className="font-mono text-[10px] text-accent-text" title={t.tokenThroughputTip}>
                {aggregateThroughput(displayedStats, t.tokenThroughputUnit)}
              </p>
            </div>
          </div>

          {/* wide 模式下弹窗很宽，切换条收窄避免两个按钮被拉得过开。 */}
          <div className={`flex rounded-lg border border-line bg-raised p-0.5 ${wide ? 'xl:w-72' : ''}`}>
            <button
              type="button"
              onClick={() => setViewMode('conversation')}
              className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                viewMode === 'conversation'
                  ? 'bg-accent-soft text-accent-text'
                  : 'text-fg-muted hover:text-fg-soft'
              }`}
            >
              {t.thisConversation}
            </button>
            <button
              type="button"
              onClick={() => setViewMode('project')}
              className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                viewMode === 'project'
                  ? 'bg-accent-soft text-accent-text'
                  : 'text-fg-muted hover:text-fg-soft'
              }`}
            >
              {t.entireProject}
            </button>
          </div>

          {/* wide 模式分两列：主模型与快速模型并排，导师模型（如有）
              落第二行。弹窗宽度上限 1280px，三列会过于拥挤。 */}
          <div className={wide ? 'grid gap-4 xl:grid-cols-2' : 'space-y-4'}>
            <ModelStatsBlock
              title={t.primaryModelTag}
              stats={displayedStats.primary}
              pricing={PRIMARY_PRICING}
              t={t}
              showsDeepSeekPromptMiss={showsDeepSeekPromptMiss}
              wide={wide}
            />

            <ModelStatsBlock
              title={t.fastModelTag}
              stats={displayedStats.fast}
              pricing={FAST_PRICING}
              t={t}
              showsDeepSeekPromptMiss={false}
              wide={wide}
            />

            {settings.mentorEnabled && settings.mentorModel && (
              <div className={wide ? 'xl:col-span-2' : ''}>
                <ModelStatsBlock
                  title={`${t.mentorModelTag} · ${settings.mentorModel}`}
                  stats={displayedStats.mentor}
                  t={t}
                  showsDeepSeekPromptMiss={false}
                  showCost={false}
                  footnote={t.mentorStatsIncludedNote}
                  wide={wide}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
