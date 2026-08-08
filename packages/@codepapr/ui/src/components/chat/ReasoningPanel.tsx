import { useLayoutEffect, useRef, useState } from 'react';
import { useAgentStore } from '../../store/agentStore';
import { getTranslation } from '../../utils/i18n';
import { isScrollContainerNearBottom, scrollContainerToBottom } from '../../utils/chatScroll';
import {
  getStreamingPreviewContent,
  MAX_STREAMING_REASONING_CHARS,
  type Lang,
} from './utils';

export function ReasoningPanel({
  content,
  isStreaming,
  lang,
}: {
  content: string;
  isStreaming?: boolean;
  lang: Lang;
}) {
  const t = getTranslation(lang);
  const bordered = useAgentStore((state) => state.settings.chatBordersEnabled);
  const [isOpen, setIsOpen] = useState(Boolean(isStreaming));
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const reasoningContentRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const visibleContent = isStreaming
    ? getStreamingPreviewContent(content, MAX_STREAMING_REASONING_CHARS)
    : content;

  const collapsedText = content.replace(/\s+/g, ' ').trim();

  useLayoutEffect(() => {
    if (isStreaming) {
      setIsOpen(true);
      shouldStickToBottomRef.current = true;
      return;
    }

    setIsOpen(false);
  }, [isStreaming]);

  useLayoutEffect(() => {
    if (!isOpen) return;

    shouldStickToBottomRef.current = true;
    scrollContainerToBottom(scrollContainerRef.current!, 'auto');
  }, [isOpen]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    const content = reasoningContentRef.current;
    if (!container || !content || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      if (!shouldStickToBottomRef.current) return;
      scrollContainerToBottom(container, 'auto');
    });

    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      className={`mb-3 overflow-hidden ${bordered ? 'rounded-xl border border-indigo-500/20 bg-[#0b0d12]/50' : ''}`}
      data-reasoning-panel-state={isOpen ? 'open' : 'closed'}
    >
      <button
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-3 px-3.5 py-2 text-left"
      >
        <span className="min-w-0 flex-1">
          {isOpen ? (
            <span className="text-xs font-semibold text-indigo-300">{t.thinkingProcess}</span>
          ) : (
            <span className="block truncate text-xs text-slate-400/80">
              <span className="font-semibold text-indigo-300/70">{t.thinkingProcess}</span> · {collapsedText}
            </span>
          )}
        </span>
        <span className="shrink-0 text-[11px] text-slate-500">
          {isStreaming ? t.streamingStatus : isOpen ? t.collapse : t.expand}
        </span>
      </button>
      {isOpen && (
        <div
          ref={scrollContainerRef}
          data-reasoning-scroll="true"
          onScroll={(event) => {
            shouldStickToBottomRef.current = isScrollContainerNearBottom(event.currentTarget);
          }}
          className={`overflow-y-auto overscroll-contain scrollbar-thin scrollbar-stable px-3.5 py-2 text-xs leading-relaxed text-slate-400/90 ${
            bordered ? 'border-t border-indigo-500/10 ' : ''
          }${
            isStreaming ? 'max-h-[4.5rem]' : 'max-h-56'
          }`}
          style={{ overflowAnchor: 'none' }}
        >
          <p ref={reasoningContentRef} className="whitespace-pre-wrap text-slate-300/90 select-text">{visibleContent}</p>
        </div>
      )}
    </div>
  );
}

export function RunningStatusIndicator({ label }: { label: string }) {
  return (
    <div className="mb-2 select-none">
      <p className="text-xs font-medium text-slate-400/90">{label}</p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#11151d]">
        <div className="status-indicator-bar h-full w-24 rounded-full bg-gradient-to-r from-indigo-500/10 via-indigo-300 to-cyan-300" />
      </div>
    </div>
  );
}
