export function RelatedFileLinks({
  paths,
  onOpenWorkspacePath,
}: {
  paths: string[];
  onOpenWorkspacePath?: (path: string) => void;
}) {
  if (!onOpenWorkspacePath || paths.length === 0) {
    return null;
  }

  const uniquePaths = Array.from(new Set(paths));

  return (
    <div className="mb-3 flex flex-wrap gap-2">
      {uniquePaths.map((path) => (
        <button
          key={path}
          type="button"
          onClick={() => onOpenWorkspacePath(path)}
          className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 text-[11px] text-sky-200 transition-colors hover:border-sky-400/50 hover:text-sky-100"
        >
          {path}
        </button>
      ))}
    </div>
  );
}
