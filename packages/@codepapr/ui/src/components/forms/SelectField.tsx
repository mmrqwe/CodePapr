import type { ReactNode, SelectHTMLAttributes } from 'react';
import { FieldLabel } from './FieldLabel';

const SELECT_BASE =
  'w-full rounded-xl border border-[#2a2d3a] bg-[#0f1117] px-4 py-3 text-sm text-slate-200 focus:border-indigo-500/60 focus:outline-none';

export interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: ReactNode;
  hint?: ReactNode;
  labelTitle?: string;
  /** 无 cursor-pointer（个别字段不使用手型光标）。 */
  pointer?: boolean;
}

/** 统一「label + 全宽 select」字段。 */
export function SelectField({
  label,
  hint,
  labelTitle,
  pointer = true,
  className = '',
  title,
  children,
  ...rest
}: SelectFieldProps) {
  return (
    <div>
      <FieldLabel hint={labelTitle}>{label}</FieldLabel>
      <select
        className={`${SELECT_BASE} ${pointer ? 'cursor-pointer' : ''} ${className}`}
        title={labelTitle ?? title}
        {...rest}
      >
        {children}
      </select>
      {hint && <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{hint}</p>}
    </div>
  );
}
