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

  // P2-20：引号内的 && 属于命令/匹配模式本身，不能拆。旧实现裸 split 会把
  // exec:grep "a&&b" 切成 `exec:grep "a` 和 `b"` 两个废子句。
  it('引号内的 && 不作为子句分隔符（双引号）', () => {
    const result = parseGoalCondition('exec:grep "a&&b" file.txt');
    expect(result.clauses).toHaveLength(1);
    expect(result.clauses[0].command).toBe('grep');
    expect(result.clauses[0].args).toEqual(['a&&b', 'file.txt']);
  });

  it('引号内的 && 不作为子句分隔符（单引号 + match 模式）', () => {
    const result = parseGoalCondition("exec:npm test match:'x && y'");
    expect(result.clauses).toHaveLength(1);
    expect(result.clauses[0].command).toBe('npm');
    expect(result.clauses[0].matchPattern).toBe('x && y');
  });

  it('引号内 && 与顶层 && 混合时只拆顶层', () => {
    const result = parseGoalCondition('exec:grep "a&&b" f && exec:npm test');
    expect(result.clauses).toHaveLength(2);
    expect(result.clauses[0].command).toBe('grep');
    expect(result.clauses[0].args).toEqual(['a&&b', 'f']);
    expect(result.clauses[1].command).toBe('npm');
    expect(result.clauses[1].args).toEqual(['test']);
  });

  it('解析带自然语言目标和 | 分隔符', () => {
    const result = parseGoalCondition('修复 auth 测试 | exec:npm test');
    expect(result.clauses).toHaveLength(1);
    expect(result.clauses[0].command).toBe('npm');
    expect(result.humanReadable).toContain('修复 auth 测试');
  });

  it('以 | 开头的输入不残留前导分隔符（边界修复）', () => {
    const objective = parseGoalCondition('| exec:npm test');
    expect(objective.clauses).toHaveLength(1);
    expect(objective.clauses[0].command).toBe('npm');

    const subjective = parseGoalCondition('| 美化登录页');
    expect(subjective.clauses).toHaveLength(0);
    expect(subjective.humanReadable).toBe('美化登录页');
  });

  it('解析带引号的命令参数', () => {
    const result = parseGoalCondition('exec:echo "hello world"');
    expect(result.clauses[0].command).toBe('echo');
    expect(result.clauses[0].args).toEqual(['hello world']);
  });

  it('双引号内的正则反斜杠不被错误剥离（\\d+ 保持 \\d+）', () => {
    const result = parseGoalCondition('exec:rg "\\d+ passed" src');
    expect(result.clauses[0].command).toBe('rg');
    expect(result.clauses[0].args).toEqual(['\\d+ passed', 'src']);
  });

  it('双引号内转义双引号与反斜杠（\\" -> "，\\\\ -> \\）', () => {
    const result = parseGoalCondition('exec:echo "a\\"b\\\\c"');
    expect(result.clauses[0].command).toBe('echo');
    expect(result.clauses[0].args).toEqual(['a"b\\c']);
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

  describe('标志参数', () => {
    it('--strict 设置严格模式', () => {
      const result = parseGoalCondition('--strict exec:npm test');
      expect(result.strictness).toBe('strict');
      expect(result.clauses).toHaveLength(1);
    });

    it('--loose 设置宽松模式', () => {
      const result = parseGoalCondition('--loose exec:npm test');
      expect(result.strictness).toBe('loose');
    });

    it('--normal 设置一般模式', () => {
      const result = parseGoalCondition('--normal exec:npm test');
      expect(result.strictness).toBe('normal');
    });

    it('默认 strictness 为 normal', () => {
      const result = parseGoalCondition('exec:npm test');
      expect(result.strictness).toBe('normal');
    });

    it('--plan-first 设置规划首轮', () => {
      const result = parseGoalCondition('--plan-first exec:npm test');
      expect(result.planFirst).toBe(true);
    });

    it('--plan 是 plan-first 的别名', () => {
      const result = parseGoalCondition('--plan 重构 auth 模块');
      expect(result.planFirst).toBe(true);
    });

    it('默认 planFirst 为 false', () => {
      const result = parseGoalCondition('exec:npm test');
      expect(result.planFirst).toBe(false);
    });

    it('多个标志可以组合', () => {
      const result = parseGoalCondition('--strict --plan-first exec:npm test');
      expect(result.strictness).toBe('strict');
      expect(result.planFirst).toBe(true);
      expect(result.clauses).toHaveLength(1);
    });

    it('标志 + 主观目标', () => {
      const result = parseGoalCondition('--loose 美化登录页');
      expect(result.strictness).toBe('loose');
      expect(result.clauses).toHaveLength(0);
      expect(result.humanReadable).toContain('美化登录页');
    });

    it('标志 + 自然语言目标 + | + 客观条件', () => {
      const result = parseGoalCondition('--strict 修复测试 | exec:npm test');
      expect(result.strictness).toBe('strict');
      expect(result.clauses).toHaveLength(1);
      expect(result.humanReadable).toContain('修复测试');
    });

    it('--strict --loose 冲突时抛出错误', () => {
      expect(() => parseGoalCondition('--strict --loose exec:npm test')).toThrow(GoalConditionParseError);
      expect(() => parseGoalCondition('--loose --strict exec:npm test')).toThrow(GoalConditionParseError);
    });

    it('相同标志重复不报错', () => {
      const result = parseGoalCondition('--strict --strict exec:npm test');
      expect(result.strictness).toBe('strict');
    });
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
