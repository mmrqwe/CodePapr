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

import { normalizeSettings, useAgentStore } from '../store/agentStore';
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
});
