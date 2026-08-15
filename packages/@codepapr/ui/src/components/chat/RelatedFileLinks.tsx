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
          className="rounded-full border border-info-bg bg-info-bg px-2.5 py-1 text-[11px] text-info transition-colors hover:border-info-bg hover:text-info"
        >
          {path}
        </button>
      ))}
    </div>
  );
}
