import { useMemo, useState, type ReactNode } from 'react';
import type { UIToolInvocation } from '../../store/agentStore';
import {
  diffLineClass,
  extractDiffInfos,
  type DiffInfo,
} from './utils';

export { DiffInfo };

export function DiffCard({ info }: { info: DiffInfo }) {  const [open, setOpen] = useState(false);
  const lines = useMemo(() => info.diff.split('\n'), [info.diff]);

  return (
    <div className="mt-1.5 ml-3.5 overflow-hidden rounded-lg border border-line bg-base">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-base transition-colors"
      >
        <svg className="w-3.5 h-3.5 flex-shrink-0 text-accent" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M14 2v6h6" />
        </svg>
        <span className="flex-1 truncate text-[10px] font-medium text-fg-soft">{info.filePath}</span>
        <span className="flex-shrink-0 text-[10px]">
          {info.added > 0 && <span className="text-ok">+{info.added}</span>}
          {info.added > 0 && info.deleted > 0 && <span className="text-fg-dim mx-0.5"> </span>}
          {info.deleted > 0 && <span className="text-danger">-{info.deleted}</span>}
        </span>
        <svg className={`w-3 h-3 flex-shrink-0 text-fg-muted transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="max-h-48 overflow-y-auto border-t border-line font-mono text-[10px] leading-5">
          {lines.map((line, i) => (
            <div
              key={`${i}:${line.slice(0, 16)}`}
              className={`whitespace-pre px-2.5 py-0.5 ${diffLineClass(line)}`}
            >
              {line || ' '}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function buildDiffCards(tool: UIToolInvocation): ReactNode {
  const infos = extractDiffInfos(tool);
  if (infos.length === 0) return null;
  return (
    <>
      {infos.map((info, i) => (
        <DiffCard key={`${info.filePath}-${i}`} info={info} />
      ))}
    </>
  );
}

export function extractToolPath(args: Record<string, unknown>): string {
  return (
    (typeof args.relativePath === 'string' ? (args.relativePath as string) : '') ||
    (typeof args.path === 'string' ? (args.path as string) : '') ||
    (typeof args.filePath === 'string' ? (args.filePath as string) : '')
  );
}

export function ToolPathLink({
  summary,
  args,
  onOpenWorkspacePath,
}: {
  summary: string;
  args: Record<string, unknown>;
  onOpenWorkspacePath?: (path: string) => void;
}) {
  const path = extractToolPath(args);
  if (!path || !onOpenWorkspacePath) {
    return <span className="flex-1 leading-snug text-fg-soft">{summary}</span>;
  }

  const idx = summary.indexOf(path);
  if (idx === -1) {
    return <span className="flex-1 leading-snug text-fg-soft">{summary}</span>;
  }

  const before = summary.slice(0, idx);
  const after = summary.slice(idx + path.length);

  return (
    <span className="flex-1 leading-snug text-fg-soft">
      {before}
      <button
        type="button"
        onClick={() => onOpenWorkspacePath(path)}
        className="text-info underline decoration-sky-500/40 underline-offset-2 hover:text-info"
      >
        {path}
      </button>
      {after}
    </span>
  );
}

