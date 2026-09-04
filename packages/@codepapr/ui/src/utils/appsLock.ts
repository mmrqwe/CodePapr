/**
 * D-16：应用市场安装锁（参照 skillsLock.ts 先例）。
 *
 * 更新判定曾经的「双事实源」：盘上 manifest.version（作者可能写错/漏 bump）
 * 与 registry listing.version 各写各的，不匹配时「可更新」角标永久失真。
 * 安装/更新时把 listing.version（与逐文件 sha256）写入 .CodePapr/apps-lock.json，
 * 更新判定读锁记录而非盘上 manifest；旧安装（锁文件出现前）回退 manifest 口径。
 */

import { readInstalledAppVersion } from './marketAppVersion';

export const APPS_LOCK_PATH = '.CodePapr/apps-lock.json';

export interface AppLockEntry {
  listingId: string;
  version: string;
  source: string;
  scope: 'global' | 'workspace';
  /** 相对 app 目录的文件路径 → 内容 SHA-256（registry 提供则照抄，否则按内容计算）。 */
  files: Record<string, string>;
  installedAt: number;
}

export interface AppsLockFile {
  version: 1;
  apps: Record<string, AppLockEntry>;
}

export interface AppLockInvoke {
  <T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

export function emptyAppsLock(): AppsLockFile {
  return { version: 1, apps: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseFiles(value: unknown): Record<string, string> {
  const files: Record<string, string> = {};
  if (!isRecord(value)) return files;
  for (const [path, hash] of Object.entries(value)) {
    if (typeof path === 'string' && path.trim() && typeof hash === 'string' && hash.trim()) {
      files[path] = hash;
    }
  }
  return files;
}

function parseEntry(value: unknown): AppLockEntry | null {
  if (!isRecord(value)) return null;
  const listingId = typeof value.listingId === 'string' ? value.listingId.trim() : '';
  const version = typeof value.version === 'string' ? value.version.trim() : '';
  if (!listingId || !version) return null;
  const scope = value.scope === 'global' ? 'global' : 'workspace';
  return {
    listingId,
    version,
    source: typeof value.source === 'string' ? value.source : '',
    scope,
    files: parseFiles(value.files),
    installedAt: typeof value.installedAt === 'number' ? value.installedAt : 0,
  };
}

export function parseAppsLock(raw: string | null | undefined): AppsLockFile {
  if (!raw?.trim()) return emptyAppsLock();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.apps)) return emptyAppsLock();
    const apps: Record<string, AppLockEntry> = {};
    for (const [key, value] of Object.entries(parsed.apps)) {
      const entry = parseEntry(value);
      if (entry) apps[key] = entry;
    }
    return { version: 1, apps };
  } catch {
    return emptyAppsLock();
  }
}

export function serializeAppsLock(lock: AppsLockFile): string {
  return `${JSON.stringify({ version: 1, apps: lock.apps }, null, 2)}\n`;
}

export function upsertAppLockEntry(lock: AppsLockFile, entry: AppLockEntry): AppsLockFile {
  return { version: 1, apps: { ...lock.apps, [entry.listingId]: entry } };
}

export function removeAppFromLock(lock: AppsLockFile, listingId: string): AppsLockFile {
  if (!(listingId in lock.apps)) return lock;
  const apps = { ...lock.apps };
  delete apps[listingId];
  return { version: 1, apps };
}

/**
 * 更新判定读的安装版本事实源：锁记录优先（D-16），旧安装（无锁条目）
 * 回退盘上 manifest.version。
 */
export function effectiveInstalledVersion(
  entry: AppLockEntry | undefined,
  manifestJson?: string | null,
): string {
  return entry?.version?.trim() || readInstalledAppVersion(manifestJson ?? undefined);
}

export async function loadAppsLock(
  invoke: AppLockInvoke,
  workspacePath: string,
): Promise<AppsLockFile> {
  if (!workspacePath) return emptyAppsLock();
  try {
    const result = await invoke<{ content: string }>('read_text_file', {
      workspacePath,
      relativePath: APPS_LOCK_PATH,
      maxBytes: 1_000_000,
    });
    return parseAppsLock(result.content);
  } catch {
    return emptyAppsLock();
  }
}

export async function saveAppsLock(
  invoke: AppLockInvoke,
  workspacePath: string,
  lock: AppsLockFile,
): Promise<void> {
  if (!workspacePath) return;
  await invoke('write_text_file', {
    workspacePath,
    relativePath: APPS_LOCK_PATH,
    content: serializeAppsLock(lock),
  });
}
