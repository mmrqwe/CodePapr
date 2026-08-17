import { useEffect, useMemo, useState } from 'react';
import { envelopeContent, planMemoryAdmission } from '@codepapr/core';
import { getTranslation, type Lang } from '../utils/i18n';
import { createId } from '../utils/createId';
import {
  admitMemoryCandidate,
  forgetMemoryEntry,
  loadMemoryCandidates,
  loadMemoryEntries,
  rejectMemoryCandidate,
  type PersistedMemoryCandidate,
  type PersistedMemoryEntry,
} from '../utils/projectStorage';
import { reprojectMemoryManagedZone } from '../tools/memoryTools';

interface MemoryLedgerPanelProps {
  workspacePath: string;
  lang?: Lang;
}

function trustBadge(
  entry: { confidence: string; trust: string },
  t: ReturnType<typeof getTranslation>
): { label: string; cls: string } {
  if (entry.trust === 'untrusted') {
    return { label: t.memoryLedgerEntryBadgeUnverified, cls: 'bg-slate-600/20 text-fg-dim' };
  }
  if (entry.confidence === 'confirmed') {
    return { label: t.memoryLedgerEntryBadgeVerified, cls: 'bg-accent-soft text-accent-text' };
  }
  return { label: t.memoryLedgerEntryBadgeReported, cls: 'bg-warn-bg text-warn' };
}

/**
 * 记忆管理面板（ADR-008/009 可观测性）：稳定记忆（含遗忘过滤）+ 候选队列 +
 * 准入/拒绝/遗忘操作。准入或遗忘后重新投影 managed zone（双区模型）。
 */
