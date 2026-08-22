import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import {
  isPluginApp,
  readAppManifest,
  shouldPersistPluginPosition,
  type OverlayLayout,
} from '../papr/pluginSurface';
import {
  layoutsFromChrome,
  parsePluginUiState,
  queueSavePluginUi,
  type PluginChrome,
  type PluginUiState,
} from '../papr/pluginUiStorage';

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
  pinnedPluginIds: string[];
  overlayLayouts: Record<string, OverlayLayout>;
  pluginChrome: Record<string, PluginChrome>;
  mountSignal: number;
  mountApp: (input: Omit<AppInstance, 'createdAt' | 'updatedAt'> & { createdAt?: number; updatedAt?: number }) => void;
  closeApp: (appId: string) => void;
  selectApp: (appId: string) => void;
  clearApps: () => void;
  openAppModal: (appId: string) => void;
  closeAppModal: () => void;
  enablePlugin: (appId: string) => void;
  disablePlugin: (appId: string) => void;
  pinPlugin: (appId: string) => void;
  unpinPlugin: (appId: string) => void;
  setOverlayLayout: (appId: string, layout: OverlayLayout) => void;
  persistPluginUi: () => void;
  hydratePluginUi: (state: PluginUiState) => void;
  resetPluginLayout: (appId: string) => void;
  setAppRunning: (appId: string, pid: number, url: string) => void;
  setAppStopped: (appId: string) => void;
  reloadApp: (appId: string) => void;
}

function omitKey<T>(record: Record<string, T>, appId: string): Record<string, T> {
  if (!(appId in record)) return record;
  const next = { ...record };
  delete next[appId];
  return next;
}

function chromeFromLayout(
  previous: PluginChrome | undefined,
  layout: OverlayLayout,
  enabled: boolean,
  visible: boolean,
): PluginChrome {
  return {
    ...previous,
    enabled,
    visible,
    x: layout.x,
    y: layout.y,
    width: layout.width,
    height: layout.height,
    sizeSource: layout.sizeSource ?? previous?.sizeSource,
  };
}

function chromeForPersist(
  chrome: Record<string, PluginChrome>,
  apps: AppInstance[],
): Record<string, PluginChrome> {
  const result: Record<string, PluginChrome> = {};
  for (const [appId, record] of Object.entries(chrome)) {
    const persistPos = shouldPersistPluginPosition(readAppManifest(apps.find((app) => app.appId === appId)));
    result[appId] = persistPos
      ? record
      : {
          enabled: record.enabled,
          visible: record.visible,
          width: record.width,
          height: record.height,
          sizeSource: record.sizeSource,
        };
  }
  return result;
}

function schedulePersist(get: () => AppRuntimeState): void {
  void import('./agentStore')
    .then(({ useAgentStore }) => {
      const workspacePath = useAgentStore.getState().workspacePath;
      if (!workspacePath) return;
      const state = get();
      void queueSavePluginUi(workspacePath, {
        chrome: chromeForPersist(state.pluginChrome, state.apps),
      });
    })
    .catch(() => {});
}

