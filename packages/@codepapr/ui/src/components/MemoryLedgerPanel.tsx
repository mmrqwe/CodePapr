import { useEffect, useMemo, useState } from 'react';
import { envelopeContent, memoryEntryProjectsToBootstrap } from '@codepapr/core';
import { getTranslation, type Lang } from '../utils/i18n';
import {
  collapseMemoryDuplicates,
  forgetMemoryEntry,
  ingestLegacyMemoryMd,
  loadMemoryEntries,
  reviveMemoryEntry,
  updateMemoryEntryContent,
  type PersistedMemoryEntry,
} from '../utils/projectStorage';
import { persistMemoryProposal } from '../utils/memoryPersist';

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

function layerOf(entry: PersistedMemoryEntry): 'bootstrap' | 'recall' | 'citation' {
  if (entry.category === 'citation') return 'citation';
  return memoryEntryProjectsToBootstrap(entry.category, entry.confidence) ? 'bootstrap' : 'recall';
}

/**
 * 记忆目录：全部稳定记忆。系统自动写入；手写笔记在此新增/编辑；其余可遗忘。
 */
export function MemoryLedgerPanel({ workspacePath, lang }: MemoryLedgerPanelProps) {
  const t = getTranslation(lang);
  const [entries, setEntries] = useState<PersistedMemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForgotten, setShowForgotten] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [collapsing, setCollapsing] = useState(false);
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState('');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      await ingestLegacyMemoryMd(workspacePath).catch(() => undefined);
      setEntries(await loadMemoryEntries(workspacePath, false));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- D-4 ratchet：接入插件时的存量欠账，勿新增
  }, [workspacePath]);

  const withBusy = async (id: string, task: () => Promise<void>): Promise<void> => {
    setBusyIds((prev) => new Set(prev).add(id));
    try {
      await task();
      setEntries(await loadMemoryEntries(workspacePath, false));
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

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const bulkForget = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setError(null);
    setNotice(null);
    try {
      for (const id of ids) {
        await forgetMemoryEntry(workspacePath, id, 'panel:bulk-forget');
      }
      setNotice(t.memoryLedgerBulkForgetDone.replace('{{count}}', String(ids.length)));
      setSelected(new Set());
      setSelectMode(false);
      setEntries(await loadMemoryEntries(workspacePath, false));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const collapseDupes = async () => {
    setCollapsing(true);
    setError(null);
    setNotice(null);
    try {
      const collapsed = await collapseMemoryDuplicates(workspacePath);
      setNotice(
        collapsed > 0
          ? t.memoryLedgerCollapseDupesDone.replace('{{count}}', String(collapsed))
          : t.memoryLedgerCollapseDupesNone
      );
      setEntries(await loadMemoryEntries(workspacePath, false));
    } catch (err) {
      setError(`${t.memoryLedgerCollapseDupesFailed}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCollapsing(false);
    }
  };

  const visibleEntries = useMemo(
    () => entries.filter((entry) => showForgotten || entry.status === 'active'),
    [entries, showForgotten]
  );

  const grouped = useMemo(() => {
    const bootstrap: PersistedMemoryEntry[] = [];
    const recall: PersistedMemoryEntry[] = [];
    const citation: PersistedMemoryEntry[] = [];
    for (const entry of visibleEntries) {
      const layer = layerOf(entry);
      if (layer === 'citation') citation.push(entry);
      else if (layer === 'recall') recall.push(entry);
      else bootstrap.push(entry);
    }
    return { bootstrap, recall, citation };
  }, [visibleEntries]);

  const addNote = async () => {
    const content = draft.trim();
    if (content.length < 8) {
      setError(t.memoryLedgerNoteTooShort);
      return;
    }
    setError(null);
    try {
      const result = await persistMemoryProposal({
        workspacePath,
        envelope: envelopeContent({
          source: 'user',
          trust: 'trusted',
          origin: 'panel:user-note',
          content,
        }),
        category: 'user-note',
      });
      if (result.status === 'dropped') {
        setError(result.note);
        return;
      }
      setDraft('');
      setEntries(await loadMemoryEntries(workspacePath, false));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const saveEdit = async (entry: PersistedMemoryEntry) => {
    await withBusy(entry.id, async () => {
      await updateMemoryEntryContent(workspacePath, entry.id, editingDraft);
      setEditingId(null);
      setEditingDraft('');
    });
  };

  const renderEntry = (entry: PersistedMemoryEntry) => {
    const badge = trustBadge(entry, t);
    const bootstrap = memoryEntryProjectsToBootstrap(entry.category, entry.confidence);
    const isNote = entry.category === 'user-note';
    const busy = busyIds.has(entry.id);
    const editing = editingId === entry.id;
    return (
      <div key={entry.id} className="rounded-lg border border-line bg-raised px-3 py-2">
        <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          {selectMode && entry.status === 'active' ? (
            <input
              type="checkbox"
              checked={selected.has(entry.id)}
              onChange={() => toggleSelected(entry.id)}
              className="accent-accent"
              aria-label={t.memoryLedgerSelect}
            />
          ) : null}
          <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${badge.cls}`}>
            {badge.label}
          </span>
          <span className="rounded-md px-1.5 py-0.5 font-mono text-[10px] text-fg-dim">
            {entry.category === 'citation'
              ? t.memoryLedgerBadgeSearch
              : bootstrap
                ? t.memoryLedgerBadgeBootstrap
                : t.memoryLedgerBadgeRecall}
          </span>
          <span className="font-mono text-[10px] text-fg-dim">{entry.category}</span>
          {entry.status !== 'active' ? (
            <span className="font-mono text-[10px] text-fg-dim">
              {entry.status}
              {entry.supersededBy ? ` → ${entry.supersededBy}` : ''}
            </span>
          ) : null}
          <span className="ml-auto flex gap-1">
            {entry.status === 'active' && isNote ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setEditingId(entry.id);
                  setEditingDraft(entry.content);
                }}
                className="rounded-md border border-line px-2 py-0.5 text-[10px] font-medium text-fg-dim transition-colors hover:border-slate-500 hover:text-fg-soft disabled:opacity-40"
              >
                {t.memoryLedgerEdit}
              </button>
            ) : null}
            {entry.status === 'active' ? (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void withBusy(entry.id, async () => {
                    await forgetMemoryEntry(workspacePath, entry.id);
                  })
                }
                className="rounded-md border border-line px-2 py-0.5 text-[10px] font-medium text-fg-dim transition-colors hover:border-slate-500 hover:text-fg-soft disabled:opacity-40"
              >
                {t.memoryLedgerForget}
              </button>
            ) : null}
            {entry.status === 'forgotten' ? (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void withBusy(entry.id, async () => {
                    await reviveMemoryEntry(workspacePath, entry.id);
                  })
                }
                className="rounded-md border border-line px-2 py-0.5 text-[10px] font-medium text-fg-dim transition-colors hover:border-accent-soft hover:text-fg disabled:opacity-40"
              >
                {t.memoryLedgerRevive}
              </button>
            ) : null}
          </span>
        </div>
        {editing ? (
          <div className="space-y-2">
            <textarea
              value={editingDraft}
              onChange={(event) => setEditingDraft(event.target.value)}
              rows={3}
              className="w-full resize-y rounded-md border border-line bg-base px-2 py-1 text-xs text-fg-soft"
            />
            <div className="flex gap-1">
              <button
                type="button"
                disabled={busy}
                onClick={() => void saveEdit(entry)}
                className="rounded-md border border-accent-soft px-2 py-0.5 text-[10px] font-medium text-accent-text"
              >
                {t.memoryLedgerSave}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditingId(null);
                  setEditingDraft('');
                }}
                className="rounded-md border border-line px-2 py-0.5 text-[10px] font-medium text-fg-dim"
              >
                {t.memoryLedgerCancel}
              </button>
            </div>
          </div>
        ) : (
          <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-fg-soft">
            {entry.content}
          </p>
        )}
      </div>
    );
  };

  const renderGroup = (title: string, items: PersistedMemoryEntry[]) => (
    <section>
      <h3 className="mb-2 text-xs font-semibold text-accent-text">
        {title} ({items.length})
      </h3>
      {items.length === 0 ? (
        <p className="py-2 text-center text-xs text-fg-muted">{t.memoryLedgerEmpty}</p>
      ) : (
        <div className="space-y-2">{items.map(renderEntry)}</div>
      )}
    </section>
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
        <button
          type="button"
          disabled={collapsing}
          onClick={() => void collapseDupes()}
          className="rounded-md border border-line px-2 py-1 text-[10px] font-medium text-fg-muted transition-colors hover:border-accent-soft hover:text-fg disabled:opacity-40"
        >
          {t.memoryLedgerCollapseDupes}
        </button>
        <button
          type="button"
          onClick={() => {
            setSelectMode((prev) => !prev);
            setSelected(new Set());
          }}
          className={`rounded-md border px-2 py-1 text-[10px] font-medium transition-colors ${
            selectMode
              ? 'border-accent-soft text-accent-text'
              : 'border-line text-fg-muted hover:border-accent-soft hover:text-fg'
          }`}
        >
          {t.memoryLedgerSelect}
        </button>
        {selectMode ? (
          <button
            type="button"
            disabled={selected.size === 0}
            onClick={() => void bulkForget()}
            className="rounded-md border border-line px-2 py-1 text-[10px] font-medium text-fg-dim transition-colors hover:border-slate-500 hover:text-fg-soft disabled:opacity-40"
          >
            {t.memoryLedgerBulkForget} ({selected.size})
          </button>
        ) : null}
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

      {notice ? <p className="text-xs text-fg-muted">{notice}</p> : null}

      <p className="text-[11px] leading-relaxed text-fg-muted">{t.memoryLedgerHint}</p>

      <section className="space-y-2 rounded-lg border border-line bg-raised px-3 py-2">
        <h3 className="text-xs font-semibold text-fg-soft">{t.memoryLedgerAddNote}</h3>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t.memoryLedgerNotePlaceholder}
          rows={3}
          className="w-full resize-y rounded-md border border-line bg-base px-2 py-1 text-xs text-fg-soft"
        />
        <button
          type="button"
          onClick={() => void addNote()}
          className="rounded-md border border-accent-soft px-2 py-1 text-[10px] font-medium text-accent-text"
        >
          {t.memoryLedgerSave}
        </button>
      </section>

      {renderGroup(t.memoryLedgerGroupBootstrap, grouped.bootstrap)}
      {renderGroup(t.memoryLedgerGroupRecall, grouped.recall)}
      {renderGroup(t.memoryLedgerGroupCitation, grouped.citation)}
    </div>
  );
}