export function MemoryLedgerPanel({ workspacePath, lang }: MemoryLedgerPanelProps) {
  const t = getTranslation(lang);
  const [entries, setEntries] = useState<PersistedMemoryEntry[]>([]);
  const [candidates, setCandidates] = useState<PersistedMemoryCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForgotten, setShowForgotten] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [loadedEntries, loadedCandidates] = await Promise.all([
        loadMemoryEntries(workspacePath, false),
        loadMemoryCandidates(workspacePath, 'pending'),
      ]);
      setEntries(loadedEntries);
      setCandidates(loadedCandidates);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [workspacePath]);

  const withBusy = async (
    id: string,
    task: () => Promise<void>,
    refresh: 'entries' | 'drop-candidate' | 'full' = 'full'
  ): Promise<void> => {
    setBusyIds((prev) => new Set(prev).add(id));
    try {
      await task();
      if (refresh === 'full') {
        await load();
        return;
      }
      if (refresh === 'entries') {
        const loadedEntries = await loadMemoryEntries(workspacePath, false);
        setEntries(loadedEntries);
      }
      setCandidates((prev) => prev.filter((candidate) => candidate.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const visibleEntries = useMemo(
    () => entries.filter((entry) => showForgotten || entry.status === 'active'),
    [entries, showForgotten]
  );

  const actionButton = (id: string, label: string, kind: 'accent' | 'danger' | 'warn', onClick: () => void) => (
    <button
      type="button"
      disabled={busyIds.has(id)}
      onClick={onClick}
      className={`rounded-md border px-2 py-0.5 text-[10px] font-medium transition-colors disabled:opacity-40 ${
        kind === 'accent'
          ? 'border-accent-soft text-accent-text hover:border-accent'
          : kind === 'warn'
            ? 'border-warn-bg text-warn hover:border-warn'
            : 'border-line text-fg-dim hover:border-slate-500 hover:text-fg-soft'
      }`}
    >
      {label}
    </button>
  );

  if (loading) {
    return <p className="p-6 text-center text-xs text-fg-muted">{t.memoryLedgerLoading}</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain p-4 scrollbar-thin scrollbar-stable">
      {error ? (
        <p className="rounded-lg border border-warn-bg bg-warn-bg/10 px-3 py-2 text-xs text-warn">
          {t.memoryLedgerLoadError}: {error}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-fg-soft">{t.memoryLedgerRefresh}</span>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-md border border-line px-2 py-1 text-[10px] font-medium text-fg-muted transition-colors hover:border-accent-soft hover:text-fg"
        >
          ↻
        </button>
        <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[11px] text-fg-muted">
          <input
            type="checkbox"
            checked={showForgotten}
            onChange={(event) => setShowForgotten(event.target.checked)}
            className="accent-accent"
          />
          {t.memoryLedgerShowForgotten}
        </label>
      </div>

      <section>
        <h3 className="mb-2 text-xs font-semibold text-accent-text">
          {t.memoryLedgerEntries} ({visibleEntries.length})
        </h3>
        {visibleEntries.length === 0 ? (
          <p className="py-6 text-center text-xs text-fg-muted">{t.memoryLedgerEmpty}</p>
        ) : (
          <div className="space-y-2">
            {visibleEntries.map((entry) => {
              const badge = trustBadge(entry, t);
              return (
                <div
                  key={entry.id}
                  className="rounded-lg border border-line bg-raised px-3 py-2"
                >
                  <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${badge.cls}`}>
                      {badge.label}
                    </span>
                    <span className="font-mono text-[10px] text-fg-dim">{entry.category}</span>
                    {entry.status !== 'active' ? (
                      <span className="font-mono text-[10px] text-fg-dim">
                        {entry.status}
                        {entry.supersededBy ? ` → ${entry.supersededBy}` : ''}
                      </span>
                    ) : null}
                    <span className="ml-auto">
                      {entry.status === 'active'
                        ? actionButton(entry.id, t.memoryLedgerForget, 'danger', () =>
                            void withBusy(
                              entry.id,
                              async () => {
                                await forgetMemoryEntry(workspacePath, entry.id);
                                await reprojectMemoryManagedZone(workspacePath);
                              },
                              'entries'
                            )
                          )
                        : null}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-fg-soft">
                    {entry.content}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold text-warn">
          {t.memoryLedgerCandidates} ({candidates.length})
        </h3>
        {candidates.length === 0 ? (
          <p className="py-6 text-center text-xs text-fg-muted">{t.memoryLedgerEmpty}</p>
        ) : (
          <div className="space-y-2">
            {candidates.map((candidate) => {
              const badge = trustBadge(candidate, t);
              return (
                <div
                  key={candidate.id}
                  className="rounded-lg border border-dashed border-line bg-raised px-3 py-2"
                >
                  <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${badge.cls}`}>
                      {badge.label}
                    </span>
                    <span className="font-mono text-[10px] text-fg-dim">{candidate.category}</span>
                    <span className="ml-auto flex items-center gap-1.5">
                      {actionButton(candidate.id, t.memoryLedgerAdmit, 'accent', () =>
                        void withBusy(
                          candidate.id,
                          async () => {
                            // 准入策略（真正防线，ADR-008）：面板是唯一准入入口，
                            // 用户确认前仍须过 planMemoryAdmission 风险检测。
                            const admission = planMemoryAdmission(
                              envelopeContent({
                                source: 'memory-candidate',
                                trust: candidate.trust as 'trusted' | 'workspace' | 'derived' | 'untrusted',
                                origin: 'memory-ledger-panel',
                                content: candidate.content,
                              })
                            );
                            if (!admission.admitted) {
                              throw new Error(`准入策略拒绝: ${admission.reason}`);
                            }
                            await admitMemoryCandidate(workspacePath, candidate.id, createId());
                            await reprojectMemoryManagedZone(workspacePath);
                          },
                          'entries'
                        )
                      )}
                      {actionButton(candidate.id, t.memoryLedgerReject, 'warn', () =>
                        void withBusy(
                          candidate.id,
                          async () => {
                            await rejectMemoryCandidate(workspacePath, candidate.id, 'inspector-reject');
                          },
                          'drop-candidate'
                        )
                      )}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-fg-soft">
                    {candidate.content}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
