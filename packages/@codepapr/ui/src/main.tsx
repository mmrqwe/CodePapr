import React from 'react';
import ReactDOM from 'react-dom/client';
import { Menu, PredefinedMenuItem } from '@tauri-apps/api/menu';
import { LogicalPosition } from '@tauri-apps/api/window';
import { fetch } from '@tauri-apps/plugin-http';
import { setGlobalFetchFn } from '@codepapr/api';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { isBlockedFetchTarget } from './utils/fetchGuard';
import './index.css';

// 插件 fetch 在浏览器外执行、不受 CORS 约束，而 capabilities 放行 http://**：
// 包一层守卫拦截链路本地/云元数据地址（169.254.169.254 等 SSRF 类目标）。
// 回环与私网（LAN LLM 端点等合法用途）不受影响。worker 的 LLM fetch 经
// proxyFetch → 主线程 getGlobalFetchFn() 同样走此守卫。
const guardedFetch: typeof fetch = (input, init) => {
  const target =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (isBlockedFetchTarget(target)) {
    return Promise.reject(
      new Error(`Blocked fetch to link-local/metadata address: ${target}`)
    );
  }
  return fetch(input, init);
};

setGlobalFetchFn(guardedFetch);

let editMenu: Menu | null = null;
let editMenuInitPromise: Promise<Menu> | null = null;

async function getOrCreateEditMenu(): Promise<Menu> {
  if (editMenu) {
    return editMenu;
  }
  if (!editMenuInitPromise) {
    editMenuInitPromise = (async () => {
      const menu = await Menu.new({
        items: [
          await PredefinedMenuItem.new({ item: 'Cut' }),
          await PredefinedMenuItem.new({ item: 'Copy' }),
          await PredefinedMenuItem.new({ item: 'Paste' }),
          await PredefinedMenuItem.new({ item: 'Separator' }),
          await PredefinedMenuItem.new({ item: 'SelectAll' }),
        ],
      });
      editMenu = menu;
      return menu;
    })().catch((err) => {
      editMenuInitPromise = null;
      throw err;
    });
  }
  return editMenuInitPromise;
}

window.addEventListener('contextmenu', async (e) => {
  const target = e.target as HTMLElement;
  const isEditable =
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable;

  if (isEditable) {
    e.preventDefault();
    try {
      const menu = await getOrCreateEditMenu();
      await menu.popup(new LogicalPosition(e.clientX, e.clientY));
    } catch {
      // 忽略菜单创建/弹窗异常
    }
  } else {
    e.preventDefault();
  }
});

// 确保 Cmd+C/V/X/A/Z 和全选等快捷键正常工作
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  const mod = e.metaKey || e.ctrlKey;
  // 阻止 Cmd+R / F5 刷新页面
  if (e.key === 'F5' || e.keyCode === 116 || (mod && (k === 'r' || k === 'f5'))) {
    e.preventDefault();
    e.stopPropagation();
  }
  // 允许所有其他快捷键（Cmd+C/V/X/A/Z 等不受影响）
}, true);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
