import { useEffect, useRef, useState } from 'react';
import { useAgentStore } from '../store/agentStore';
import { getTranslation, type Lang } from '../utils/i18n';
import { CacheStatsDashboard } from './CacheStatsDashboard';
import { ContextInspectorModal } from './ContextInspectorModal';
import { ProjectStatsModal } from './ProjectStatsModal';

type StatsTab = 'cache' | 'project' | 'context';

export interface StatsModalProps {
  workspacePath: string;
  lang?: Lang;
  onClose: () => void;
}

export function StatsModal({
  workspacePath,
  lang,
  onClose,
}: StatsModalProps) {
  const t = getTranslation(lang);
  const [tab, setTab] = useState<StatsTab>('cache');
  const [projectVisited, setProjectVisited] = useState(false);
  const [contextVisited, setContextVisited] = useState(false);
  const [contextLoading, setContextLoading] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const latestContextSnapshot = useAgentStore((state) => state._latestContextSnapshot);
  const activeSessionId = useAgentStore((state) => state.activeSessionId);

  useEffect(() => {
    if (tab === 'project') setProjectVisited(true);
  }, [tab]);

  useEffect(() => {
    if (tab !== 'context') return;
    setContextVisited(true);
    let cancelled = false;
    setContextLoading(true);
    // 必须按当前会话消息重算：request-context 快照是「即将发出
    // 的请求」，不含本轮已经生成的助手总结。
    void useAgentStore.getState().computeContextSnapshot().finally(() => {
      if (!cancelled) setContextLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [tab]);

  useEffect(() => {
    const node = dialogRef.current;
    const previous = document.activeElement as HTMLElement | null;
    node?.focus();
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const tabClass = (active: boolean) =>
    `rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
      active ? 'bg-accent-soft text-accent-text' : 'text-fg-muted hover:text-fg-soft'
    }`;

  const contextSnapshot =
    latestContextSnapshot && latestContextSnapshot.sessionId === activeSessionId
      ? latestContextSnapshot.snapshot
      : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="stats-modal-title"
        tabIndex={-1}
        className="flex h-[90vh] w-[min(96vw,1280px)] flex-col overflow-hidden rounded-2xl border border-line bg-base shadow-2xl outline-none"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <h2 id="stats-modal-title" className="text-sm font-semibold text-fg">
            {t.projectStats}
          </h2>
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg border border-line bg-raised p-0.5" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'cache'}
                onClick={() => setTab('cache')}
                className={tabClass(tab === 'cache')}
              >
                {t.cacheStatsTitle}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'project'}
                onClick={() => setTab('project')}
                className={tabClass(tab === 'project')}
              >
                {t.projectStatsTitle}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'context'}
                onClick={() => setTab('context')}
                className={tabClass(tab === 'context')}
              >
                {t.viewContext}
              </button>
            </div>
            <button
              type="button"
              onClick={onClose}
              title={t.cancel}
              className="text-lg leading-none text-fg-muted transition-colors hover:text-fg"
            >
              ×
            </button>
          </div>
        </div>

        <div className={tab === 'cache' ? 'flex min-h-0 min-w-0 flex-1 flex-col' : 'hidden'}>
          <CacheStatsDashboard
            lang={lang}
            collapsible={false}
            wide
          />
        </div>

        {projectVisited && (
          <div className={tab === 'project' ? 'flex min-h-0 min-w-0 flex-1 flex-col' : 'hidden'}>
            <ProjectStatsModal workspacePath={workspacePath} lang={lang} embedded />
          </div>
        )}

        {contextVisited && (
          <div className={tab === 'context' ? 'flex min-h-0 min-w-0 flex-1 flex-col' : 'hidden'}>
            {contextSnapshot ? (
              <ContextInspectorModal
                snapshot={contextSnapshot}
                lang={lang}
                workspacePath={workspacePath || undefined}
                embedded
              />
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-10 text-sm text-fg-muted">
                {contextLoading ? t.memoryLedgerLoading : t.contextInspectorEmpty}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
