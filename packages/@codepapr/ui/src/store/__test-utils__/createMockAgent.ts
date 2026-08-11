import { vi } from 'vitest';
import type { IAgentResponse, IMessage } from '@codepapr/types';
import type { AgentRuntimeHandle, AgentRuntimeStreamEvent } from '../../agent/WorkerBackedAgent';

export interface MockAgentOverrides {
  /** Custom chat implementation. Defaults to a no-op vi.fn() returning a minimal response. */
  chat?: AgentRuntimeHandle['chat'];
  /** Pre-built logStore.length() return value. Defaults to 0. */
  logStoreLength?: number;
  /** Pre-built logStore.getMessagesSince() return value or factory. Defaults to []. */
  logMessages?: IMessage[] | (() => IMessage[]);
  /** Custom cancel implementation. Defaults to no-op. */
  cancel?: () => void;
  /** Custom cancelSession implementation. Defaults to the cancel override when
   *  provided, else no-op. */
  cancelSession?: () => void;
  /** Custom destroy implementation. Defaults to no-op. */
  destroy?: () => void;
  /** Pre-built isCrashed() return value (or dynamic getter). Defaults to false. */
  isCrashed?: boolean | (() => boolean);
  /** Custom runAppAgent implementation. Defaults to rejecting (unused in most tests). */
  runAppAgent?: AgentRuntimeHandle['runAppAgent'];
}

const DEFAULT_RESPONSE: IAgentResponse = {
  role: 'assistant',
  content: '',
  cacheStats: {
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    newInputTokens: 0,
    outputTokens: 0,
    calls: 1,
  },
};

/**
 * Build a `AgentRuntimeHandle`-shaped mock for use in store tests.
 *
 * Defaults are safe enough for any test that does not specifically inspect
 * agent behavior. Override only the bits the test cares about — the factory
 * preserves the rest, so adding new required fields to `AgentRuntimeHandle`
 * only requires updating this file (not every callsite).
 */
export function createMockAgent(overrides: MockAgentOverrides = {}): AgentRuntimeHandle {
  const chat = overrides.chat ??
    vi.fn(async (
      _userInput: string,
      _onStreamEvent?: (event: AgentRuntimeStreamEvent) => void,
      _images?: unknown,
    ): Promise<IAgentResponse> => DEFAULT_RESPONSE);

  const messagesProvider = typeof overrides.logMessages === 'function'
    ? overrides.logMessages
    : () => overrides.logMessages ?? [];

  const isCrashed = typeof overrides.isCrashed === 'function'
    ? overrides.isCrashed
    : () => overrides.isCrashed ?? false;

  return {
    chat,
    isCrashed,
    getSession: () => ({
      logStore: {
        length: () => overrides.logStoreLength ?? 0,
        getMessagesSince: () => messagesProvider(),
      },
    }),
    cancel: overrides.cancel ?? (() => undefined),
    cancelSession: overrides.cancelSession ?? overrides.cancel ?? (() => undefined),
    destroy: overrides.destroy ?? (() => undefined),
    runAppAgent: overrides.runAppAgent ?? (() => Promise.reject(new Error('not available in mock'))),
    cancelAppAgent: () => undefined,
    // logStore is typed as the full `AppendOnlyLog` class. The store only
    // calls `length()` and `getMessagesSince()` on it, so we provide a
    // minimal shape and isolate the cast inside this factory.
  } as unknown as AgentRuntimeHandle;
}
