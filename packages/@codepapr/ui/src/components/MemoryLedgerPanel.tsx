import { useEffect, useMemo, useState } from 'react';
import { memoryProjectsToBootstrap } from '@codepapr/core';
import { getTranslation, type Lang } from '../utils/i18n';
import {
  forgetMemoryEntry,
  loadMemoryEntries,
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
 * 记忆目录：全部稳定记忆 + 遗忘。系统自动写入，用户只事后浏览 / 遗忘。
 */
export function MemoryLedgerPanel({ workspacePath, lang }: MemoryLedgerPanelProps) {
  const t = getTranslation(lang);
  const [entries, setEntries] = useState<PersistedMemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForgotten, setShowForgotten] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setEntries(await loadMemoryEntries(workspacePath, false));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [workspacePath]);

  const withBusy = async (id: string, task: () => Promise<void>): Promise<void> => {
    setBusyIds((prev) => new Set(prev).add(id));
    try {
      await task();
      const loadedEntries = await loadMemoryEntries(workspacePath, false);
      setEntries(loadedEntries);
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

      <p className="text-[11px] leading-relaxed text-fg-muted">{t.memoryLedgerHint}</p>

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
              const bootstrap = memoryProjectsToBootstrap(entry.category);
              return (
                <div
                  key={entry.id}
                  className="rounded-lg border border-line bg-raised px-3 py-2"
                >
                  <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${badge.cls}`}>
                      {badge.label}
                    </span>
                    <span className="rounded-md px-1.5 py-0.5 font-mono text-[10px] text-fg-dim">
                      {bootstrap ? t.memoryLedgerBadgeBootstrap : t.memoryLedgerBadgeRecall}
                    </span>
                    <span className="font-mono text-[10px] text-fg-dim">{entry.category}</span>
                    {entry.status !== 'active' ? (
                      <span className="font-mono text-[10px] text-fg-dim">
                        {entry.status}
                        {entry.supersededBy ? ` → ${entry.supersededBy}` : ''}
                      </span>
                    ) : null}
                    <span className="ml-auto">
                      {entry.status === 'active' ? (
                        <button
                          type="button"
                          disabled={busyIds.has(entry.id)}
                          onClick={() =>
                            void withBusy(entry.id, async () => {
                              await forgetMemoryEntry(workspacePath, entry.id);
                              await reprojectMemoryManagedZone(workspacePath);
                            })
                          }
                          className="rounded-md border border-line px-2 py-0.5 text-[10px] font-medium text-fg-dim transition-colors hover:border-slate-500 hover:text-fg-soft disabled:opacity-40"
                        >
                          {t.memoryLedgerForget}
                        </button>
                      ) : null}
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
    </div>
  );
}
