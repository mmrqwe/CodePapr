import { create } from 'zustand';
import type { PaprAppSettings, PaprManifest } from '@codepapr/types';

interface PermissionState {
  manifests: Record<string, PaprManifest>;
  appSettings: PaprAppSettings | null;
  cacheManifest: (appId: string, manifest: PaprManifest) => void;
  clearManifest: (appId: string) => void;
  setAppSettings: (settings: PaprAppSettings) => void;
  clearAll: () => void;
}

export const usePermissionStore = create<PermissionState>()((set) => ({
  manifests: {},
  appSettings: null,

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

  setAppSettings: (settings) => {
    set({ appSettings: settings });
  },

  clearAll: () => {
    set({ manifests: {}, appSettings: null });
  },
}));
