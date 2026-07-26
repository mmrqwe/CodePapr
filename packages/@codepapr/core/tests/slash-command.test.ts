import { describe, expect, it } from 'vitest';
import {
  getBuiltinPromptCommand,
  listBuiltinPromptCommandNames,
  parseCommandMarkdown,
  parseInlineCommandLine,
  parseSlashInput,
  expandCommandTemplate,
} from '../src/agent/slashCommand';

describe('slashCommand - parseCommandMarkdown', () => {
  it('解析 frontmatter 与模板正文', () => {
    const raw = [
      '---',
      'description: 运行测试并总结',
      'usage: 运行测试。用法: /test <目标>',
      "example: '/test src/'",
      'agent: explore',
      'model: deepseek-v4-pro',
      '---',
      '请运行 $ARGUMENTS 并总结结果。',
    ].join('\n');
    const def = parseCommandMarkdown('test', raw);
    expect(def.name).toBe('test');
    expect(def.description).toBe('运行测试并总结');
    expect(def.usage).toBe('运行测试。用法: /test <目标>');
    expect(def.example).toBe('/test src/');
    expect(def.agent).toBe('explore');
    expect(def.model).toBe('deepseek-v4-pro');
    expect(def.template).toBe('请运行 $ARGUMENTS 并总结结果。');
  });

  it('无 frontmatter 时全文作为模板', () => {
    const def = parseCommandMarkdown('greet', '你好 $1');
    expect(def.template).toBe('你好 $1');
    expect(def.description).toBeUndefined();
  });
});

describe('slashCommand - parseSlashInput', () => {
  it('优先解析新的双横杠命令格式，同时兼容旧斜杠格式', () => {
    expect(parseSlashInput('--test foo bar')).toEqual({
      name: 'test',
      args: ['foo', 'bar'],
      prefix: '--',
    });
    expect(parseSlashInput('/test foo bar')).toEqual({
      name: 'test',
      args: ['foo', 'bar'],
      prefix: '/',
    });
  });

  it('非斜杠输入返回 null', () => {
    expect(parseSlashInput('hello')).toBeNull();
    expect(parseSlashInput('/')).toBeNull();
    expect(parseSlashInput('--')).toBeNull();
    expect(parseSlashInput('   ')).toBeNull();
  });
});

describe('slashCommand - built-in prompt commands', () => {
  it('提供常用内置提示命令', () => {
    expect(listBuiltinPromptCommandNames()).toEqual([
      'review',
      'fix',
      'test',
      'explain',
      'diagnose',
      'refactor',
      'doc',
      'search',
      'lint',
      'clean',
      'commit',
      'summary',
      'build',
      'new',
      'optimize',
    ]);
    expect(getBuiltinPromptCommand('review')?.template).toContain('$ARGUMENTS');
    expect(getBuiltinPromptCommand('REVIEW')?.name).toBe('review');
    expect(getBuiltinPromptCommand('unknown')).toBeNull();
  });

  it('快速命令声明 fast model 路由偏好', () => {
    expect(getBuiltinPromptCommand('search')?.model).toBe('fast');
    expect(getBuiltinPromptCommand('lint')?.model).toBe('fast');
    expect(getBuiltinPromptCommand('clean')?.model).toBe('fast');
    expect(getBuiltinPromptCommand('commit')?.model).toBe('fast');
    expect(getBuiltinPromptCommand('summary')?.model).toBe('fast');
    expect(getBuiltinPromptCommand('build')?.model).toBe('fast');
  });

  it('新创建和优化命令使用默认路由（未声明 model）', () => {
    expect(getBuiltinPromptCommand('new')?.model).toBeUndefined();
    expect(getBuiltinPromptCommand('optimize')?.model).toBeUndefined();
  });

  it('所有内置命令都声明 usage 和 example', () => {
    for (const name of listBuiltinPromptCommandNames()) {
      const cmd = getBuiltinPromptCommand(name);
      expect(cmd?.usage, `${name} missing usage`).toBeTruthy();
      expect(cmd?.example, `${name} missing example`).toBeTruthy();
    }
  });
});

describe('slashCommand - expandCommandTemplate', () => {
  it('替换 $ARGUMENTS 与位置参数', async () => {
    const result = await expandCommandTemplate('运行 $1，全部参数：$ARGUMENTS', ['lint', 'build']);
    expect(result).toBe('运行 lint，全部参数：lint build');
  });

  it('内联执行 shell 命令', async () => {
    const result = await expandCommandTemplate('分支是 !`git branch`', [], {
      runShell: async (cmd) => {
        expect(cmd).toBe('git branch');
        return 'main\n';
      },
    });
    expect(result).toBe('分支是 main');
  });

  it('内联读取文件内容', async () => {
    const result = await expandCommandTemplate('参考 @src/index.ts', [], {
      readFile: async (path) => {
        expect(path).toBe('src/index.ts');
        return 'export const x = 1;';
      },
    });
    expect(result).toContain('```');
    expect(result).toContain('export const x = 1;');
  });

  it('shell 执行失败时嵌入错误而非抛出', async () => {
    const result = await expandCommandTemplate('!`bad`', [], {
      runShell: async () => {
        throw new Error('boom');
      },
    });
    expect(result).toContain('命令执行失败: boom');
  });

  it('多个内联命令按位置精确替换', async () => {
    const result = await expandCommandTemplate('!`git branch` 和 !`git rev-parse HEAD`', [], {
      runShell: async (cmd) => {
        if (cmd === 'git branch') return 'main';
        return 'abc123';
      },
    });
    expect(result).toBe('main 和 abc123');
  });

  it('shell 输出包含另一个 token 文本时不会误替换', async () => {
    const result = await expandCommandTemplate('!`cmd1` 然后 !`cmd2`', [], {
      runShell: async (cmd) => {
        if (cmd === 'cmd1') return '!`cmd2`';
        return 'real-output';
      },
    });
    expect(result).toBe('!`cmd2` 然后 real-output');
  });
});

describe('slashCommand - parseInlineCommandLine', () => {
  it('将简单命令行拆成 command 和 args', () => {
    expect(parseInlineCommandLine('git status -s')).toEqual({
      command: 'git',
      args: ['status', '-s'],
    });
    expect(parseInlineCommandLine('node -e "console.log(1)"')).toEqual({
      command: 'node',
      args: ['-e', 'console.log(1)'],
    });
  });

  it('拒绝复合 shell 操作符', () => {
    expect(() => parseInlineCommandLine('git status | cat')).toThrow('不支持');
    expect(() => parseInlineCommandLine('npm test && npm run build')).toThrow('不支持');
  });
});
