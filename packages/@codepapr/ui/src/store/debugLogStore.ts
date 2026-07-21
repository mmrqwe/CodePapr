import { create } from 'zustand';

export interface DebugLogEntry {
  timestamp: number;
  category: string;
  message: string;
  data?: unknown;
}

interface DebugLogState {
  logs: DebugLogEntry[];
  pushLog: (category: string, message: string, data?: unknown) => void;
  clearLogs: () => void;
}

const MAX_LOGS = 500;

export const useDebugLogStore = create<DebugLogState>()((set) => ({
  logs: [],

  pushLog: (category, message, data) => {
    set((state) => {
      const entry: DebugLogEntry = {
        timestamp: Date.now(),
        category,
        message,
        data,
      };
      const next = [...state.logs, entry];
      return { logs: next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next };
    });
  },

  clearLogs: () => set({ logs: [] }),
}));

/** 便捷函数：不依赖 React 组件即可写入日志 */
export function pushDebugLog(category: string, message: string, data?: unknown): void {
  useDebugLogStore.getState().pushLog(category, message, data);
}
