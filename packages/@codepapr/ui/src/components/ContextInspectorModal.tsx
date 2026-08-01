import { useMemo, type ReactNode } from 'react';
import type { ContextStage, IContextSnapshot } from '@codepapr/types';
import { getTranslation, type Lang } from '../utils/i18n';

interface ContextInspectorModalProps {
  snapshot: IContextSnapshot;
  lang?: Lang;
  onClose: () => void;
}

interface StageStyle {
  dot: string;
  border: string;
  bg: string;
  badge: string;
}

const STAGE_STYLES: Record<ContextStage, StageStyle> = {
  'stable-prefix': {
    dot: 'bg-indigo-400',
    border: 'border-indigo-500/40',
    bg: 'bg-indigo-500/5',
    badge: 'bg-indigo-500/15 text-indigo-300',
  },
  'session-state': {
    dot: 'bg-amber-400',
    border: 'border-amber-500/40',
    bg: 'bg-amber-500/5',
    badge: 'bg-amber-500/15 text-amber-300',
  },
  conversation: {
    dot: 'bg-slate-400',
    border: 'border-slate-600/50',
    bg: 'bg-slate-700/10',
    badge: 'bg-slate-600/20 text-slate-300',
  },
};

const STAGE_ORDER: ContextStage[] = ['stable-prefix', 'session-state', 'conversation'];

function formatTokens(value: number): string {
  return `~${value.toLocaleString()}`;
}

export function ContextInspectorModal({ snapshot, lang, onClose }: ContextInspectorModalProps) {
  const t = getTranslation(lang);

  const stageLabels: Record<ContextStage, string> = {
    'stable-prefix': t.stageStablePrefix,
    'session-state': t.stageSessionState,
    conversation: t.stageConversation,
  };

  const fullText = useMemo(() => {
    const parts: string[] = [];
    if (snapshot.toolNames.length > 0) {
      parts.push(
        `[${stageLabels['stable-prefix']} · ${t.toolsEstimate}]\n${snapshot.toolNames.join(', ')}`
      );
    }
    for (const message of snapshot.messages) {
      const header = `[${stageLabels[message.stage]} · ${message.role}]`;
      parts.push(`${header}\n${message.content}`);
    }
    return parts.join('\n\n');
  }, [snapshot, stageLabels, t.toolsEstimate]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm md:p-4">
      <div className="flex h-full w-full flex-col overflow-hidden rounded-2xl border border-[#2a2d3a] bg-[#161922] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[#2a2d3a] px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-200">{t.contextInspectorTitle}</h2>
            <p className="mt-1 text-xs text-slate-500">{t.contextInspectorTip}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void navigator.clipboard.writeText(fullText)}
              className="rounded-lg border border-[#2a2d3a] px-2.5 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:border-indigo-400 hover:text-white"
            >
              {t.copy}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-lg leading-none text-slate-500 transition-colors hover:text-slate-200"
              title={t.cancel}
            >
              ×
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[#2a2d3a] px-5 py-3">
          <span className="text-xs font-semibold text-slate-200">
            {t.currentContextLength}{' '}
            <span className="font-mono text-indigo-300">
              {formatTokens(snapshot.totalTokens)} {t.tokensUnit}
            </span>
          </span>
          <span className="text-[11px] text-slate-600">·</span>
          {STAGE_ORDER.map((stage) => (
            <span key={stage} className="flex items-center gap-1.5 text-[11px] text-slate-400">
              <span className={`inline-block h-2 w-2 rounded-full ${STAGE_STYLES[stage].dot}`} />
              {stageLabels[stage]}
              <span className="font-mono text-slate-500">
                {formatTokens(snapshot.tokensByStage[stage])}
              </span>
            </span>
          ))}
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain scrollbar-thin scrollbar-stable bg-[#0f1117] p-4">
          {(() => {
            const prefixStyle = STAGE_STYLES['stable-prefix'];
            const toolsBlock =
              snapshot.toolNames.length > 0 && snapshot.toolsTokenEstimate > 0 ? (
                <div
                  key="tools"
                  className={`rounded-xl border ${prefixStyle.border} ${prefixStyle.bg} overflow-hidden`}
                >
                  <div className="flex flex-wrap items-center gap-2 border-b border-white/5 px-3 py-2">
                    <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${prefixStyle.badge}`}>
                      {stageLabels['stable-prefix']}
                    </span>
                    <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
                      {t.toolsEstimate}
                    </span>
                    <span className="text-[11px] text-slate-500">· {snapshot.toolNames.length}</span>
                    <span className="ml-auto font-mono text-[10px] text-slate-500">
                      {formatTokens(snapshot.toolsTokenEstimate)} {t.tokensUnit}
                    </span>
                  </div>
                  <div className="whitespace-pre-wrap break-words px-3 py-2.5 text-xs leading-relaxed text-slate-300">
                    {snapshot.toolNames.join(', ')}
                  </div>
                </div>
              ) : null;

            const nodes: ReactNode[] = [];
            let toolsInserted = false;
            snapshot.messages.forEach((message, index) => {
              const style = STAGE_STYLES[message.stage];
              nodes.push(
                <div
                  key={`msg-${index}`}
                  className={`rounded-xl border ${style.border} ${style.bg} overflow-hidden`}
                >
                  <div className="flex flex-wrap items-center gap-2 border-b border-white/5 px-3 py-2">
                    <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${style.badge}`}>
                      {stageLabels[message.stage]}
                    </span>
                    <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
                      {message.role}
                    </span>
                    {message.toolName && (
                      <span className="text-[11px] text-slate-500">· {message.toolName}</span>
                    )}
                    {message.toolCallNames && message.toolCallNames.length > 0 && (
                      <span className="text-[11px] text-slate-500">
                        · {message.toolCallNames.join(', ')}
                      </span>
                    )}
                    <span className="ml-auto font-mono text-[10px] text-slate-500">
                      {formatTokens(message.estimatedTokens)} {t.tokensUnit}
                    </span>
                  </div>
                  <pre className="whitespace-pre-wrap break-words px-3 py-2.5 text-xs leading-relaxed text-slate-200">
                    {message.content || ' '}
                  </pre>
                </div>
              );
              if (!toolsInserted && toolsBlock && message.stage === 'stable-prefix') {
                nodes.push(toolsBlock);
                toolsInserted = true;
              }
            });
            if (!toolsInserted && toolsBlock) {
              nodes.unshift(toolsBlock);
            }
            return nodes;
          })()}
        </div>
      </div>
    </div>
  );
}
