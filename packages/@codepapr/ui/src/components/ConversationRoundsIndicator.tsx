import { useRef, useEffect, useState, useCallback, useMemo, memo } from 'react';
import type { RefObject } from 'react';
import type { UIMessage } from '../store/agentStore';

interface ConversationRoundsIndicatorProps {
  messages: UIMessage[];
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  /** Preferred jump handler (e.g. chat pane that may need to widen its render
   *  window first). Falls back to a direct DOM scroll when omitted. */
  onScrollToMessage?: (messageId: string) => void;
}

interface RoundData {
  id: string;
  index: number;
  content: string;
}

function getFirstSentence(text: string): string {
  const firstLine = text.split('\n')[0].trim();
  if (!firstLine) return '';
  if (firstLine.length <= 60) return firstLine;
  const end = firstLine.search(/[。！？.!?]/);
  if (end > 0 && end <= 60) return firstLine.slice(0, end + 1);
  return `${firstLine.slice(0, 60)}…`;
}

const MAX_BAR_HEIGHT = 200;
const MIN_BAR_HEIGHT = 40;
const TICK_MIN_SPACING = 6;
const LEAVE_DELAY = 200;

export const ConversationRoundsIndicator = memo(
  function ConversationRoundsIndicator({
    messages,
    scrollContainerRef,
    onScrollToMessage,
  }: ConversationRoundsIndicatorProps) {
    const rounds = useMemo<RoundData[]>(() => {
      let idx = 0;
      const result: RoundData[] = [];
      for (const m of messages) {
        if (m.role !== 'user' || m.hidden || !m.content) continue;
        idx++;
        result.push({
          id: m.id,
          index: idx,
          content: getFirstSentence(m.content),
        });
      }
      return result;
    }, [messages]);

    const [currentRoundIndex, setCurrentRoundIndex] = useState(1);
    const [panelOpen, setPanelOpen] = useState(false);
    const indicatorRef = useRef<HTMLDivElement | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);
    const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const rafRef = useRef(0);

    // lightweight current-round tracking via scroll ratio (no DOM queries)
    useEffect(() => {
      const container = scrollContainerRef.current;
      if (!container || rounds.length < 2) return;

      const update = () => {
        if (rafRef.current) return;
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = 0;
          const sh = container.scrollHeight - container.clientHeight;
          const ratio = sh > 0 ? container.scrollTop / sh : 0;
          const idx = Math.round(1 + ratio * (rounds.length - 1));
          setCurrentRoundIndex(Math.max(1, Math.min(rounds.length, idx)));
        });
      };

      update();
      container.addEventListener('scroll', update, { passive: true });
      return () => {
        container.removeEventListener('scroll', update);
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
      };
    }, [rounds.length, scrollContainerRef]);

    // hover handlers
    const showPanel = useCallback(() => {
      if (leaveTimerRef.current) { clearTimeout(leaveTimerRef.current); leaveTimerRef.current = null; }
      setPanelOpen(true);
    }, []);
    const scheduleHide = useCallback(() => {
      leaveTimerRef.current = setTimeout(() => setPanelOpen(false), LEAVE_DELAY);
    }, []);
    const cancelHide = useCallback(() => {
      if (leaveTimerRef.current) { clearTimeout(leaveTimerRef.current); leaveTimerRef.current = null; }
    }, []);
    const hidePanel = useCallback(() => setPanelOpen(false), []);

    const scrollToRound = useCallback(
      (roundId: string) => {
        if (onScrollToMessage) {
          onScrollToMessage(roundId);
          hidePanel();
          return;
        }
        const container = scrollContainerRef.current;
        if (!container) return;
        const el = container.querySelector(`[data-message-id="${roundId}"]`);
        if (!el) return;
        container.scrollTo?.({ top: Math.max(0, (el as HTMLElement).offsetTop - 80), behavior: 'smooth' });
        hidePanel();
      },
      [onScrollToMessage, scrollContainerRef, hidePanel],
    );

    // cleanup
    useEffect(() => () => { if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current); }, []);

    if (rounds.length < 2) return null;

    const barHeight = Math.min(MAX_BAR_HEIGHT, Math.max(MIN_BAR_HEIGHT, (rounds.length - 1) * TICK_MIN_SPACING + 4));
    const tickSpacing = rounds.length > 1 ? (barHeight - 4) / (rounds.length - 1) : 0;

    return (
      <>
        <div
          ref={indicatorRef}
          className="rounds-indicator-bar"
          style={{ height: barHeight }}
          onMouseEnter={showPanel}
          onMouseLeave={scheduleHide}
        >
          {rounds.map((round, i) => {
            const isCurrent = round.index === currentRoundIndex;
            return (
              <div
                key={round.id}
                className={`rounds-indicator-tick${isCurrent ? ' current' : ''}`}
                style={{ top: 2 + i * tickSpacing }}
                title={round.content}
              />
            );
          })}
        </div>

        {panelOpen && (
          <div ref={panelRef} className="rounds-panel" onMouseEnter={cancelHide} onMouseLeave={hidePanel}>
            <div className="rounds-panel-header">
              <span className="rounds-panel-title">{`对话轮次 · ${rounds.length}`}</span>
              <button type="button" className="rounds-panel-close" onClick={(e) => { e.stopPropagation(); hidePanel(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-3.5 w-3.5">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="rounds-panel-list">
              {rounds.map((round) => {
                const isCurrent = round.index === currentRoundIndex;
                return (
                  <button
                    key={round.id}
                    type="button"
                    className={`rounds-panel-item${isCurrent ? ' current' : ''}`}
                    onClick={() => scrollToRound(round.id)}
                  >
                    <span className="rounds-panel-num">#{round.index}</span>
                    <span className="rounds-panel-text">{round.content}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </>
    );
  },
  (prev, next) => prev.messages === next.messages && prev.scrollContainerRef === next.scrollContainerRef,
);
