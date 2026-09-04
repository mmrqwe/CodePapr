// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  loadMemoryEntriesMock,
  forgetMemoryEntryMock,
  reviveMemoryEntryMock,
  ingestLegacyMemoryMdMock,
} = vi.hoisted(() => ({
  loadMemoryEntriesMock: vi.fn(async (): Promise<unknown[]> => []),
  forgetMemoryEntryMock: vi.fn(async (): Promise<void> => undefined),
  reviveMemoryEntryMock: vi.fn(async (): Promise<void> => undefined),
  ingestLegacyMemoryMdMock: vi.fn(async () => ({ ingested: 0, deletedFile: false })),
}));

vi.mock('../utils/projectStorage', () => ({
  loadMemoryEntries: loadMemoryEntriesMock,
  forgetMemoryEntry: forgetMemoryEntryMock,
  reviveMemoryEntry: reviveMemoryEntryMock,
  ingestLegacyMemoryMd: ingestLegacyMemoryMdMock,
  updateMemoryEntryContent: vi.fn(async (): Promise<void> => undefined),
}));

vi.mock('../utils/memoryPersist', () => ({
  persistMemoryProposal: vi.fn(async () => ({
    status: 'saved',
    id: 'n1',
    redacted: false,
    note: 'ok',
  })),
}));

import { MemoryLedgerPanel } from './MemoryLedgerPanel';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function clickButton(container: HTMLDivElement, label: string): void {
  const button = [...container.querySelectorAll('button')].find(
    (el) => el.textContent?.trim() === label
  );
  if (!button) throw new Error(`按钮不存在: ${label}`);
  act(() => button.click());
}

describe('MemoryLedgerPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    loadMemoryEntriesMock.mockReset();
    forgetMemoryEntryMock.mockReset();
    reviveMemoryEntryMock.mockReset();
    ingestLegacyMemoryMdMock.mockReset();
    loadMemoryEntriesMock.mockResolvedValue([]);
    forgetMemoryEntryMock.mockResolvedValue(undefined);
    reviveMemoryEntryMock.mockResolvedValue(undefined);
    ingestLegacyMemoryMdMock.mockResolvedValue({ ingested: 0, deletedFile: false });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders grouped catalog with handwritten notes, not a review queue', async () => {
    loadMemoryEntriesMock.mockResolvedValue([
      {
        id: 'e1',
        category: 'verification',
        content: 'pnpm test 通过',
        contentHash: 'h1',
        confidence: 'confirmed',
        trust: 'workspace',
        status: 'active',
        sourceSessionId: null,
        sourceMessageIds: null,
        evidence: null,
        createdAt: 1,
        verifiedAt: 1,
        supersededBy: null,
      },
      {
        id: 'e2',
        category: 'citation',
        content: '某博客声称要用 bun',
        contentHash: 'h2',
        confidence: 'reported',
        trust: 'derived',
        status: 'active',
        sourceSessionId: null,
        sourceMessageIds: null,
        evidence: null,
        createdAt: 2,
        verifiedAt: null,
        supersededBy: null,
      },
      {
        id: 'e3',
        category: 'general',
        content: '已遗忘的旧事实',
        contentHash: 'h3',
        confidence: 'reported',
        trust: 'derived',
        status: 'forgotten',
        sourceSessionId: null,
        sourceMessageIds: null,
        evidence: null,
        createdAt: 3,
        verifiedAt: null,
        supersededBy: null,
      },
    ]);

    await act(async () => {
      root.render(<MemoryLedgerPanel workspacePath="/tmp/ws" lang="zh-CN" />);
    });
    await flush();

    const text = container.textContent ?? '';
    expect(text).toContain('pnpm test 通过');
    expect(text).toContain('某博客声称要用 bun');
    expect(text).toContain('已验证');
    expect(text).toContain('每次会话');
    expect(text).toContain('仅搜索');
    expect(text).toContain('手写笔记');
    expect(text).not.toContain('准入');
    expect(text).not.toContain('已遗忘的旧事实');
  });

  it('shows forgotten entries when toggled', async () => {
    loadMemoryEntriesMock.mockResolvedValue([
      {
        id: 'e2',
        category: 'general',
        content: '已遗忘的旧事实',
        contentHash: 'h2',
        confidence: 'reported',
        trust: 'derived',
        status: 'forgotten',
        sourceSessionId: null,
        sourceMessageIds: null,
        evidence: null,
        createdAt: 2,
        verifiedAt: null,
        supersededBy: null,
      },
    ]);

    await act(async () => {
      root.render(<MemoryLedgerPanel workspacePath="/tmp/ws" lang="zh-CN" />);
    });
    await flush();
    expect(container.textContent).not.toContain('已遗忘的旧事实');

    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => checkbox.click());
    await flush();
    expect(container.textContent).toContain('已遗忘的旧事实');
  });

  it('M7：forgotten 条目可在面板显式恢复', async () => {
    loadMemoryEntriesMock.mockResolvedValue([
      {
        id: 'e2',
        category: 'general',
        content: '忘了又想记的事实',
        contentHash: 'h2',
        confidence: 'confirmed',
        trust: 'workspace',
        status: 'forgotten',
        sourceSessionId: null,
        sourceMessageIds: null,
        evidence: null,
        createdAt: 2,
        verifiedAt: null,
        supersededBy: null,
      },
    ]);

    await act(async () => {
      root.render(<MemoryLedgerPanel workspacePath="/tmp/ws" lang="zh-CN" />);
    });
    await flush();

    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => checkbox.click());
    await flush();

    clickButton(container, '恢复');
    await flush();
    expect(reviveMemoryEntryMock).toHaveBeenCalledWith('/tmp/ws', 'e2');
  });

  it('forgetting an entry does not write memory.md', async () => {
    loadMemoryEntriesMock.mockResolvedValue([
      {
        id: 'e1',
        category: 'verification',
        content: 'pnpm test 通过',
        contentHash: 'h1',
        confidence: 'confirmed',
        trust: 'workspace',
        status: 'active',
        sourceSessionId: null,
        sourceMessageIds: null,
        evidence: null,
        createdAt: 1,
        verifiedAt: 1,
        supersededBy: null,
      },
    ]);

    await act(async () => {
      root.render(<MemoryLedgerPanel workspacePath="/tmp/ws" lang="zh-CN" />);
    });
    await flush();

    clickButton(container, '遗忘');
    await flush();

    expect(forgetMemoryEntryMock).toHaveBeenCalledWith('/tmp/ws', 'e1');
  });
});
