import type { PaprAppSettings, PaprLevel } from '@codepapr/types';

/**
 * Capabilities granted per permission level. Single source of truth shared by
 * the runtime bridge (usePaprBridge) and app_render validation. The Rust
 * backend keeps an equivalent table in papr_runtime/permission.rs.
 */
export const LEVEL_GRANTS: Record<number, ReadonlySet<string>> = {
  0: new Set(),
  1: new Set(['storage:read', 'storage:write', 'fs:read', 'fs:write', 'agent:run:*', 'workspace:read']),
  2: new Set(['storage:read', 'storage:write', 'fs:read', 'fs:write', 'agent:run:*', 'workspace:read', 'http:get', 'http:post']),
  3: new Set(['storage:read', 'storage:write', 'fs:read', 'fs:write', 'agent:run:*', 'workspace:read', 'http:get', 'http:post', 'workspace:write', 'workspace:exec']),
};

export function levelAllows(level: number, capability: string): boolean {
  const grants = LEVEL_GRANTS[level] ?? LEVEL_GRANTS[1];
  if (grants.has(capability)) return true;
  const prefix = capability.split(':')[0];
  if (grants.has(prefix)) return true;
  if (capability.startsWith('agent:run:')) return grants.has('agent:run:*');
  return false;
}

export function resolveEffectiveLevel(
  manifestLevel: PaprLevel | undefined,
  settings: PaprAppSettings | null,
  appId: string,
): PaprLevel {
  if (!settings) return 1;
  const manifestLvl = (manifestLevel ?? settings.defaultLevel) as PaprLevel;
  const userOverride = settings.appOverrides[appId] as PaprLevel | undefined;
  let effective: PaprLevel = userOverride !== undefined
    ? Math.min(userOverride, manifestLvl) as PaprLevel
    : manifestLvl;
  if (effective >= 3 && !settings.allowLevel3) {
    effective = 2 as PaprLevel;
  }
  return effective;
}

/** Returns the subset of `permissions` that the given level does NOT grant. */
export function disallowedPermissionsForLevel(level: number, permissions: string[]): string[] {
  return permissions.filter((p) => !levelAllows(level, p));
}
