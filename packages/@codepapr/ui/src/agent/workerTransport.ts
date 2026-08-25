import type { AgentWorkerToMainMessage, MainToAgentWorkerMessage } from './agentWorkerProtocol';
import type { AgentRuntimeTransport } from './agentRuntimeHost';

export class WorkerTransport implements AgentRuntimeTransport {
  readonly kind = 'worker' as const;
  private readonly worker: Worker;
  private readonly messageListeners: Array<(message: AgentWorkerToMainMessage) => void> = [];
  private readonly errorListeners: Array<(error: { message: string; detail?: string }) => void> = [];
  private terminated = false;

  constructor() {
    this.worker = new Worker(new URL('./agentRuntime.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.addEventListener('message', (event: MessageEvent<AgentWorkerToMainMessage>) => {
      for (const listener of this.messageListeners) {
        listener(event.data);
      }
    });
    this.worker.addEventListener('error', (event: ErrorEvent) => {
      const detail = event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined;
      for (const listener of this.errorListeners) {
        listener({ message: event.message || 'unknown error', detail });
      }
    });
    this.worker.addEventListener('messageerror', () => {
      for (const listener of this.errorListeners) {
        listener({
          message: 'Agent worker message could not be deserialized (structured clone failure)',
        });
      }
    });
  }

  post(message: MainToAgentWorkerMessage, transfer?: Transferable[]): void {
    if (this.terminated) return;
    try {
      if (transfer && transfer.length > 0) {
        this.worker.postMessage(message, transfer);
      } else {
        this.worker.postMessage(message);
      }
    } catch {
      // worker may already be terminated
    }
  }

  addMessageListener(listener: (message: AgentWorkerToMainMessage) => void): void {
    this.messageListeners.push(listener);
  }

  addErrorListener(listener: (error: { message: string; detail?: string }) => void): void {
    this.errorListeners.push(listener);
  }

  terminate(_options?: { kill?: boolean }): void {
    if (this.terminated) return;
    this.terminated = true;
    try {
      this.worker.terminate();
    } catch {
      // already terminated
    }
  }
}
