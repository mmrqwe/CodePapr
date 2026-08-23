import { describe, expect, it } from 'vitest';
import {
  detectProjectVerifyCommands,
  fillAgentsVerifyCommands,
} from '../src/agent/projectVerifyCommands';
import { getDefaultAgentsTemplate } from '../src/agent/projectRules';
import { shouldSuggestCheckCommand } from '../src/agent/defaultCheckCommand';

describe('detectProjectVerifyCommands', () => {
  it('从 npm package.json scripts 识别 test/lint/build', () => {
    const commands = detectProjectVerifyCommands({
      rootFileNames: ['package.json', 'package-lock.json'],
      packageJsonText: JSON.stringify({
        scripts: { test: 'vitest', lint: 'eslint .', build: 'tsc -b' },
      }),
    });
    expect(commands).toEqual({
      test: 'npm test',
      lint: 'npm run lint',
      build: 'npm run build',
    });
  });

  it('优先认 pnpm 锁文件，且不覆盖已有 node 脚本', () => {
    const commands = detectProjectVerifyCommands({
      rootFileNames: ['package.json', 'pnpm-lock.yaml', 'Cargo.toml'],
      packageJsonText: JSON.stringify({ scripts: { test: 'vitest' } }),
    });
    expect(commands.test).toBe('pnpm test');
    expect(commands.build).toBe('cargo check');
    expect(commands.lint).toBeUndefined();
  });

  it('Go 模块填 test/lint/build', () => {
    expect(detectProjectVerifyCommands({ rootFileNames: ['go.mod'] })).toEqual({
      test: 'go test ./...',
      lint: 'go vet ./...',
      build: 'go build ./...',
    });
  });
});

describe('fillAgentsVerifyCommands', () => {
  it('只填空着的验证行，不改已有内容', () => {
    const filled = fillAgentsVerifyCommands(getDefaultAgentsTemplate(), {
      test: 'npm test',
      lint: 'npm run lint',
      build: 'npm run build',
    });
    expect(filled).toContain('- 测试：npm test');
    expect(filled).toContain('- Lint：npm run lint');
    expect(filled).toContain('- 构建：npm run build');

    const custom = '# 规则\n## 验证\n- 测试：pytest\n- Lint：\n- 构建：\n';
    const next = fillAgentsVerifyCommands(custom, { test: 'npm test', lint: 'ruff check' });
    expect(next).toContain('- 测试：pytest');
    expect(next).toContain('- Lint：ruff check');
    expect(next).toContain('- 构建：');
  });
});

describe('shouldSuggestCheckCommand', () => {
  it('仅在 Agent 改了文件且本轮不是 /check 时提示', () => {
    expect(
      shouldSuggestCheckCommand({ mode: 'agent', toolNames: ['write'] })
    ).toBe(true);
    expect(
      shouldSuggestCheckCommand({ mode: 'ask', toolNames: ['write'] })
    ).toBe(false);
    expect(
      shouldSuggestCheckCommand({
        mode: 'agent',
        commandName: 'check',
        toolNames: ['edit'],
      })
    ).toBe(false);
    expect(
      shouldSuggestCheckCommand({ mode: 'agent', toolNames: ['read', 'grep'] })
    ).toBe(false);
  });
});
