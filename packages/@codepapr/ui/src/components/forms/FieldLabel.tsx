import type { ReactNode } from 'react';

interface FieldLabelProps {
  children: ReactNode;
  hint?: string;
  /** tight → mb-1.5 + tracking-[0.15em]（SearXNG 高级区样式） */
  tight?: boolean;
  className?: string;
}

export function FieldLabel({ children, hint, tight = false, className = '' }: FieldLabelProps) {
  return (
    <label
      className={`block text-xs font-semibold uppercase text-slate-500 ${
        tight ? 'mb-1.5 tracking-[0.15em]' : 'mb-2 tracking-[0.18em]'
      } ${className}`}
      title={hint}
    >
      {children}
    </label>
  );
}
