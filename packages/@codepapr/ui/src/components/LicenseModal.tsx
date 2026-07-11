import { useState } from 'react';
import { LICENSE_GROUPS } from '../utils/licenses';
import { useAgentStore } from '../store/agentStore';

export function LicenseModal({ onClose }: { onClose: () => void }) {
  const { settings } = useAgentStore();
  const lang = (settings.lang ?? 'zh-CN') as 'zh-CN' | 'zh-TW' | 'en';
  const [activeGroup, setActiveGroup] = useState(0);
  const [activeEntry, setActiveEntry] = useState(0);

  const group = LICENSE_GROUPS[activeGroup];
  const entry = group?.entries[activeEntry];

  const title = lang === 'en' ? 'Third-Party Licenses' : lang === 'zh-TW' ? '第三方授權' : '第三方许可';

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex max-h-[88vh] w-[min(96vw,900px)] flex-col overflow-hidden rounded-3xl border border-[#2a2d3a] bg-[#1a1d27] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#2a2d3a] px-6 py-4">
          <h2 className="text-lg font-semibold text-slate-100">{title}</h2>
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-slate-400 transition-colors hover:bg-[#2a2d3a] hover:text-slate-200">
            {lang === 'en' ? 'Close' : lang === 'zh-TW' ? '關閉' : '关闭'}
          </button>
        </div>

        <div className="flex border-b border-[#2a2d3a]">
          {LICENSE_GROUPS.map((g, i) => (
            <button
              key={g.label}
              onClick={() => { setActiveGroup(i); setActiveEntry(0); }}
              className={`px-4 py-2.5 text-xs font-medium transition-colors ${
                i === activeGroup
                  ? 'border-b-2 border-indigo-400 text-indigo-200'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {g.label}
            </button>
          ))}
        </div>

        <div className="flex flex-1 overflow-hidden">
          <div className="w-56 flex-shrink-0 overflow-y-auto border-r border-[#2a2d3a] bg-[#10131b] py-2">
            {group?.entries.map((e, i) => (
              <button
                key={e.name}
                onClick={() => setActiveEntry(i)}
                className={`block w-full truncate px-4 py-2 text-left text-xs transition-colors ${
                  i === activeEntry
                    ? 'bg-indigo-500/15 text-indigo-200'
                    : 'text-slate-400 hover:bg-[#2a2d3a] hover:text-slate-200'
                }`}
              >
                <div className="font-medium">{e.name}</div>
                <div className="text-[10px] text-slate-500">{e.license}</div>
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-5">
            {entry && (
              <div>
                <h3 className="mb-1 text-sm font-semibold text-slate-100">{entry.name}</h3>
                <p className="mb-4 text-xs text-slate-500">{entry.license}</p>
                <pre className="whitespace-pre-wrap text-[11px] leading-relaxed text-slate-400 font-mono">{entry.text}</pre>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
