import { useEffect, useState } from 'react';
import type { UIMessage } from '../../store/agentStore';
import { useAgentStore } from '../../store/agentStore';
import { getTranslation } from '../../utils/i18n';
import { getToolInvocationSummary, type Lang } from './utils';
import { buildDiffCards, extractToolPath, ToolPathLink } from './DiffCard';

export function ToolInvocationsPanel({
  msg,
  lang,
  onOpenWorkspacePath,
}: {
  msg: UIMessage;
  lang: Lang;
  onOpenWorkspacePath?: (path: string) => void;
}) {
  const t = getTranslation(lang);
  const bordered = useAgentStore((state) => state.settings.chatBordersEnabled);
  const toolInvocations = msg.toolInvocations ?? [];
  const anyRunning = toolInvocations.some((tool) => tool.status === 'running');
  const allCompleted = toolInvocations.length > 0 && toolInvocations.every((tool) => tool.status === 'success' || tool.status === 'error' || tool.status === 'cancelled');
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (anyRunning) {
      setIsOpen(true);
    } else if (allCompleted) {
      setIsOpen(false);
    }
  }, [toolInvocations, anyRunning, allCompleted]);

  if (toolInvocations.length === 0) {
    return null;
  }

  const first = toolInvocations[0];
  const rest = toolInvocations.length - 1;
  const firstSummary = getToolInvocationSummary(first);

  return (
    <div
      className={`mb-3 overflow-hidden ${bordered ? 'rounded-xl border border-emerald-500/20 bg-[#0b0d12]/60' : ''}`}
      data-tool-panel-state={isOpen ? 'open' : 'closed'}
    >
      <button
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        className={`flex w-full items-center justify-between gap-3 px-3.5 py-2 text-left ${bordered && isOpen ? 'border-b border-emerald-500/10' : ''}`}
      >
        <div className="min-w-0 flex-1">
          {anyRunning || !allCompleted ? (
            <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-emerald-300">
              <span>{t.toolCalls}</span>
              <span className="rounded-full border border-slate-600/60 px-2 py-0.5 text-[10px] text-slate-300">
                {toolInvocations.length}
              </span>
            </div>
          ) : (
            <span className="block truncate text-[11px] text-slate-400">
              <span className="font-mono text-emerald-300/80">{first.name}</span> · {firstSummary}{rest > 0 ? ` · ... +${rest}` : ''}
            </span>
          )}
        </div>
        <span className="shrink-0 text-[11px] text-slate-500">{isOpen ? t.collapse : t.expand}</span>
      </button>
      {isOpen && (
        <div className="max-h-64 divide-y divide-[#1f2430] overflow-y-auto">
          {toolInvocations.map((tool) => {
            const isRunning = tool.status === 'running';
            const isFailed = tool.status === 'error';
            const isCancelled = tool.status === 'cancelled';
            const summary = getToolInvocationSummary(tool);
            const diffCards = buildDiffCards(tool);
            const args = tool.arguments ?? {};
            const toolPath =
              extractToolPath(args) && onOpenWorkspacePath ? summary : null;

            return (
              <div key={tool.id} className="px-3.5 py-2 text-[11px] text-slate-300">
                <div className="flex items-start gap-2">
                  <span className={`mt-0.5 h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                    isRunning
                      ? 'bg-amber-400 animate-pulse'
                      : isFailed
                        ? 'bg-red-400'
                        : isCancelled
                          ? 'bg-slate-500'
                          : 'bg-emerald-400'
                  }`} />
                  {toolPath ? (
                    <ToolPathLink
                      summary={toolPath}
                      args={args}
                      onOpenWorkspacePath={onOpenWorkspacePath}
                    />
                  ) : (
                    <span className="flex-1 leading-snug text-slate-300">{summary}</span>
                  )}
                  <span className={`flex-shrink-0 text-[10px] ${
                    isRunning
                      ? 'text-amber-400'
                      : isFailed
                        ? 'text-red-400'
                        : isCancelled
                          ? 'text-slate-500'
                          : 'text-emerald-500'
                  }`}>
                    {isRunning
                      ? t.toolRunning
                      : isFailed
                        ? t.toolFailed
                        : isCancelled
                          ? t.cancel
                          : t.toolCompleted}
                  </span>
                </div>
                {diffCards}
                {!diffCards && tool.name === 'task' && tool.output && (() => {
                  try {
                    const result = JSON.parse(tool.output);
                    if (result && Array.isArray(result.steps) && result.steps.length > 0) {
                      return (
                        <div className="mt-1.5 ml-3.5 space-y-0.5 border-l border-[#232734] pl-3">
                          {result.steps.map((step: { name: string; status: string; summary: string }, i: number) => (
                            <div key={i} className="flex items-center gap-1.5 text-[10px]">
                              <span className={step.status === 'error' ? 'text-red-400' : 'text-emerald-400'}>{step.status === 'error' ? '✗' : '✓'}</span>
                              <span className="text-slate-500">{step.name}</span>
                              {step.summary && <span className="truncate text-slate-600">· {step.summary}</span>}
                            </div>
                          ))}
                        </div>
                      );
                    }
                  } catch { /* ignore */ }
                  return null;
                })()}
                {tool.error && (
                  <div className="mt-1 ml-3.5 text-[10px] text-red-400">{tool.error}</div>
                )}
                {tool.output && !diffCards && tool.name !== 'task' && (
                  <div className="mt-1 ml-3.5 max-h-24 overflow-y-auto rounded border border-[#1f2430] bg-[#06080c] px-2 py-1 font-mono text-[10px] leading-relaxed text-slate-500 whitespace-pre-wrap">
                    {tool.output}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
