import { useEffect, useMemo, useState } from 'react';
import type { UIMessage } from '../store/agentStore';
import { getTranslation, type Lang } from '../utils/i18n';

interface ContextDebugModalProps {
  messages: UIMessage[];
  lang?: Lang;
  onClose: () => void;
}

interface ContextDebugEntry {
  id: string;
  label: string;
  preview: string;
  timestamp: number;
  content: string;
}

function buildPreview(content: string, fallback: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return fallback;
  }

  return normalized.length > 72 ? `${normalized.slice(0, 71)}…` : normalized;
}

function formatTimestamp(timestamp: number, lang: Lang | undefined): string {
  try {
    return new Date(timestamp).toLocaleString(lang === 'en' ? 'en-US' : lang ?? 'zh-CN', {
      hour12: false,
    });
  } catch {
    return String(timestamp);
  }
}

export function ContextDebugModal({ messages, lang, onClose }: ContextDebugModalProps) {
  const t = getTranslation(lang);
  const entries = useMemo<ContextDebugEntry[]>(() => {
    const assistantMessages = messages.filter(
      (message) =>
        message.role === 'assistant' &&
        typeof message.promptContent === 'string' &&
        message.promptContent.trim().length > 0
    );

    return assistantMessages.map((message, index) => ({
      id: message.id,
      label:
        typeof message.agentStep === 'number'
          ? `${t.agentStepLabel} ${message.agentStep}`
          : `${t.contextDebugRound} ${index + 1}`,
      preview: buildPreview(message.content, t.streamingStatus),
      timestamp: message.timestamp,
      content: message.promptContent!.trim(),
    }));
  }, [messages, t.agentStepLabel, t.contextDebugRound, t.streamingStatus]);

  const [selectedId, setSelectedId] = useState<string | null>(entries[0]?.id ?? null);

  useEffect(() => {
    if (!entries.some((entry) => entry.id === selectedId)) {
      setSelectedId(entries[0]?.id ?? null);
    }
  }, [entries, selectedId]);

  const selectedEntry = entries.find((entry) => entry.id === selectedId) ?? null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-3 backdrop-blur-sm md:p-4">
      <div className="flex h-full w-full flex-col overflow-hidden rounded-2xl border border-line bg-base shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-fg">{t.contextDebugTitle}</h2>
            <p className="mt-1 text-xs text-fg-muted">{t.contextDebugTip}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-lg leading-none text-fg-muted transition-colors hover:text-fg"
            title={t.cancel}
          >
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {entries.length === 0 ? (
            <div className="flex h-full items-center justify-center px-6 py-10 text-sm text-fg-muted">
              {t.contextDebugEmpty}
            </div>
          ) : (
            <div className="grid h-full min-h-0 grid-cols-1 grid-rows-[minmax(220px,0.85fr)_minmax(0,1.65fr)] lg:grid-cols-[320px_minmax(0,1fr)] lg:grid-rows-1">
              <div className="min-h-0 border-b border-line lg:border-b-0 lg:border-r">
                <div className="h-full min-h-0 overflow-y-auto overscroll-contain scrollbar-thin scrollbar-stable">
                  {entries.map((entry) => {
                    const selected = entry.id === selectedEntry?.id;
                    return (
                      <button
                        key={entry.id}
                        type="button"
                        onClick={() => setSelectedId(entry.id)}
                        className={`flex w-full flex-col gap-1 border-b border-line px-4 py-3 text-left transition-colors ${
                          selected
                            ? 'bg-accent-soft text-accent-text'
                            : 'text-fg-soft hover:bg-raised'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-xs font-semibold">{entry.label}</span>
                          <span className="text-[10px] text-fg-muted">
                            {formatTimestamp(entry.timestamp, lang)}
                          </span>
                        </div>
                        <p className="text-xs text-fg-muted">{entry.preview}</p>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex min-h-0 flex-col">
                <div className="flex items-center justify-between border-b border-line px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-semibold text-fg">
                      {selectedEntry?.label ?? t.contextDebugTitle}
                    </p>
                    <p className="mt-1 text-[11px] text-fg-muted">
                      {selectedEntry
                        ? formatTimestamp(selectedEntry.timestamp, lang)
                        : t.contextDebugNoSelection}
                    </p>
                  </div>
                  {selectedEntry && (
                    <button
                      type="button"
                      onClick={() => void navigator.clipboard.writeText(selectedEntry.content)}
                      className="rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-fg-soft transition-colors hover:border-accent hover:text-fg"
                    >
                      {t.copy}
                    </button>
                  )}
                </div>

                <div className="min-h-0 flex-1 overflow-auto overscroll-contain scrollbar-thin scrollbar-stable bg-base p-4">
                  {selectedEntry ? (
                    <pre className="min-h-full whitespace-pre-wrap break-words rounded-xl border border-line bg-base p-4 text-xs leading-relaxed text-fg">
                      {selectedEntry.content}
                    </pre>
                  ) : (
                    <div className="flex h-full items-center justify-center text-sm text-fg-muted">
                      {t.contextDebugNoSelection}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}