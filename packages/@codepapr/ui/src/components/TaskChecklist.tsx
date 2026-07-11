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
  const prevUpdatedAt = useRef(checklist.updatedAt);
  const collapsedRef = useRef(false);

  collapsedRef.current = collapsed;

  const done = checklist.items.filter((i) => i.status === 'completed' || i.status === 'failed').length;
  const total = checklist.items.length;
  const allDone = checklist.status === 'completed';

  // 新对话开始 → 收起旧清单（除非同一轮中已有新清单到达）
  const currentTurnHasTodo = useRef(false);

  useEffect(() => {
    if (isLoading) {
      currentTurnHasTodo.current = false;
      setCollapsed(true);
    }
  }, [isLoading]);

  // ── updatedAt 变了 → 有新进展 ──
  const hasNewUpdate = prevUpdatedAt.current !== checklist.updatedAt;

  useEffect(() => {
    if (!hasNewUpdate) return;
    prevUpdatedAt.current = checklist.updatedAt;

    if (allDone && !isLoading) {
      setCollapsed(true);
    } else {
      currentTurnHasTodo.current = true;
      setCollapsed(false);
    }
  }, [hasNewUpdate, allDone, isLoading]);

  // ── 折叠摘要条 ──
  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        className="w-full rounded-2xl border border-[#2a2d3a] bg-[#121722] px-4 py-2.5 text-left flex items-center justify-between hover:bg-[#161c2b] transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-300">{t.todoTitle}</span>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${allDone ? 'bg-emerald-500/15 text-emerald-300' : 'bg-indigo-500/15 text-indigo-300'}`}>
            {allDone ? t.todoAllDone : `${done}/${total}`}
          </span>
          {isLoading && (
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-indigo-400 animate-pulse" />
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="h-1 w-16 rounded-full bg-[#1e2535]">
            <div
              className={`h-1 rounded-full ${allDone ? 'bg-emerald-500' : 'bg-indigo-500'}`}
              style={{ width: `${total > 0 ? (done / total) * 100 : 0}%` }}
            />
          </div>
          <span className="text-[10px] text-slate-500">{lang === 'en' ? 'Expand' : '展开'}</span>
        </div>
      </button>
    );
  }

  // ── 完整展开 ──
  return (
    <div className="rounded-2xl border border-[#2a2d3a] bg-[#121722] p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-200">{t.todoTitle}</span>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${allDone ? 'bg-emerald-500/15 text-emerald-300' : 'bg-indigo-500/15 text-indigo-300'}`}>
            {allDone ? t.todoAllDone : `${done}/${total}`}
          </span>
        </div>
        <button
          className="rounded-md px-2 py-0.5 text-[10px] text-slate-500 transition-colors hover:bg-[#1e2535] hover:text-slate-300"
          onClick={() => setCollapsed(true)}
        >
          {lang === 'en' ? 'Collapse' : '收起'}
        </button>
      </div>

      <div className="mb-3 h-1 w-full rounded-full bg-[#1e2535]">
        <div
          className={`h-1 rounded-full transition-all duration-500 ${allDone ? 'bg-emerald-500' : 'bg-indigo-500'}`}
          style={{ width: `${total > 0 ? (done / total) * 100 : 0}%` }}
        />
      </div>

      <div className="space-y-1 max-h-[148px] overflow-y-auto">
        {checklist.items.map((item) => {
          const isDone = item.status === 'completed';
          const isFailed = item.status === 'failed';
          const isRunning = item.status === 'running';

          return (
            <div
              key={item.id}
              className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 ${
                isRunning ? 'bg-amber-500/8 border border-amber-500/20' :
                isFailed ? 'bg-red-500/8 border border-red-500/20' :
                isDone ? 'bg-emerald-500/5' :
                'bg-[#0d1118]'
              }`}
            >
              <span className={`flex-shrink-0 text-[11px] ${isDone ? 'text-emerald-400' : isFailed ? 'text-red-400' : isRunning ? 'text-amber-400 animate-pulse' : 'text-slate-600'}`}>
                {isDone ? '\u2713' : isFailed ? '\u2717' : isRunning ? '\u25B6' : '\u25CB'}
              </span>
              <span className={`min-w-0 flex-1 truncate text-[11px] leading-snug ${isDone ? 'text-slate-500 line-through' : isFailed ? 'text-red-300' : isRunning ? 'text-amber-100' : 'text-slate-400'}`}>
                {item.title}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
