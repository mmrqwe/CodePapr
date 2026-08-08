import type { ReactNode } from 'react';

export interface ToggleFieldProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  desc?: ReactNode;
  /** 附加说明（title 属性，也作为 hover 提示）。 */
  title?: string;
  /** label 下方额外的说明块（如 fastModelHint）。 */
  extra?: ReactNode;
  disabled?: boolean;
}

/** 卡片式开关：左侧 checkbox + 右侧 label/desc。 */
export function ToggleField({
  checked,
  onChange,
  label,
  desc,
  title,
  extra,
  disabled,
}: ToggleFieldProps) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-2xl border border-[#2a2d3a] bg-[#10131b] px-5 py-4 ${
        disabled ? 'cursor-not-allowed opacity-60' : ''
      }`}
      title={title}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        title={title}
        disabled={disabled}
        className="mt-0.5 h-4 w-4 cursor-pointer rounded border-[#3a3f55] bg-[#0b0d12] accent-indigo-500"
      />
      <span className="block">
        <span className="block text-sm font-medium text-slate-100">{label}</span>
        {desc && <span className="mt-1 block text-xs leading-relaxed text-slate-500">{desc}</span>}
        {extra && <span className="mt-2 block text-xs leading-relaxed text-slate-500">{extra}</span>}
      </span>
    </label>
  );
}
