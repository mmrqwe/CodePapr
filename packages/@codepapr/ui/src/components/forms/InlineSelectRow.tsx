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
    <div className="rounded-2xl border border-line bg-base px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <span className="block">
          <span className="block text-sm font-medium text-fg">{title}</span>
          {desc && (
            <span className="mt-0.5 block text-xs leading-relaxed text-fg-muted">{desc}</span>
          )}
        </span>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="rounded-xl border border-line bg-base px-4 py-2.5 text-sm text-fg focus:border-accent-soft focus:outline-none"
        >
          {children}
        </select>
      </div>
    </div>
  );
}
