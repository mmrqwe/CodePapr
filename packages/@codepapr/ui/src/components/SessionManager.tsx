import { useAgentStore, SessionMeta } from '../store/agentStore';
import { getTranslation } from '../utils/i18n';

function SessionItem({ session, isActive }: { session: SessionMeta; isActive: boolean }) {
  const selectSession = useAgentStore((state) => state.selectSession);
  const deleteSession = useAgentStore((state) => state.deleteSession);
  const settings = useAgentStore((state) => state.settings);
  const t = getTranslation(settings.lang);

  // N9：会话删除是 purge 语义（消息/checkpoint 永久清除，不可恢复），
  // 必须与角色卡删除一致先确认，误点 ✕ 不得直接摧毁整个会话。
  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const confirmText =
      settings.lang === 'en'
        ? `Delete session "${session.name}"? This cannot be undone.`
        : settings.lang === 'zh-TW'
          ? `刪除會話「${session.name}」？此操作無法復原。`
          : `删除会话「${session.name}」？此操作无法恢复。`;
    if (typeof window !== 'undefined' && !window.confirm(confirmText)) return;
    deleteSession(session.id);
  };

  return (
    <div
      onClick={() => selectSession(session.id)}
      className={`group flex items-center gap-2 px-3 py-1.5 rounded-lg cursor-pointer transition-colors ${
        isActive ? 'bg-indigo-600/20 border border-indigo-500/30' : 'hover:bg-[#1a1d27] border border-transparent'
      }`}
    >
      <div className="flex-1 min-w-0">
        <p className={`text-xs font-medium truncate ${isActive ? 'text-indigo-300' : 'text-slate-300'}`}>
          {session.name}
        </p>
      </div>
      <button
        onClick={handleDeleteClick}
        className="opacity-0 group-hover:opacity-100 text-slate-600 hover:text-red-400 transition-all text-xs px-1"
        title={t.deleteSession}
      >
        ✕
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
      <div className="flex items-center border-b border-[#202432] px-4 min-h-[60px]">
        <button
          onClick={newSession}
          title={t.newTaskTip}
          className="w-full rounded-xl bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
        >
          {t.newTask}
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain scrollbar-thin scrollbar-stable px-3 pt-2 pb-3">
        {sessions.length === 0 && (
          <p className="py-6 text-center text-xs text-slate-600 select-none">{t.noTasks}</p>
        )}
        {sessions.map((s) => (
          <SessionItem key={s.id} session={s} isActive={s.id === activeSessionId} />
        ))}
      </div>
    </div>
  );
}
