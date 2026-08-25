import { describe, expect, it } from 'vitest';
import { _sidecarHostBridgeEventsForTest } from './sidecarHostBridge';

describe('sidecar host bridge events', () => {
  it('keeps permission and mutation event names stable', () => {
    expect(_sidecarHostBridgeEventsForTest()).toEqual({
      permission: 'agent-runtime://permission-request',
      cancel: 'agent-runtime://permission-cancel',
      mutated: 'agent-runtime://workspace-mutated',
    });
  });
});
