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
  post(message: MainToAgentWorkerMessage, transfer?: Transferable[]): void;
  addMessageListener(listener: (message: AgentWorkerToMainMessage) => void): void;
  addErrorListener(listener: (error: { message: string; detail?: string }) => void): void;
  terminate(): void;
}
