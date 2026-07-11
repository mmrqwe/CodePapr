/**
 * goal-e2e.test.ts: /goal 端到端集成测试
 *
 * 验证 GoalRunner + goalCondition + 真实命令执行 的完整循环：
 * 1. 创建临时测试项目（含 bug 的 calc.js + test.js）
 * 2. 验证初始状态：npm test 退出码为 1
 * 3. 模拟 Worker 修复 bug 后：npm test 退出码为 0
 * 4. 验证 GoalRunner 在条件满足后正确退出
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, afterEach } from 'vitest';
import {
  parseGoalCondition,
  evaluateGoalCondition,
  GoalRunner,
  serializeGoalState,
  type ConditionExecutor,
} from '@codepapr/core';

const realExecutor: ConditionExecutor = {
  runCommand: async (workspacePath, command, args) => {
    const result = spawnSync(command, args, {
      cwd: workspacePath,
      encoding: 'utf-8',
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return {
      exitCode: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      timedOut: result.signal === 'SIGTERM' && result.status === null,
    };
  },
};

async function createTestProject(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'goal-e2e-'));
  await fsp.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'goal-test', version: '1.0.0', scripts: { test: 'node test.js' } }, null, 2),
    'utf-8'
  );
  await fsp.writeFile(
    path.join(dir, 'calc.js'),
    'function add(a, b) { return a - b; }\nfunction multiply(a, b) { return a * b; }\nmodule.exports = { add, multiply };\n',
    'utf-8'
  );
  await fsp.writeFile(
    path.join(dir, 'test.js'),
    [
      "const { add, multiply } = require('./calc');",
      'let passed = 0, failed = 0;',
      'function assert(cond, name) { if (cond) { passed++; } else { failed++; console.error("FAIL: " + name); } }',
      'assert(add(1, 2) === 3, "add(1,2)");',
      'assert(add(0, 0) === 0, "add(0,0)");',
      'assert(multiply(2, 3) === 6, "multiply(2,3)");',
      'console.log(`${passed} passed, ${failed} failed`);',
      'if (failed > 0) process.exit(1);',
    ].join('\n'),
    'utf-8'
  );
  return dir;
}

async function fixBug(dir: string): Promise<void> {
  await fsp.writeFile(
    path.join(dir, 'calc.js'),
    'function add(a, b) { return a + b; }\nfunction multiply(a, b) { return a * b; }\nmodule.exports = { add, multiply };\n',
    'utf-8'
  );
}

describe('goal e2e', () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('条件函数正确检测失败和成功', async () => {
    const dir = await createTestProject();
    cleanupDirs.push(dir);

    const condition = parseGoalCondition('exec:node test.js');
    const failResult = await evaluateGoalCondition(condition, dir, realExecutor);
    expect(failResult.met).toBe(false);
    expect(failResult.details[0].exitCode).toBe(1);

    await fixBug(dir);
    const passResult = await evaluateGoalCondition(condition, dir, realExecutor);
    expect(passResult.met).toBe(true);
    expect(passResult.details[0].exitCode).toBe(0);
  });

  it('match 模式正确匹配测试输出', async () => {
    const dir = await createTestProject();
    cleanupDirs.push(dir);
    await fixBug(dir);

    const condition = parseGoalCondition('exec:node test.js match:"3 passed"');
    const result = await evaluateGoalCondition(condition, dir, realExecutor);
    expect(result.met).toBe(true);
  });

  it('GoalRunner 在条件满足后正确结束', async () => {
    const dir = await createTestProject();
    cleanupDirs.push(dir);

    const condition = parseGoalCondition('exec:node test.js');
    let workerCallCount = 0;

    const runner = new GoalRunner({
      condition,
      userGoalText: '修复 calc.js 的 bug',
      limits: { maxIterations: 5, maxWallClockMs: 60_000 },
      callbacks: {
        runWorkerTurn: async () => {
          workerCallCount += 1;
          if (workerCallCount === 1) {
            return {
              content: 'I see the bug, fixing it now.',
              transcript: '[Tool Calls] workspace_run_command\n[Tool Result] fixing',
              outputTokens: 50,
            };
          }
          await fixBug(dir);
          return {
            content: 'Bug fixed: changed a-b to a+b.',
            transcript: '[Tool Calls] workspace_write_file\n[Tool Result] written',
            outputTokens: 50,
          };
        },
        runVerifier: async (_transcript, conditionResult) => ({
          verdict: conditionResult.met ? 'SATISFIED' : 'NOT_MET',
          evidence: conditionResult.met ? 'Tests pass' : 'Tests still fail',
        }),
        evaluateCondition: () => evaluateGoalCondition(condition, dir, realExecutor),
        onStateChange: () => {},
        isAborted: () => false,
      },
    });

    const result = await runner.run();
    expect(result.status).toBe('satisfied');
    expect(result.iteration).toBe(2);
    expect(result.lastConditionResult?.met).toBe(true);
    expect(result.lastVerdict?.verdict).toBe('SATISFIED');
  });

  it('GoalRunner 条件不满足时持续循环到 limit', async () => {
    const dir = await createTestProject();
    cleanupDirs.push(dir);

    const condition = parseGoalCondition('exec:node test.js');
    const runner = new GoalRunner({
      condition,
      userGoalText: '',
      limits: { maxIterations: 3, maxWallClockMs: 60_000 },
      callbacks: {
        runWorkerTurn: async () => ({
          content: 'trying to fix...',
          transcript: '[Tool Calls] workspace_write_file',
          outputTokens: 30,
        }),
        runVerifier: async (_t, cr) => ({
          verdict: cr.met ? 'SATISFIED' : 'NOT_MET',
          evidence: 'not fixed yet',
        }),
        evaluateCondition: () => evaluateGoalCondition(condition, dir, realExecutor),
        onStateChange: () => {},
        isAborted: () => false,
      },
    });

    const result = await runner.run();
    expect(result.status).toBe('limit_exceeded');
    expect(result.iteration).toBe(3);
    expect(result.lastConditionResult?.met).toBe(false);
  });

  it('复合条件 && 全部通过时 met 为 true', async () => {
    const dir = await createTestProject();
    cleanupDirs.push(dir);
    await fixBug(dir);

    const condition = parseGoalCondition('exec:node test.js && exec:node -e "console.log(42)"');
    const result = await evaluateGoalCondition(condition, dir, realExecutor);
    expect(result.met).toBe(true);
    expect(result.details).toHaveLength(2);
    expect(result.details[0].met).toBe(true);
    expect(result.details[1].met).toBe(true);
  });

  it('复合条件 && 部分失败时 met 为 false', async () => {
    const dir = await createTestProject();
    cleanupDirs.push(dir);

    const condition = parseGoalCondition('exec:node test.js && exec:node -e "console.log(42)"');
    const result = await evaluateGoalCondition(condition, dir, realExecutor);
    expect(result.met).toBe(false);
    expect(result.details[0].met).toBe(false);
  });

  it('serializeGoalState 生成有效 Markdown', () => {
    const condition = parseGoalCondition('exec:node test.js');
    const state = {
      status: 'satisfied' as const,
      iteration: 2,
      startedAt: 1000,
      elapsedMs: 5000,
      totalOutputTokens: 500,
      lastVerdict: { verdict: 'SATISFIED' as const, evidence: 'ok' },
      lastConditionResult: { met: true, evidence: 'exit 0', details: [] },
      feedbackHistory: [],
    };
    const md = serializeGoalState(state, condition, 'fix bug');
    expect(md).toContain('# Goal State');
    expect(md).toContain('satisfied');
    expect(md).toContain('fix bug');
    expect(md).toContain('node test.js');
    expect(md).toContain('SATISFIED');
  });
});
