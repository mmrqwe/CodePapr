export interface InsightCacheSettings {
  insightMaxDepth: number;
  insightMaxSourceFiles: number;
  insightMaxFileBytes: number;
  insightMaxSymbols: number;
  insightMaxEdges: number;
  insightMaxTreeEntries: number;
}

export interface InsightCacheEntry {
  path: string;
  isDir: boolean;
  bytes: number;
  mtimeMs?: number;
}

export function hash32(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

export function computeInsightCacheKey(
  workspacePath: string,
  entries: readonly InsightCacheEntry[],
  settings: InsightCacheSettings,
  contentFingerprint: string = '',
): string {
  const entrySummary = [...entries]
    .map((entry) => `${entry.path}\0${entry.isDir ? 'd' : 'f'}\0${entry.bytes}\0${entry.mtimeMs ?? 0}`)
    .sort()
    .join('\n');
  return [
    workspacePath,
    String(entries.length),
    String(settings.insightMaxDepth),
    String(settings.insightMaxSourceFiles),
    String(settings.insightMaxFileBytes),
    String(settings.insightMaxSymbols),
    String(settings.insightMaxEdges),
    String(settings.insightMaxTreeEntries),
    hash32(entrySummary),
    hash32(contentFingerprint),
  ].join('|');
}
