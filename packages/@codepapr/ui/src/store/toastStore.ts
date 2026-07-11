import { create } from 'zustand';

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

export interface ToastItem {
  id: string;
  variant: ToastVariant;
  title?: string;
  message: string;
  /** Auto-dismiss duration in ms. `0` or negative => sticky. Default 4500 ms. */
  durationMs?: number;
  createdAt: number;
}

interface ToastState {
  toasts: ToastItem[];
  showToast: (input: Omit<ToastItem, 'id' | 'createdAt'>) => string;
  dismissToast: (id: string) => void;
  clearToasts: () => void;
}

const DEFAULT_DURATION_MS = 4500;
const MAX_VISIBLE_TOASTS = 5;

function generateId(): string {
  return `toast-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  showToast: (input) => {
    const id = generateId();
    const item: ToastItem = {
      id,
      createdAt: Date.now(),
      durationMs: input.durationMs ?? DEFAULT_DURATION_MS,
      variant: input.variant,
      title: input.title,
      message: input.message,
    };
    set((state) => {
      const next = [...state.toasts, item];
      // Cap visible count: drop the oldest when over limit.
      if (next.length > MAX_VISIBLE_TOASTS) {
        next.splice(0, next.length - MAX_VISIBLE_TOASTS);
      }
      return { toasts: next };
    });
    return id;
  },
  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
  clearToasts: () => set({ toasts: [] }),
}));

/** Convenience helpers; safe to call from any module (no React context required). */
export const toast = {
  info: (message: string, opts?: Partial<Omit<ToastItem, 'id' | 'createdAt' | 'variant' | 'message'>>) =>
    useToastStore.getState().showToast({ variant: 'info', message, ...opts }),
  success: (message: string, opts?: Partial<Omit<ToastItem, 'id' | 'createdAt' | 'variant' | 'message'>>) =>
    useToastStore.getState().showToast({ variant: 'success', message, ...opts }),
  warning: (message: string, opts?: Partial<Omit<ToastItem, 'id' | 'createdAt' | 'variant' | 'message'>>) =>
    useToastStore.getState().showToast({ variant: 'warning', message, ...opts }),
  error: (message: string, opts?: Partial<Omit<ToastItem, 'id' | 'createdAt' | 'variant' | 'message'>>) =>
    useToastStore.getState().showToast({ variant: 'error', message, durationMs: opts?.durationMs ?? 8000, ...opts }),
};
