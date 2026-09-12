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
  /** 缺省 'externalPath'。'dangerousCommand'：高危命令一次性确认
   *  （path 承载命令文本；批准只对当次调用生效，绝不产生持久授权）。 */
  kind?: 'externalPath' | 'dangerousCommand';
  /** dangerousCommand 专用：完整命令行与风险说明（弹窗展示）。 */
  command?: string;
  reason?: string;
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
  /** 该请求绑定了工具执行的 AbortSignal：取消时由 signal 的 abort 监听器
   *  按请求精确回收，跨运行的全局取消（cancelSession/cancelAppAgent）不得
   *  连带拒绝它——只有无绑定的请求才走全局取消兜底。 */
  trackedBySignal: boolean;
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
    signal?: AbortSignal,
  ) => Promise<ExternalAccessResponse>;
  respondToExternalAccess: (
    approved: boolean,
    scope: 'directory' | 'file',
  ) => Promise<void>;
  requestDangerousCommand: (
    command: string,
    reason: string,
    workspacePath?: string,
    signal?: AbortSignal,
  ) => Promise<boolean>;
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

/** 取消排队中的外部访问请求。
 *
 *  默认（destroy/完整 cancel）：全部拒绝。
 *  `onlyUntracked: true`（cancelSession/cancelAppAgent 等按运行取消）：
 *  只拒绝未绑定工具 AbortSignal 的请求——绑定了 signal 的请求属于仍在
 *  运行的其它执行（聊天回合与 papr app-agent 可并发），由各自的 signal
 *  abort 时精确回收，全局取消不得连带误伤。 */
export function cancelExternalAccessRequests(
  reason: unknown = new DOMException('权限请求已取消', 'AbortError'),
  options?: { onlyUntracked?: boolean },
): void {
  const removed: PendingExternalRequest[] = [];
  if (options?.onlyUntracked) {
    const kept: PendingExternalRequest[] = [];
    for (const entry of pendingQueue.splice(0)) {
      if (entry.trackedBySignal) {
        kept.push(entry);
      } else {
        removed.push(entry);
      }
    }
    pendingQueue.push(...kept);
  } else {
    removed.push(...pendingQueue.splice(0));
  }
  if (removed.length === 0) return;
  usePermissionStore.setState({ pendingRequest: currentPendingRequest() });
  if (pendingQueue.length === 0) publishPermissionWait(false);
  for (const entry of removed) {
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
    signal?: AbortSignal,
  ) => {
    const abortReason = () =>
      signal?.reason instanceof Error
        ? signal.reason
        : new DOMException('权限请求已取消', 'AbortError');
    const normalized = normalizePathDots(rawPath);
    const existing = pendingQueue.find(
      (entry) =>
        entry.request.kind !== 'dangerousCommand' &&
        entry.request.path === normalized &&
        entry.request.operation === operation,
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
        // 并入已有请求的调用方：自己的 signal abort 只拒绝自己的 promise，
        // 不得影响队列条目（它还服务其它执行）。
        if (signal) {
          if (signal.aborted) {
            reject(abortReason());
            return;
          }
          signal.addEventListener('abort', () => reject(abortReason()), { once: true });
        }
      });
    }

    return new Promise<ExternalAccessResponse>((resolve, reject) => {
      const wasEmpty = pendingQueue.length === 0;
      const entry: PendingExternalRequest = {
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
        trackedBySignal: signal !== undefined,
      };
      pendingQueue.push(entry);
      if (signal) {
        if (signal.aborted) {
          pendingQueue.pop();
          reject(abortReason());
          return;
        }
        // 工具执行被取消（会话取消 / app-agent 取消 / 工具超时）时按请求
        // 精确回收：移出队列并拒绝，不影响其它执行的排队请求。
        signal.addEventListener(
          'abort',
          () => {
            const index = pendingQueue.indexOf(entry);
            if (index === -1) return;
            pendingQueue.splice(index, 1);
            syncPending(set);
            if (pendingQueue.length === 0) publishPermissionWait(false);
            reject(abortReason());
          },
          { once: true },
        );
      }
      syncPending(set);
      if (wasEmpty) publishPermissionWait(true);
    });
  },

  requestDangerousCommand: (command, reason, workspacePath, signal) => {
    const abortReason = () =>
      signal?.reason instanceof Error
        ? signal.reason
        : new DOMException('权限请求已取消', 'AbortError');
    return new Promise<boolean>((resolve, reject) => {
      const wasEmpty = pendingQueue.length === 0;
      const entry: PendingExternalRequest = {
        request: {
          id: createId(),
          path: command,
          operation: 'execute',
          kind: 'dangerousCommand',
          command,
          reason,
          allowFile: false,
          ...(workspacePath ? { workspacePath } : {}),
        },
        // 高危命令确认是一次性的：对外复用 respond 通道，但只暴露批准与否。
        resolve: (value) => resolve(value.approved),
        reject,
        responding: false,
        trackedBySignal: signal !== undefined,
      };
      pendingQueue.push(entry);
      if (signal) {
        if (signal.aborted) {
          pendingQueue.pop();
          reject(abortReason());
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            const index = pendingQueue.indexOf(entry);
            if (index === -1) return;
            pendingQueue.splice(index, 1);
            syncPending(set);
            if (pendingQueue.length === 0) publishPermissionWait(false);
            reject(abortReason());
          },
          { once: true },
        );
      }
      syncPending(set);
      if (wasEmpty) publishPermissionWait(true);
    });
  },

  respondToExternalAccess: async (approved, scope) => {
    const entry = pendingQueue[0];
    if (!entry || entry.responding) return;
    entry.responding = true;

    try {
      // dangerousCommand 的一次性确认绝不落盘持久授权（grant 仅外部路径）。
      if (approved && entry.request.kind !== 'dangerousCommand') {
        let grantScope: 'directory' | 'file' = scope;
        let grantPath: string;
        if (
          scope === 'directory' &&
          (entry.request.operation === 'list' || entry.request.operation === 'execute')
        ) {
          grantPath = entry.request.path;
        } else if (scope === 'directory') {
          const dir = getDirname(entry.request.path);
          if (dir === '/') {
            // 根目录直属文件：「允许此文件夹」等价于授予整个文件系统根，
            // 一次点击的授权面过大，降级为仅授予该文件本身。
            grantScope = 'file';
            grantPath = entry.request.path;
          } else {
            grantPath = dir;
          }
        } else {
          grantPath = entry.request.path;
        }
        const policy = await invoke<ExternalAccessPolicyPayload>('grant_external_access', {
          workspacePath: entry.request.workspacePath,
          rawPath: grantPath,
          scope: grantScope,
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
      // （否则用户授权 /Users/EXAMPLE/x 后 /Users/example/x 仍被误拒）。
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
