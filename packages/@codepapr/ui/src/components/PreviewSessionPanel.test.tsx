// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PreviewSessionPanel } from './PreviewSessionPanel';
import { usePreviewStore } from '../store/previewStore';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => ({ closed: true })),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

function openPreview() {
  usePreviewStore.getState().openPreviewSession({
    pid: 4242,
    url: 'http://localhost:5173/',
    title: 'preview',
    workspacePath: '/tmp/ws',
    openedAt: 1,
  });
}

describe('PreviewSessionPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    usePreviewStore.setState({ activePreviewSession: null });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  // 回归 #24：挂载时 iframe 只创建一次——旧实现挂载后立即 bump frameKey，
  // key 变更强制卸载刚挂载的 iframe 再重挂同一 URL（双重加载）。
  it('creates the iframe only once on mount', () => {
    const createElementSpy = vi.spyOn(document, 'createElement');
    openPreview();

    act(() => {
      root.render(<PreviewSessionPanel workspacePath="/tmp/ws" lang="zh-CN" />);
    });

    const iframeCreations = createElementSpy.mock.calls.filter(
      (call) => String(call[0]).toLowerCase() === 'iframe'
    ).length;
    expect(iframeCreations).toBe(1);
  });

  it('remounts the iframe when the preview session changes', () => {
    const createElementSpy = vi.spyOn(document, 'createElement');
    openPreview();

    act(() => {
      root.render(<PreviewSessionPanel workspacePath="/tmp/ws" lang="zh-CN" />);
    });

    act(() => {
      usePreviewStore.getState().openPreviewSession({
        pid: 4242,
        url: 'http://localhost:5173/other',
        title: 'preview 2',
        workspacePath: '/tmp/ws',
        openedAt: 2,
      });
    });

    const iframeCreations = createElementSpy.mock.calls.filter(
      (call) => String(call[0]).toLowerCase() === 'iframe'
    ).length;
    expect(iframeCreations).toBe(2);
  });
});
