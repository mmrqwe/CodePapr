import type { WorkspaceEntry } from './types';
import { pathsEquivalent } from '../../utils/pathComparison';

export function upsertRecentWorkspace(
  recent: WorkspaceEntry[],
  path: string,
): WorkspaceEntry[] {
  const normalizedPath = path.trim();
  if (!normalizedPath) {
    return recent;
  }
  const name = normalizedPath.split(/[\\/]/).filter(Boolean).pop() ?? normalizedPath;
  // 平台感知大小写去重：macOS/Windows 上同目录的不同大小写写法是同一目录，
  // 不应产生两条 recent 记录。
  const existingIndex = recent.findIndex((entry) => pathsEquivalent(entry.path, normalizedPath));
  const now = Date.now();
  if (existingIndex >= 0) {
    const entry = recent[existingIndex];
    const updated = { ...entry, name: name || entry.name, lastOpenedAt: now, path: normalizedPath };
    const rest = recent.filter((_, i) => i !== existingIndex);
    return [updated, ...rest];
  }
  const newEntry: WorkspaceEntry = { path: normalizedPath, name, lastOpenedAt: now, pinned: false };
  return [newEntry, ...recent].slice(0, 10);
}

export function sortRecentWorkspaces(recent: WorkspaceEntry[]): WorkspaceEntry[] {
  const pinned = recent.filter((e) => e.pinned);
  const unpinned = recent.filter((e) => !e.pinned);
  unpinned.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  return [...pinned, ...unpinned];
}
