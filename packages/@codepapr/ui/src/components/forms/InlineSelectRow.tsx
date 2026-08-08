import type { ReactNode } from 'react';

export interface InlineSelectRowProps {
  title: ReactNode;
  desc?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}

/** 「标题 + 描述 + 右侧紧凑 select」的行式布局（如 thinkingEffort / 多模态模型档位）。 */
export function InlineSelectRow({ title, desc, value, onChange, children }: InlineSelectRowProps) {
  return (
    <div className="rounded-2xl border border-[#2a2d3a] bg-[#10131b] px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <span className="block">
          <span className="block text-sm font-medium text-slate-100">{title}</span>
          {desc && (
            <span className="mt-0.5 block text-xs leading-relaxed text-slate-500">{desc}</span>
          )}
        </span>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-2.5 text-sm text-slate-200 focus:border-indigo-500/60 focus:outline-none"
        >
          {children}
        </select>
      </div>
    </div>
  );
}
