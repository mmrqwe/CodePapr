import React from 'react';
import ReactDOM from 'react-dom/client';
import { Menu, PredefinedMenuItem } from '@tauri-apps/api/menu';
import { LogicalPosition } from '@tauri-apps/api/window';
import { fetch } from '@tauri-apps/plugin-http';
import { setGlobalFetchFn } from '@codepapr/api';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

setGlobalFetchFn(fetch);

let editMenu: Menu | null = null;

async function initEditMenu() {
  editMenu = await Menu.new({
    items: [
      await PredefinedMenuItem.new({ item: 'Cut' }),
      await PredefinedMenuItem.new({ item: 'Copy' }),
      await PredefinedMenuItem.new({ item: 'Paste' }),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await PredefinedMenuItem.new({ item: 'SelectAll' }),
    ],
  });
}

window.addEventListener('contextmenu', async (e) => {
  const target = e.target as HTMLElement;
  const isEditable =
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable;

  if (isEditable) {
    e.preventDefault();
    if (!editMenu) await initEditMenu();
    await editMenu?.popup(new LogicalPosition(e.clientX, e.clientY));
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
