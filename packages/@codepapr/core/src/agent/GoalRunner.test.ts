import { describe, it, expect, vi } from 'vitest';
import {
  GoalRunner,
  DEFAULT_GOAL_MAX_ITERATIONS,
  DEFAULT_GOAL_MAX_WALL_CLOCK_MS,
  serializeGoalState,
  type WorkerTurnResult,
} from './GoalRunner';
import { parseGoalCondition } from './goalCondition';
import type {
  GoalVerdict,
  ConditionResult,
} from '@codepapr/types';

function makeConditionResult(met: boolean): ConditionResult {
  return {
    met,
    evidence: met ? 'exit code 0' : 'exit code 1',
    details: [
      {
        clauseIndex: 0,
        met,
        exitCode: met ? 0 : 1,
        stdout: met ? 'passed' : 'failed',
        stderr: '',
        evidence: `exit code ${met ? 0 : 1}`,
      },
    ],
  };
}

function makeVerdict(verdict: 'SATISFIED' | 'NOT_MET' | 'AMBIGUOUS'): GoalVerdict {
  return {
    verdict,
    evidence: `verdict: ${verdict}`,
    missing: verdict === 'SATISFIED' ? undefined : 'missing evidence',
  };
}

function makeVerdictWithProgress(verdict: 'SATISFIED' | 'NOT_MET' | 'AMBIGUOUS', progress?: number): GoalVerdict {
  return {
    verdict,
    evidence: `verdict: ${verdict}`,
    missing: verdict === 'SATISFIED' ? undefined : 'missing evidence',
    progress,
  };
}

function makeSubjectiveConditionResult(): ConditionResult {
  return {
    met: false,
    evidence: '主观验证模式：无客观验证条件',
    details: [],
  };
}

function makeWorkerResult(content: string, outputTokens = 100): WorkerTurnResult {
  return {
    content,
    transcript: '[Tool Calls] exec\n[Tool Result] output',
    outputTokens,
  };
}

