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
    const sendSpy = vi.fn(async () => {});
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

  describe('QuestionCard (plan mode question tool)', () => {
    type SendMessageSpy = (
      input: string,
      displayContent?: string,
      mode?: WorkMode,
      images?: IImageContent[]
    ) => Promise<void>;

    function makeSendSpy(): ReturnType<typeof vi.fn<SendMessageSpy>> {
      return vi.fn<SendMessageSpy>(async () => {});
    }

    function setPlanQuestion(
      sendMessageSpy: (input: string, displayContent?: string, mode?: WorkMode, images?: IImageContent[]) => Promise<void>,      extraMessages: UIMessage[] = []
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
  });
});
