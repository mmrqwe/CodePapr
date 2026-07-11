import { useMemo } from 'react';

interface GitDiffPreviewProps {
  diff: string;
  maxHeightClassName?: string;
}

function lineClassName(line: string): string {
  if (line.startsWith('diff --git ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
    return 'bg-[#101520] text-slate-400';
  }
  if (line.startsWith('@@')) {
    return 'bg-sky-500/10 text-sky-200';
  }
  if (line.startsWith('+') && !line.startsWith('+++')) {
    return 'bg-emerald-500/10 text-emerald-200';
  }
  if (line.startsWith('-') && !line.startsWith('---')) {
    return 'bg-rose-500/10 text-rose-200';
  }
  return 'text-slate-400';
}

export function GitDiffPreview({
  diff,
  maxHeightClassName = 'max-h-56',
}: GitDiffPreviewProps) {
  const lines = useMemo(() => diff.split('\n'), [diff]);

  return (
    <div className={`overflow-auto rounded-lg border border-[#202432] bg-[#0b0d13] ${maxHeightClassName}`}>
      <div className="min-w-full font-mono text-[10px] leading-5">
        {lines.map((line, index) => (
          <div
            key={`${index}:${line.slice(0, 32)}`}
            className={`whitespace-pre px-2 py-0.5 ${lineClassName(line)}`}
          >
            {line || ' '}
          </div>
        ))}
      </div>
    </div>
  );
}
