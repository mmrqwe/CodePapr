import { create } from 'zustand';

export interface PreviewSession {
  pid: number | null;
  url: string;
  title: string;
  workspacePath: string;
  openedAt: number;
}

interface PreviewState {
  activePreviewSession: PreviewSession | null;
  openPreviewSession: (session: Omit<PreviewSession, 'openedAt'> & { openedAt?: number }) => void;
  reloadPreviewSession: () => void;
  closePreviewSession: () => void;
  clearPreviewSessionByPid: (pid: number) => void;
}

export const usePreviewStore = create<PreviewState>()((set) => ({
  activePreviewSession: null,
  openPreviewSession: (session) => {
    set({
      activePreviewSession: {
        ...session,
        openedAt: session.openedAt ?? Date.now(),
      },
    });
  },
  reloadPreviewSession: () => {
    set((state) =>
      state.activePreviewSession
        ? {
            activePreviewSession: {
              ...state.activePreviewSession,
              openedAt: Date.now(),
            },
          }
        : state
    );
  },
  closePreviewSession: () => {
    set({ activePreviewSession: null });
  },
  clearPreviewSessionByPid: (pid) => {
    set((state) =>
      state.activePreviewSession?.pid === pid
        ? { activePreviewSession: null }
        : state
    );
  },
}));