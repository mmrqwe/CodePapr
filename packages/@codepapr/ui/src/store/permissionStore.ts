import { create } from 'zustand';
import { createId } from '../utils/createId';

export interface ExternalAccessRequest {
  id: string;
  path: string;
  operation: 'read' | 'list';
}

export interface ExternalAccessResponse {
  approved: boolean;
  scope: 'directory' | 'file';
}

function normalizePathDots(p: string): string {
  const isAbsolute = p.startsWith('/');
  const parts = p.split('/').filter(Boolean);
  const result: string[] = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') {
      if (result.length > 0 && result[result.length - 1] !== '..') {
        result.pop();
      } else if (!isAbsolute) {
        result.push('..');
      }
    } else {
      result.push(part);
    }
  }
  return (isAbsolute ? '/' : '') + result.join('/');
}

export function getDirname(p: string): string {
  const normalized = normalizePathDots(p);
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0) return '/';
  return normalized.slice(0, lastSlash);
}

export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[/\\]/.test(p);
}

interface PermissionStoreState {
  pendingRequest: ExternalAccessRequest | null;
  allowedExternalDirs: string[];
  allowedExternalFiles: string[];

  requestExternalAccess: (path: string, operation: 'read' | 'list') => Promise<ExternalAccessResponse>;
  respondToExternalAccess: (approved: boolean, scope: 'directory' | 'file') => void;
  isExternalPathAllowed: (path: string) => boolean;
  addAllowedDir: (dir: string) => void;
  addAllowedFile: (file: string) => void;
  clearAllowlist: () => void;
}

let pendingResolve: ((value: ExternalAccessResponse) => void) | null = null;

export const usePermissionStore = create<PermissionStoreState>((set, get) => ({
  pendingRequest: null,
  allowedExternalDirs: [],
  allowedExternalFiles: [],

  requestExternalAccess: (rawPath: string, operation: 'read' | 'list') => {
    const normalized = normalizePathDots(rawPath);
    return new Promise<ExternalAccessResponse>((resolve) => {
      pendingResolve = resolve;
      set({
        pendingRequest: {
          id: createId(),
          path: normalized,
          operation,
        },
      });
    });
  },

  respondToExternalAccess: (approved: boolean, scope: 'directory' | 'file') => {
    const { pendingRequest } = get();
    if (pendingRequest && approved) {
      if (scope === 'directory') {
        get().addAllowedDir(getDirname(pendingRequest.path));
      } else {
        get().addAllowedFile(pendingRequest.path);
      }
    }
    if (pendingResolve) {
      pendingResolve({ approved, scope });
      pendingResolve = null;
    }
    set({ pendingRequest: null });
  },

  isExternalPathAllowed: (rawPath: string) => {
    const normalized = normalizePathDots(rawPath);
    const { allowedExternalDirs, allowedExternalFiles } = get();
    for (const dir of allowedExternalDirs) {
      if (normalized === dir || normalized.startsWith(dir + '/')) return true;
    }
    for (const file of allowedExternalFiles) {
      if (normalized === file) return true;
    }
    return false;
  },

  addAllowedDir: (dir: string) => {
    const normalized = normalizePathDots(dir);
    const { allowedExternalDirs } = get();
    if (!allowedExternalDirs.includes(normalized)) {
      set({ allowedExternalDirs: [...allowedExternalDirs, normalized] });
    }
  },

  addAllowedFile: (file: string) => {
    const normalized = normalizePathDots(file);
    const { allowedExternalFiles } = get();
    if (!allowedExternalFiles.includes(normalized)) {
      set({ allowedExternalFiles: [...allowedExternalFiles, normalized] });
    }
  },

  clearAllowlist: () => {
    set({ allowedExternalDirs: [], allowedExternalFiles: [] });
  },
}));
