import { useEffect, useRef, useState } from 'react';
import { type Lang, getTranslation } from '../utils/i18n';
import type { TaskChecklist as TaskChecklistType } from '../utils/taskChecklistTypes';

interface TaskChecklistProps {
  checklist: TaskChecklistType;
  lang?: Lang;
  isLoading?: boolean;
}

export function TaskChecklist({ checklist, lang, isLoading }: TaskChecklistProps) {
  const t = getTranslation(lang);
  const [collapsed, setCollapsed] = useState(false);
  const previousChecklist = useRef(checklist);
  const wasLoading = useRef(isLoading);

  const done = checklist.items.filter((i) => i.status === 'completed' || i.status === 'failed').length;
  const total = checklist.items.length;
  const allDone = checklist.status === 'completed';

  useEffect(() => {
    const updated = previousChecklist.current !== checklist;
    const startedTurn = isLoading && !wasLoading.current;
    previousChecklist.current = checklist;
    wasLoading.current = isLoading;

    // Each commit produces a new checklist, even for updates in the same millisecond.
    if (updated) {
      setCollapsed(allDone && !isLoading);
    } else if (startedTurn) {
      setCollapsed(true);
    }
  }, [checklist, allDone, isLoading]);

  // ── 折叠摘要条 ──
  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        className="w-full rounded-2xl border border-line bg-base px-4 py-2.5 text-left flex items-center justify-between hover:bg-raised transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-fg-soft">{t.todoTitle}</span>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${allDone ? 'bg-ok-bg text-ok' : 'bg-accent-soft text-accent-text'}`}>
            {allDone ? t.todoAllDone : `${done}/${total}`}
          </span>
          {isLoading && (
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="h-1 w-16 rounded-full bg-raised">
            <div
              className={`h-1 rounded-full ${allDone ? 'bg-ok' : 'bg-accent'}`}
              style={{ width: `${total > 0 ? (done / total) * 100 : 0}%` }}
            />
          </div>
          <span className="text-[10px] text-fg-muted">{lang === 'en' ? 'Expand' : '展开'}</span>
        </div>
      </button>
    );
  }

  // ── 完整展开 ──
  return (
    <div className="rounded-2xl border border-line bg-base p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-fg">{t.todoTitle}</span>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${allDone ? 'bg-ok-bg text-ok' : 'bg-accent-soft text-accent-text'}`}>
            {allDone ? t.todoAllDone : `${done}/${total}`}
          </span>
        </div>
        <button
          className="rounded-md px-2 py-0.5 text-[10px] text-fg-muted transition-colors hover:bg-raised hover:text-fg-soft"
          onClick={() => setCollapsed(true)}
        >
          {lang === 'en' ? 'Collapse' : '收起'}
        </button>
      </div>

      <div className="mb-3 h-1 w-full rounded-full bg-raised">
        <div
          className={`h-1 rounded-full transition-all duration-500 ${allDone ? 'bg-ok' : 'bg-accent'}`}
          style={{ width: `${total > 0 ? (done / total) * 100 : 0}%` }}
        />
      </div>

      <div className="space-y-1 max-h-[148px] overflow-y-auto">
        {checklist.items.map((item) => {
          const isDone = item.status === 'completed';
          const isFailed = item.status === 'failed';
          // 模型经常不显式标 running，清单看起来像停在原地；回合进行中时把系统
          // 推导的 currentTaskId 视作「执行中」，回合结束自动回落 pending。
          const isRunning =
            item.status === 'running' ||
            (isLoading === true && item.status === 'pending' && item.id === checklist.currentTaskId);

          return (
            <div
              key={item.id}
              className={`flex items-start gap-2 rounded-md px-2.5 py-1.5 ${
                isRunning ? 'bg-warn-bg border border-warn-bg' :
                isFailed ? 'bg-danger-bg border border-danger-bg' :
                isDone ? 'bg-ok-bg' :
                'bg-base'
              }`}
            >
              <span className={`flex-shrink-0 text-[11px] leading-snug ${isDone ? 'text-ok' : isFailed ? 'text-danger' : isRunning ? 'text-warn animate-pulse' : 'text-fg-dim'}`}>
                {isDone ? '\u2713' : isFailed ? '\u2717' : isRunning ? '\u25B6' : '\u25CB'}
              </span>
              <div className="min-w-0 flex-1">
                <span className={`block truncate text-[11px] leading-snug ${isDone ? 'text-fg-muted line-through' : isFailed ? 'text-danger' : isRunning ? 'text-warn' : 'text-fg-muted'}`}>
                  {item.title}
                </span>
                {item.summary && (
                  <p className="mt-0.5 whitespace-pre-wrap break-words text-[11px] leading-snug text-fg-soft">
                    {item.summary}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
