import { useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useToastStore, type ToastItem, type ToastVariant } from '../store/toastStore';
import { useAgentStore } from '../store/agentStore';
import { getTranslation } from '../utils/i18n';

const VARIANT_CLASS: Record<ToastVariant, { frame: string; accent: string; icon: string }> = {
  info: {
    frame: 'border-info-bg bg-toast-info text-info shadow-[0_18px_48px_rgba(14,165,233,0.18)]',
    accent: 'bg-info',
    icon: 'text-info',
  },
  success: {
    frame: 'border-ok-bg bg-toast-ok text-ok shadow-[0_18px_48px_rgba(16,185,129,0.20)]',
    accent: 'bg-ok',
    icon: 'text-ok',
  },
  warning: {
    frame: 'border-warn-bg bg-toast-warn text-warn shadow-[0_18px_48px_rgba(245,158,11,0.22)]',
    accent: 'bg-warn',
    icon: 'text-warn',
  },
  error: {
    frame: 'border-danger-bg bg-toast-danger text-danger shadow-[0_18px_48px_rgba(244,63,94,0.24)]',
    accent: 'bg-danger',
    icon: 'text-danger',
  },
};

function VariantIcon({ variant }: { variant: ToastVariant }) {
  const cls = `h-4 w-4 flex-shrink-0 ${VARIANT_CLASS[variant].icon}`;
  if (variant === 'success') {
    return (
      <svg className={cls} fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
      </svg>
    );
  }
  if (variant === 'error') {
    return (
      <svg className={cls} fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="9" />
        <path strokeLinecap="round" d="M12 8v5M12 16h.01" />
      </svg>
    );
  }
  if (variant === 'warning') {
    return (
      <svg className={cls} fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4l9 16H3L12 4z" />
        <path strokeLinecap="round" d="M12 10v4M12 17h.01" />
      </svg>
    );
  }
  return (
    <svg className={cls} fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="9" />
      <path strokeLinecap="round" d="M12 8h.01M11 12h1v5h1" />
    </svg>
  );
}

function ToastCard({
  toast,
  dismissLabel,
  onDismiss,
}: {
  toast: ToastItem;
  dismissLabel: string;
  onDismiss: (id: string) => void;
}) {
  const styles = VARIANT_CLASS[toast.variant];
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const duration = toast.durationMs ?? 0;
    if (duration <= 0) return;
    timerRef.current = setTimeout(() => onDismiss(toast.id), duration);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [toast.id, toast.durationMs, onDismiss]);

  return (
    <div
      role={toast.variant === 'error' ? 'alert' : 'status'}
      aria-live={toast.variant === 'error' ? 'assertive' : 'polite'}
      className={`pointer-events-auto relative w-80 max-w-[92vw] overflow-hidden rounded-xl border ${styles.frame} backdrop-blur-md`}
    >
      <div className={`absolute left-0 top-0 h-full w-1 ${styles.accent}`} />
      <div className="flex items-start gap-2.5 px-3.5 py-2.5 pl-4">
        <VariantIcon variant={toast.variant} />
        <div className="min-w-0 flex-1">
          {toast.title && (
            <div className="mb-0.5 truncate text-[12px] font-semibold">{toast.title}</div>
          )}
          <div className="whitespace-pre-wrap break-words text-[12px] leading-relaxed opacity-90">
            {toast.message}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onDismiss(toast.id)}
          aria-label={dismissLabel}
          className="-mr-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-[16px] leading-none opacity-60 transition-opacity hover:opacity-100"
        >
          ×
        </button>
      </div>
    </div>
  );
}

export function ToastContainer() {
  const { toasts, dismissToast } = useToastStore(
    useShallow((state) => ({ toasts: state.toasts, dismissToast: state.dismissToast }))
  );
  const lang = useAgentStore((state) => state.settings.lang);
  const t = getTranslation(lang);

  if (toasts.length === 0) return null;

  return (
    <div
      data-toast-container
      className="pointer-events-none fixed bottom-4 right-4 z-[1000] flex flex-col items-end gap-2"
    >
      {toasts.map((item) => (
        <ToastCard
          key={item.id}
          toast={item}
          dismissLabel={t.toastDismiss}
          onDismiss={dismissToast}
        />
      ))}
    </div>
  );
}
