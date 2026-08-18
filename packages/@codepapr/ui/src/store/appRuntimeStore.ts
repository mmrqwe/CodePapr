import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

/** 诊断埋点：openedAppId 被清空 = 用户看到「app 自己退出」。把每次变更连同
 * 调用栈落盘，抓住无 UI 操作时的幕后调用者。 */
function diagStoreEvent(action: string): void {
  const stack = (new Error().stack ?? '').split('\n').slice(2, 6).join(' <- ');
  void import('./agentStore')
    .then(({ useAgentStore }) => {
      const workspacePath = useAgentStore.getState().workspacePath;
      if (workspacePath) {
        invoke('log_ui_event', { workspacePath, message: `${action} | ${stack}` }).catch(() => {});
      }
    })
    .catch(() => { /* 诊断不影响功能 */ });
}

export interface AppInstance {
  appId: string;
  title: string;
  icon?: string;
  html: string;
  filePath: string;
  createdAt: number;
  updatedAt: number;
  command?: string;
  args?: string[];
  port?: number;
  pid?: number;
  url?: string;
  manifestJson?: string;
}

interface AppRuntimeState {
  apps: AppInstance[];
  activeAppId: string | null;
  openedAppId: string | null;
  mountSignal: number;
  mountApp: (input: Omit<AppInstance, 'createdAt' | 'updatedAt'> & { createdAt?: number; updatedAt?: number }) => void;
  closeApp: (appId: string) => void;
  selectApp: (appId: string) => void;
  clearApps: () => void;
  openAppModal: (appId: string) => void;
  closeAppModal: () => void;
  setAppRunning: (appId: string, pid: number, url: string) => void;
  setAppStopped: (appId: string) => void;
  reloadApp: (appId: string) => void;
}

export const useAppRuntimeStore = create<AppRuntimeState>()((set) => ({
  apps: [],
  activeAppId: null,
  openedAppId: null,
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
        command: input.command,
        args: input.args,
        port: input.port,
        manifestJson: input.manifestJson,
        createdAt: input.createdAt ?? now,
        updatedAt: input.updatedAt ?? now,
      };

      const existingIndex = state.apps.findIndex((app) => app.appId === input.appId);
      const nextApps =
        existingIndex >= 0
          ? state.apps.map((app, index) =>
              index === existingIndex
                ? { ...app, title: instance.title, icon: instance.icon, html: instance.html, command: instance.command, args: instance.args, port: instance.port, manifestJson: instance.manifestJson, updatedAt: now }
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
    diagStoreEvent(`closeApp(${appId})`);
    set((state) => {
      const nextApps = state.apps.filter((app) => app.appId !== appId);
      const nextActiveAppId =
        state.activeAppId === appId ? (nextApps[nextApps.length - 1]?.appId ?? null) : state.activeAppId;
      return {
        apps: nextApps,
        activeAppId: nextActiveAppId,
        openedAppId: state.openedAppId === appId ? null : state.openedAppId,
      };
    });
  },

  selectApp: (appId) => {
    set((state) => (state.apps.some((app) => app.appId === appId) ? { activeAppId: appId } : state));
  },

  clearApps: () => {
    diagStoreEvent('clearApps()');
    set({ apps: [], activeAppId: null, openedAppId: null });
  },

  openAppModal: (appId) => {
    diagStoreEvent(`openAppModal(${appId})`);
    set({ openedAppId: appId });
  },

  closeAppModal: () => {
    diagStoreEvent('closeAppModal()');
    set({ openedAppId: null });
  },

  setAppRunning: (appId, pid, url) => {
    set((state) => ({
      apps: state.apps.map((app) =>
        app.appId === appId ? { ...app, pid, url } : app
      ),
    }));
  },

  setAppStopped: (appId) => {
    diagStoreEvent(`setAppStopped(${appId})`);
    void invoke('unregister_app_backend_port', { appId }).catch(() => {});
    set((state) => ({
      apps: state.apps.map((app) =>
        app.appId === appId ? { ...app, pid: undefined, url: undefined } : app
      ),
    }));
  },

  reloadApp: (appId) => {
    set((state) => ({
      apps: state.apps.map((app) =>
        app.appId === appId ? { ...app, updatedAt: Date.now() } : app
      ),
    }));
  },
}));
