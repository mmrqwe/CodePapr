import type { InputHTMLAttributes, ReactNode } from 'react';
import { FieldLabel } from './FieldLabel';

const INPUT_CLASS =
  'w-full rounded-xl border border-line bg-base px-4 py-3 text-sm text-fg placeholder-slate-700 focus:border-accent-soft focus:outline-none';

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: ReactNode;
  /** 额外说明段落（显示在字段下方）。 */
  hint?: ReactNode;
  labelTitle?: string;
  /** tight 标签样式（mb-1.5 + tracking-[0.15em]，SearXNG 区风格）。 */
  labelTight?: boolean;
  /** 附加兄弟节点（如 <datalist>），渲染在 input 之后。 */
  children?: ReactNode;
}

/** 统一「label + 全宽 input」字段。 */
export function TextField({
  label,
  hint,
  labelTitle,
  labelTight = false,
  className = '',
  title,
  children,
  ...rest
}: TextFieldProps) {
  return (
    <div>
      <FieldLabel hint={labelTitle} tight={labelTight}>{label}</FieldLabel>
      <input
        className={`${INPUT_CLASS} ${className}`}
        title={labelTitle ?? title}
        {...rest}
      />
      {children}
      {hint && <p className="mt-1 text-[10px] leading-relaxed text-fg-dim">{hint}</p>}
    </div>
  );
}
