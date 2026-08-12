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
}));
