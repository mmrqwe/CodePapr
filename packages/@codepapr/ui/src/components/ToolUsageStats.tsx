import { useEffect, useMemo, useState } from 'react';
import { getTranslation, type Lang } from '../utils/i18n';
import { useAgentStore } from '../store/agentStore';
import { aggregateToolUsageInDb } from '../utils/projectStorage';
import type { UIMessage } from '../store/internals/types';

interface ToolUsage {
  name: string;
  count: number;
  success: number;
  error: number;
}

export function aggregateToolUsage(sessionMessages: Record<string, UIMessage[]>): ToolUsage[] {
  const map = new Map<string, ToolUsage>();
  for (const messages of Object.values(sessionMessages)) {
    for (const msg of messages) {
      for (const inv of msg.toolInvocations ?? []) {
        const entry = map.get(inv.name) ?? { name: inv.name, count: 0, success: 0, error: 0 };
        entry.count += 1;
        if (inv.status === 'success') entry.success += 1;
        else if (inv.status === 'error') entry.error += 1;
        map.set(inv.name, entry);
      }
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

export function ToolUsageStats({ lang }: { lang?: Lang }) {
  const t = getTranslation(lang);
  const workspacePath = useAgentStore((s) => s.workspacePath);
  const sessionMessages = useAgentStore((s) => s.sessionMessages);
  // Sessions are lazy-loaded (only a few stay resident in memory), so stats are
  // aggregated in the backend across all sessions; the in-memory aggregation
  // remains as a fallback when the command is unavailable.
  const [dbUsage, setDbUsage] = useState<ToolUsage[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDbUsage(null);
    if (!workspacePath) return;
    void aggregateToolUsageInDb(workspacePath)
      .then((result) => {
        if (!cancelled) setDbUsage(result.sort((a, b) => b.count - a.count));
      })
      .catch(() => {
        if (!cancelled) setDbUsage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workspacePath]);

  const usage = useMemo(
    () => dbUsage ?? aggregateToolUsage(sessionMessages),
    [dbUsage, sessionMessages]
  );
  const maxCount = Math.max(...usage.map((u) => u.count), 1);
  const totalCalls = usage.reduce((s, u) => s + u.count, 0);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-fg-soft">{t.toolUsageTitle}</p>
        <span className="text-[11px] text-fg-muted">
          {totalCalls.toLocaleString()} {t.toolUsageTotalCalls} · {usage.length} {t.toolUsageDistinctTools}
        </span>
      </div>

      {usage.length === 0 ? (
        <div className="rounded-xl border border-line bg-base px-4 py-3 text-xs text-fg-muted">
          {t.toolUsageEmpty}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3 px-1 text-[10px] text-fg-dim">
            <span className="w-44 flex-shrink-0">{t.toolUsageToolCol}</span>
            <span className="flex-1" />
            <span className="w-16 flex-shrink-0 text-right">{t.toolUsageCountCol}</span>
            <span className="w-14 flex-shrink-0 text-right">{t.toolUsageSuccessCol}</span>
          </div>
          <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
            {usage.map((u, i) => {
              const pct = (u.count / maxCount) * 100;
              const successRate = u.count > 0 ? (u.success / u.count) * 100 : 0;
              return (
                <div key={u.name} className="flex items-center gap-3">
                  <span
                    className="w-44 flex-shrink-0 truncate font-mono text-[11px] text-fg-soft"
                    title={`${u.name} · ${u.success} ok / ${u.error} err`}
                  >
                    {u.name}
                  </span>
                  <div className="h-5 flex-1 overflow-hidden rounded-md bg-deep">
                    <div
                      className="bar-grow flex h-full items-center justify-end rounded-md bg-accent-soft pr-1.5"
                      style={{ width: `${Math.max(pct, 2)}%`, animationDelay: `${i * 25}ms` }}
                    >
                      {pct >= 15 && <span className="text-[10px] font-medium text-fg/80">{u.count}</span>}
                    </div>
                  </div>
                  <span className="w-16 flex-shrink-0 text-right text-[11px] tabular-nums text-fg-muted">
                    {u.count.toLocaleString()}
                  </span>
                  <span
                    className={`w-14 flex-shrink-0 text-right text-[11px] tabular-nums ${
                      successRate >= 90 ? 'text-green-400' : successRate >= 60 ? 'text-yellow-400' : 'text-danger'
                    }`}
                  >
                    {successRate.toFixed(0)}%
                  </span>
                </div>
              );
            })}
          </div>
          <p className="px-1 text-[10px] leading-relaxed text-fg-dim">{t.toolUsageNote}</p>
        </>
      )}
    </div>
  );
}
