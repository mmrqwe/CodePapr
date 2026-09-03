interface DangerConfirmDialogProps {
  title: string;
  warning: string;
  confirmLabel: string;
  cancelLabel: string;
  executing?: boolean;
  executingLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** In-app confirm for irreversible actions. Native `window.confirm` is unreliable in the Tauri webview. */
export function DangerConfirmDialog({
  title,
  warning,
  confirmLabel,
  cancelLabel,
  executing = false,
  executingLabel,
  onConfirm,
  onCancel,
}: DangerConfirmDialogProps) {
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-overlay"
      onClick={executing ? undefined : onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="danger-confirm-title"
        className="mx-4 w-full max-w-md rounded-2xl border border-line bg-base p-6 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="danger-confirm-title" className="mb-2 text-sm font-semibold text-fg">
          {title}
        </h2>
        <p className="mb-5 text-xs leading-relaxed text-fg-muted">{warning}</p>
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
            data-action="confirm-delete"
            onClick={onConfirm}
            disabled={executing}
            className="rounded-lg border border-danger-bg bg-danger px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-danger disabled:cursor-not-allowed disabled:opacity-50"
          >
            {executing ? executingLabel || confirmLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