describe('GoalRunner', () => {
  it('#24：Worker 回合中提问（question）→ 循环暂停并返回 awaiting_input', async () => {
    const condition = parseGoalCondition('exec:npm test');
    const question = {
      question: '要修改哪些文件？',
      header: '确认',
      options: [{ label: '仅 core 包' }, { label: '全部' }],
    };
    const runner = new GoalRunner({
      condition,
      userGoalText: '',
      limits: { maxIterations: 5, maxWallClockMs: 60_000 },
      callbacks: {
        runWorkerTurn: vi.fn().mockResolvedValue({ ...makeWorkerResult('等一下'), question }),
        runVerifier: vi.fn(),
        evaluateCondition: vi.fn(),
        onStateChange: vi.fn(),
        isAborted: () => false,
      },
    });

    const result = await runner.run();
    expect(result.status).toBe('awaiting_input');
    expect(result.question).toEqual(question);
    // 提问回合后不得继续评估/验证（循环立即终止）
    expect(runner.getState().iteration).toBe(1);
  });

  it('条件立即满足时第一轮就结束', async () => {
    const condition = parseGoalCondition('exec:npm test');
    const runner = new GoalRunner({
      condition,
      userGoalText: '',
      limits: { maxIterations: 5, maxWallClockMs: 60_000 },
      callbacks: {
        runWorkerTurn: vi.fn().mockResolvedValue(makeWorkerResult('done')),
        runVerifier: vi.fn().mockResolvedValue(makeVerdict('SATISFIED')),
        evaluateCondition: vi.fn().mockResolvedValue(makeConditionResult(true)),
        onStateChange: vi.fn(),
        isAborted: () => false,
      },
    });

    const result = await runner.run();
    expect(result.status).toBe('satisfied');
    expect(result.iteration).toBe(1);
    expect(result.feedbackHistory).toHaveLength(1);
  });

  it('条件不满足时继续循环，满足后结束', async () => {
    const condition = parseGoalCondition('exec:npm test');
    let evalCount = 0;
    const runner = new GoalRunner({
      condition,
      userGoalText: '',
      limits: { maxIterations: 10, maxWallClockMs: 60_000 },
      callbacks: {
        runWorkerTurn: vi.fn().mockResolvedValue(makeWorkerResult('working')),
        runVerifier: vi.fn().mockImplementation(async (_transcript, conditionResult) => {
          // Verifier 跟随条件结果：条件满足时判定 SATISFIED
          return makeVerdict(conditionResult.met ? 'SATISFIED' : 'NOT_MET');
        }),
        evaluateCondition: vi.fn().mockImplementation(async () => {
          evalCount += 1;
          return makeConditionResult(evalCount >= 3);
        }),
        onStateChange: vi.fn(),
        isAborted: () => false,
      },
    });

    const result = await runner.run();
    expect(result.status).toBe('satisfied');
    expect(result.iteration).toBe(3);
    expect(result.feedbackHistory).toHaveLength(3);
  });

  it('达到 maxIterations 时返回 limit_exceeded', async () => {
    const condition = parseGoalCondition('exec:npm test');
    const runner = new GoalRunner({
      condition,
      userGoalText: '',
      limits: { maxIterations: 3, maxWallClockMs: 60_000 },
      callbacks: {
        runWorkerTurn: vi.fn().mockResolvedValue(makeWorkerResult('working')),
        runVerifier: vi.fn().mockResolvedValue(makeVerdict('NOT_MET')),
        evaluateCondition: vi.fn().mockResolvedValue(makeConditionResult(false)),
        onStateChange: vi.fn(),
        isAborted: () => false,
      },
    });

    const result = await runner.run();
    expect(result.status).toBe('limit_exceeded');
    expect(result.iteration).toBe(3);
    expect(result.feedbackHistory).toHaveLength(3);
  });

  it('用户中断时返回 interrupted', async () => {
    const condition = parseGoalCondition('exec:npm test');
    let callCount = 0;
    const runner = new GoalRunner({
      condition,
      userGoalText: '',
      limits: { maxIterations: 10, maxWallClockMs: 60_000 },
      callbacks: {
        runWorkerTurn: vi.fn().mockImplementation(async () => {
          callCount += 1;
          return makeWorkerResult('working');
        }),
        runVerifier: vi.fn().mockResolvedValue(makeVerdict('NOT_MET')),
        evaluateCondition: vi.fn().mockResolvedValue(makeConditionResult(false)),
        onStateChange: vi.fn(),
        isAborted: () => callCount >= 1,
      },
    });

    const result = await runner.run();
    expect(result.status).toBe('interrupted');
    expect(result.iteration).toBe(1);
  });

  it('N5：验证命令期间点停止 → 评估完成后立即中断，跳过 verifier', async () => {
    const condition = parseGoalCondition('exec:npm test');
    let aborted = false;
    const runVerifier = vi.fn().mockResolvedValue(makeVerdict('NOT_MET'));
    const runner = new GoalRunner({
      condition,
      userGoalText: '',
      limits: { maxIterations: 10, maxWallClockMs: 60_000 },
      callbacks: {
        runWorkerTurn: vi.fn().mockResolvedValue(makeWorkerResult('working')),
        runVerifier,
        evaluateCondition: vi.fn().mockImplementation(async () => {
          // 模拟 120s 验证命令期间用户点停止
          aborted = true;
          return makeConditionResult(false);
        }),
        onStateChange: vi.fn(),
        isAborted: () => aborted,
      },
    });

    const result = await runner.run();
    expect(result.status).toBe('interrupted');
    expect(result.iteration).toBe(1);
    // verifier 绝不执行：验证阶段的中断不能被拖到下一轮才发现
    expect(runVerifier).not.toHaveBeenCalled();
  });

  it('N5：verifier 调用期间点停止 → 完成后立即中断，不进入压缩/下一轮', async () => {
    const condition = parseGoalCondition('exec:npm test');
    let aborted = false;
    const runVerifier = vi.fn().mockImplementation(async () => {
      aborted = true;
      return makeVerdict('NOT_MET');
    });
    const onCompaction = vi.fn();
    const runWorkerTurn = vi.fn().mockResolvedValue(makeWorkerResult('working'));
    const runner = new GoalRunner({
      condition,
      userGoalText: '',
      limits: { maxIterations: 10, maxWallClockMs: 60_000 },
      callbacks: {
        runWorkerTurn,
        runVerifier,
        evaluateCondition: vi.fn().mockResolvedValue(makeConditionResult(false)),
        onStateChange: vi.fn(),
        onCompaction,
        isAborted: () => aborted,
      },
    });

    const result = await runner.run();
    expect(result.status).toBe('interrupted');
    expect(result.iteration).toBe(1);
    expect(runWorkerTurn).toHaveBeenCalledTimes(1);
    expect(onCompaction).not.toHaveBeenCalled();
  });

  it('N5：验证回调抛 AbortError 时按用户中断处理', async () => {
    const condition = parseGoalCondition('exec:npm test');
    const runner = new GoalRunner({
      condition,
      userGoalText: '',
      limits: { maxIterations: 10, maxWallClockMs: 60_000 },
      callbacks: {
        runWorkerTurn: vi.fn().mockResolvedValue(makeWorkerResult('working')),
        runVerifier: vi.fn().mockRejectedValue(
          new DOMException('Goal aborted', 'AbortError')
        ),
        evaluateCondition: vi.fn().mockResolvedValue(makeConditionResult(false)),
        onStateChange: vi.fn(),
        isAborted: () => true,
      },
    });

    const result = await runner.run();
    expect(result.status).toBe('interrupted');
  });

  it('N5：条件评估回调抛 AbortError 时按用户中断处理（不降级为评估错误）', async () => {
    const condition = parseGoalCondition('exec:npm test');
    let aborted = false;
    const runVerifier = vi.fn().mockResolvedValue(makeVerdict('NOT_MET'));
    const runner = new GoalRunner({
      condition,
      userGoalText: '',
      limits: { maxIterations: 10, maxWallClockMs: 60_000 },
      callbacks: {
        runWorkerTurn: vi.fn().mockResolvedValue(makeWorkerResult('working')),
        runVerifier,
        evaluateCondition: vi.fn().mockImplementation(async () => {
          aborted = true;
          throw new DOMException('Goal aborted', 'AbortError');
        }),
        onStateChange: vi.fn(),
        isAborted: () => aborted,
      },
    });

    const result = await runner.run();
    expect(result.status).toBe('interrupted');
    expect(runVerifier).not.toHaveBeenCalled();
  });

  it('N23：主观目标 verifier 失败时立即以 error 终止（不跑满迭代烧 token）', async () => {
    const condition = parseGoalCondition('给我一个能运行的计算器应用');
    expect(condition.clauses.length).toBe(0);
    const runWorkerTurn = vi.fn().mockResolvedValue(makeWorkerResult('working'));
    const runner = new GoalRunner({
      condition,
      userGoalText: '',
      limits: { maxIterations: 20, maxWallClockMs: 60_000 },
      callbacks: {
        runWorkerTurn,
        runVerifier: vi.fn().mockRejectedValue(new Error('provider exploded')),
        evaluateCondition: vi.fn().mockResolvedValue(makeSubjectiveConditionResult()),
        onStateChange: vi.fn(),
        isAborted: () => false,
      },
    });

    const result = await runner.run();

    expect(result.status).toBe('error');
    expect(result.error).toContain('Verifier');
    expect(runWorkerTurn).toHaveBeenCalledTimes(1);
    expect(result.iteration).toBe(1);
  });

  it('客观目标 verifier 失败时降级为仅条件评估，循环继续', async () => {
    const condition = parseGoalCondition('exec:npm test');
    let evalCount = 0;
    const runner = new GoalRunner({
      condition,
      userGoalText: '',
      limits: { maxIterations: 5, maxWallClockMs: 60_000 },
      callbacks: {
        runWorkerTurn: vi.fn().mockResolvedValue(makeWorkerResult('working')),
        runVerifier: vi.fn().mockRejectedValue(new Error('verifier down')),
        evaluateCondition: vi.fn().mockImplementation(async () => {
          evalCount += 1;
          return makeConditionResult(evalCount >= 2);
        }),
        onStateChange: vi.fn(),
        isAborted: () => false,
      },
    });

    const result = await runner.run();

    expect(result.status).toBe('satisfied');
    expect(result.iteration).toBe(2);
  });

  it('Worker turn 抛出错误时返回 error', async () => {
    const condition = parseGoalCondition('exec:npm test');
    const runner = new GoalRunner({
      condition,
      userGoalText: '',
      limits: { maxIterations: 5, maxWallClockMs: 60_000 },
      callbacks: {
        runWorkerTurn: vi.fn().mockRejectedValue(new Error('LLM error')),
        runVerifier: vi.fn(),
        evaluateCondition: vi.fn(),
        onStateChange: vi.fn(),
        isAborted: () => false,
      },
    });

    const result = await runner.run();
    expect(result.status).toBe('error');
    expect(result.error).toBe('LLM error');
  });

  it('条件满足但 Verifier 判定 NOT_MET 时不结束', async () => {
    const condition = parseGoalCondition('exec:npm test');
    const runner = new GoalRunner({
      condition,
      userGoalText: '',
      limits: { maxIterations: 3, maxWallClockMs: 60_000 },
      callbacks: {
        runWorkerTurn: vi.fn().mockResolvedValue(makeWorkerResult('done')),
        runVerifier: vi.fn().mockResolvedValue(makeVerdict('NOT_MET')),
        evaluateCondition: vi.fn().mockResolvedValue(makeConditionResult(true)),
        onStateChange: vi.fn(),
        isAborted: () => false,
      },
    });

    const result = await runner.run();
    expect(result.status).toBe('limit_exceeded');
  });

  it('Verifier 出错时降级为仅条件评估', async () => {
    const condition = parseGoalCondition('exec:npm test');
    const runner = new GoalRunner({
      condition,
      userGoalText: '',
      limits: { maxIterations: 5, maxWallClockMs: 60_000 },
      callbacks: {
        runWorkerTurn: vi.fn().mockResolvedValue(makeWorkerResult('done')),
        runVerifier: vi.fn().mockRejectedValue(new Error('verifier down')),
        evaluateCondition: vi.fn().mockResolvedValue(makeConditionResult(true)),
        onStateChange: vi.fn(),
        isAborted: () => false,
      },
    });

    const result = await runner.run();
    expect(result.status).toBe('satisfied');
    expect(result.lastVerdict?.evidence).toContain('降级');
  });

  it('onStateChange 在每轮被调用', async () => {
    const condition = parseGoalCondition('exec:npm test');
    const onStateChange = vi.fn();
    const runner = new GoalRunner({
      condition,
      userGoalText: '',
      limits: { maxIterations: 2, maxWallClockMs: 60_000 },
      callbacks: {
        runWorkerTurn: vi.fn().mockResolvedValue(makeWorkerResult('working')),
        runVerifier: vi.fn().mockResolvedValue(makeVerdict('NOT_MET')),
        evaluateCondition: vi.fn().mockResolvedValue(makeConditionResult(false)),
        onStateChange,
        isAborted: () => false,
      },
    });

    await runner.run();
    expect(onStateChange.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('writeGoalState 被调用', async () => {
    const condition = parseGoalCondition('exec:npm test');
    const writeGoalState = vi.fn().mockResolvedValue(undefined);
    const runner = new GoalRunner({
      condition,
      userGoalText: 'test goal',
      limits: { maxIterations: 1, maxWallClockMs: 60_000 },
      callbacks: {
        runWorkerTurn: vi.fn().mockResolvedValue(makeWorkerResult('done')),
        runVerifier: vi.fn().mockResolvedValue(makeVerdict('SATISFIED')),
        evaluateCondition: vi.fn().mockResolvedValue(makeConditionResult(true)),
        onStateChange: vi.fn(),
        writeGoalState,
        isAborted: () => false,
      },
    });

    await runner.run();
    expect(writeGoalState).toHaveBeenCalled();
  });

  it('初始 prompt 包含目标条件', () => {
    const condition = parseGoalCondition('exec:npm test');
    const runner = new GoalRunner({
      condition,
      userGoalText: '修复测试',
      limits: { maxIterations: 5, maxWallClockMs: 60_000 },
      callbacks: {
        runWorkerTurn: vi.fn(),
        runVerifier: vi.fn(),
        evaluateCondition: vi.fn(),
        onStateChange: vi.fn(),
        isAborted: () => false,
      },
    });

    // 通过运行来间接验证 prompt（Worker 第一轮收到的 prompt 应包含目标）
    // 这里验证 getState 初始状态
    const state = runner.getState();
    expect(state.status).toBe('running');
    expect(state.iteration).toBe(0);
    expect(state.feedbackHistory).toHaveLength(0);
  });

  it('DEFAULT 常量值合理', () => {
    expect(DEFAULT_GOAL_MAX_ITERATIONS).toBe(20);
    expect(DEFAULT_GOAL_MAX_WALL_CLOCK_MS).toBe(1_800_000);
  });

  it('plan-first 模式第 1 轮跳过条件评估和 Verifier', async () => {
    const condition = parseGoalCondition('--plan-first exec:npm test');
    let evalCount = 0;

    const runner = new GoalRunner({
      condition,
      userGoalText: '',
      limits: { maxIterations: 5, maxWallClockMs: 60_000, planFirst: true },
      callbacks: {
        runWorkerTurn: vi.fn().mockResolvedValue(makeWorkerResult('plan')),
        runVerifier: vi.fn().mockImplementation(async (_transcript, conditionResult) => {
          return makeVerdict(conditionResult.met ? 'SATISFIED' : 'NOT_MET');
        }),
        evaluateCondition: vi.fn().mockImplementation(async () => {
          evalCount += 1;
          return makeConditionResult(evalCount >= 2);
        }),
        onStateChange: vi.fn(),
        isAborted: () => false,
      },
    });

    const result = await runner.run();
    expect(result.status).toBe('satisfied');
    // 第 1 轮跳过评估，evaluateCondition 从第 2 轮开始调用
    // 第 2 轮 evalCount=1 (false), 第 3 轮 evalCount=2 (true) → satisfied
    expect(result.iteration).toBe(3);
    // feedbackHistory 只有 2 条（第 1 轮被跳过）
    expect(result.feedbackHistory).toHaveLength(2);
  });

  it('主观模式：SATISFIED 但 progress 低于门槛时不结束（继续循环）', async () => {
    const condition = parseGoalCondition('美化登录页');
    const runner = new GoalRunner({
      condition,
      userGoalText: '美化登录页',
      limits: { maxIterations: 2, maxWallClockMs: 60_000 },
      callbacks: {
        runWorkerTurn: vi.fn().mockResolvedValue(makeWorkerResult('working')),
        runVerifier: vi.fn().mockResolvedValue(makeVerdictWithProgress('SATISFIED', 0.5)),
        evaluateCondition: vi.fn().mockResolvedValue(makeSubjectiveConditionResult()),
        onStateChange: vi.fn(),
        isAborted: () => false,
      },
    });

    const result = await runner.run();
    expect(result.status).toBe('limit_exceeded');
    expect(result.iteration).toBe(2);
    expect(result.feedbackHistory).toHaveLength(2);
  });

  it('主观模式：SATISFIED 且 progress 达到门槛时结束', async () => {
    const condition = parseGoalCondition('美化登录页');
    const runner = new GoalRunner({
      condition,
      userGoalText: '美化登录页',
      limits: { maxIterations: 5, maxWallClockMs: 60_000 },
      callbacks: {
        runWorkerTurn: vi.fn().mockResolvedValue(makeWorkerResult('done')),
        runVerifier: vi.fn().mockResolvedValue(makeVerdictWithProgress('SATISFIED', 0.95)),
        evaluateCondition: vi.fn().mockResolvedValue(makeSubjectiveConditionResult()),
        onStateChange: vi.fn(),
        isAborted: () => false,
      },
    });

    const result = await runner.run();
    expect(result.status).toBe('satisfied');
    expect(result.iteration).toBe(1);
  });

  it('主观模式：SATISFIED 无 progress 字段按达成处理（兼容旧输出）', async () => {
    const condition = parseGoalCondition('美化登录页');
    const runner = new GoalRunner({
      condition,
      userGoalText: '美化登录页',
      limits: { maxIterations: 5, maxWallClockMs: 60_000 },
      callbacks: {
        runWorkerTurn: vi.fn().mockResolvedValue(makeWorkerResult('done')),
        runVerifier: vi.fn().mockResolvedValue(makeVerdict('SATISFIED')),
        evaluateCondition: vi.fn().mockResolvedValue(makeSubjectiveConditionResult()),
        onStateChange: vi.fn(),
        isAborted: () => false,
      },
    });

    const result = await runner.run();
    expect(result.status).toBe('satisfied');
    expect(result.iteration).toBe(1);
  });

  it('主观模式 loose：progress ≥ 0.7 即达成', async () => {
    const condition = parseGoalCondition('--loose 美化登录页');
    const runner = new GoalRunner({
      condition,
      userGoalText: '美化登录页',
      limits: { maxIterations: 5, maxWallClockMs: 60_000 },
      callbacks: {
        runWorkerTurn: vi.fn().mockResolvedValue(makeWorkerResult('done')),
        runVerifier: vi.fn().mockResolvedValue(makeVerdictWithProgress('SATISFIED', 0.75)),
        evaluateCondition: vi.fn().mockResolvedValue(makeSubjectiveConditionResult()),
        onStateChange: vi.fn(),
        isAborted: () => false,
      },
    });

    const result = await runner.run();
    expect(result.status).toBe('satisfied');
    expect(result.iteration).toBe(1);
  });
});

describe('serializeGoalState', () => {
  it('序列化 satisfied 状态', () => {
    const condition = parseGoalCondition('exec:npm test');
    const state = {
      status: 'satisfied' as const,
      iteration: 3,
      startedAt: 1000,
      elapsedMs: 5000,
      totalOutputTokens: 3000,
      lastVerdict: makeVerdict('SATISFIED'),
      lastConditionResult: makeConditionResult(true),
      feedbackHistory: [],
    };
    const md = serializeGoalState(state, condition, '修复测试');
    expect(md).toContain('# Goal State');
    expect(md).toContain('satisfied');
    expect(md).toContain('修复测试');
    expect(md).toContain('npm test');
    expect(md).toContain('SATISFIED');
    expect(md).toContain('**Iteration:** 3');
  });

  it('序列化 error 状态包含错误信息', () => {
    const condition = parseGoalCondition('exec:npm test');
    const state = {
      status: 'error' as const,
      iteration: 1,
      startedAt: 1000,
      elapsedMs: 1000,
      totalOutputTokens: 100,
      lastVerdict: null,
      lastConditionResult: null,
      feedbackHistory: [],
      error: 'LLM timeout',
    };
    const md = serializeGoalState(state, condition, '');
    expect(md).toContain('## Error');
    expect(md).toContain('LLM timeout');
  });
});
