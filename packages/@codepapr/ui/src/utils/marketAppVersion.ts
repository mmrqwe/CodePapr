/** Compare dotted app versions (`1.2.3`). Missing / unparsable segments count as 0. */
export function compareAppVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d > 0) return 1;
    if (d < 0) return -1;
  }
  return 0;
}

function parseVersion(raw: string): number[] {
  return String(raw ?? '')
    .trim()
    .split(/[.+-]/)
    .map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
}

export function readInstalledAppVersion(manifestJson: string | undefined): string {
  if (!manifestJson) return '';
  try {
    const parsed = JSON.parse(manifestJson) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version.trim() : '';
  } catch {
    return '';
  }
}

/** True when the marketplace listing is newer than the copy on disk. */
export function isMarketUpdateAvailable(installedVersion: string, marketVersion: string): boolean {
  const market = marketVersion.trim();
  if (!market) return false;
  const installed = installedVersion.trim();
  if (!installed) return true;
  return compareAppVersions(market, installed) > 0;
}
