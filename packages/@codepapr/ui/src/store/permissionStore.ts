import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
import { createId } from '../utils/createId';
import { pathsEquivalent, pathUnderDir } from '../utils/pathComparison';

export interface ExternalAccessRequest {
  id: string;
  path: string;
  operation: 'read' | 'list' | 'write' | 'execute';
  workspacePath?: string;
  allowFile?: boolean;
}

export interface ExternalAccessResponse {
  approved: boolean;
  scope: 'directory' | 'file';
}

interface ExternalAccessPolicyPayload {
  yolo: boolean;
  allowedDirs: string[];
  allowedFiles: string[];
}

interface PendingExternalRequest {
  request: ExternalAccessRequest;
  resolve: (value: ExternalAccessResponse) => void;
  reject: (reason: unknown) => void;
  responding: boolean;
}

function normalizePathDots(p: string): string {
  const rawPath = p.replace(/\\/g, '/');
  const isDrivePath = /^[A-Za-z]:\//.test(rawPath);
  const isUncPath = rawPath.startsWith('//');
  const isAbsolute = rawPath.startsWith('/') || isDrivePath;
  const prefix = isDrivePath
    ? rawPath.slice(0, 2)
    : isUncPath
      ? '//'
      : isAbsolute
        ? '/'
        : '';
  const pathWithoutPrefix = isDrivePath
    ? rawPath.slice(2)
    : isUncPath
      ? rawPath.slice(2)
      : isAbsolute
        ? rawPath.slice(1)
        : rawPath;
  const parts = pathWithoutPrefix.split('/').filter(Boolean);
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
  return prefix + (prefix && !prefix.endsWith('/') ? '/' : '') + result.join('/');
}

export function getDirname(p: string): string {
  const normalized = normalizePathDots(p);
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0) return '/';
  return normalized.slice(0, lastSlash);
}

export function isAbsolutePath(p: string): boolean {
  const normalized = p.replace(/\\/g, '/');
  return normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized);
}

interface PermissionStoreState {
  pendingRequest: ExternalAccessRequest | null;
  allowedExternalDirs: string[];
  allowedExternalFiles: string[];
  yolo: boolean;

  hydratePolicy: () => Promise<void>;
  setYolo: (enabled: boolean) => Promise<void>;
  requestExternalAccess: (
    path: string,
    operation: ExternalAccessRequest['operation'],
    workspacePath?: string,
    allowFile?: boolean,
  ) => Promise<ExternalAccessResponse>;
  respondToExternalAccess: (
    approved: boolean,
    scope: 'directory' | 'file',
  ) => Promise<void>;
  isExternalPathAllowed: (path: string) => boolean;
  addAllowedDir: (dir: string) => void;
  addAllowedFile: (file: string) => void;
  clearAllowlist: () => Promise<void>;
}

const pendingQueue: PendingExternalRequest[] = [];
let policyHydration: Promise<void> | null = null;
const permissionWaitListeners = new Set<(waiting: boolean) => void>();

export function subscribePermissionWait(listener: (waiting: boolean) => void): () => void {
  permissionWaitListeners.add(listener);
  return () => permissionWaitListeners.delete(listener);
}

export function isPermissionWaitActive(): boolean {
  return pendingQueue.length > 0;
}

export function cancelExternalAccessRequests(reason: unknown = new DOMException('权限请求已取消', 'AbortError')): void {
  const requests = pendingQueue.splice(0);
  usePermissionStore.setState({ pendingRequest: null });
  if (requests.length > 0) publishPermissionWait(false);
  for (const entry of requests) {
    entry.reject(reason);
  }
}

function publishPermissionWait(waiting: boolean): void {
  for (const listener of permissionWaitListeners) {
    listener(waiting);
  }
}

function currentPendingRequest(): ExternalAccessRequest | null {
  return pendingQueue[0]?.request ?? null;
}

function syncPending(set: (state: Partial<PermissionStoreState>) => void): void {
  set({ pendingRequest: currentPendingRequest() });
}

