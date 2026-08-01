import { useState } from 'react';
import { useAgentStore } from '../store/agentStore';
import { aggregateProjectStats } from '../store/internals/stats';
import type { ConversationStats, ModelTierStats } from '../store/internals/types';
import { getTranslation, type Lang } from '../utils/i18n';

interface DeepSeekPricing {
  modelLabel: string;
  cacheReadPerMillionRmb: number;
  cacheMissInputPerMillionRmb: number;
  outputPerMillionRmb: number;
}

const PRIMARY_PRICING: DeepSeekPricing = {
  modelLabel: 'deepseek-v4-pro',
  cacheReadPerMillionRmb: 0.025,
  cacheMissInputPerMillionRmb: 3,
  outputPerMillionRmb: 6,
};

const FAST_PRICING: DeepSeekPricing = {
  modelLabel: 'deepseek-v4-flash',
  cacheReadPerMillionRmb: 0.02,
  cacheMissInputPerMillionRmb: 1,
  outputPerMillionRmb: 2,
};

function formatRmb(value: number): string {
  return `¥${value.toFixed(5)}`;
}

function StatRow({ label, value, color = 'text-slate-300' }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="flex justify-between items-center py-1.5">
      <span className="text-xs text-slate-500">{label}</span>
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
}

function ModelStatsBlock({ title, stats, pricing, t, showsDeepSeekPromptMiss, showCost = true, footnote }: ModelStatsBlockProps) {
  const { totalCacheRead, totalCacheCreation, totalInput, totalOutput, calls, rounds } = stats;

  const totalTokens = totalCacheRead + totalCacheCreation + totalInput;
  const totalCacheMissInput = totalCacheCreation + totalInput;
  const hitRate = totalTokens > 0 ? totalCacheRead / totalTokens : 0;

  const costWithCache = pricing
    ? (
        totalCacheRead * pricing.cacheReadPerMillionRmb +
        totalCacheMissInput * pricing.cacheMissInputPerMillionRmb +
        totalOutput * pricing.outputPerMillionRmb
      ) /
      1_000_000
    : 0;
  const costWithoutCache = pricing
    ? (totalTokens * pricing.cacheMissInputPerMillionRmb + totalOutput * pricing.outputPerMillionRmb) /
      1_000_000
    : 0;
  const savings = costWithoutCache > 0 ? 1 - costWithCache / costWithoutCache : 0;

  const hitColor =
    hitRate >= 0.8 ? 'text-green-400' : hitRate >= 0.5 ? 'text-yellow-400' : 'text-slate-400';

  return (
    <div className="rounded-xl border border-[#2a2d3a] bg-[#1a1d27] p-3">
      <p className="mb-3 text-xs font-semibold text-indigo-400">{title}</p>

      <div className="rounded-lg border border-[#2a2d3a] bg-[#151720] p-3 text-center mb-3">
        <p className="mb-1 text-[11px] text-slate-500">{t.cacheHitRate}</p>
        <p className={`text-2xl font-bold font-mono ${hitColor}`}>
          {(hitRate * 100).toFixed(1)}%
        </p>
        <div className="mt-2 flex justify-center gap-4">
          <span className="text-[11px] text-slate-600">{t.callCount}: {calls.toLocaleString()}</span>
          <span className="text-[11px] text-slate-600">{t.roundsLabel}: {rounds.toLocaleString()}</span>
        </div>
      </div>

      <div className="mb-3">
        <p className="mb-2 text-[11px] font-medium text-slate-500">{t.tokenUsage}</p>
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

      {showCost && pricing && (
        <div>
          <p className="mb-2 text-[11px] font-medium text-slate-500">{t.costEstimation}</p>
          <StatRow label={t.actualCost} value={formatRmb(costWithCache)} color="text-indigo-400" />
          <StatRow label={t.withoutCache} value={formatRmb(costWithoutCache)} color="text-slate-500" />
          <div className="mt-2 border-t border-[#2a2d3a] pt-2">
            <StatRow
              label={t.savings}
              value={`${(savings * 100).toFixed(1)}%`}
              color={savings > 0.5 ? 'text-green-400' : 'text-slate-400'}
            />
          </div>
        </div>
      )}

      {footnote && (
        <p className="mt-2 text-[10px] leading-relaxed text-slate-600">{footnote}</p>
      )}
    </div>
  );
}

export interface CacheStatsDashboardProps {
  lang?: Lang;
  collapsible?: boolean;
  onOpenContextInspector?: () => void;
}

export function CacheStatsDashboard({ lang, collapsible = true, onOpenContextInspector }: CacheStatsDashboardProps) {
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
            <h2 className="text-sm font-semibold text-slate-300">{t.cacheStatsTitle}</h2>
            {activeSession && (
              <p className="truncate text-[11px] text-slate-500">
                {t.session}: {activeSession.name}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            className="rounded-md border border-[#2a2d3a] px-2 py-1 text-[10px] font-medium text-slate-400 transition-colors hover:border-indigo-500/50 hover:text-slate-100"
          >
            {collapsed ? t.expand : t.collapse}
          </button>
        </div>
      )}

      {showContent && (
        <div className={`min-h-0 flex-1 space-y-4 overflow-y-scroll scrollbar-thin ${collapsible ? 'border-t border-[#2a2d3a] px-4 py-4' : 'px-4 py-4'}`}>
          <div className="flex items-center justify-between gap-3 rounded-xl border border-[#2a2d3a] bg-[#1a1d27] px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-[11px] text-slate-500">{t.currentContextLength}</p>
              <p className="font-mono text-sm font-semibold text-indigo-300">
                {contextSnapshot
                  ? `~${contextSnapshot.totalTokens.toLocaleString()} ${t.tokensUnit}`
                  : '—'}
              </p>
            </div>
            <button
              type="button"
              onClick={onOpenContextInspector}
              disabled={!contextSnapshot || !onOpenContextInspector}
              className="flex-shrink-0 rounded-lg border border-[#2a2d3a] px-2.5 py-1.5 text-xs font-medium text-slate-300 transition-colors enabled:hover:border-indigo-400 enabled:hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t.viewContext}
            </button>
          </div>

          <div className="flex rounded-lg border border-[#2a2d3a] bg-[#1a1d27] p-0.5">
            <button
              type="button"
              onClick={() => setViewMode('conversation')}
              className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                viewMode === 'conversation'
                  ? 'bg-indigo-500/20 text-indigo-300'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {t.thisConversation}
            </button>
            <button
              type="button"
              onClick={() => setViewMode('project')}
              className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                viewMode === 'project'
                  ? 'bg-indigo-500/20 text-indigo-300'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {t.entireProject}
            </button>
          </div>

          <ModelStatsBlock
            title={t.primaryModelTag}
            stats={displayedStats.primary}
            pricing={PRIMARY_PRICING}
            t={t}
            showsDeepSeekPromptMiss={showsDeepSeekPromptMiss}
          />

          <ModelStatsBlock
            title={t.fastModelTag}
            stats={displayedStats.fast}
            pricing={FAST_PRICING}
            t={t}
            showsDeepSeekPromptMiss={false}
          />

          {settings.mentorEnabled && settings.mentorModel && (
            <ModelStatsBlock
              title={`${t.mentorModelTag} · ${settings.mentorModel}`}
              stats={displayedStats.mentor}
              t={t}
              showsDeepSeekPromptMiss={false}
              showCost={false}
              footnote={t.mentorStatsIncludedNote}
            />
          )}
        </div>
      )}
    </div>
  );
}
