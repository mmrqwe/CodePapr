// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IContextSnapshot } from '@codepapr/types';
import { ContextInspectorModal, previewContextRow } from './ContextInspectorModal';

vi.mock('./MemoryLedgerPanel', () => ({
  MemoryLedgerPanel: () => null,
}));

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('previewContextRow', () => {
  it('shows the first line of a final assistant reply', () => {
    expect(
      previewContextRow({
        content: '**已修复：P0 / P1 / 已修复 三个筛选按钮挤压问题**\n\n体检报告本身已是交互版',
      })
    ).toBe('**已修复：P0 / P1 / 已修复 三个筛选按钮挤压问题** 体检报告本身已是交互版');
  });

  it('keeps tool names and still shows assistant status text', () => {
    expect(
      previewContextRow({
        content: '交互版已就绪，正在做最后的可用性校验。',
        toolCallNames: ['app_render', 'bash'],
      })
    ).toBe('工具: app_render, bash · 交互版已就绪，正在做最后的可用性校验。');
  });

  it('falls back to tool names when content is empty', () => {
    expect(previewContextRow({ content: '  ', toolCallNames: ['read'] })).toBe('工具: read');
  });
});

describe('ContextInspectorModal', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('previews assistant replies in collapsed rows instead of leaving them blank', () => {
    const snapshot: IContextSnapshot = {
      round: 1,
      model: 'muse-spark-1.2-contributor',
      messages: [
        {
          role: 'user',
          content: '这个学习体检报告应该可以交互啊',
          stage: 'conversation',
          estimatedTokens: 12,
        },
        {
          role: 'assistant',
          content: '已把体检报告升级为交互版',
          stage: 'conversation',
          estimatedTokens: 20,
          toolCallNames: ['app_render'],
        },
        {
          role: 'assistant',
          content: '**学习 App 体检完成 — 已修复 4 项**',
          stage: 'conversation',
          estimatedTokens: 80,
        },
      ],
      toolNames: ['app_render'],
      toolsTokenEstimate: 10,
      totalTokens: 122,
      tokensByStage: {
        'stable-prefix': 10,
        'session-state': 0,
        conversation: 112,
      },
      capturedAt: Date.now(),
    };

    act(() => {
      root.render(<ContextInspectorModal snapshot={snapshot} lang="zh-CN" onClose={() => undefined} />);
    });

    expect(container.textContent).toContain('工具: app_render · 已把体检报告升级为交互版');
    expect(container.textContent).toContain('**学习 App 体检完成 — 已修复 4 项**');
  });
});
