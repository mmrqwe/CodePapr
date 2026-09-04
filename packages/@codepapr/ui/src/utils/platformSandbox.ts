import type { PaprAccess } from '@codepapr/types';
import { detectPlatform } from './pathComparison';

/**
 * C-5：两轴沙箱（network:false / local≤read）的进程级强制目前仅 macOS
 * （sandbox-exec）实现。Windows/Linux 上 bash/后端进程实际不受限，UI 若按
 * 「完全断网/只读」呈现即虚假承诺——检测到收窄档时必须向用户推告警。
 * 完整跨平台沙箱另立项。
 */
export function sandboxEnforcedOnThisPlatform(platform: string = detectPlatform()): boolean {
  return platform === 'darwin';
}

export function platformSandboxWarning(
  access: Pick<PaprAccess, 'local' | 'network'>,
  platform: string = detectPlatform(),
): string | null {
  if (sandboxEnforcedOnThisPlatform(platform)) return null;
  const narrowed: string[] = [];
  if (!access.network) narrowed.push('断网（network:false）');
  if (access.local !== 'write') narrowed.push('工作区只读（local≤read）');
  if (narrowed.length === 0) return null;
  return `进程级沙箱仅 macOS 生效：该应用声明的 ${narrowed.join(' + ')} 在当前平台无法强制执行，其 bash/后端进程实际不受此限制（CSP 只约束 iframe 内 JS，管不到进程层）。请自行评估风险。`;
}
