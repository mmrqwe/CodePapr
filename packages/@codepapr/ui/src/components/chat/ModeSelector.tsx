import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkMode } from '../../utils/agentPrompts';
import type { Lang } from './utils';

interface ModeSelectorProps {
  mode: WorkMode;
  setMode: (mode: WorkMode) => void;
  isLoading: boolean;
  lang: Lang;
  sessionLock: 'app' | 'coding' | null;
}

export function ModeSelector({ mode, setMode, isLoading, lang, sessionLock }: ModeSelectorProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const allModes: { id: WorkMode; label: string }[] = [
    { id: 'ask', label: lang === 'en' ? 'Ask' : lang === 'zh-TW' ? 'Ask' : 'Ask' },
    { id: 'plan', label: lang === 'en' ? 'Plan' : lang === 'zh-TW' ? 'Plan' : 'Plan' },
    { id: 'agent', label: lang === 'en' ? 'Agent' : lang === 'zh-TW' ? 'Agent' : 'Agent' },
    { id: 'app', label: lang === 'en' ? 'App' : lang === 'zh-TW' ? 'App' : 'App' },
  ];

  const modes = useMemo(() => {
    if (sessionLock === 'app') return allModes.filter((m) => m.id === 'app');
    if (sessionLock === 'coding') return allModes.filter((m) => m.id !== 'app');
    return allModes;
  }, [sessionLock]);
  const active = modes.find((m) => m.id === mode) ?? modes[0];
  const isLocked = sessionLock === 'app';

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div className="relative flex-shrink-0" ref={ref}>
      <button
        onClick={() => { if (!isLocked) setOpen(!open); }}
        disabled={isLoading}
        title={
          sessionLock === 'app'
            ? (lang === 'en' ? 'App session - mode locked' : lang === 'zh-TW' ? 'App 會話 - 模式已鎖定' : 'App 会话 - 模式已锁定')
            : sessionLock === 'coding'
              ? (lang === 'en' ? 'Coding session - App mode unavailable' : lang === 'zh-TW' ? '編碼會話 - App 模式不可用' : '编码会话 - App 模式不可用')
              : undefined
        }
        className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-fg-muted hover:text-fg hover:bg-slate-700/50 transition-colors disabled:opacity-50"
      >
        {active.label}
        {isLocked ? (
          <svg className="w-3 h-3 text-fg-muted" fill="currentColor" viewBox="0 0 16 16">
            <path d="M4 6v-2a4 4 0 0 1 8 0v2h1.25A1.75 1.75 0 0 1 15 7.75v5.5A1.75 1.75 0 0 1 13.25 15H2.75A1.75 1.75 0 0 1 1 13.25v-5.5C1 6.784 1.784 6 2.75 6H4zm1.75-2a2.25 2.25 0 0 1 4.5 0v2h-4.5V4zM2.75 7.5a.25.25 0 0 0-.25.25v5.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25H2.75z"/>
          </svg>
        ) : (
          <svg className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
          </svg>
        )}
      </button>
      {open && !isLocked && (
        <div className="absolute bottom-full mb-1 left-0 w-28 bg-raised border border-line rounded-xl shadow-xl overflow-hidden z-20">
          {modes.map((m) => (
            <button
              key={m.id}
              onClick={() => { setMode(m.id); setOpen(false); }}
              className={`w-full text-left px-3 py-2 text-xs transition-colors hover:bg-slate-700/50 ${
                mode === m.id ? 'text-accent bg-accent-soft' : 'text-fg-muted'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
