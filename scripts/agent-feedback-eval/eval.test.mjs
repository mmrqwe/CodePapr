#!/usr/bin/env node
/**
 * 评估引擎自身的确定性单测（离线、零真实调用）。
 * metrics/report 是"给 agent 打分的尺"——尺必须比被测量更可靠。
 * 运行：npm run eval:units
 */
import { describe, expect, it } from 'vitest';
import { computeMetrics } from './lib/metrics.mjs';
import { aggregate, diffAgainstBaseline, overallPassRate } from './lib/report.mjs';

const ev = (o) => o;
function fakeRun(events, { exitCode = 0, after = {} } = {}) {
  return { exitCode, events, after, elapsedMs: 1000 };
}
function seq(calls) {
  const events = [];
  for (const c of calls) {
    events.push(ev({ type: 'tool.start', toolCallId: c.id, toolName: c.name, arguments: c.args ?? {} }));
    events.push(
      ev({
        type: 'tool.end',
        toolCallId: c.id,
        toolName: c.name,
        success: c.ok !== false,
        ...(c.err ? { errorPreview: c.err } : {}),
        ...(c.out ? { outputPreview: c.out } : {}),
      })
    );
  }
  events.push(ev({ type: 'message.end', round: calls.length, hasToolCalls: true }));
  return events;
}

describe('metrics: 反馈闭环六尺', () => {
  it('健康单调用 → pass，firstCallSuccess', () => {
    const run = fakeRun(seq([{ id: '1', name: 'read', args: { p: 'a' } }]));
    const m = computeMetrics(run, { budgetRounds: 10 });
    expect(m.pass).toBe(true);
    expect(m.firstCallSuccess).toBe(true);
    expect(m.hadError).toBe(false);
  });

  it('死循环：同 tool+args 连续 3 次才计，2 次不算', () => {
    const a = { id: 'x', name: 'edit', args: { s: 'q' }, ok: false };
    const loop3 = seq([a, { ...a, id: 'y' }, { ...a, id: 'z' }]);
    expect(computeMetrics(fakeRun(loop3), { budgetRounds: 50 }).deadLoops).toBe(1);
    const loop2 = seq([a, { ...a, id: 'y' }, { id: 'w', name: 'read' }]);
    expect(computeMetrics(fakeRun(loop2), { budgetRounds: 50 }).deadLoops).toBe(0);
  });

  it('死循环即使状态检查通过也一票否决', () => {
    const a = { id: 'x', name: 'bash', args: { c: 'git' }, ok: false };
    const run = fakeRun(seq([a, { ...a, id: 'y' }, { ...a, id: 'z' }]));
    expect(computeMetrics(run, { budgetRounds: 50, assert: () => true }).pass).toBe(false);
  });

  it('fallbackQuality：错误后改道 → true；改到错误后但成功调用在错误之前（先对后试错）→ 也 true', () => {
    const after = fakeRun(seq([
      { id: '1', name: 'bash', args: {}, ok: false, err: 'blocked, use grep 工具' },
      { id: '2', name: 'grep', args: {}, ok: true },
    ]));
    expect(computeMetrics(after, { budgetRounds: 10, expectToolAfterError: 'grep' }).fallbackQuality).toBe(true);

    const before = fakeRun(seq([
      { id: '1', name: 'grep', args: {}, ok: true },
      { id: '2', name: 'bash', args: {}, ok: false, err: 'blocked' },
      { id: '3', name: 'read', args: {}, ok: true },
    ]));
    const m = computeMetrics(before, { budgetRounds: 10, expectToolAfterError: 'grep' });
    expect(m.fallbackQuality).toBe(true);
    expect(m.pass).toBe(true);
  });

  it('fallbackQuality=false 直接否决（撞墙后无视引导）', () => {
    const run = fakeRun(seq([
      { id: '1', name: 'bash', args: {}, ok: false, err: 'use grep' },
      { id: '2', name: 'read', args: {}, ok: true },
    ]));
    const m = computeMetrics(run, { budgetRounds: 10, expectToolAfterError: 'grep' });
    expect(m.fallbackQuality).toBe(false);
    expect(m.pass).toBe(false);
  });

  it('超时（exit 2）一票否决', () => {
    const run = fakeRun(seq([{ id: '1', name: 'read' }]), { exitCode: 2 });
    expect(computeMetrics(run, { budgetRounds: 10 }).pass).toBe(false);
  });

  it('contextPollution 取单次输出峰值', () => {
    const run = fakeRun(seq([
      { id: '1', name: 'bash', out: 'x'.repeat(500) },
      { id: '2', name: 'read', out: 'y'.repeat(2049) },
    ]));
    expect(computeMetrics(run, { budgetRounds: 10 }).contextPollutionChars).toBe(2049);
  });

  it('rounds 超预算否决', () => {
    const run = fakeRun([{ type: 'message.end', round: 12 }, { type: 'message.end', round: 21 }]);
    expect(computeMetrics(run, { budgetRounds: 10 }).pass).toBe(false);
  });
});

describe('report: L3 聚合与回归判定', () => {
  const mkRow = (scenario, model, pass, rounds = 4) => ({
    scenario,
    model,
    metrics: {
      pass, rounds, toolCallCount: 3, errorCount: 0, firstCallSuccess: pass,
      deadLoops: 0, contextPollutionChars: 100,
    },
  });

  it('aggregate 计算 passRate 与均值', () => {
    const cells = aggregate([
      mkRow('s1', 'm1', true), mkRow('s1', 'm1', true), mkRow('s1', 'm1', false),
    ]);
    expect(cells[0].passRate).toBeCloseTo(2 / 3);
    expect(cells[0].count).toBe(3);
  });

  it('baseline diff：>5% 下滑判 REGRESSION，5% 以内不判', () => {
    const baseline = { cells: [{ scenario: 's1', model: 'm1', passRate: 0.8, count: 5, passed: 4 }] };
    const cur = (rate) => [{ scenario: 's1', model: 'm1', passRate: rate, count: 5, passed: rate * 5 }];
    expect(diffAgainstBaseline(cur(0.6), baseline)[0].verdict).toBe('REGRESSION');
    expect(diffAgainstBaseline(cur(0.75), baseline)[0].verdict).not.toBe('REGRESSION');
    expect(diffAgainstBaseline(cur(0.4), { cells: [] })[0].verdict).toBe('new');
  });

  it('overallPassRate 按 run 加权', () => {
    const rate = overallPassRate([
      { count: 5, passed: 5 }, { count: 5, passed: 0 },
    ]);
    expect(rate).toBe(0.5);
  });
});
