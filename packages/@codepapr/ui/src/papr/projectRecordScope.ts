/**
 * 看板按「所属项目」过滤记录。数据与插件同目录，隔离靠 workspaceId 字段。
 * 未打标的旧记录不显示在任何项目（避免串台）。
 */
export function normalizeWorkspaceId(path: string | null | undefined): string {
  return String(path ?? '').trim().replace(/[/\\]+$/, '');
}

export function recordWorkspaceId(record: unknown): string {
  if (!record || typeof record !== 'object') return '';
  const rec = record as { workspaceId?: unknown; workspacePath?: unknown };
  return normalizeWorkspaceId(String(rec.workspaceId ?? rec.workspacePath ?? ''));
}

export function eventWorkspaceId(event: unknown): string {
  if (!event || typeof event !== 'object') return '';
  const ev = event as { workspaceId?: unknown; payload?: unknown };
  const tagged = normalizeWorkspaceId(String(ev.workspaceId ?? ''));
  if (tagged) return tagged;
  return recordWorkspaceId(ev.payload);
}

export function belongsToProject(record: unknown, workspaceId: string): boolean {
  const id = normalizeWorkspaceId(workspaceId);
  if (!id) return false;
  return recordWorkspaceId(record) === id;
}

export function eventBelongsToProject(event: unknown, workspaceId: string): boolean {
  const id = normalizeWorkspaceId(workspaceId);
  if (!id) return false;
  const evId = eventWorkspaceId(event);
  if (!evId) return false;
  return evId === id;
}

export function stampRecord<T extends Record<string, unknown>>(
  record: T,
  workspaceId: string,
  workspaceName?: string,
): T & { workspaceId: string; workspaceName: string } {
  return {
    ...record,
    workspaceId: normalizeWorkspaceId(workspaceId),
    workspaceName: workspaceName || String(record.workspaceName ?? ''),
  };
}

export function filterRecords<T>(list: T[] | null | undefined, workspaceId: string): T[] {
  if (!Array.isArray(list)) return [];
  return list.filter((r) => belongsToProject(r, workspaceId));
}

export function filterEvents<T>(list: T[] | null | undefined, workspaceId: string): T[] {
  if (!Array.isArray(list)) return [];
  return list.filter((ev) => eventBelongsToProject(ev, workspaceId));
}

export function mergeProjectSlice<T>(
  all: T[] | null | undefined,
  projectSlice: Array<Record<string, unknown>> | null | undefined,
  workspaceId: string,
  workspaceName?: string,
): Array<T & { workspaceId: string; workspaceName: string }> {
  const id = normalizeWorkspaceId(workspaceId);
  const others = (Array.isArray(all) ? all : []).filter((r) => !belongsToProject(r, id));
  const stamped = (Array.isArray(projectSlice) ? projectSlice : []).map((r) =>
    stampRecord(r, id, workspaceName),
  );
  return [...others, ...stamped] as Array<T & { workspaceId: string; workspaceName: string }>;
}

export function clearedAtForProject(raw: unknown, workspaceId: string): number {
  const id = normalizeWorkspaceId(workspaceId);
  if (!id) return 0;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const n = Number((raw as Record<string, unknown>)[id]);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function writeClearedAt(raw: unknown, workspaceId: string, ts: number): Record<string, number> {
  const id = normalizeWorkspaceId(workspaceId);
  const map =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? { ...(raw as Record<string, number>) }
      : {};
  if (id) map[id] = ts;
  return map;
}
