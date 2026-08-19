import type { Lang } from '../utils/i18n';

export interface GitDiscardConfirmDialogProps {
  lang: Lang;
  title: string;
  warning: string;
  files: readonly string[];
  confirmLabel: string;
  executing?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const PREVIEW_LIMIT = 8;

export function GitDiscardConfirmDialog({
  lang,
  title,
  warning,
  files,
  confirmLabel,
  executing = false,
  onConfirm,
  onCancel,
}: GitDiscardConfirmDialogProps) {
  const hiddenCount = Math.max(0, files.length - PREVIEW_LIMIT);
  const preview = files.slice(0, PREVIEW_LIMIT);
  const moreLabel =
    lang === 'en'
      ? `and ${hiddenCount} more`
      : lang === 'zh-TW'
        ? `另有 ${hiddenCount} 個`
        : `另有 ${hiddenCount} 个`;
  const cancelLabel = lang === 'en' ? 'Cancel' : lang === 'zh-TW' ? '取消' : '取消';
  const filesLabel = lang === 'en' ? 'Files' : lang === 'zh-TW' ? '檔案' : '文件';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay" onClick={onCancel}>
      <div
        className="mx-4 w-full max-w-md rounded-2xl border border-line bg-base p-6 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="mb-2 text-sm font-semibold text-fg">{title}</h2>
        <p className="mb-3 text-xs leading-relaxed text-fg-muted">{warning}</p>
        {files.length > 0 && (
          <div className="mb-4 rounded-lg border border-line bg-raised px-3 py-2">
            <div className="mb-1 text-[10px] font-semibold text-fg-soft">
              {filesLabel} ({files.length})
            </div>
            <ul className="max-h-40 space-y-1 overflow-y-auto text-[11px] text-fg">
              {preview.map((path) => (
                <li key={path} className="truncate font-mono" title={path}>
                  {path}
                </li>
              ))}
            </ul>
            {hiddenCount > 0 && (
              <div className="mt-1 text-[10px] text-fg-muted">{moreLabel}</div>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={executing}
            className="rounded-lg border border-line px-4 py-2 text-xs text-fg-muted transition-colors hover:border-line-strong hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={executing}
            className="rounded-lg border border-danger-bg bg-danger px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-danger disabled:cursor-not-allowed disabled:opacity-50"
          >
            {executing
              ? lang === 'en'
                ? 'Discarding...'
                : lang === 'zh-TW'
                  ? '處理中...'
                  : '处理中...'
              : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
