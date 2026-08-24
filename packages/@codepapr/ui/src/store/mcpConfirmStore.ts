import { create } from 'zustand';
import type { McpConfirmRequest } from '../tools/mcpTools';

interface PendingMcpConfirm {
  request: McpConfirmRequest;
  resolve: (approved: boolean) => void;
  responding: boolean;
}

interface McpConfirmStoreState {
  pendingConfirm: McpConfirmRequest | null;
  requestConfirm: (request: McpConfirmRequest) => Promise<boolean>;
  respondToConfirm: (approved: boolean) => void;
  cancelPendingConfirms: () => void;
}

const pendingQueue: PendingMcpConfirm[] = [];

function syncPending(set: (state: Partial<McpConfirmStoreState>) => void): void {
  set({ pendingConfirm: pendingQueue[0]?.request ?? null });
}

export const useMcpConfirmStore = create<McpConfirmStoreState>((set) => ({
  pendingConfirm: null,

  requestConfirm: (request) => {
    return new Promise<boolean>((resolve) => {
      const wasEmpty = pendingQueue.length === 0;
      pendingQueue.push({ request, resolve, responding: false });
      if (wasEmpty) {
        syncPending(set);
      }
    });
  },

  respondToConfirm: (approved) => {
    const entry = pendingQueue[0];
    if (!entry || entry.responding) return;
    entry.responding = true;
    pendingQueue.shift();
    syncPending(set);
    entry.resolve(approved);
  },

  cancelPendingConfirms: () => {
    cancelPendingMcpConfirms();
  },
}));

/** 切工作区/销毁回合：拒绝全部排队中的 MCP 确认，避免弹窗留在新项目上。 */
export function cancelPendingMcpConfirms(): void {
  const removed = pendingQueue.splice(0);
  useMcpConfirmStore.setState({ pendingConfirm: null });
  for (const entry of removed) {
    if (entry.responding) continue;
    entry.responding = true;
    entry.resolve(false);
  }
}
