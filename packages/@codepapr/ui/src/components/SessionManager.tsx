import { useAgentStore, SessionMeta } from '../store/agentStore';
import { getTranslation } from '../utils/i18n';

function SessionItem({ session, isActive }: { session: SessionMeta; isActive: boolean }) {
  const selectSession = useAgentStore((state) => state.selectSession);
  const archiveSession = useAgentStore((state) => state.archiveSession);
  const settings = useAgentStore((state) => state.settings);
  const t = getTranslation(settings.lang);

  const handleArchiveClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    archiveSession(session.id);
  };

  return (
    <div
      onClick={() => selectSession(session.id)}
      className={`group flex items-center gap-2 px-3 py-1.5 rounded-lg cursor-pointer transition-colors ${
        isActive ? 'bg-accent-soft border border-accent-soft' : 'hover:bg-raised border border-transparent'
      }`}
    >
      <div className="flex-1 min-w-0">
        <p className={`text-xs font-medium truncate ${isActive ? 'text-accent-text' : 'text-fg-soft'}`}>
          {session.name}
        </p>
      </div>
      <button
        onClick={handleArchiveClick}
        className="opacity-0 group-hover:opacity-100 text-fg-dim hover:text-accent-text transition-all text-[10px] px-1"
        title={t.archiveSessionTip}
      >
        {t.archiveSession}
      </button>
    </div>
  );
}

export function SessionManager() {
  const sessions = useAgentStore((state) => state.sessions);
  const activeSessionId = useAgentStore((state) => state.activeSessionId);
  const newSession = useAgentStore((state) => state.newSession);
  const settings = useAgentStore((state) => state.settings);
  const t = getTranslation(settings.lang);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center border-b border-line px-4 min-h-[60px]">
        <button
          onClick={newSession}
          title={t.newTaskTip}
          className="w-full rounded-xl bg-accent px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-accent"
        >
          {t.newTask}
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain scrollbar-thin scrollbar-stable px-3 pt-2 pb-3">
        {sessions.length === 0 && (
          <p className="py-6 text-center text-xs text-fg-dim select-none">{t.noTasks}</p>
        )}
        {sessions.map((s) => (
          <SessionItem key={s.id} session={s} isActive={s.id === activeSessionId} />
        ))}
      </div>
    </div>
  );
}
