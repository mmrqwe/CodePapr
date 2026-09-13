import { beforeEach, describe, expect, it } from 'vitest';
import {
  startSubagentProgress,
  completeSubagentProgress,
  finalizeSubagentRunsForRequest,
  finalizeSubagentRunsForSession,
  resetSubagentProgress,
  getSubagentRuns,
  getSubagentRunsForSession,
  pushSubagentStep,
  toggleSubagentCollapse,
} from './subagentProgress';

beforeEach(() => {
  resetSubagentProgress();
});

describe('subagentProgress 完成即移除', () => {
  it('complete 后条目从面板数据中消失，不留下已完成残留', () => {
    for (let i = 0; i < 60; i += 1) {
      const id = startSubagentProgress(`agent-${i}`);
      completeSubagentProgress(id);
    }
    startSubagentProgress('still-running');

    const runs = getSubagentRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.agent).toBe('still-running');
  });

  it('重复 start 帧（同 runId）复用条目，complete 一次即清空', () => {
    const first = startSubagentProgress('mentor', 'a', 'dup-id');
    const second = startSubagentProgress('mentor', 'a', 'dup-id');
    expect(second).toBe(first);
    expect(getSubagentRuns()).toHaveLength(1);

    completeSubagentProgress('dup-id');
    expect(getSubagentRuns()).toHaveLength(0);
  });
});

describe('subagentProgress 默认折叠', () => {
  it('新建 run 默认折叠，toggle 后才展开', () => {
    const runId = startSubagentProgress('explore', '查找入口', undefined, 's1');

    expect(getSubagentRuns()[0]?.collapsed).toBe(true);

    toggleSubagentCollapse(runId);
    expect(getSubagentRuns()[0]?.collapsed).toBe(false);

    toggleSubagentCollapse(runId);
    expect(getSubagentRuns()[0]?.collapsed).toBe(true);
  });
});

describe('subagentProgress runId 隔离', () => {
  it('并行 run 的 step 不会串到另一条', () => {
    const first = startSubagentProgress('explore', 'a');
    const second = startSubagentProgress('scout', 'b');
    pushSubagentStep(second, { name: 'websearch', status: 'success', summary: 'ok' });
    completeSubagentProgress(first);

    const runs = getSubagentRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.agent).toBe('scout');
    expect(runs[0]?.steps.map((step) => step.name)).toEqual(['websearch']);
  });
});

describe('subagentProgress 兜底收尾', () => {
  it('finalizeSubagentRunsForRequest 清掉指定回合的在飞条目', () => {
    const doomed = startSubagentProgress('mentor', 'a', undefined, 's1', 'req-1');
    startSubagentProgress('explore', 'b', undefined, 's1', 'req-2');

    finalizeSubagentRunsForRequest('req-1');

    const runs = getSubagentRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).not.toBe(doomed);
    expect(runs[0]?.agent).toBe('explore');
  });

  it('finalizeSubagentRunsForSession 只清指定会话的条目', () => {
    startSubagentProgress('mentor', 'a', undefined, 'session-old');
    startSubagentProgress('mentor', 'b', undefined, 'session-new');

    finalizeSubagentRunsForSession('session-old');

    const runs = getSubagentRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.prompt).toBe('b');
  });

  it('complete 帧丢失时，回合结算兜底杜绝「永远正在思考」', () => {
    startSubagentProgress('mentor', '架构评审', 'lost-frame', 's1', 'req-1');
    expect(getSubagentRunsForSession('s1')).toHaveLength(1);

    // worker 没有发出 complete（丢帧/被强杀），result 帧到达触发兜底：
    finalizeSubagentRunsForRequest('req-1');
    expect(getSubagentRunsForSession('s1')).toHaveLength(0);
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

  it('mentor 结束后新会话与旧会话都看不到残留', () => {
    const runId = startSubagentProgress('mentor', '架构评审', undefined, 'session-old');
    completeSubagentProgress(runId);

    expect(getSubagentRunsForSession('session-old')).toHaveLength(0);
    expect(getSubagentRunsForSession('session-new')).toEqual([]);
  });
});
