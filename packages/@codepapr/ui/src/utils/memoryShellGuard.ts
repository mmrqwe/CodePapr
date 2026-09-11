/**
 * memoryShellGuard（P2-4）：非 macOS 平台上 Agent exec/bash 改写 MEMORY.md 的兜底。
 *
 * macOS：sandbox-exec profile 对 `.CodePapr` 整树 deny file-write*（内核级），
 * Agent 无法通过 shell 改写记忆文件，本守卫直接短路。
 * Windows/Linux：进程级沙箱不生效，词法闸门（assertShellCodePaprAccess）可被
 * 构造路径绕过。本守卫在命令执行前后比对文件内容：内容被非受信通道改动则用
 * 单飞写队列回滚原内容，并把拦截注记合并进工具结果。
 *
 * 竞态归因：受信写入（curator / 面板）都会推进 memoryFile.getMemoryMdWriteSeq。
 * 命令执行期间序号前进 = 合法写入赢得竞态，不恢复——否则会把用户在命令执行
 * 期间的面板保存回滚掉。
 */

import {
  getMemoryMdWriteSeq,
  readMemoryMd,
  requestMemoryMdWrite,
} from './memoryFile';
import { sandboxEnforcedOnThisPlatform } from './platformSandbox';

export const MEMORY_SHELL_GUARD_NOTE =
  '[memory-guard] 检测到 shell 命令改动了 .CodePapr/MEMORY.md，已回滚——该文件仅由记忆管家与用户在记忆面板维护。';

export interface MemoryShellGuardResult<T> {
  result: T;
  /** 检测到越权改动并已成功回滚（调用方应把注记附进工具结果）。 */
  intercepted: boolean;
}

/**
 * 包住一次前台命令执行。命令抛错时不做事后比对（没有成功返回=没有可归因的
 * 写入窗口）；平台沙箱已强制或工作区为空时零额外 IPC。
 */
export async function runWithMemoryShellGuard<T>(
  workspacePath: string,
  run: () => Promise<T>,
  platform?: string
): Promise<MemoryShellGuardResult<T>> {
  const workspace = workspacePath.trim();
  if (!workspace || sandboxEnforcedOnThisPlatform(platform)) {
    return { result: await run(), intercepted: false };
  }
  const seqBefore = getMemoryMdWriteSeq();
  const before = await readMemoryMd(workspace);
  const result = await run();
  if (getMemoryMdWriteSeq() !== seqBefore) {
    return { result, intercepted: false };
  }
  const after = await readMemoryMd(workspace);
  if (after === before) {
    return { result, intercepted: false };
  }
  if (before === null) {
    // 命令新建了文件。before===null 既可能是「本就不存在」也可能是瞬时读取
    // 失败，无法安全判定来源；回滚意味着删除，误判会丢用户数据——只告警。
    if (after !== null) {
      console.warn(
        '[memory-shell-guard] shell 命令新建了 .CodePapr/MEMORY.md；非 macOS 平台无进程级沙箱，未回滚（请检查该文件内容）'
      );
    }
    return { result, intercepted: false };
  }
  const restore = await requestMemoryMdWrite(workspace, before, {
    expectedContent: after,
    origin: 'guard',
  });
  if (!restore.ok) {
    console.warn('[memory-shell-guard] 越权写回滚失败:', restore.reasons.join(','));
    return { result, intercepted: false };
  }
  return { result, intercepted: true };
}

/** 把拦截注记合并进命令结果（stderr 优先，其次 stdout；非对象原样返回）。 */
export function attachMemoryGuardNote<T>(result: T, note: string = MEMORY_SHELL_GUARD_NOTE): T {
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    const field =
      typeof record.stderr === 'string' ? 'stderr' : typeof record.stdout === 'string' ? 'stdout' : null;
    if (field) {
      const existing = record[field] as string;
      return { ...record, [field]: existing ? `${existing}\n${note}` : note } as T;
    }
  }
  return result;
}
