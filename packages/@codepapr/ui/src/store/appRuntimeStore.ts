import { create } from 'zustand';

export interface AppInstance {
  appId: string;
  title: string;
  icon?: string;
  html: string;
  filePath: string;
  createdAt: number;
  updatedAt: number;
}

interface AppRuntimeState {
  apps: AppInstance[];
  activeAppId: string | null;
  mountSignal: number;
  mountApp: (input: Omit<AppInstance, 'createdAt' | 'updatedAt'> & { createdAt?: number; updatedAt?: number }) => void;
  closeApp: (appId: string) => void;
  selectApp: (appId: string) => void;
  clearApps: () => void;
  reloadActiveApp: () => void;
}

export const useAppRuntimeStore = create<AppRuntimeState>()((set) => ({
  apps: [],
  activeAppId: null,
  mountSignal: 0,

  mountApp: (input) => {
    set((state) => {
      const now = Date.now();
      const instance: AppInstance = {
        appId: input.appId,
        title: input.title,
        icon: input.icon,
        html: input.html,
        filePath: input.filePath,
        createdAt: input.createdAt ?? now,
        updatedAt: input.updatedAt ?? now,
      };

      const existingIndex = state.apps.findIndex((app) => app.appId === input.appId);
      const nextApps =
        existingIndex >= 0
          ? state.apps.map((app, index) =>
              index === existingIndex
                ? { ...app, title: instance.title, icon: instance.icon, html: instance.html, updatedAt: now }
                : app
            )
          : [...state.apps, instance];

      return {
        apps: nextApps,
        activeAppId: input.appId,
        mountSignal: state.mountSignal + 1,
      };
    });
  },

  closeApp: (appId) => {
    set((state) => {
      const nextApps = state.apps.filter((app) => app.appId !== appId);
      const nextActiveAppId =
        state.activeAppId === appId ? (nextApps[nextApps.length - 1]?.appId ?? null) : state.activeAppId;
      return { apps: nextApps, activeAppId: nextActiveAppId };
    });
  },

  selectApp: (appId) => {
    set((state) => (state.apps.some((app) => app.appId === appId) ? { activeAppId: appId } : state));
  },

  clearApps: () => {
    set({ apps: [], activeAppId: null });
  },

  reloadActiveApp: () => {
    set((state) =>
      state.activeAppId
        ? {
            apps: state.apps.map((app) =>
              app.appId === state.activeAppId ? { ...app, updatedAt: Date.now() } : app
            ),
          }
        : state
    );
  },
}));
