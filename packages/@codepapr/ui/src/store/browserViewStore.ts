import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

export type BrowserEngine = 'embedded' | 'headless';

export interface BrowserPageSession {
  url: string;
  title: string;
  workspacePath: string;
  startedAt: number;
}

interface BrowserViewState {
  /** Agent 正在浏览的页面会话（embedded/headless 引擎通用）。 */
  pageSession: BrowserPageSession | null;
  /** 内置浏览器面板是否打开（仅 embedded 引擎可显示真实 WebView）。 */
  panelOpen: boolean;
  /** 当前浏览器引擎。 */
  engine: BrowserEngine;
  setPageSession: (session: BrowserPageSession | null) => void;
  openPanel: () => void;
  closePanel: () => void;
  setEngine: (engine: BrowserEngine) => void;
}

export const useBrowserViewStore = create<BrowserViewState>()((set) => ({
  pageSession: null,
  panelOpen: false,
  engine: 'embedded',
  setPageSession: (session) => set({ pageSession: session }),
  openPanel: () => set({ panelOpen: true }),
  closePanel: () => set({ panelOpen: false }),
  setEngine: (engine) =>
    set((state) =>
      // 切到 headless 时面板无法显示 WebView，需一并关闭。
      engine === 'headless' && state.panelOpen
        ? { engine, panelOpen: false }
        : { engine }
    ),
}));

/** 把浏览器引擎同步到 Rust 后端与本地 store（启动与设置变更时调用）。 */
export async function applyBrowserEngine(engine: BrowserEngine): Promise<void> {
  useBrowserViewStore.getState().setEngine(engine);
  try {
    await invoke('set_browser_engine', { engine });
  } catch {
    // 后端尚未就绪时忽略；下次设置变更会重试。
  }
}
