/**
 * useAgent: React hook 接口，调用 Tauri IPC 与后端 Agent 通信
 */

export interface UseAgentOptions {
  sessionId: string;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

export interface UseAgentReturn {
  chat: (input: string) => Promise<{ content: string; stats?: unknown }>;
  loading: boolean;
}

export function useAgent(opts: UseAgentOptions): UseAgentReturn {
  return {
    async chat(input: string) {
      const result = (await opts.invoke('agent_chat', {
        sessionId: opts.sessionId,
        input,
      })) as { content: string; stats?: unknown };
      return result;
    },
    loading: false,
  };
}
