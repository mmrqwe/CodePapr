import { create } from 'zustand';
import type { PaprManifest } from '@codepapr/types';

interface PermissionState {
  manifests: Record<string, PaprManifest>;
  cacheManifest: (appId: string, manifest: PaprManifest) => void;
  clearManifest: (appId: string) => void;
  clearAll: () => void;
}

export const usePermissionStore = create<PermissionState>()((set) => ({
  manifests: {},

  cacheManifest: (appId, manifest) => {
    set((state) => ({
      manifests: { ...state.manifests, [appId]: manifest },
    }));
  },

  clearManifest: (appId) => {
    set((state) => {
      const next = { ...state.manifests };
      delete next[appId];
      return { manifests: next };
    });
  },

  clearAll: () => {
    set({ manifests: {} });
  },
}));
