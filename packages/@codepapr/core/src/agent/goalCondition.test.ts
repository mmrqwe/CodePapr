import { describe, it, expect } from 'vitest';
import {
  parseGoalCondition,
  evaluateGoalCondition,
  GoalConditionParseError,
  type ConditionExecutor,
} from './goalCondition';

describe('parseGoalCondition', () => {
  it('解析简单的 exec 条件', () => {
    const result = parseGoalCondition('exec:npm test');
    expect(result.clauses).toHaveLength(1);
    expect(result.clauses[0].command).toBe('npm');
    expect(result.clauses[0].args).toEqual(['test']);
    expect(result.clauses[0].matchPattern).toBeUndefined();
  });

  it('解析带参数的 exec 条件', () => {
    const result = parseGoalCondition('exec:npm run test -- --silent');
    expect(result.clauses[0].command).toBe('npm');
    expect(result.clauses[0].args).toEqual(['run', 'test', '--', '--silent']);
  });

  it('解析带 match 模式的条件', () => {
    const result = parseGoalCondition('exec:npm test match:"\\d+ passed"');
    expect(result.clauses[0].command).toBe('npm');
    expect(result.clauses[0].args).toEqual(['test']);
    expect(result.clauses[0].matchPattern).toBe('\\d+ passed');
  });

  it('解析带单引号 match 模式的条件', () => {
    const result = parseGoalCondition("exec:npm test match:'\\d+ passed'");
    expect(result.clauses[0].matchPattern).toBe('\\d+ passed');
  });

  it('解析 && 复合条件', () => {
    const result = parseGoalCondition('exec:npm run lint && exec:npm test');
    expect(result.clauses).toHaveLength(2);
    expect(result.clauses[0].command).toBe('npm');
    expect(result.clauses[0].args).toEqual(['run', 'lint']);
    expect(result.clauses[1].command).toBe('npm');
    expect(result.clauses[1].args).toEqual(['test']);
  });

  it('解析带自然语言目标和 | 分隔符', () => {
    const result = parseGoalCondition('修复 auth 测试 | exec:npm test');
    expect(result.clauses).toHaveLength(1);
    expect(result.clauses[0].command).toBe('npm');
    expect(result.humanReadable).toContain('修复 auth 测试');
  });

  it('解析带引号的命令参数', () => {
    const result = parseGoalCondition('exec:echo "hello world"');
    expect(result.clauses[0].command).toBe('echo');
    expect(result.clauses[0].args).toEqual(['hello world']);
  });

  it('空输入抛出 GoalConditionParseError', () => {
    expect(() => parseGoalCondition('')).toThrow(GoalConditionParseError);
    expect(() => parseGoalCondition('   ')).toThrow(GoalConditionParseError);
  });

  it('纯自然语言输入作为主观目标（不抛错）', () => {
    const r1 = parseGoalCondition('npm test');
    expect(r1.clauses).toHaveLength(0);
    expect(r1.humanReadable).toBe('npm test');

    const r2 = parseGoalCondition('run:npm test');
    expect(r2.clauses).toHaveLength(0);
    expect(r2.humanReadable).toBe('run:npm test');

    const r3 = parseGoalCondition('给我补充足够的真实图片，让这个网站真正丰富起来');
    expect(r3.clauses).toHaveLength(0);
    expect(r3.humanReadable).toContain('真实图片');
  });

  it('exec 后无命令抛出错误', () => {
    expect(() => parseGoalCondition('exec:')).toThrow(GoalConditionParseError);
    expect(() => parseGoalCondition('exec:   ')).toThrow(GoalConditionParseError);
  });

  it('| 后无条件抛出错误', () => {
    expect(() => parseGoalCondition('修复测试 |')).toThrow(GoalConditionParseError);
  });

  it('humanReadable 包含命令和退出码描述', () => {
    const result = parseGoalCondition('exec:npm test');
    expect(result.humanReadable).toContain('npm test');
    expect(result.humanReadable).toContain('退出码为 0');
  });

  it('humanReadable 包含 match 描述', () => {
    const result = parseGoalCondition('exec:npm test match:"passed"');
    expect(result.humanReadable).toContain('匹配');
    expect(result.humanReadable).toContain('passed');
  });
});

