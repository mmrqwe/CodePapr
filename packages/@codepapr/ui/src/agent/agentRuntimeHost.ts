import type { AgentWorkerToMainMessage, MainToAgentWorkerMessage } from './agentWorkerProtocol';

/** Isolate-agnostic host for the agent chat loop (Web Worker or Node sidecar). */
export interface AgentRuntimeHost {
  postMessage(message: AgentWorkerToMainMessage): void;
  subscribe(handler: (message: MainToAgentWorkerMessage) => void): void;
  /** When set, LLM HTTP uses this fetch instead of proxying through the UI. */
  fetch?: typeof globalThis.fetch;
  installFatalHandlers?(report: (message: string, detail?: string) => void): void;
}

/** UI ↔ runtime transport. WorkerBackedAgent talks only through this. */
export interface AgentRuntimeTransport {
  /** Sidecar is isolated from WKWebView freeze; Worker is not. */
  readonly kind?: 'worker' | 'sidecar';
  post(message: MainToAgentWorkerMessage, transfer?: Transferable[]): void;
  addMessageListener(listener: (message: AgentWorkerToMainMessage) => void): void;
  addErrorListener(listener: (error: { message: string; detail?: string }) => void): void;
  /**
   * Detach this transport. Sidecar: omit `kill` to keep the app-level Node
   * process (session switch sends `init` on a new agent). Pass `{ kill: true }`
   * after a crash so recovery starts a fresh process.
   */
  terminate(options?: { kill?: boolean }): void;
}
