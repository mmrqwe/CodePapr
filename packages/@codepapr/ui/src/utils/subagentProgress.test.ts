import { beforeEach, describe, expect, it } from 'vitest';
import {
  startSubagentProgress,
  completeSubagentProgress,
  clearSubagentProgress,
  getSubagentRuns,
} from './subagentProgress';

beforeEach(() => {
  clearSubagentProgress();
});

describe('subagentProgress 有界裁剪', () => {
  // 回归 #7：runs 数组只增不减会随子代理调用次数无限增长；
  // clear 会把运行中的条目标记完成并裁剪最旧的已完成条目。
  it('caps completed runs while preserving the newest ones', () => {
    for (let i = 0; i < 60; i += 1) {
      startSubagentProgress(`agent-${i}`);
      completeSubagentProgress(`out-${i}`);
    }
    startSubagentProgress('still-running');
    clearSubagentProgress();

    const runs = getSubagentRuns();
    expect(runs).toHaveLength(50);
    // 全部已结算（clear 语义），裁剪保留最新完成的条目（UI 可见的近期记录）
    expect(runs.every((run) => run.state === 'completed')).toBe(true);
    expect(runs[runs.length - 1]?.agent).toBe('still-running');
    expect(runs[0]?.agent).toBe('agent-11');
  });
});