function applyPolicy(
  set: (state: Partial<PermissionStoreState>) => void,
  policy: ExternalAccessPolicyPayload,
): void {
  set({
    yolo: policy.yolo === true,
    allowedExternalDirs: (policy.allowedDirs ?? []).map(normalizePathDots),
    allowedExternalFiles: (policy.allowedFiles ?? []).map(normalizePathDots),
  });
}

export const usePermissionStore = create<PermissionStoreState>((set, get) => ({
  pendingRequest: null,
  allowedExternalDirs: [],
  allowedExternalFiles: [],
  yolo: false,

  hydratePolicy: async () => {
    if (!policyHydration) {
      policyHydration = invoke<ExternalAccessPolicyPayload>('get_external_access_policy')
        .then((policy) => applyPolicy(set, policy))
        .catch((error) => {
          console.warn('无法加载外部文件访问策略:', error);
        })
        .finally(() => {
          policyHydration = null;
        });
    }
    await policyHydration;
  },

  setYolo: async (enabled: boolean) => {
    const policy = await invoke<ExternalAccessPolicyPayload>('set_external_access_yolo', {
      enabled,
    });
    applyPolicy(set, policy);
  },

  requestExternalAccess: (
    rawPath: string,
    operation: ExternalAccessRequest['operation'],
    workspacePath?: string,
    allowFile = true,
  ) => {
    const normalized = normalizePathDots(rawPath);
    const existing = pendingQueue.find(
      (entry) => entry.request.path === normalized && entry.request.operation === operation,
    );
    if (existing) {
      return new Promise<ExternalAccessResponse>((resolve, reject) => {
        const originalResolve = existing.resolve;
        const originalReject = existing.reject;
        existing.resolve = (value) => {
          originalResolve(value);
          resolve(value);
        };
        existing.reject = (reason) => {
          originalReject(reason);
          reject(reason);
        };
      });
    }

    return new Promise<ExternalAccessResponse>((resolve, reject) => {
      const wasEmpty = pendingQueue.length === 0;
      pendingQueue.push({
        request: {
          id: createId(),
          path: normalized,
          operation,
          ...(workspacePath ? { workspacePath } : {}),
          allowFile,
        },
        resolve,
        reject,
        responding: false,
      });
      syncPending(set);
      if (wasEmpty) publishPermissionWait(true);
    });
  },

  respondToExternalAccess: async (approved, scope) => {
    const entry = pendingQueue[0];
    if (!entry || entry.responding) return;
    entry.responding = true;

    try {
      if (approved) {
        const grantPath =
          scope === 'directory' &&
          (entry.request.operation === 'list' || entry.request.operation === 'execute')
            ? entry.request.path
            : scope === 'directory'
              ? getDirname(entry.request.path)
              : entry.request.path;
        const policy = await invoke<ExternalAccessPolicyPayload>('grant_external_access', {
          workspacePath: entry.request.workspacePath,
          rawPath: grantPath,
          scope,
        });
        applyPolicy(set, policy);
      }

      pendingQueue.shift();
      syncPending(set);
      if (pendingQueue.length === 0) publishPermissionWait(false);
      entry.resolve({ approved, scope });
    } catch (error) {
      pendingQueue.shift();
      syncPending(set);
      if (pendingQueue.length === 0) publishPermissionWait(false);
      entry.reject(error);
    }
  },

  isExternalPathAllowed: (rawPath: string) => {
    const normalized = normalizePathDots(rawPath);
    if (get().yolo) return true;
    const { allowedExternalDirs, allowedExternalFiles } = get();
    for (const dir of allowedExternalDirs) {
      // 平台感知大小写：macOS/Windows 上同一目录的不同大小写写法必须放行
      // （否则用户授权 /Users/example/x 后 /Users/example/x 仍被误拒）。
      if (pathUnderDir(normalized, dir)) return true;
    }
    for (const file of allowedExternalFiles) {
      if (pathsEquivalent(normalized, file)) return true;
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

  clearAllowlist: async () => {
    const policy = await invoke<ExternalAccessPolicyPayload>('clear_external_access_grants');
    applyPolicy(set, policy);
  },
}));
