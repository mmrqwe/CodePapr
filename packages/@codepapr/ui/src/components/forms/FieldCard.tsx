import type { HTMLAttributes, ReactNode } from 'react';

interface FieldCardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  /** loose → py-5（默认 py-4） */
  padding?: 'normal' | 'loose';
}

/** 设置页统一卡片容器。 */
export function FieldCard({
  children,
  padding = 'normal',
  className = '',
  ...rest
}: FieldCardProps) {
  return (
    <div
      className={`rounded-2xl border border-[#2a2d3a] bg-[#10131b] px-5 ${
        padding === 'loose' ? 'py-5' : 'py-4'
      } ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}
