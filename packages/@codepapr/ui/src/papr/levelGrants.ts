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

/**
 * Built-in tools an app agent (papr.agent.run) may use at each level. Single
 * source of truth shared by the worker's handleRunAppAgent registry filter and
 * app_render validation (which rejects manifests declaring tools the level
 * does not grant, instead of silently stripping them at runtime).
 */
export const APP_AGENT_LEVEL_TOOLS: Record<number, ReadonlySet<string>> = {
  0: new Set(),
  1: new Set(['read', 'grep', 'list', 'lsp', 'diagnostics', 'read_image', 'skill_load', 'todo', 'local_time_now']),
  2: new Set(['read', 'grep', 'list', 'lsp', 'diagnostics', 'read_image', 'skill_load', 'todo', 'local_time_now', 'websearch', 'webfetch']),
  3: new Set(['read', 'grep', 'list', 'lsp', 'diagnostics', 'read_image', 'skill_load', 'todo', 'local_time_now', 'websearch', 'webfetch', 'write', 'edit', 'patch', 'bash']),
};

/** Lowest level granting the tool, or null when the tool is never available. */
export function minLevelForAgentTool(toolName: string): number | null {
  for (const level of [0, 1, 2, 3]) {
    if (APP_AGENT_LEVEL_TOOLS[level]?.has(toolName)) return level;
  }
  return null;
}

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
