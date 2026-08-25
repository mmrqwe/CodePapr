/// <reference lib="webworker" />

import { startAgentRuntime } from './agentRuntimeLoop';

declare const self: DedicatedWorkerGlobalScope;

startAgentRuntime({
  postMessage: (message) => {
    self.postMessage(message);
  },
  subscribe: (handler) => {
    self.onmessage = (event: MessageEvent) => {
      handler(event.data);
    };
  },
  installFatalHandlers: (report) => {
    self.addEventListener('error', (event) => {
      report(
        event.message || 'Worker global error',
        event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined,
      );
    });
    self.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason as unknown;
      report(
        `Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
        reason instanceof Error ? reason.stack : undefined,
      );
    });
  },
});