export const useAppRuntimeStore = create<AppRuntimeState>()((set, get) => ({
  apps: [],
  activeAppId: null,
  openedAppId: null,
  pinnedPluginIds: [],
  overlayLayouts: {},
  pluginChrome: {},
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
                ? { ...app, title: instance.title, icon: instance.icon, html: instance.html, filePath: instance.filePath, command: instance.command, args: instance.args, port: instance.port, manifestJson: instance.manifestJson, updatedAt: now }
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
        pinnedPluginIds: state.pinnedPluginIds.filter((id) => id !== appId),
        overlayLayouts: omitKey(state.overlayLayouts, appId),
        pluginChrome: omitKey(state.pluginChrome, appId),
      };
    });
    get().persistPluginUi();
  },

  selectApp: (appId) => {
    set((state) => (state.apps.some((app) => app.appId === appId) ? { activeAppId: appId } : state));
  },

  clearApps: () => {
    diagStoreEvent('clearApps()');
    set({
      apps: [],
      activeAppId: null,
      openedAppId: null,
      pinnedPluginIds: [],
      overlayLayouts: {},
      pluginChrome: {},
    });
  },

  openAppModal: (appId) => {
    const app = get().apps.find((item) => item.appId === appId);
    if (app && isPluginApp(app)) {
      diagStoreEvent(`openAppModal(${appId})→pinPlugin`);
      get().pinPlugin(appId);
      return;
    }
    diagStoreEvent(`openAppModal(${appId})`);
    set({ openedAppId: appId });
  },

  closeAppModal: () => {
    diagStoreEvent('closeAppModal()');
    set({ openedAppId: null });
  },

  enablePlugin: (appId) => {
    let changed = false;
    set((state) => {
      const app = state.apps.find((item) => item.appId === appId);
      if (!app || !isPluginApp(app)) return state;
      const previous = state.pluginChrome[appId];
      const visible = previous?.visible ?? state.pinnedPluginIds.includes(appId);
      if (previous?.enabled === true && previous.visible === visible) return state;
      changed = true;
      return {
        pluginChrome: {
          ...state.pluginChrome,
          [appId]: { ...previous, enabled: true, visible },
        },
      };
    });
    if (changed) get().persistPluginUi();
  },

  disablePlugin: (appId) => {
    let changed = false;
    set((state) => {
      const previous = state.pluginChrome[appId];
      const pinned = state.pinnedPluginIds.includes(appId);
      if (!pinned && previous?.enabled === false && previous.visible === false) return state;
      changed = true;
      return {
        pinnedPluginIds: state.pinnedPluginIds.filter((id) => id !== appId),
        pluginChrome: {
          ...state.pluginChrome,
          [appId]: { ...previous, enabled: false, visible: false },
        },
      };
    });
    if (changed) get().persistPluginUi();
  },

  pinPlugin: (appId) => {
    let changed = false;
    set((state) => {
      const app = state.apps.find((item) => item.appId === appId);
      if (!app || !isPluginApp(app)) return state;
      const previous = state.pluginChrome[appId];
      const alreadyPinned = state.pinnedPluginIds.includes(appId);
      if (alreadyPinned && previous?.enabled === true && previous.visible === true) return state;
      changed = true;
      const without = state.pinnedPluginIds.filter((id) => id !== appId);
      return {
        pinnedPluginIds: alreadyPinned ? state.pinnedPluginIds : [...without, appId],
        pluginChrome: {
          ...state.pluginChrome,
          [appId]: { ...previous, enabled: true, visible: true },
        },
      };
    });
    if (changed) get().persistPluginUi();
  },

  unpinPlugin: (appId) => {
    let changed = false;
    set((state) => {
      const previous = state.pluginChrome[appId];
      const pinned = state.pinnedPluginIds.includes(appId);
      if (!pinned && previous?.visible === false) return state;
      changed = true;
      return {
        pinnedPluginIds: state.pinnedPluginIds.filter((id) => id !== appId),
        pluginChrome: {
          ...state.pluginChrome,
          [appId]: {
            ...previous,
            enabled: previous?.enabled ?? true,
            visible: false,
          },
        },
      };
    });
    if (changed) get().persistPluginUi();
  },

  setOverlayLayout: (appId, layout) => {
    set((state) => {
      if (!state.pinnedPluginIds.includes(appId)) return state;
      const previous = state.pluginChrome[appId];
      const enabled = previous?.enabled ?? true;
      return {
        overlayLayouts: { ...state.overlayLayouts, [appId]: layout },
        pluginChrome: {
          ...state.pluginChrome,
          [appId]: chromeFromLayout(previous, layout, enabled, true),
        },
      };
    });
  },

  persistPluginUi: () => {
    schedulePersist(get);
  },

  hydratePluginUi: (state) => {
    const parsed = parsePluginUiState(state);
    set({
      pluginChrome: parsed.chrome,
      overlayLayouts: layoutsFromChrome(parsed.chrome),
    });
  },

  resetPluginLayout: (appId) => {
    set((state) => {
      const previous = state.pluginChrome[appId];
      const enabled = previous?.enabled ?? state.pinnedPluginIds.includes(appId);
      const visible = previous?.visible ?? state.pinnedPluginIds.includes(appId);
      return {
        overlayLayouts: omitKey(state.overlayLayouts, appId),
        pluginChrome: {
          ...state.pluginChrome,
          [appId]: { enabled, visible },
        },
      };
    });
    get().persistPluginUi();
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
