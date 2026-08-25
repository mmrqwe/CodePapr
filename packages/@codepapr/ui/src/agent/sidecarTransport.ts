import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AgentWorkerToMainMessage, MainToAgentWorkerMessage } from './agentWorkerProtocol';
import type { AgentRuntimeTransport } from './agentRuntimeHost';
import { attachSidecarHostBridge } from './sidecarHostBridge';

const FRAME_EVENT = 'agent-runtime://frame';
const EXIT_EVENT = 'agent-runtime://exit';

interface AgentRuntimeFrameEvent {
  runtimeId: string;
  message: AgentWorkerToMainMessage;
}

interface AgentRuntimeExitEvent {
  runtimeId: string;
  code: number | null;
  signal?: string | null;
  error?: string;
}

export interface SidecarTransportOptions {
  onWorkspaceMutated?: (paths: string[]) => void;
}

/**
 * One Node sidecar process per transport instance (matches Worker lifetime).
 * Posts are queued until `agent_runtime_start` returns.
 */
export class SidecarTransport implements AgentRuntimeTransport {
  private runtimeId: string | null = null;
  private readonly queue: string[] = [];
  private ready = false;
  private terminated = false;
  private startFailed = false;
  private readonly messageListeners: Array<(message: AgentWorkerToMainMessage) => void> = [];
  private readonly errorListeners: Array<(error: { message: string; detail?: string }) => void> = [];
  private unlistenFrame: UnlistenFn | null = null;
  private unlistenExit: UnlistenFn | null = null;
  private detachHostBridge: (() => void) | null = null;
  private readonly onWorkspaceMutated?: (paths: string[]) => void;

  constructor(options: SidecarTransportOptions = {}) {
    this.onWorkspaceMutated = options.onWorkspaceMutated;
    void this.start();
  }

  private async start(): Promise<void> {
    try {
      const runtimeId = await invoke<string>('agent_runtime_start');
      if (this.terminated) {
        await invoke('agent_runtime_stop', { runtimeId }).catch(() => undefined);
        return;
      }
      this.runtimeId = runtimeId;
      this.detachHostBridge = await attachSidecarHostBridge({
        runtimeId,
        onWorkspaceMutated: this.onWorkspaceMutated,
      });
      this.unlistenFrame = await listen<AgentRuntimeFrameEvent>(FRAME_EVENT, (event) => {
        if (event.payload.runtimeId !== this.runtimeId) return;
        for (const listener of this.messageListeners) {
          listener(event.payload.message);
        }
      });
      this.unlistenExit = await listen<AgentRuntimeExitEvent>(EXIT_EVENT, (event) => {
        if (event.payload.runtimeId !== this.runtimeId) return;
        if (this.terminated) return;
        const detail = event.payload.error
          ?? (event.payload.signal ? `signal ${event.payload.signal}` : `exit ${event.payload.code ?? 'unknown'}`);
        this.emitError({ message: `Agent sidecar exited (${detail})`, detail });
      });
      this.ready = true;
      while (this.queue.length > 0 && !this.terminated) {
        const line = this.queue.shift();
        if (line === undefined) break;
        await invoke('agent_runtime_send', { runtimeId: this.runtimeId, line });
      }
    } catch (error) {
      this.startFailed = true;
      this.emitError({
        message: `Failed to start agent sidecar: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private emitError(error: { message: string; detail?: string }): void {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }

  post(message: MainToAgentWorkerMessage, _transfer?: Transferable[]): void {
    if (this.terminated || this.startFailed) return;
    const line = `${JSON.stringify(message)}\n`;
    if (!this.ready || !this.runtimeId) {
      this.queue.push(line);
      return;
    }
    void invoke('agent_runtime_send', { runtimeId: this.runtimeId, line }).catch((error) => {
      this.emitError({
        message: `Failed to send to agent sidecar: ${error instanceof Error ? error.message : String(error)}`,
      });
    });
  }

  addMessageListener(listener: (message: AgentWorkerToMainMessage) => void): void {
    this.messageListeners.push(listener);
  }

  addErrorListener(listener: (error: { message: string; detail?: string }) => void): void {
    this.errorListeners.push(listener);
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.queue.length = 0;
    const runtimeId = this.runtimeId;
    this.runtimeId = null;
    this.unlistenFrame?.();
    this.unlistenExit?.();
    this.unlistenFrame = null;
    this.unlistenExit = null;
    this.detachHostBridge?.();
    this.detachHostBridge = null;
    if (runtimeId) {
      void invoke('agent_runtime_stop', { runtimeId }).catch(() => undefined);
    }
  }
}
