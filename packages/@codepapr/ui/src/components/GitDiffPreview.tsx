import { useMemo } from 'react';

interface GitDiffPreviewProps {
  diff: string;
  maxHeightClassName?: string;
}

function lineClassName(line: string): string {
  if (line.startsWith('diff --git ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
    return 'bg-base text-fg-muted';
  }
  if (line.startsWith('@@')) {
    return 'bg-info-bg text-info';
  }
  if (line.startsWith('+') && !line.startsWith('+++')) {
    return 'bg-ok-bg text-ok';
  }
  if (line.startsWith('-') && !line.startsWith('---')) {
    return 'bg-danger-bg text-danger';
  }
  return 'text-fg-muted';
}

export function GitDiffPreview({
  diff,
  maxHeightClassName = 'max-h-56',
}: GitDiffPreviewProps) {
  const lines = useMemo(() => diff.split('\n'), [diff]);

  return (
    <div className={`overflow-auto rounded-lg border border-line bg-base ${maxHeightClassName}`}>
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
