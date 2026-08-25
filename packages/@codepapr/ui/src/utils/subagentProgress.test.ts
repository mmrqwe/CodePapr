import { beforeEach, describe, expect, it } from 'vitest';
import {
  startSubagentProgress,
  completeSubagentProgress,
  clearSubagentProgress,
  resetSubagentProgress,
  getSubagentRuns,
  getSubagentRunsForSession,
  pushSubagentStep,
} from './subagentProgress';

beforeEach(() => {
  resetSubagentProgress();
});

describe('subagentProgress 有界裁剪', () => {
  // 回归 #7：runs 数组只增不减会随子代理调用次数无限增长；
  // clear 会把运行中的条目标记完成并裁剪最旧的已完成条目。
  it('caps completed runs while preserving the newest ones', () => {
    for (let i = 0; i < 60; i += 1) {
      const id = startSubagentProgress(`agent-${i}`);
      completeSubagentProgress(id, `out-${i}`);
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

describe('subagentProgress runId 隔离', () => {
  it('并行 run 的 step 不会串到另一条', () => {
    const first = startSubagentProgress('explore', 'a');
    const second = startSubagentProgress('scout', 'b');
    pushSubagentStep(second, { name: 'websearch', status: 'success', summary: 'ok' });
    completeSubagentProgress(first, 'explore-done');

    const runs = getSubagentRuns();
    expect(runs).toHaveLength(2);
    expect(runs[0]?.agent).toBe('explore');
    expect(runs[0]?.steps).toEqual([]);
    expect(runs[0]?.state).toBe('completed');
    expect(runs[1]?.agent).toBe('scout');
    expect(runs[1]?.steps.map((step) => step.name)).toEqual(['websearch']);
    expect(runs[1]?.state).toBe('running');
  });
});

describe('subagentProgress 会话隔离', () => {
  it('getSubagentRunsForSession 只返回带匹配 sessionId 的条目', () => {
    startSubagentProgress('mentor', 'old', undefined, 'session-a');
    startSubagentProgress('explore', 'new', undefined, 'session-b');
    startSubagentProgress('scout', 'untagged');

    expect(getSubagentRunsForSession('session-a').map((run) => run.agent)).toEqual(['mentor']);
    expect(getSubagentRunsForSession('session-b').map((run) => run.agent)).toEqual(['explore']);
    expect(getSubagentRunsForSession(null)).toEqual([]);
    expect(getSubagentRuns()).toHaveLength(3);
  });

  it('新会话 id 看不到上一会话已完成的 mentor 条目', () => {
    const runId = startSubagentProgress('mentor', '架构评审', undefined, 'session-old');
    completeSubagentProgress(runId, 'done');

    expect(getSubagentRunsForSession('session-old')).toHaveLength(1);
    expect(getSubagentRunsForSession('session-new')).toEqual([]);
  });
});
