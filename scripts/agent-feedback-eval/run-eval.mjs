#!/usr/bin/env node
/**
 * Coding Agent 反馈闭环评估入口（Phase 4：L2 恢复基准 + L3 回归）。
 *
 * 用法：
 *   node scripts/agent-feedback-eval/run-eval.mjs --pr              # PR 门禁：子集 x1 run
 *   node scripts/agent-feedback-eval/run-eval.mjs --nightly         # 夜间全量：全场景 x5 x 全模型
 *   node scripts/agent-feedback-eval/run-eval.mjs --scenario=ambiguous-edit --runs=1   # 单场景调试
 *   node scripts/agent-feedback-eval/run-eval.mjs --nightly --update-baseline           # 通过后固化基线
 *
 * 前置：cargo build -p codepapr-cli -p codepapr-server（会用 mtime 守卫拒绝陈旧二进制）。
 * 真实模型凭证从桌面 ui.settings 读取（不落盘、不打印 apiKey）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCase } from './lib/cliRunner.mjs';
import { computeMetrics } from './lib/metrics.mjs';
import { loadEvalModels } from './lib/models.mjs';
import { aggregate, diffAgainstBaseline, overallPassRate, renderMarkdown } from './lib/report.mjs';
import { scenarios } from './scenarios/recovery.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = path.join(here, 'baselines', 'latest.json');
const resultsDir = path.join(here, 'results');

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);

// PR 冒子集：三条最能体现"反馈闭环"的场景（歧义恢复、拦截改道、验证循环）。
const PR_SUBSET = ['ambiguous-edit', 'blocked-repo-grep', 'diagnostics-fix-loop'];

function selectScenarios() {
  if (typeof argv.scenario === 'string') {
    const wanted = argv.scenario.split(',');
    const picked = scenarios.filter((s) => wanted.includes(s.name));
    if (picked.length !== wanted.length) {
      const missing = wanted.filter((w) => !scenarios.some((s) => s.name === w));
      throw new Error(`未知场景: ${missing.join(', ')}`);
    }
    return picked;
  }
  if (argv.pr) return scenarios.filter((s) => PR_SUBSET.includes(s.name));
  return scenarios;
}

function gitSha() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function main() {
  const models = argv.model === 'first' ? loadEvalModels({ all: false }) : loadEvalModels({ all: true });
  const sel = selectScenarios();
  const runs = Number(argv.runs ?? (argv.nightly ? 5 : 1));
  const timeoutMs = Number(argv.timeoutMs ?? 300_000);
  const rows = [];
  const startedAt = new Date().toISOString();
  console.log(
    `[eval] ${sel.length} 场景 x ${models.length} 模型 x ${runs} run = ${sel.length * models.length * runs} 次真实调用 (git ${gitSha()})`
  );

  for (const scenario of sel) {
    for (const model of models) {
      for (let i = 0; i < runs; i++) {
        const tag = `${scenario.name}/${model.label}/${i + 1}`;
        let run;
        try {
          run = await runCase({
            scenario: scenario.name,
            files: scenario.files,
            prompt: scenario.prompt,
            setup: scenario.setup ?? null,
            gitRepo: !!scenario.gitRepo,
            model,
            yolo: false,
            timeoutMs,
          });
        } catch (err) {
          console.log(`  ✗ ${tag}: runner error ${err.message}`);
          rows.push({
            scenario: scenario.name,
            model: model.label,
            runIndex: i,
            metrics: {
              pass: false, exitCode: -1, firstCallSuccess: false, hadError: false,
              toolCallCount: 0, errorCount: 0, rounds: 0, budgetRounds: scenario.budgetRounds,
              deadLoops: 0, fallbackQuality: null, avoidViolation: false,
              contextPollutionChars: 0, elapsedMs: 0, toolSequence: [],
            },
            error: String(err.message).slice(0, 400),
          });
          continue;
        }
        const metrics = computeMetrics(run, scenario);
        rows.push({ scenario: scenario.name, model: model.label, runIndex: i, metrics });
        console.log(
          `  ${metrics.pass ? '✓' : '✗'} ${tag}: rounds=${metrics.rounds}/${scenario.budgetRounds} calls=${metrics.toolCallCount} err=${metrics.errorCount} loops=${metrics.deadLoops} exit=${metrics.exitCode}` +
            (metrics.pass ? '' : ` seq=${metrics.toolSequence.join(' ')}`)
        );
      }
    }
  }

  const cells = aggregate(rows);
  const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : null;
  const diffed = diffAgainstBaseline(cells, baseline);
  const overall = overallPassRate(cells);
  const report = {
    meta: { date: startedAt, gitSha: gitSha(), runs, models: models.map((m) => m.label), nightly: !!argv.nightly, pr: !!argv.pr },
    overallPassRate: +overall.toFixed(3),
    cells: diffed,
    rows,
  };

  fs.mkdirSync(resultsDir, { recursive: true });
  const stamp = startedAt.replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(resultsDir, `${stamp}.json`), JSON.stringify(report, null, 2));
  const markdown = renderMarkdown(diffed, { date: startedAt, gitSha: gitSha() });
  fs.writeFileSync(path.join(resultsDir, `${stamp}.md`), markdown);
  console.log('\n' + markdown + '\n');

  if (argv['update-baseline']) {
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(baselinePath, JSON.stringify({ meta: report.meta, cells }, null, 2));
    console.log(`[eval] baseline 已更新: ${baselinePath}`);
  }

  const regressions = diffed.filter((c) => c.verdict === 'REGRESSION');
  if (regressions.length) {
    console.error(`[eval] 检出 ${regressions.length} 项相对 baseline 的回归：${regressions.map((c) => c.scenario + '/' + c.model).join(', ')}`);
  }
  // --gate：PR 模式下通过率 < 60% 或有回归即非零退出（供 CI 用）
  if (argv.gate && (overall < 0.6 || regressions.length)) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[eval] 失败:', err);
  process.exit(1);
});
