// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeSettings, useAgentStore } from '../store/agentStore';
import { useMcpConfirmStore } from '../store/mcpConfirmStore';
import { McpConfirmDialog } from './McpConfirmDialog';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('McpConfirmDialog', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useMcpConfirmStore.setState({ pendingConfirm: null });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    useMcpConfirmStore.setState({ pendingConfirm: null });
  });

  it('renders English copy when settings.lang is en', async () => {
    useAgentStore.setState((state) => ({
      ...state,
      settings: normalizeSettings({ ...state.settings, lang: 'en' }),
    }));
    useMcpConfirmStore.setState({
      pendingConfirm: {
        requestId: 'r1',
        serverId: 'fs',
        serverName: 'Filesystem MCP',
        toolName: 'write_file',
        arguments: { path: '/tmp/x' },
      },
    });

    await act(async () => {
      root.render(<McpConfirmDialog />);
    });

    expect(container.textContent).toContain('Confirm MCP action');
    expect(container.textContent).toContain('Allow');
    expect(container.textContent).toContain('Deny');
    expect(container.textContent).not.toContain('高风险');
  });
});
