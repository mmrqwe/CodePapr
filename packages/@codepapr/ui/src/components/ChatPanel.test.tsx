// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, colorizeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  colorizeMock: vi.fn(async () => ''),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  convertFileSrc: (path: string) => path,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: () => Promise.resolve(() => {}),
}));

vi.mock('monaco-editor/esm/vs/editor/editor.api', () => ({
  editor: {
    colorize: colorizeMock,
  },
}));

vi.mock('./MonacoTextEditor', () => ({
  configureMonacoLanguageServices: vi.fn(),
}));

import { normalizeSettings, useAgentStore, type UIMessage } from '../store/agentStore';
import { useCharactersStore } from '../store/charactersStore';
import {
  completeSubagentProgress,
  resetSubagentProgress,
  startSubagentProgress,
} from '../utils/subagentProgress';
import type { CharacterProfile } from '../utils/characterTypes';
import type { WorkMode } from '../utils/agentPrompts';
import type { IImageContent } from '@codepapr/types';
import { ChatPanel } from './ChatPanel';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('ChatPanel', () => {
  let container: HTMLDivElement;
  let root: Root;
  let scrollToMock: ReturnType<typeof vi.fn>;
  let resizeObservers: Array<{
    callback: ResizeObserverCallback;
    observe: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }>;
  let rAFQueue: Array<() => void>;
  let rAFIdCounter: number;

  function flushRAF() {
    while (rAFQueue.length > 0) {
      const pending = rAFQueue;
      rAFQueue = [];
      pending.forEach((cb) => cb());
    }
  }

  beforeEach(() => {
    invokeMock.mockReset();
    colorizeMock.mockClear();
    resizeObservers = [];
    rAFQueue = [];
    rAFIdCounter = 1;
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      rAFQueue.push(cb);
      return rAFIdCounter++;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      const idx = id - 1;
      if (idx >= 0 && idx < rAFQueue.length) {
        rAFQueue[idx] = () => {};
      }
    });
    Element.prototype.scrollIntoView = vi.fn();
    scrollToMock = vi.fn(function (
      this: HTMLElement,
      options: { top: number; behavior: ScrollBehavior }
    ) {
      Object.defineProperty(this, 'scrollTop', {
        value: options.top,
        writable: true,
        configurable: true,
      });
    });
    Element.prototype.scrollTo = scrollToMock as unknown as typeof Element.prototype.scrollTo;
    vi.stubGlobal(
      'ResizeObserver',
      class MockResizeObserver {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();

        constructor(callback: ResizeObserverCallback) {
          resizeObservers.push({
            callback,
            observe: this.observe,
            disconnect: this.disconnect,
          });
        }
      }
    );

    useAgentStore.setState((state) => ({
      ...state,
      settings: normalizeSettings({ fastModelEnabled: false }),
      workspacePath: '/tmp/codepapr-chat',
      sessions: [
        {
          id: 'session-1',
          name: '会话 1',
          provider: 'deepseek',
          model: 'deepseek-v4-pro',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      activeSessionId: 'session-1',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: '把回复布局改成 VS Code 那样',
          timestamp: 1,
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '正式回答应该平铺显示。',
          reasoningContent: '这段思考默认折叠，不该直接显示。',
          toolInvocations: [
            {
              id: 'tool-1',
              name: 'workspace_run_command',
              arguments: { command: 'npm', args: ['test'] },
              status: 'success',
            },
          ],
          timestamp: 2,
        },
        {
          id: 'assistant-summary',
          role: 'assistant',
          workMode: 'agent',
          content: '执行总结：已完成布局调整。',
          synthetic: true,
          timestamp: 3,
        },
      ],
      sessionMessages: {
        'session-1': [
          {
            id: 'user-1',
            role: 'user',
            content: '把回复布局改成 VS Code 那样',
            timestamp: 1,
          },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: '正式回答应该平铺显示。',
            reasoningContent: '这段思考默认折叠，不该直接显示。',
            toolInvocations: [
              {
                id: 'tool-1',
                name: 'workspace_run_command',
                arguments: { command: 'npm', args: ['test'] },
                status: 'success',
              },
            ],
            timestamp: 2,
          },
          {
            id: 'assistant-summary',
            role: 'assistant',
            workMode: 'agent',
            content: '执行总结：已完成布局调整。',
            synthetic: true,
            timestamp: 3,
          },
        ],
      },
      projectDiagnosticsReport: null,
      isLoading: false,
      showSettings: false,
    }));

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    useCharactersStore.setState({
      loaded: true,
      loading: false,
      characters: [],
      activeCharacterId: null,
    });
    resetSubagentProgress();
  });

  it('renders user messages as bubbles, assistant replies as plain blocks, and keeps reasoning/tool details collapsed', async () => {
    await act(async () => {
      root.render(<ChatPanel />);
    });

    const userMessage = container.querySelector('[data-message-role="user"]');
    const summaryMessage = container.querySelector(
      '[data-message-role="assistant"][data-message-synthetic="true"]'
    );
    const processGroup = container.querySelector('[data-process-group-state]');

    expect(userMessage?.getAttribute('data-message-variant')).toBe('bubble');
    expect(summaryMessage?.getAttribute('data-message-variant')).toBe('bubble');
    expect(processGroup?.getAttribute('data-process-group-state')).toBe('closed');
    expect(container.textContent).toContain('处理过程');
    expect(container.textContent).toContain('执行总结：已完成布局调整。');
    expect(container.textContent).not.toContain('这段思考默认折叠，不该直接显示。');
    expect(container.textContent).not.toContain('npm test');
    expect(container.textContent).not.toContain('正式回答应该平铺显示。');

    await act(async () => {
      (processGroup?.querySelector('button') as HTMLButtonElement | null)?.click();
    });

    const openedReasoningPanel = container.querySelector('[data-reasoning-panel-state]');
    const openedToolPanel = container.querySelector('[data-tool-panel-state]');

    expect(openedReasoningPanel).not.toBeNull();
    expect(openedToolPanel).not.toBeNull();
    expect(container.textContent).toContain('正式回答应该平铺显示。');
    expect(openedReasoningPanel?.getAttribute('data-reasoning-panel-state')).toBe('closed');
    expect(openedToolPanel?.getAttribute('data-tool-panel-state')).toBe('closed');
  });

  it('auto-expands tool cards when a command is still running and shows its live log tail', async () => {
    useAgentStore.setState((state) => ({
      ...state,
      messages: [
        {
          id: 'assistant-running',
          role: 'assistant',
          content: '',
          statusText: '正在测试: npm run test',
          toolInvocations: [
            {
              id: 'tool-running',
              name: 'workspace_run_command',
              arguments: { command: 'npm', args: ['run', 'test'] },
              status: 'running',
              statusText: '正在测试: npm run test',
              output: ['[out] PASS src/App.test.tsx', '[err] warning line'].join('\n'),
            },
          ],
          timestamp: 4,
        },
      ],
      sessionMessages: {
        'session-1': [
          {
            id: 'assistant-running',
            role: 'assistant',
            content: '',
            statusText: '正在测试: npm run test',
            toolInvocations: [
              {
                id: 'tool-running',
                name: 'workspace_run_command',
                arguments: { command: 'npm', args: ['run', 'test'] },
                status: 'running',
                statusText: '正在测试: npm run test',
                output: ['[out] PASS src/App.test.tsx', '[err] warning line'].join('\n'),
              },
            ],
            timestamp: 4,
          },
        ],
      },
    }));

    await act(async () => {
      root.render(<ChatPanel />);
    });

    const toolPanel = container.querySelector('[data-tool-panel-state]');

    expect(toolPanel?.getAttribute('data-tool-panel-state')).toBe('open');
    expect(container.textContent).toContain('执行 npm run test');
    expect(container.textContent).toContain('PASS src/App.test.tsx');
    expect(container.textContent).toContain('warning line');
  });

  it('does not crash when a streaming message adds tool invocations after initial render', async () => {
    useAgentStore.setState((state) => ({
      ...state,
      messages: [
        {
          id: 'assistant-streaming-tools',
          role: 'assistant',
          content: '正在准备执行',
          isStreaming: true,
          timestamp: 6,
        },
      ],
      sessionMessages: {
        'session-1': [
          {
            id: 'assistant-streaming-tools',
            role: 'assistant',
            content: '正在准备执行',
            isStreaming: true,
            timestamp: 6,
          },
        ],
      },
    }));

    await act(async () => {
      root.render(<ChatPanel />);
    });

    await act(async () => {
      useAgentStore.setState((state) => ({
        ...state,
        messages: [
          {
            id: 'assistant-streaming-tools',
            role: 'assistant',
            content: '正在运行命令',
            isStreaming: true,
            toolInvocations: [
              {
                id: 'tool-late-start',
                name: 'workspace_run_command',
                arguments: { command: 'npm', args: ['run', 'build'] },
                status: 'running',
                statusText: '正在构建: npm run build',
                output: '[out] vite building',
              },
            ],
            timestamp: 7,
          },
        ],
        sessionMessages: {
          'session-1': [
            {
              id: 'assistant-streaming-tools',
              role: 'assistant',
              content: '正在运行命令',
              isStreaming: true,
              toolInvocations: [
                {
                  id: 'tool-late-start',
                  name: 'workspace_run_command',
                  arguments: { command: 'npm', args: ['run', 'build'] },
                  status: 'running',
                  statusText: '正在构建: npm run build',
                  output: '[out] vite building',
                },
              ],
              timestamp: 7,
            },
          ],
        },
      }));
      root.render(<ChatPanel />);
    });

    const toolPanel = container.querySelector('[data-tool-panel-state]');

    expect(toolPanel?.getAttribute('data-tool-panel-state')).toBe('open');
    expect(container.textContent).toContain('执行 npm run build');
    expect(container.textContent).toContain('vite building');
  });

  it('renders streaming assistant content as plain text without markdown colorization', async () => {
    useAgentStore.setState((state) => ({
      ...state,
      messages: [
        {
          id: 'assistant-streaming',
          role: 'assistant',
          content: '```ts\nconst value = 1;\n```',
          reasoningContent: '正在分析代码块渲染开销',
          isStreaming: true,
          timestamp: 5,
        },
      ],
      sessionMessages: {
        'session-1': [
          {
            id: 'assistant-streaming',
            role: 'assistant',
            content: '```ts\nconst value = 1;\n```',
            reasoningContent: '正在分析代码块渲染开销',
            isStreaming: true,
            timestamp: 5,
          },
        ],
      },
    }));

    await act(async () => {
      root.render(<ChatPanel />);
    });

    expect(colorizeMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('```ts');
    expect(container.querySelector('.markdown-body')).toBeNull();
  });

  it('uses scroll containers instead of scrollIntoView and keeps reasoning auto-scrolled while streaming', async () => {
    useAgentStore.setState((state) => ({
      ...state,
      messages: [
        {
          id: 'assistant-streaming',
          role: 'assistant',
          content: '正在输出',
          reasoningContent: '第一段思考',
          isStreaming: true,
          timestamp: 8,
        },
      ],
      sessionMessages: {
        'session-1': [
          {
            id: 'assistant-streaming',
            role: 'assistant',
            content: '正在输出',
            reasoningContent: '第一段思考',
            isStreaming: true,
            timestamp: 8,
          },
        ],
      },
    }));

    await act(async () => {
      root.render(<ChatPanel />);
    });

    const chatScroll = container.querySelector('[data-chat-scroll="true"]') as HTMLDivElement;
    const reasoningScroll = container.querySelector('[data-reasoning-scroll="true"]') as HTMLDivElement;
    expect(reasoningScroll).not.toBeNull();
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();

    const chatObserver = resizeObservers.find(
      (ro) => !(ro.observe.mock.calls[0]?.[0] instanceof HTMLParagraphElement)
    );
    expect(chatObserver).toBeTruthy();

    Object.defineProperty(chatScroll, 'scrollHeight', {
      value: 1000,
      writable: true,
      configurable: true,
    });

    await act(async () => {
      chatObserver!.callback([], {} as ResizeObserver);
    });
    flushRAF();

    expect(chatScroll.scrollTop).toBe(1000);

    const reasoningObserver = resizeObservers.find(
      (ro) => ro.observe.mock.calls[0]?.[0] instanceof HTMLParagraphElement
    );
    expect(reasoningObserver).toBeTruthy();

    await act(async () => {
      useAgentStore.setState((state) => ({
        ...state,
        messages: [
          {
            id: 'assistant-streaming',
            role: 'assistant',
            content: '正在输出更多内容',
            reasoningContent: '第一段思考\n第二段思考',
            isStreaming: true,
            timestamp: 9,
          },
        ],
        sessionMessages: {
          'session-1': [
            {
              id: 'assistant-streaming',
              role: 'assistant',
              content: '正在输出更多内容',
              reasoningContent: '第一段思考\n第二段思考',
              isStreaming: true,
              timestamp: 9,
            },
          ],
        },
      }));
      root.render(<ChatPanel />);
    });

    Object.defineProperty(reasoningScroll, 'scrollHeight', {
      value: 800,
      writable: true,
      configurable: true,
    });

    await act(async () => {
      reasoningObserver!.callback([], {} as ResizeObserver);
    });

    expect(reasoningScroll.scrollTop).toBe(800);
  });

  it('keeps the chat list pinned to the bottom when content height grows asynchronously', async () => {
    useAgentStore.setState((state) => ({
      ...state,
      messages: [
        {
          id: 'assistant-streaming',
          role: 'assistant',
          content: '第一段输出',
          isStreaming: true,
          timestamp: 20,
        },
      ],
      sessionMessages: {
        'session-1': [
          {
            id: 'assistant-streaming',
            role: 'assistant',
            content: '第一段输出',
            isStreaming: true,
            timestamp: 20,
          },
        ],
      },
    }));

    await act(async () => {
      root.render(<ChatPanel />);
    });

    const observer = resizeObservers[0];
    expect(observer).toBeTruthy();

    const chatScroll = container.querySelector('[data-chat-scroll="true"]') as HTMLDivElement;
    Object.defineProperty(chatScroll, 'scrollHeight', {
      value: 1200,
      writable: true,
      configurable: true,
    });

    await act(async () => {
      observer?.callback([], {} as ResizeObserver);
    });
    flushRAF();

    expect(chatScroll.scrollTop).toBe(1200);
  });

  it('scrolls to the bottom when on-demand session history finishes loading', async () => {
    useAgentStore.setState((state) => ({
      ...state,
      messages: [],
      sessionMessages: {},
      sessionMessagesLoading: true,
    }));

    await act(async () => {
      root.render(<ChatPanel />);
    });

    const chatScroll = container.querySelector('[data-chat-scroll="true"]') as HTMLDivElement;
    expect(chatScroll).not.toBeNull();
    Object.defineProperty(chatScroll, 'scrollHeight', {
      value: 900,
      writable: true,
      configurable: true,
    });

    await act(async () => {
      useAgentStore.setState((state) => ({
        ...state,
        messages: [
          {
            id: 'user-loaded',
            role: 'user',
            content: '按需加载完成的历史消息',
            timestamp: 10,
          },
        ],
        sessionMessagesLoading: false,
      }));
      root.render(<ChatPanel />);
    });
    flushRAF();

    expect(chatScroll.scrollTop).toBe(900);
  });

  it('scrolls to the bottom when message rendering is un-deferred', async () => {
    await act(async () => {
      root.render(<ChatPanel deferMessages />);
    });

    const chatScroll = container.querySelector('[data-chat-scroll="true"]') as HTMLDivElement;
    expect(chatScroll).not.toBeNull();
    expect(container.querySelector('[data-message-role="user"]')).toBeNull();
    Object.defineProperty(chatScroll, 'scrollHeight', {
      value: 1100,
      writable: true,
      configurable: true,
    });

    await act(async () => {
      root.render(<ChatPanel deferMessages={false} />);
    });
    flushRAF();

    expect(chatScroll.scrollTop).toBe(1100);
  });

  it('does not collapse textual summary-style conversations', async () => {
    useAgentStore.setState((state) => ({
      ...state,
      messages: [
        {
          id: 'user-textual',
          role: 'user',
          content: '请分析这个系统架构并给出结论',
          timestamp: 10,
        },
        {
          id: 'assistant-textual',
          role: 'assistant',
          content: '这里是完整分析过程。',
          timestamp: 11,
        },
        {
          id: 'assistant-summary-textual',
          role: 'assistant',
          workMode: 'ask',
          content: '总结：系统分层清晰。',
          synthetic: true,
          timestamp: 12,
        },
      ],
      sessionMessages: {
        'session-1': [
          {
            id: 'user-textual',
            role: 'user',
            content: '请分析这个系统架构并给出结论',
            timestamp: 10,
          },
          {
            id: 'assistant-textual',
            role: 'assistant',
            content: '这里是完整分析过程。',
            timestamp: 11,
          },
          {
            id: 'assistant-summary-textual',
            role: 'assistant',
            workMode: 'ask',
            content: '总结：系统分层清晰。',
            synthetic: true,
            timestamp: 12,
          },
        ],
      },
    }));

    await act(async () => {
      root.render(<ChatPanel />);
    });

    expect(container.querySelector('[data-process-group-state]')).toBeNull();
    expect(container.textContent).toContain('这里是完整分析过程。');
    expect(container.textContent).toContain('总结：系统分层清晰。');
  });

  it('shows compact help in the placeholder and removes the footer tip line', async () => {
    await act(async () => {
      root.render(<ChatPanel />);
    });

    const input = container.querySelector('textarea');

    expect(input?.getAttribute('placeholder')).toBe('Shift+Enter 换行 Enter 发送 /help 帮助');
    expect(container.textContent).not.toContain('Shift+Enter 换行 · Enter 发送');
  });

  function setTwoSessions(extra: Record<string, unknown> = {}) {
    useAgentStore.setState((state) => ({
      ...state,
      sessions: [
        { id: 'session-1', name: '会话 1', provider: 'deepseek', model: 'deepseek-v4-pro', createdAt: 2, updatedAt: 2 },
        { id: 'session-2', name: '会话 2', provider: 'deepseek', model: 'deepseek-v4-pro', createdAt: 1, updatedAt: 1 },
      ],
      activeSessionId: 'session-1',
      messages: [],
      sessionMessages: { 'session-1': [], 'session-2': [] },
      sessionConversationStats: {},
      conversationStats: {
        primary: { totalCacheRead: 0, totalCacheCreation: 0, totalInput: 0, totalOutput: 0, promptCacheHitTokens: 0, promptCacheMissTokens: 0, calls: 0, rounds: 0 },
        fast: { totalCacheRead: 0, totalCacheCreation: 0, totalInput: 0, totalOutput: 0, promptCacheHitTokens: 0, promptCacheMissTokens: 0, calls: 0, rounds: 0 },
        mentor: { totalCacheRead: 0, totalCacheCreation: 0, totalInput: 0, totalOutput: 0, promptCacheHitTokens: 0, promptCacheMissTokens: 0, calls: 0, rounds: 0 },
      },
      isLoading: false,
      loadingSessionId: null,
      _sessionInputState: {},
      ...extra,
    }));
  }

  it('restores per-session draft and mode when switching sessions', async () => {
    setTwoSessions({
      _sessionInputState: {
        'session-1': { mode: 'ask', draft: '会话 1 的草稿', images: [], files: [] },
        'session-2': { mode: 'plan', draft: '会话 2 的草稿', images: [], files: [] },
      },
    });

    await act(async () => {
      root.render(<ChatPanel />);
    });

    let textarea = container.querySelector('textarea');
    expect(textarea?.value).toBe('会话 1 的草稿');
    expect(container.textContent).toContain('Ask');

    await act(async () => {
      useAgentStore.getState().selectSession('session-2');
    });

    textarea = container.querySelector('textarea');
    expect(textarea?.value).toBe('会话 2 的草稿');
    expect(container.textContent).toContain('Plan');

    await act(async () => {
      useAgentStore.getState().selectSession('session-1');
    });

    textarea = container.querySelector('textarea');
    expect(textarea?.value).toBe('会话 1 的草稿');
    expect(container.textContent).toContain('Ask');
  });

  it('allows typing and sending in a project without any session', async () => {
    const sendSpy = vi.fn(async () => true);
    useAgentStore.setState((state) => ({
      ...state,
      settings: normalizeSettings({ fastModelEnabled: false, apiKey: 'test-key' }),
      sessions: [],
      activeSessionId: null,
      messages: [],
      sessionMessages: {},
      _sessionInputState: {},
      isLoading: false,
      loadingSessionId: null,
      sessionMessagesLoading: false,
      sendMessage: sendSpy,
    }));

    await act(async () => {
      root.render(<ChatPanel />);
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();

    const setNativeValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )!.set!;
    await act(async () => {
      setNativeValue.call(textarea, '空项目的第一条消息');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(
      '空项目的第一条消息'
    );

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(sendSpy).toHaveBeenCalledWith(
      '空项目的第一条消息',
      '空项目的第一条消息',
      'agent',
      undefined
    );
  });

  it('sends pending text attachments in the prompt and as display chips', async () => {
    const sendSpy = vi.fn(async () => true);
    useAgentStore.setState((state) => ({
      ...state,
      settings: normalizeSettings({ fastModelEnabled: false, apiKey: 'test-key' }),
      sessions: [
        {
          id: 'session-1',
          name: '会话 1',
          provider: 'deepseek',
          model: 'deepseek-v4-pro',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      activeSessionId: 'session-1',
      messages: [],
      sessionMessages: { 'session-1': [] },
      _sessionInputState: {
        'session-1': {
          mode: 'agent',
          draft: '看看这个',
          images: [],
          files: [{ id: 'f1', name: 'a.ts', content: 'export const x = 1;', size: 18 }],
        },
      },
      isLoading: false,
      loadingSessionId: null,
      sessionMessagesLoading: false,
      sendMessage: sendSpy,
    }));

    await act(async () => {
      root.render(<ChatPanel />);
    });

    expect(container.textContent).toContain('a.ts');

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(sendSpy).toHaveBeenCalledWith(
      '看看这个\n\n--- a.ts ---\nexport const x = 1;',
      '看看这个',
      'agent',
      undefined,
      [{ name: 'a.ts', size: 18 }],
    );
  });

  it('shows sent file chips on user messages', async () => {
    useAgentStore.setState((state) => ({
      ...state,
      messages: [
        {
          id: 'user-file',
          role: 'user',
          content: '看看这个',
          attachedFiles: [{ name: 'sent.ts', size: 18 }],
          timestamp: 1,
        },
      ],
      sessionMessages: {
        'session-1': [
          {
            id: 'user-file',
            role: 'user',
            content: '看看这个',
            attachedFiles: [{ name: 'sent.ts', size: 18 }],
            timestamp: 1,
          },
        ],
      },
    }));

    await act(async () => {
      root.render(<ChatPanel />);
    });

    expect(container.textContent).toContain('sent.ts');
  });

  it('prevents default paste when clipboard contains files', async () => {
    await act(async () => {
      root.render(<ChatPanel />);
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    const file = new File(['hello'], 'note.txt', { type: 'text/plain', lastModified: 1 });
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', {
      value: {
        files: [file],
        items: [{ kind: 'file', type: file.type, getAsFile: () => file }],
      },
    });

    await act(async () => {
      textarea.dispatchEvent(event);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(event.defaultPrevented).toBe(true);
    expect(container.textContent).toContain('note.txt');
  });

  it('accepts file drops on the composer without navigating away', async () => {
    await act(async () => {
      root.render(<ChatPanel />);
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    const file = new File(['export {}'], 'dropped.ts', { type: 'text/plain', lastModified: 1 });
    const dataTransfer = {
      types: ['Files'],
      files: [file],
      items: [{ kind: 'file', type: file.type, getAsFile: () => file }],
      dropEffect: 'none',
    };

    const dragOver = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(dragOver, 'dataTransfer', { value: dataTransfer });
    textarea.dispatchEvent(dragOver);
    expect(dragOver.defaultPrevented).toBe(true);

    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer });
    await act(async () => {
      textarea.dispatchEvent(drop);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(drop.defaultPrevented).toBe(true);
    expect(container.textContent).toContain('dropped.ts');
  });

  it('#26：slash 命令发送被拒绝（sendMessage 返回 false）时保留草稿供重试', async () => {
    const sendSpy = vi.fn(async () => false);
    useAgentStore.setState((state) => ({
      ...state,
      settings: normalizeSettings({ fastModelEnabled: false, apiKey: 'test-key' }),
      sessions: [],
      activeSessionId: null,
      messages: [],
      sessionMessages: {},
      _sessionInputState: {},
      isLoading: false,
      loadingSessionId: null,
      sessionMessagesLoading: false,
      sendMessage: sendSpy,
    }));

    await act(async () => {
      root.render(<ChatPanel />);
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();

    const setNativeValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )!.set!;
    await act(async () => {
      setNativeValue.call(textarea, '/review 我的代码');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(sendSpy).toHaveBeenCalled();
    // 发送被拒绝：草稿必须保留，用户可直接修改重试（旧实现先清空再发送，草稿永久丢失）
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(
      '/review 我的代码'
    );
  });

  it('带参数的 slash 命令 Enter 直接发送，不再被命令下拉拦截', async () => {
    const sendSpy = vi.fn(async () => true);
    useAgentStore.setState((state) => ({
      ...state,
      settings: normalizeSettings({ fastModelEnabled: false, apiKey: 'test-key' }),
      sessions: [],
      activeSessionId: null,
      messages: [],
      sessionMessages: {},
      _sessionInputState: {},
      isLoading: false,
      loadingSessionId: null,
      sessionMessagesLoading: false,
      sendMessage: sendSpy,
    }));

    await act(async () => {
      root.render(<ChatPanel />);
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    const setNativeValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )!.set!;
    await act(async () => {
      setNativeValue.call(textarea, '/goal exec:npm test');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(sendSpy).toHaveBeenCalledWith(
      '/goal exec:npm test',
      '/goal exec:npm test',
      'agent',
      undefined
    );
  });

  it('无参精确匹配 /help 时 Enter 直接发送，不必先补全空格', async () => {
    const sendSpy = vi.fn(async () => true);
    useAgentStore.setState((state) => ({
      ...state,
      settings: normalizeSettings({ fastModelEnabled: false, apiKey: 'test-key' }),
      sessions: [],
      activeSessionId: null,
      messages: [],
      sessionMessages: {},
      _sessionInputState: {},
      isLoading: false,
      loadingSessionId: null,
      sessionMessagesLoading: false,
      sendMessage: sendSpy,
    }));

    await act(async () => {
      root.render(<ChatPanel />);
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    const setNativeValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )!.set!;
    await act(async () => {
      setNativeValue.call(textarea, '/help');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(sendSpy).toHaveBeenCalledWith('/help', '/help', 'agent', undefined);
  });

  it('下拉打开时 Tab 补全命令名，不插入制表符', async () => {
    const sendSpy = vi.fn(async () => true);
    useAgentStore.setState((state) => ({
      ...state,
      settings: normalizeSettings({ fastModelEnabled: false, apiKey: 'test-key' }),
      sessions: [],
      activeSessionId: null,
      messages: [],
      sessionMessages: {},
      _sessionInputState: {},
      isLoading: false,
      loadingSessionId: null,
      sessionMessagesLoading: false,
      sendMessage: sendSpy,
    }));

    await act(async () => {
      root.render(<ChatPanel />);
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    const setNativeValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )!.set!;
    await act(async () => {
      setNativeValue.call(textarea, '/rev');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(sendSpy).not.toHaveBeenCalled();
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('/review ');
  });

  it('回合进行中仍可发送本地 /help', async () => {
    const sendSpy = vi.fn(async () => true);
    useAgentStore.setState((state) => ({
      ...state,
      settings: normalizeSettings({ fastModelEnabled: false, apiKey: 'test-key' }),
      sessions: [],
      activeSessionId: null,
      messages: [],
      sessionMessages: {},
      _sessionInputState: {},
      isLoading: true,
      loadingSessionId: 'session-busy',
      sessionMessagesLoading: false,
      sendMessage: sendSpy,
    }));

    await act(async () => {
      root.render(<ChatPanel />);
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    const setNativeValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )!.set!;
    await act(async () => {
      setNativeValue.call(textarea, '/help');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(sendSpy).toHaveBeenCalledWith('/help', '/help', 'agent', undefined);
  });

  it('#26：slash 命令发送成功（返回 true）时正常清空草稿', async () => {
    const sendSpy = vi.fn(async () => true);
    useAgentStore.setState((state) => ({
      ...state,
      settings: normalizeSettings({ fastModelEnabled: false, apiKey: 'test-key' }),
      sessions: [],
      activeSessionId: null,
      messages: [],
      sessionMessages: {},
      _sessionInputState: {},
      isLoading: false,
      loadingSessionId: null,
      sessionMessagesLoading: false,
      sendMessage: sendSpy,
    }));

    await act(async () => {
      root.render(<ChatPanel />);
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    const setNativeValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )!.set!;
    await act(async () => {
      setNativeValue.call(textarea, '/help');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(sendSpy).toHaveBeenCalled();
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
  });

  describe('batched history rendering (sliding window)', () => {
    function setLongConversation(rounds: number, batchRounds: number) {
      const messages: UIMessage[] = [];
      for (let i = 1; i <= rounds; i++) {
        messages.push({ id: `user-${i}`, role: 'user', content: `问题 ${i}`, timestamp: i * 2 - 1 });
        messages.push({ id: `assistant-${i}`, role: 'assistant', content: `回答 ${i}`, timestamp: i * 2 });
      }
      useAgentStore.setState((state) => ({
        ...state,
        settings: normalizeSettings({ fastModelEnabled: false, chatRenderBatchRounds: batchRounds }),
        sessions: [
          { id: 'session-1', name: '会话 1', provider: 'deepseek', model: 'deepseek-v4-pro', createdAt: 1, updatedAt: 1 },
        ],
        activeSessionId: 'session-1',
        messages,
        sessionMessages: { 'session-1': messages },
        sessionMessagesLoading: false,
        isLoading: false,
        loadingSessionId: null,
        _pendingChatJump: null,
      }));
    }

    function findButton(text: string): HTMLButtonElement | undefined {
      return Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent?.includes(text)
      );
    }

    it('renders only the latest N rounds at first with a top spacer for unloaded history', async () => {
      setLongConversation(10, 3);

      await act(async () => {
        root.render(<ChatPanel />);
      });

      // 最近 3 轮（8-10）在 DOM 中，第 7 轮尚未渲染
      expect(container.querySelector('[data-message-id="user-8"]')).not.toBeNull();
      expect(container.querySelector('[data-message-id="user-10"]')).not.toBeNull();
      expect(container.querySelector('[data-message-id="user-7"]')).toBeNull();

      // 上方未渲染历史由占位块撑起
      const topSpacer = container.querySelector('[data-chat-scroll] [aria-hidden]') as HTMLElement | null;
      expect(topSpacer).not.toBeNull();
      expect(parseInt(topSpacer!.style.height, 10)).toBeGreaterThan(0);

      expect(findButton('加载更早')?.textContent).toContain('7');
      expect(container.textContent).not.toContain('加载更新');
    });

    it('slides the window up on the top sentinel: loads earlier rounds and unloads later ones', async () => {
      setLongConversation(10, 3);

      await act(async () => {
        root.render(<ChatPanel />);
      });

      await act(async () => {
        findButton('加载更早')?.click();
      });

      // 窗口上移 2 轮（步长 = ceil(3/2)）：第 6-8 轮可见
      expect(container.querySelector('[data-message-id="user-6"]')).not.toBeNull();
      expect(container.querySelector('[data-message-id="user-8"]')).not.toBeNull();
      expect(container.querySelector('[data-message-id="user-5"]')).toBeNull();
      // 第 9-10 轮被卸载，DOM 保持有界
      expect(container.querySelector('[data-message-id="user-9"]')).toBeNull();
      expect(container.querySelector('[data-message-id="user-10"]')).toBeNull();
      // 下方出现「加载更新」哨兵
      expect(findButton('加载更新')?.textContent).toContain('2');
    });

    it('slides back down and re-attaches to the tail', async () => {
      setLongConversation(10, 3);

      await act(async () => {
        root.render(<ChatPanel />);
      });

      await act(async () => {
        findButton('加载更早')?.click();
      });
      await act(async () => {
        findButton('加载更新')?.click();
      });

      // 回到尾部：第 8-10 轮可见，且不再有「加载更新」哨兵
      expect(container.querySelector('[data-message-id="user-10"]')).not.toBeNull();
      expect(container.querySelector('[data-message-id="user-7"]')).toBeNull();
      expect(container.textContent).not.toContain('加载更新');
    });

    it('moves the window to the viewport when scrolling into unloaded regions', async () => {
      setLongConversation(10, 3);

      await act(async () => {
        root.render(<ChatPanel />);
      });

      // 初始贴尾：第 8-10 轮可见
      expect(container.querySelector('[data-message-id="user-8"]')).not.toBeNull();
      expect(container.querySelector('[data-message-id="user-1"]')).toBeNull();

      // 模拟把滚动条直接拖到最顶部（未加载的占位区）
      const scrollContainer = container.querySelector('[data-chat-scroll="true"]') as HTMLElement;
      await act(async () => {
        Object.defineProperty(scrollContainer, 'scrollTop', { value: 0, writable: true, configurable: true });
        scrollContainer.dispatchEvent(new Event('scroll'));
      });
      await act(async () => {
        flushRAF();
      });

      // 窗口跟随视口：第 1 轮出现，尾部卸载
      expect(container.querySelector('[data-message-id="user-1"]')).not.toBeNull();
      expect(container.querySelector('[data-message-id="user-10"]')).toBeNull();
    });

    it('tracks the viewport round for the rounds indicator', async () => {
      setLongConversation(10, 3);

      await act(async () => {
        root.render(<ChatPanel />);
      });

      const ticks = () => Array.from(container.querySelectorAll('.rounds-indicator-tick'));
      expect(ticks().length).toBe(10);

      const scrollContainer = container.querySelector('[data-chat-scroll="true"]') as HTMLElement;

      // 滚到底部 → 最后一轮高亮
      await act(async () => {
        Object.defineProperty(scrollContainer, 'scrollTop', { value: 1_000_000, writable: true, configurable: true });
        scrollContainer.dispatchEvent(new Event('scroll'));
      });
      await act(async () => {
        flushRAF();
      });
      expect(ticks()[9]?.className).toContain('current');

      // 滚到顶部 → 第一轮高亮
      await act(async () => {
        Object.defineProperty(scrollContainer, 'scrollTop', { value: 0, writable: true, configurable: true });
        scrollContainer.dispatchEvent(new Event('scroll'));
      });
      await act(async () => {
        flushRAF();
      });
      expect(ticks()[0]?.className).toContain('current');
    });

    it('keeps the tail rendered and trims the head while new rounds arrive at the bottom', async () => {
      setLongConversation(10, 3);

      await act(async () => {
        root.render(<ChatPanel />);
      });
      expect(container.querySelector('[data-message-id="user-8"]')).not.toBeNull();

      // 追加 2 轮（模拟流式新回合到达）
      await act(async () => {
        const current = useAgentStore.getState().messages;
        const extra: UIMessage[] = [
          { id: 'user-11', role: 'user', content: '问题 11', timestamp: 21 },
          { id: 'assistant-11', role: 'assistant', content: '回答 11', timestamp: 22 },
          { id: 'user-12', role: 'user', content: '问题 12', timestamp: 23 },
          { id: 'assistant-12', role: 'assistant', content: '回答 12', timestamp: 24 },
        ];
        useAgentStore.setState({
          messages: [...current, ...extra],
          sessionMessages: { 'session-1': [...current, ...extra] },
        });
      });

      // 窗口重新贴尾：最新轮可见，头部旧轮被卸载，DOM 保持有界
      expect(container.querySelector('[data-message-id="user-12"]')).not.toBeNull();
      expect(container.querySelector('[data-message-id="user-10"]')).not.toBeNull();
      expect(container.querySelector('[data-message-id="user-9"]')).toBeNull();
    });

    it('renders everything without sentinels when the conversation fits the batch', async () => {
      setLongConversation(3, 6);

      await act(async () => {
        root.render(<ChatPanel />);
      });

      expect(container.querySelector('[data-message-id="user-1"]')).not.toBeNull();
      expect(container.querySelector('[data-message-id="user-3"]')).not.toBeNull();
      expect(container.textContent).not.toContain('加载更早');
      expect(container.textContent).not.toContain('加载更新');
    });

    it('keeps the latest round visible after session history finishes loading', async () => {
      // 7 轮 / 批次 6：空窗口若被当成合法值，会渲染前 6 轮并露出「加载更新的 1 轮」。
      setLongConversation(7, 6);
      const loaded = useAgentStore.getState().messages;
      useAgentStore.setState({
        messages: [],
        sessionMessages: { 'session-1': [] },
        sessionMessagesLoading: true,
      });

      await act(async () => {
        root.render(<ChatPanel />);
      });

      await act(async () => {
        useAgentStore.setState({
          messages: loaded,
          sessionMessages: { 'session-1': loaded },
          sessionMessagesLoading: false,
        });
      });
      await act(async () => {
        flushRAF();
      });

      expect(container.querySelector('[data-message-id="user-7"]')).not.toBeNull();
      expect(container.textContent).not.toContain('加载更新');
    });

    it('moves the window when a jump request targets an unloaded message', async () => {
      setLongConversation(10, 3);

      await act(async () => {
        root.render(<ChatPanel />);
      });
      expect(container.querySelector('[data-message-id="user-2"]')).toBeNull();

      await act(async () => {
        useAgentStore.getState().requestChatScrollToMessage('user-2');
      });

      // 目标进入窗口，同时尾部轮被卸载
      expect(container.querySelector('[data-message-id="user-2"]')).not.toBeNull();
      expect(container.querySelector('[data-message-id="user-8"]')).toBeNull();
      expect(useAgentStore.getState()._pendingChatJump).toBeNull();
    });

    it('scrolls directly without moving the window when the target is already rendered', async () => {
      setLongConversation(10, 3);

      await act(async () => {
        root.render(<ChatPanel />);
      });
      scrollToMock.mockClear();

      await act(async () => {
        useAgentStore.getState().requestChatScrollToMessage('user-9');
      });

      // 窗口未移动：第 7 轮仍未渲染；但发生了滚动
      expect(container.querySelector('[data-message-id="user-7"]')).toBeNull();
      expect(scrollToMock).toHaveBeenCalled();
    });
  });

  it('shows the cancel button only on the session that is actually running', async () => {
    setTwoSessions({
      isLoading: true,
      loadingSessionId: 'session-1',
      activeSessionId: 'session-2',
    });

    await act(async () => {
      root.render(<ChatPanel />);
    });

    // 查看未执行的会话 2：不显示取消按钮
    expect(container.textContent).not.toContain('取消');

    await act(async () => {
      useAgentStore.getState().selectSession('session-1');
    });

    // 切回执行中的会话 1：显示取消按钮
    expect(container.textContent).toContain('取消');
  });

  it('does not show leftover mentor progress on a newly created empty session', async () => {
    startSubagentProgress('mentor', '架构评审', undefined, 'session-1');

    await act(async () => {
      root.render(<ChatPanel />);
    });
    expect(container.textContent).toContain('Mentor 正在思考');

    await act(async () => {
      useAgentStore.getState().newSession();
    });

    expect(container.textContent).not.toContain('Mentor 正在思考');
    expect(container.textContent).toContain('CodePapr');
  });

  it('hides the mentor panel as soon as the run completes', async () => {
    const runId = startSubagentProgress('mentor', '架构评审', undefined, 'session-1');

    await act(async () => {
      root.render(<ChatPanel />);
    });
    expect(container.textContent).toContain('Mentor 正在思考');

    await act(async () => {
      completeSubagentProgress(runId);
    });

    expect(container.textContent).not.toContain('Mentor 正在思考');
    expect(container.querySelector('[data-subagent-run="mentor"]')).toBeNull();
  });

  it('does not carry mentor progress into another session that already has messages', async () => {
    startSubagentProgress('mentor', '架构评审', undefined, 'session-1');
    setTwoSessions({
      messages: [
        {
          id: 'user-s1',
          role: 'user',
          content: '会话 1 的问题',
          timestamp: 1,
        },
      ],
      sessionMessages: {
        'session-1': [
          {
            id: 'user-s1',
            role: 'user',
            content: '会话 1 的问题',
            timestamp: 1,
          },
        ],
        'session-2': [
          {
            id: 'user-s2',
            role: 'user',
            content: '会话 2 的问题',
            timestamp: 2,
          },
        ],
      },
    });

    await act(async () => {
      root.render(<ChatPanel />);
    });
    expect(container.textContent).toContain('Mentor 正在思考');
    expect(container.textContent).toContain('会话 1 的问题');

    await act(async () => {
      useAgentStore.getState().selectSession('session-2');
    });

    expect(container.textContent).not.toContain('Mentor 正在思考');
    expect(container.textContent).toContain('会话 2 的问题');
  });

  it('renders explore progress after the conversation, not above it', async () => {
    startSubagentProgress('explore', '查找入口', undefined, 'session-1');

    await act(async () => {
      root.render(<ChatPanel />);
    });

    const text = container.textContent ?? '';
    const userAt = text.indexOf('把回复布局改成 VS Code 那样');
    const exploreAt = text.indexOf('Explore 正在分析代码');
    expect(userAt).toBeGreaterThan(-1);
    expect(exploreAt).toBeGreaterThan(userAt);
    expect(container.querySelector('[data-subagent-run="explore"]')).not.toBeNull();
  });

  describe('QuestionCard (plan mode question tool)', () => {
    type SendMessageSpy = (
      input: string,
      displayContent?: string,
      mode?: WorkMode,
      images?: IImageContent[]
    ) => Promise<boolean>;

    function makeSendSpy(): ReturnType<typeof vi.fn<SendMessageSpy>> {
      return vi.fn<SendMessageSpy>(async () => true);
    }

    function setPlanQuestion(
      sendMessageSpy: (input: string, displayContent?: string, mode?: WorkMode, images?: IImageContent[]) => Promise<boolean>,
      extraMessages: UIMessage[] = []
    ) {
      const baseMessages: UIMessage[] = [
        {
          id: 'user-1',
          role: 'user',
          content: '帮我规划一下',
          timestamp: 1,
        },
        {
          id: 'plan-1',
          role: 'assistant',
          workMode: 'plan',
          content: '开始规划',
          timestamp: 2,
        },
        ...extraMessages,
      ];
      useAgentStore.setState((state) => ({
        ...state,
        settings: normalizeSettings({ fastModelEnabled: false, apiKey: 'test-key' }),
        workspacePath: '/tmp/codepapr-chat',
        sessions: [
          {
            id: 'session-1',
            name: '会话 1',
            provider: 'deepseek',
            model: 'deepseek-v4-pro',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        activeSessionId: 'session-1',
        messages: baseMessages,
        sessionMessages: { 'session-1': baseMessages },
        _sessionInputState: { 'session-1': { mode: 'plan', draft: '', images: [], files: [] } },
        isLoading: false,
        showSettings: false,
        sendMessage: sendMessageSpy,
      }));
    }

    function clickText(text: string) {
      const button = Array.from(container.querySelectorAll('button')).find((el) =>
        el.textContent?.includes(text)
      );
      if (!button) throw new Error(`未找到包含 "${text}" 的按钮`);
      return act(async () => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    }

    it('renders a single-select question card and answers with the full question text', async () => {
      const sendSpy = makeSendSpy();
      setPlanQuestion(sendSpy, [
        {
          id: 'plan-q',
          role: 'assistant',
          workMode: 'plan',
          content: '',
          timestamp: 3,
          question: {
            question: '你希望系统采用什么技术栈？React 还是 Vue，还是 Rust + Tauri？',
            header: '技术栈',
            options: [{ label: 'rust+tauri' }, { label: 'react+vite' }],
            multiple: false,
          },
        },
      ]);

      await act(async () => {
        root.render(<ChatPanel />);
      });

      expect(container.textContent).toContain('你希望系统采用什么技术栈？React 还是 Vue，还是 Rust + Tauri？');

      await clickText('rust+tauri');

      // 回答必须携带完整问题文本（而非截断的 header）
      const callArgs = sendSpy.mock.calls[0];
      expect(callArgs?.[0]).toContain('你希望系统采用什么技术栈？React 还是 Vue，还是 Rust + Tauri？');
      expect(callArgs?.[0]).toContain('rust+tauri');
      expect(callArgs?.[0]).toContain('不要开始执行');
      expect(callArgs?.[2]).toBe('plan');

      // 源消息被标记为已回答
      const planMsg = useAgentStore.getState().messages.find((m) => m.id === 'plan-q');
      expect(planMsg?.questionAnswered).toBe(true);
    });

    it('supports multi-select with a confirm button', async () => {
      const sendSpy = makeSendSpy();
      setPlanQuestion(sendSpy, [
        {
          id: 'plan-q',
          role: 'assistant',
          workMode: 'plan',
          content: '',
          timestamp: 3,
          question: {
            question: '需要哪些模块？',
            header: '模块',
            options: [{ label: '模块A' }, { label: '模块B' }, { label: '模块C' }],
            multiple: true,
          },
        },
      ]);

      await act(async () => {
        root.render(<ChatPanel />);
      });

      await clickText('模块A');
      await clickText('模块C');

      // 确认按钮出现且可点击
      await clickText('确认选择');

      const callArgs = sendSpy.mock.calls[0];
      expect(callArgs?.[0]).toContain('模块A、模块C');
      expect(callArgs?.[0]).toContain('需要哪些模块？');
      expect(callArgs?.[2]).toBe('plan');
    });

    it('marks the question card answered and disables further interaction', async () => {
      const sendSpy = makeSendSpy();
      setPlanQuestion(sendSpy, [
        {
          id: 'plan-q',
          role: 'assistant',
          workMode: 'plan',
          content: '',
          timestamp: 3,
          question: {
            question: '继续吗？',
            header: '确认',
            options: [{ label: '继续' }, { label: '停止' }],
            multiple: false,
          },
        },
      ]);

      // 模拟已答状态持久化恢复
      useAgentStore.setState((state) => ({
        messages: state.messages.map((m) =>
          m.id === 'plan-q' ? { ...m, questionAnswered: true } : m
        ),
        sessionMessages: {
          'session-1': (state.sessionMessages['session-1'] ?? []).map((m) =>
            m.id === 'plan-q' ? { ...m, questionAnswered: true } : m
          ),
        },
      }));

      await act(async () => {
        root.render(<ChatPanel />);
      });

      expect(container.textContent).toContain('已回答');

      await clickText('继续');
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it('renders legacy decision-card markdown through the unified QuestionCard', async () => {
      const sendSpy = makeSendSpy();
      setPlanQuestion(sendSpy, [
        {
          id: 'plan-q',
          role: 'assistant',
          workMode: 'plan',
          content: `## 待确认选项 | 你希望系统采用什么技术栈？\n1. rust+tauri\n2. react+vite`,
          timestamp: 3,
        },
      ]);

      await act(async () => {
        root.render(<ChatPanel />);
      });

      // 旧格式决策卡片渲染为统一 QuestionCard
      expect(container.textContent).toContain('你希望系统采用什么技术栈？');
      expect(container.textContent).toContain('rust+tauri');

      await clickText('rust+tauri');
      const callArgs = sendSpy.mock.calls[0];
      expect(callArgs?.[0]).toContain('你希望系统采用什么技术栈？');
      expect(callArgs?.[0]).toContain('rust+tauri');
      expect(callArgs?.[2]).toBe('plan');
    });

    function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
      const proto =
        el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    it('allows entering custom thoughts when options do not satisfy user', async () => {
      const sendSpy = makeSendSpy();
      setPlanQuestion(sendSpy, [
        {
          id: 'plan-q',
          role: 'assistant',
          workMode: 'plan',
          content: '',
          timestamp: 3,
          question: {
            question: '你希望系统采用什么技术栈？',
            header: '技术栈',
            options: [{ label: 'rust+tauri' }, { label: 'react+vite' }],
            multiple: false,
          },
        },
      ]);

      await act(async () => {
        root.render(<ChatPanel />);
      });

      // 点击展开「其它想法」
      await clickText('其它想法');

      const input = container.querySelector('input[type="text"]') as HTMLInputElement;
      expect(input).not.toBeNull();

      await act(async () => {
        setInputValue(input, '我想用 Next.js + Tailwind');
      });

      // 点击提交回答
      await clickText('提交回答');

      const callArgs = sendSpy.mock.calls[0];
      expect(callArgs?.[0]).toContain('你希望系统采用什么技术栈？');
      expect(callArgs?.[0]).toContain('我想用 Next.js + Tailwind');
      expect(callArgs?.[2]).toBe('plan');
    });

    it('renders direct custom input for open-ended questions without options', async () => {
      const sendSpy = makeSendSpy();
      setPlanQuestion(sendSpy, [
        {
          id: 'plan-q',
          role: 'assistant',
          workMode: 'plan',
          content: '',
          timestamp: 3,
          question: {
            question: '请详细描述您期望的用户交互流程？',
            header: '交互流程',
            multiple: false,
          },
        },
      ]);

      await act(async () => {
        root.render(<ChatPanel />);
      });

      const input = container.querySelector('input[type="text"]') as HTMLInputElement;
      expect(input).not.toBeNull();

      await act(async () => {
        setInputValue(input, '用户先登录，然后进入仪表盘');
      });

      await clickText('提交回答');

      const callArgs = sendSpy.mock.calls[0];
      expect(callArgs?.[0]).toContain('请详细描述您期望的用户交互流程？');
      expect(callArgs?.[0]).toContain('用户先登录，然后进入仪表盘');
      expect(callArgs?.[2]).toBe('plan');
    });
  });

  it('N16：会话消息加载失败时显示提示横幅，重试成功后消失', async () => {
    useAgentStore.setState((state) => ({
      ...state,
      _messageLoadFailedSessions: { 'session-1': true },
      messages: [],
      sessionMessages: { 'session-1': [] },
    }));

    await act(async () => {
      root.render(<ChatPanel />);
    });

    // 空白会话必须有可见提示（此前 _messageLoadFailedSessions 无 UI 消费者）
    expect(container.textContent).toContain('会话历史加载失败');

    // 重试成功：横幅消失、消息恢复
    invokeMock.mockResolvedValueOnce({
      messagesJson: JSON.stringify([
        { id: 'user-1', role: 'user', content: '把回复布局改成 VS Code 那样', timestamp: 1 },
      ]),
    });
    await act(async () => {
      const retryButton = Array.from(container.querySelectorAll('button')).find(
        (el) => el.textContent?.includes('重试')
      );
      retryButton?.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).not.toContain('会话历史加载失败');
    expect(useAgentStore.getState()._messageLoadFailedSessions['session-1']).toBe(false);
    expect(useAgentStore.getState().messages.map((m) => m.id)).toEqual(['user-1']);
  });

  it('N16：重试失败时横幅保留并提示', async () => {
    useAgentStore.setState((state) => ({
      ...state,
      _messageLoadFailedSessions: { 'session-1': true },
      messages: [],
      sessionMessages: { 'session-1': [] },
    }));

    await act(async () => {
      root.render(<ChatPanel />);
    });

    invokeMock.mockRejectedValueOnce(new Error('db locked'));
    await act(async () => {
      const retryButton = Array.from(container.querySelectorAll('button')).find(
        (el) => el.textContent?.includes('重试')
      );
      retryButton?.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(useAgentStore.getState()._messageLoadFailedSessions['session-1']).toBe(true);
    expect(container.textContent).toContain('会话历史加载失败');
    expect(container.textContent).toContain('重新加载失败');
  });

  function setPlainAssistantThread() {
    useAgentStore.setState((state) => ({
      ...state,
      messages: [
        { id: 'user-plain', role: 'user', content: '你好', timestamp: 1 },
        { id: 'assistant-plain', role: 'assistant', content: '你好，我是助手。', timestamp: 2 },
      ],
      sessionMessages: {
        'session-1': [
          { id: 'user-plain', role: 'user', content: '你好', timestamp: 1 },
          { id: 'assistant-plain', role: 'assistant', content: '你好，我是助手。', timestamp: 2 },
        ],
      },
    }));
  }

  function setActiveCharacter(overrides: Partial<CharacterProfile> = {}) {
    const now = new Date().toISOString();
    const character: CharacterProfile = {
      id: 'char-1',
      name: 'Ada',
      avatarDataUrl: null,
      showAvatar: true,
      interactionMode: 'persona',
      description: '',
      personality: '',
      scenario: '',
      firstMessage: '',
      alternateGreetings: [],
      selectedGreetingIndex: 0,
      exampleMessages: '',
      systemPrompt: '',
      postHistoryInstructions: '',
      tags: [],
      creator: '',
      characterVersion: '',
      source: 'manual',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
    useCharactersStore.setState({
      loaded: true,
      loading: false,
      characters: [character],
      activeCharacterId: character.id,
    });
  }

  it('does not show a default avatar when no character is enabled', async () => {
    setPlainAssistantThread();

    await act(async () => {
      root.render(<ChatPanel />);
    });

    expect(container.querySelector('[data-chat-avatar]')).toBeNull();
  });

  it('shows a placeholder avatar when a character is enabled without an image', async () => {
    setPlainAssistantThread();
    useAgentStore.setState((state) => ({
      ...state,
      settings: normalizeSettings({ ...state.settings, experimentalCharacters: true, fastModelEnabled: false }),
    }));
    setActiveCharacter({ avatarDataUrl: null });

    await act(async () => {
      root.render(<ChatPanel />);
    });

    expect(container.querySelector('[data-chat-avatar="placeholder"]')).not.toBeNull();
    expect(container.querySelector('[data-chat-avatar="photo"]')).toBeNull();
  });

  it('shows the character photo when an avatar data URL is present', async () => {
    setPlainAssistantThread();
    useAgentStore.setState((state) => ({
      ...state,
      settings: normalizeSettings({ ...state.settings, experimentalCharacters: true, fastModelEnabled: false }),
    }));
    setActiveCharacter({ avatarDataUrl: 'data:image/png;base64,aaaa' });

    await act(async () => {
      root.render(<ChatPanel />);
    });

    const photo = container.querySelector('[data-chat-avatar="photo"] img') as HTMLImageElement | null;
    expect(photo?.getAttribute('src')).toBe('data:image/png;base64,aaaa');
  });

  it('hides the avatar when the enabled character turns showAvatar off', async () => {
    setPlainAssistantThread();
    useAgentStore.setState((state) => ({
      ...state,
      settings: normalizeSettings({ ...state.settings, experimentalCharacters: true, fastModelEnabled: false }),
    }));
    setActiveCharacter({ showAvatar: false, avatarDataUrl: 'data:image/png;base64,aaaa' });

    await act(async () => {
      root.render(<ChatPanel />);
    });

    expect(container.querySelector('[data-chat-avatar]')).toBeNull();
  });
});
