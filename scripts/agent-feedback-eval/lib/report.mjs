#!/usr/bin/env node
/**
 * L3 回归仪表盘：把一轮评估的原始 run 结果聚合成"版本 x 模型 x 场景"的
 * 指标，并与 committed baseline 做阈值 diff（通过率下滑 > 5% 判红）。
 *
 * LLM 是随机的：单跑无意义，聚合看 passRate 均值；红线只卡"整体通过率"
 * 与"死循环回归"，避免偶发抖动误伤。
 */

export const PASS_RATE_DROP_THRESHOLD = 0.05; // 相对 baseline 的绝对下滑红线

/** 聚合：key = `${scenario}|${model}` → {count, passed, passRate, 各指标均值}。 */
export function aggregate(rows) {
  const buckets = new Map();
  for (const r of rows) {
    const key = `${r.scenario}|${r.model}`;
    if (!buckets.has(key)) buckets.set(key, { scenario: r.scenario, model: r.model, runs: [] });
    buckets.get(key).runs.push(r.metrics);
  }
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return [...buckets.values()].map((b) => {
    const runs = b.runs;
    const passed = runs.filter((m) => m.pass).length;
    return {
      scenario: b.scenario,
      model: b.model,
      count: runs.length,
      passed,
      passRate: runs.length ? passed / runs.length : 0,
      firstCallSuccessRate: mean(runs.map((m) => (m.firstCallSuccess ? 1 : 0))),
      meanRounds: Math.round(mean(runs.map((m) => m.rounds))),
      meanToolCalls: Math.round(mean(runs.map((m) => m.toolCallCount))),
      meanErrors: +mean(runs.map((m) => m.errorCount)).toFixed(1),
      deadLoopRuns: runs.filter((m) => m.deadLoops > 0).length,
      contextPollutionMax: Math.max(0, ...runs.map((m) => m.contextPollutionChars)),
    };
  });
}

/** 与 baseline diff：返回带 delta + verdict 的行。 */
export function diffAgainstBaseline(current, baseline) {
  const baseMap = new Map((baseline?.cells ?? []).map((c) => [`${c.scenario}|${c.model}`, c]));
  return current.map((cell) => {
    const base = baseMap.get(`${cell.scenario}|${cell.model}`);
    const passDelta = base ? cell.passRate - base.passRate : null;
    // epsilon：恰好 5% 的下滑属于"阈值内"，但浮点 0.8-0.75=0.05000...04 会误判回归
    const regression =
      base !== undefined &&
      base.passRate - cell.passRate > PASS_RATE_DROP_THRESHOLD + 1e-9;
    return {
      ...cell,
      baselinePassRate: base?.passRate ?? null,
      passDelta: passDelta === null ? null : +(passDelta * 100).toFixed(1),
      verdict: !base ? 'new' : regression ? 'REGRESSION' : cell.passRate >= 0.6 ? 'ok' : 'weak',
    };
  });
}

export function overallPassRate(cells) {
  const total = cells.reduce((a, c) => a + c.count, 0);
  const passed = cells.reduce((a, c) => a + c.passed, 0);
  return total ? passed / total : 0;
}

export function renderMarkdown(cells, meta) {
  const lines = [];
  lines.push(`# Coding Agent 反馈闭环评估报告`);
  lines.push('');
  lines.push(
    `- 时间：${meta.date}  git：${meta.gitSha}  模型：${[...new Set(cells.map((c) => c.model))].join(', ')}`
  );
  lines.push(`- 总体通过率：${(overallPassRate(cells) * 100).toFixed(1)}%  (${cells.reduce((a, c) => a + c.count, 0)} runs)`);
  const regressions = cells.filter((c) => c.verdict === 'REGRESSION');
  lines.push(`- 对比 baseline：${regressions.length ? `**${regressions.length} 项回归**` : '无回归'}`);
  lines.push('');
  lines.push('| 场景 | 模型 | 通过率 | Δ | 首调成功率 | 平均轮数 | 死循环runs | 上下文污染(峰值字符) |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const c of cells) {
    const flag = c.verdict === 'REGRESSION' ? ' ⚠' : '';
    lines.push(
      `| ${c.scenario}${flag} | ${c.model} | ${(c.passRate * 100).toFixed(0)}% | ${c.passDelta === null ? '新增' : (c.passDelta > 0 ? '+' : '') + c.passDelta} | ${(c.firstCallSuccessRate * 100).toFixed(0)}% | ${c.meanRounds}r/${c.count}run | ${c.deadLoopRuns} | ${c.contextPollutionMax} |`
    );
  }
  return lines.join('\n');
}
