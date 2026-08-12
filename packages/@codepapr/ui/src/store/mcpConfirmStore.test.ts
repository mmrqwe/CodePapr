import { beforeEach, describe, expect, it } from 'vitest';
import { useMcpConfirmStore } from './mcpConfirmStore';
import type { McpConfirmRequest } from '../tools/mcpTools';

function makeRequest(id: string): McpConfirmRequest {
  return {
    requestId: id,
    serverId: 'filesystem',
    serverName: 'Filesystem MCP',
    toolName: 'write_file',
    arguments: { path: '/tmp/x.txt', content: 'hello' },
  };
}

describe('useMcpConfirmStore', () => {
  beforeEach(() => {
    useMcpConfirmStore.setState({ pendingConfirm: null });
  });

  it('approves a pending request and resolves the promise with true', async () => {
    const promise = useMcpConfirmStore.getState().requestConfirm(makeRequest('r1'));
    expect(useMcpConfirmStore.getState().pendingConfirm?.requestId).toBe('r1');

    useMcpConfirmStore.getState().respondToConfirm(true);

    await expect(promise).resolves.toBe(true);
    expect(useMcpConfirmStore.getState().pendingConfirm).toBeNull();
  });

  it('denies a pending request and resolves the promise with false', async () => {
    const promise = useMcpConfirmStore.getState().requestConfirm(makeRequest('r1'));

    useMcpConfirmStore.getState().respondToConfirm(false);

    await expect(promise).resolves.toBe(false);
    expect(useMcpConfirmStore.getState().pendingConfirm).toBeNull();
  });

  it('queues multiple requests and surfaces them one at a time', async () => {
    const first = useMcpConfirmStore.getState().requestConfirm(makeRequest('r1'));
    const second = useMcpConfirmStore.getState().requestConfirm(makeRequest('r2'));
    expect(useMcpConfirmStore.getState().pendingConfirm?.requestId).toBe('r1');

    useMcpConfirmStore.getState().respondToConfirm(true);
    expect(useMcpConfirmStore.getState().pendingConfirm?.requestId).toBe('r2');
    await expect(first).resolves.toBe(true);

    useMcpConfirmStore.getState().respondToConfirm(false);
    expect(useMcpConfirmStore.getState().pendingConfirm).toBeNull();
    await expect(second).resolves.toBe(false);
  });

  it('ignores a second response to the same request', async () => {
    const promise = useMcpConfirmStore.getState().requestConfirm(makeRequest('r1'));

    useMcpConfirmStore.getState().respondToConfirm(true);
    useMcpConfirmStore.getState().respondToConfirm(false);

    await expect(promise).resolves.toBe(true);
    expect(useMcpConfirmStore.getState().pendingConfirm).toBeNull();
  });

  it('ignores responses when no request is pending', () => {
    expect(() => useMcpConfirmStore.getState().respondToConfirm(true)).not.toThrow();
    expect(useMcpConfirmStore.getState().pendingConfirm).toBeNull();
  });
});
