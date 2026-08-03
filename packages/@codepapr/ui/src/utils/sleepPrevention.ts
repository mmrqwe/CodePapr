/**
 * 引用计数式防休眠：Agent 回合进行中阻止系统空闲休眠。
 *
 * macOS 空闲休眠会挂起 WKWebView Web Content 进程，休眠/唤醒循环中 WebKit
 * 会静默杀掉 Web Worker（无 JS 错误事件），导致 Agent 回合中途丢失。
 * 因此回合进行中持有电源断言（Rust 侧 IOPMAssertion，仅阻止空闲休眠，
 * 合盖仍会睡）；回合结束释放。多个持有者（聊天回合、App Agent 运行）可
 * 重叠：首个 acquire 创建断言，最后一个 release 才真正释放。
 *
 * 全部 best-effort：命令失败（非桌面环境 / 旧后端）静默忽略，绝不影响主流程。
 */
import { invoke } from '@tauri-apps/api/core';

let holders = 0;

export async function acquireSleepPrevention(): Promise<void> {
  holders += 1;
  if (holders === 1) {
    try {
      await invoke('prevent_idle_sleep');
    } catch {
      // best-effort
    }
  }
}

export async function releaseSleepPrevention(): Promise<void> {
  if (holders <= 0) {
    return;
  }
  holders -= 1;
  if (holders === 0) {
    try {
      await invoke('allow_idle_sleep');
    } catch {
      // best-effort
    }
  }
}

/** Test/inspection helper: current number of active holders. */
export function sleepPreventionHolders(): number {
  return holders;
}

/** Test helper: reset module state. */
export function resetSleepPreventionForTest(): void {
  holders = 0;
}
