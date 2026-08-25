import { afterEach, describe, expect, it, vi } from 'vitest';
import { shouldUseSidecarAgentRuntime, shouldUseWorkerAgentRuntime } from './providerFactory';

describe('shouldUseSidecarAgentRuntime', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is off in unit tests', () => {
    expect(shouldUseSidecarAgentRuntime()).toBe(false);
  });

  it('stays off even when localStorage asks for sidecar (MODE=test)', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    });
    localStorage.setItem('codepapr-agent-runtime', 'sidecar');
    expect(shouldUseSidecarAgentRuntime()).toBe(false);
  });
});

describe('shouldUseWorkerAgentRuntime', () => {
  it('is off in unit tests even when Worker exists', () => {
    expect(shouldUseWorkerAgentRuntime()).toBe(false);
  });
});

describe('shouldUseSidecarAgentRuntime', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is off in unit tests', () => {
    expect(shouldUseSidecarAgentRuntime()).toBe(false);
  });

  it('stays off even when localStorage asks for sidecar (MODE=test)', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    });
    localStorage.setItem('codepapr-agent-runtime', 'sidecar');
    expect(shouldUseSidecarAgentRuntime()).toBe(false);
  });
});
