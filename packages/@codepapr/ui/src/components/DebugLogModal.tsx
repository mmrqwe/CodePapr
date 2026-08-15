import { useEffect, useRef } from 'react';
import { useDebugLogStore } from '../store/debugLogStore';
import { getTranslation, type Lang } from '../utils/i18n';

interface DebugLogModalProps {
  lang?: Lang;
  onClose: () => void;
}

export function DebugLogModal({ lang = 'zh-CN', onClose }: DebugLogModalProps) {
  const logs = useDebugLogStore((state) => state.logs);
  const clearLogs = useDebugLogStore((state) => state.clearLogs);
  const t = getTranslation(lang);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  const copyAll = () => {
    const text = logs
      .map((entry) => {
        const time = new Date(entry.timestamp).toLocaleTimeString();
        const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
        return `[${time}] [${entry.category}] ${entry.message}${dataStr}`;
      })
      .join('\n');
    void navigator.clipboard.writeText(text);
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-deep/80 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex h-[80vh] w-[min(92vw,900px)] flex-col overflow-hidden rounded-2xl border border-line bg-base shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-fg">{t.debugLogTitle}</h2>
            <span className="text-[10px] text-fg-dim">{logs.length} {lang === 'en' ? 'entries' : '条'}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={copyAll}
              className="rounded-md border border-line px-2.5 py-1 text-[11px] text-fg-muted transition-colors hover:border-line-strong hover:text-fg"
            >
              {lang === 'en' ? 'Copy' : '复制'}
            </button>
            <button
              type="button"
              onClick={clearLogs}
              className="rounded-md border border-line px-2.5 py-1 text-[11px] text-fg-muted transition-colors hover:border-danger-bg hover:text-danger"
            >
              {lang === 'en' ? 'Clear' : '清空'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-line px-2.5 py-1 text-[11px] text-fg-muted transition-colors hover:border-line-strong hover:text-fg"
            >
              ✕
            </button>
          </div>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-auto overscroll-contain scrollbar-thin scrollbar-stable p-3 font-mono text-[11px] leading-relaxed">
          {logs.length === 0 ? (
            <div className="flex h-full items-center justify-center text-fg-dim">
              {lang === 'en' ? 'No logs yet.' : '暂无日志。'}
            </div>
          ) : (
            logs.map((entry, index) => {
              const time = new Date(entry.timestamp).toLocaleTimeString();
              const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
              const isErr = entry.category.includes('error') || entry.message.toLowerCase().includes('error');
              const isWarn = entry.category.includes('warn') || entry.message.toLowerCase().includes('failed');
              return (
                <div
                  key={index}
                  className={`whitespace-pre-wrap break-all px-1 py-0.5 ${
                    isErr
                      ? 'text-danger'
                      : isWarn
                      ? 'text-warn'
                      : 'text-fg-muted'
                  }`}
                >
                  <span className="text-fg-dim">[{time}]</span>{' '}
                  <span className="text-fg-muted">[{entry.category}]</span>{' '}
                  {entry.message}
                  {dataStr && <span className="text-fg-dim">{dataStr}</span>}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
