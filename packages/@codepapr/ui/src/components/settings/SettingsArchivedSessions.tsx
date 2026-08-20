import { useEffect } from 'react';
import { useAgentStore } from '../../store/agentStore';
import { FieldCard } from '../forms';
import type { Translation } from './types';
import type { Lang } from '../../utils/i18n';

function formatArchivedAt(timestamp: number | null | undefined, lang: Lang): string {
  if (typeof timestamp !== 'number' || timestamp <= 0) return '';
  const locale = lang === 'en' ? 'en-US' : lang === 'zh-TW' ? 'zh-TW' : 'zh-CN';
  return new Date(timestamp).toLocaleString(locale);
}

export function SettingsArchivedSessions({ t, currentLang }: { t: Translation; currentLang: Lang }) {
  const workspacePath = useAgentStore((state) => state.workspacePath);
  const archivedSessions = useAgentStore((state) => state.archivedSessions);
  const loadArchivedSessions = useAgentStore((state) => state.loadArchivedSessions);
  const restoreArchivedSession = useAgentStore((state) => state.restoreArchivedSession);
  const deleteArchivedSession = useAgentStore((state) => state.deleteArchivedSession);

  useEffect(() => {
    void loadArchivedSessions();
  }, [loadArchivedSessions, workspacePath]);

  const handleDelete = (id: string, name: string) => {
    const confirmText = t.deleteArchivedSessionConfirm.replace('{name}', name);
    if (typeof window !== 'undefined' && !window.confirm(confirmText)) return;
    deleteArchivedSession(id);
  };

  return (
    <FieldCard>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">
        {t.archivedSessions}
      </h3>
      <p className="mb-3 text-xs leading-relaxed text-fg-muted">{t.archivedSessionsDesc}</p>

      {!workspacePath && (
        <p className="text-xs text-fg-dim">{t.archivedSessionsNeedWorkspace}</p>
      )}

      {workspacePath && archivedSessions.length === 0 && (
        <p className="text-xs text-fg-dim">{t.noArchivedSessions}</p>
      )}

      {workspacePath && archivedSessions.length > 0 && (
        <div className="space-y-2">
          {archivedSessions.map((session) => (
            <div
              key={session.id}
              className="flex items-center gap-2 rounded-xl border border-line bg-raised px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-fg">{session.name}</p>
                {typeof session.archivedAt === 'number' && session.archivedAt > 0 && (
                  <p className="truncate text-[10px] text-fg-dim">
                    {formatArchivedAt(session.archivedAt, currentLang)}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => void restoreArchivedSession(session.id)}
                className="rounded-lg border border-accent-soft px-2.5 py-1 text-[11px] font-medium text-accent-text transition-colors hover:border-accent hover:bg-accent-soft"
              >
                {t.restoreSession}
              </button>
              <button
                type="button"
                onClick={() => handleDelete(session.id, session.name)}
                className="rounded-lg border border-line px-2.5 py-1 text-[11px] font-medium text-fg-muted transition-colors hover:border-danger-bg hover:text-danger"
              >
                {t.deleteArchivedSession}
              </button>
            </div>
          ))}
        </div>
      )}
    </FieldCard>
  );
}