describe('evaluateGoalCondition', () => {
  const mockExecutor: ConditionExecutor = {
    runCommand: async (_workspacePath, command, args) => {
      // 模拟不同命令的行为
      const fullCmd = `${command} ${args.join(' ')}`;
      if (fullCmd.includes('pass')) {
        return {
          exitCode: 0,
          stdout: '5 passed, 0 failed',
          stderr: '',
          timedOut: false,
        };
      }
      if (fullCmd.includes('fail')) {
        return {
          exitCode: 1,
          stdout: '2 passed, 3 failed',
          stderr: 'some error',
          timedOut: false,
        };
      }
      if (fullCmd.includes('timeout')) {
        return {
          exitCode: null,
          stdout: '',
          stderr: '',
          timedOut: true,
        };
      }
      return {
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        timedOut: false,
      };
    },
  };

  it('退出码为 0 时条件满足', async () => {
    const condition = parseGoalCondition('exec:npm pass');
    const result = await evaluateGoalCondition(condition, '/ws', mockExecutor);
    expect(result.met).toBe(true);
    expect(result.details).toHaveLength(1);
    expect(result.details[0].met).toBe(true);
    expect(result.details[0].exitCode).toBe(0);
  });

  it('退出码非 0 时条件不满足', async () => {
    const condition = parseGoalCondition('exec:npm fail');
    const result = await evaluateGoalCondition(condition, '/ws', mockExecutor);
    expect(result.met).toBe(false);
    expect(result.details[0].met).toBe(false);
    expect(result.details[0].exitCode).toBe(1);
  });

  it('超时时条件不满足', async () => {
    const condition = parseGoalCondition('exec:npm timeout');
    const result = await evaluateGoalCondition(condition, '/ws', mockExecutor);
    expect(result.met).toBe(false);
  });

  it('match 模式匹配时条件满足', async () => {
    const condition = parseGoalCondition('exec:npm pass match:"\\d+ passed"');
    const result = await evaluateGoalCondition(condition, '/ws', mockExecutor);
    expect(result.met).toBe(true);
  });

  it('match 模式不匹配时条件不满足', async () => {
    const condition = parseGoalCondition('exec:npm pass match:"all \\d+ tests passed"');
    const result = await evaluateGoalCondition(condition, '/ws', mockExecutor);
    expect(result.met).toBe(false);
  });

  it('复合条件全部满足时 met 为 true', async () => {
    const condition = parseGoalCondition('exec:npm pass && exec:echo ok');
    const result = await evaluateGoalCondition(condition, '/ws', mockExecutor);
    expect(result.met).toBe(true);
    expect(result.details).toHaveLength(2);
  });

  it('复合条件部分不满足时 met 为 false', async () => {
    const condition = parseGoalCondition('exec:npm pass && exec:npm fail');
    const result = await evaluateGoalCondition(condition, '/ws', mockExecutor);
    expect(result.met).toBe(false);
    expect(result.details[0].met).toBe(true);
    expect(result.details[1].met).toBe(false);
  });

  it('evidence 包含命令和退出码信息', async () => {
    const condition = parseGoalCondition('exec:npm pass');
    const result = await evaluateGoalCondition(condition, '/ws', mockExecutor);
    expect(result.evidence).toContain('npm pass');
    expect(result.evidence).toContain('退出码: 0');
    expect(result.evidence).toContain('5 passed');
  });

  it('evidence 包含 stderr', async () => {
    const condition = parseGoalCondition('exec:npm fail');
    const result = await evaluateGoalCondition(condition, '/ws', mockExecutor);
    expect(result.evidence).toContain('some error');
  });
});
