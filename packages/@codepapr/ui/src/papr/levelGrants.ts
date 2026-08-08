import type { PaprAccess, PaprAppSettings, PaprLevel, PaprLocalAccess, PaprManifest } from '@codepapr/types';
export type { PaprAccess, PaprLocalAccess };

/**
 * 两轴权限模型：local（无/只读/读写执行）× network（关/开）。
 * 单一声明源，供运行时桥（usePaprBridge）、app_render 校验、worker 工具过滤共用。
 * Rust 后端在 papr_runtime/permission.rs 维护等价表。
 */

export const LOCAL_ORDER: PaprLocalAccess[] = ['none', 'read', 'write'];

function localRank(local: PaprLocalAccess): number {
  return LOCAL_ORDER.indexOf(local);
}

/** 旧四档等级 → 两轴映射（仅老 manifest 迁移）：L0→{无,关} L1→{只读,关} L2→{只读,开} L3→{读写,开} */
export function legacyLevelToAccess(level: number | undefined): PaprAccess {
  switch (level ?? 1) {
    case 0:
      return { local: 'none', network: false };
    case 1:
      return { local: 'read', network: false };
    case 2:
      return { local: 'read', network: true };
    default:
      return { local: 'write', network: true };
  }
}

/** 两轴 → 旧等级（manifest 兼容字段用）：{无,关}→0 {只读,关}→1 {只读,开}→2 {读写,*}→3 */
export function legacyAccessToLevel(access: PaprAccess): PaprLevel {
  if (access.local === 'write') return 3;
  if (access.local === 'read') return access.network ? 2 : 1;
  return 0;
}

/** 两轴取交集（用户覆盖只能收窄，不能放大）。 */
export function intersectAccess(a: PaprAccess, b: PaprAccess): PaprAccess {
  return {
    local: localRank(a.local) < localRank(b.local) ? a.local : b.local,
    network: a.network && b.network,
  };
}

/** manifest 声明的两轴访问；缺省回落到用户全局默认。 */
export function manifestAccess(
  manifest: PaprManifest | null,
  settings: PaprAppSettings | null,
): PaprAccess {
  if (manifest?.local) {
    return { local: manifest.local, network: manifest.network === true };
  }
  if (manifest?.level !== undefined) {
    return legacyLevelToAccess(manifest.level);
  }
  return {
    local: settings?.defaultLocal ?? 'none',
    network: settings?.defaultNetwork ?? false,
  };
}

/** 生效访问 = manifest 声明 ∩ 用户逐 app 覆盖（覆盖只能收窄）。 */
export function resolveEffectiveAccess(
  manifest: PaprManifest | null,
  settings: PaprAppSettings | null,
  appId: string,
): PaprAccess {
  const declared = manifestAccess(manifest, settings);
  const override = settings?.appOverrides[appId];
  return override ? intersectAccess(override, declared) : declared;
}

/** papr SDK 能力检查（两轴）：storage/fs 永远允许，http 需网络轴，agent 需 manifest 声明。 */
export function accessAllows(access: PaprAccess, capability: string, manifest: PaprManifest | null): boolean {
  if (capability.startsWith('http:')) return access.network;
  if (capability.startsWith('agent:run:')) {
    const name = capability.slice('agent:run:'.length);
    return manifest?.agents?.some((a) => a.name === name) ?? false;
  }
  if (capability.startsWith('storage:') || capability.startsWith('fs:')) return true;
  return false;
}

/** app agent 内置工具（papr.agent.run）按两轴推导的可用工具集。 */
export function agentToolsFor(local: PaprLocalAccess, network: boolean): Set<string> {
  const tools = new Set<string>(['todo', 'local_time_now']);
  if (localRank(local) >= 1) {
    for (const t of ['read', 'grep', 'list', 'lsp', 'diagnostics', 'read_image', 'skill_load']) {
      tools.add(t);
    }
  }
  if (localRank(local) >= 2) {
    for (const t of ['write', 'edit', 'patch', 'bash']) {
      tools.add(t);
    }
  }
  if (network) {
    tools.add('websearch');
    tools.add('webfetch');
  }
  return tools;
}

/** 工具所需的最低两轴门槛；null 表示该工具在 app agent 中永不可用。 */
export function minAccessForAgentTool(toolName: string): { local: PaprLocalAccess; network: boolean } | null {
  const byTool: Record<string, { local: PaprLocalAccess; network: boolean }> = {
    todo: { local: 'none', network: false },
    local_time_now: { local: 'none', network: false },
    read: { local: 'read', network: false },
    grep: { local: 'read', network: false },
    list: { local: 'read', network: false },
    lsp: { local: 'read', network: false },
    diagnostics: { local: 'read', network: false },
    read_image: { local: 'read', network: false },
    skill_load: { local: 'read', network: false },
    write: { local: 'write', network: false },
    edit: { local: 'write', network: false },
    patch: { local: 'write', network: false },
    bash: { local: 'write', network: false },
    websearch: { local: 'none', network: true },
    webfetch: { local: 'none', network: true },
  };
  return byTool[toolName] ?? null;
}

/** 判断 access 是否满足工具门槛。 */
export function accessMeetsTool(access: PaprAccess, toolName: string): boolean {
  const required = minAccessForAgentTool(toolName);
  if (!required) return false;
  if (localRank(access.local) < localRank(required.local)) return false;
  if (required.network && !access.network) return false;
  return true;
}
