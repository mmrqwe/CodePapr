/**
 * task 工具并发槽：同一 JS 领域内最多同时跑 N 个子代理会话。
 * 主线程 uiTaskTool 与 Worker task handler 各自一份模块单例（隔离正确：
 * 两条运行时不会同时执行同一批 task）。
 */

export const TASK_PARALLEL_CONCURRENCY = 4;

export function createTaskSlot(limit: number = TASK_PARALLEL_CONCURRENCY): {
  withTaskSlot: <T>(fn: () => Promise<T>) => Promise<T>;
  activeCount: () => number;
} {
  const max = Math.max(1, limit);
  let active = 0;
  const waiters: Array<() => void> = [];

  const withTaskSlot = async <T>(fn: () => Promise<T>): Promise<T> => {
    while (active >= max) {
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    }
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      const next = waiters.shift();
      next?.();
    }
  };

  return {
    withTaskSlot,
    activeCount: () => active,
  };
}

const defaultSlot = createTaskSlot();

export function withTaskSlot<T>(fn: () => Promise<T>): Promise<T> {
  return defaultSlot.withTaskSlot(fn);
}
