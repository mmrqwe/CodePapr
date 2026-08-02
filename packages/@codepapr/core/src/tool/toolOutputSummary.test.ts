import { describe, it, expect } from 'vitest';
import {
  resolveToolContextMode,
  summarizeToolOutput,
  applyToolContextMode,
  DEFAULT_SUMMARY_MAX_CHARS,
  DEFAULT_AUTO_THRESHOLD_CHARS,
  type ToolContextConfig,
} from './toolOutputSummary';

function makeConfig(overrides: Partial<ToolContextConfig> = {}): ToolContextConfig {
  return {
    defaultMode: 'auto',
    overrides: {},
    summaryMaxChars: DEFAULT_SUMMARY_MAX_CHARS,
    autoThresholdChars: DEFAULT_AUTO_THRESHOLD_CHARS,
    ...overrides,
  };
}

describe('resolveToolContextMode', () => {
  it('returns full for protected tools', () => {
    const config = makeConfig({ defaultMode: 'summary' });
    expect(resolveToolContextMode('question', config)).toBe('full');
    expect(resolveToolContextMode('todo', config)).toBe('full');
    expect(resolveToolContextMode('skill', config)).toBe('full');
    expect(resolveToolContextMode('task', config)).toBe('full');
  });

  it('uses overrides when present', () => {
    const config = makeConfig({ overrides: { bash: 'full' } });
    expect(resolveToolContextMode('bash', config)).toBe('full');
  });

  it('uses category defaults', () => {
    const config = makeConfig();
    expect(resolveToolContextMode('bash', config)).toBe('summary');
    expect(resolveToolContextMode('read', config)).toBe('auto');
    expect(resolveToolContextMode('write', config)).toBe('summary');
    expect(resolveToolContextMode('grep', config)).toBe('auto');
  });

  it('falls back to defaultMode for unknown tools', () => {
    const config = makeConfig({ defaultMode: 'summary' });
    expect(resolveToolContextMode('unknown_tool', config)).toBe('summary');
  });
});

describe('summarizeToolOutput', () => {
  it('summarizes bash output', () => {
    const summary = summarizeToolOutput(
      'bash',
      { command: 'npm run build' },
      'Build successful\nDone in 3.2s',
      true,
      500
    );
    expect(summary).toContain('[bash]');
    expect(summary).toContain('✓');
    expect(summary).toContain('npm run build');
  });

  it('summarizes failed bash output', () => {
    const summary = summarizeToolOutput(
      'bash',
      { command: 'npm test' },
      { error: 'Test failed' },
      false,
      500
    );
    expect(summary).toContain('✗');
  });

  it('summarizes read output', () => {
    const summary = summarizeToolOutput(
      'read',
      { path: 'src/main.ts' },
      'line1\nline2\nline3',
      true,
      500
    );
    expect(summary).toContain('[read]');
    expect(summary).toContain('src/main.ts');
    expect(summary).toContain('3 行');
  });

  it('summarizes write output', () => {
    const summary = summarizeToolOutput(
      'write',
      { path: 'src/utils.ts', content: 'hello world' },
      'OK',
      true,
      500
    );
    expect(summary).toContain('[write]');
    expect(summary).toContain('src/utils.ts');
  });

  it('summarizes grep output', () => {
    const summary = summarizeToolOutput(
      'grep',
      { pattern: 'TODO' },
      'file1.ts:1: TODO fix\nfile2.ts:5: TODO cleanup',
      true,
      500
    );
    expect(summary).toContain('[grep]');
    expect(summary).toContain('TODO');
    expect(summary).toContain('2 条匹配');
  });

  it('summarizes glob output', () => {
    const summary = summarizeToolOutput(
      'glob',
      { pattern: '**/*.ts' },
      'src/a.ts\nsrc/b.ts',
      true,
      500
    );
    expect(summary).toContain('[glob]');
    expect(summary).toContain('2 个文件');
  });

  it('summarizes browser output', () => {
    const summary = summarizeToolOutput(
      'browser',
      { action: 'navigate', url: 'https://example.com' },
      'Page loaded',
      true,
      500
    );
    expect(summary).toContain('[browser]');
    expect(summary).toContain('navigate');
    expect(summary).toContain('https://example.com');
  });

  it('summarizes unknown tools generically', () => {
    const summary = summarizeToolOutput(
      'custom_tool',
      { foo: 'bar' },
      'some output',
      true,
      500
    );
    expect(summary).toContain('[custom_tool]');
    expect(summary).toContain('✓');
  });

  it('respects maxChars limit', () => {
    const longOutput = 'x'.repeat(1000);
    const summary = summarizeToolOutput(
      'bash',
      { command: 'echo test' },
      longOutput,
      true,
      50
    );
    expect(summary.length).toBeLessThanOrEqual(51);
  });
});

describe('applyToolContextMode', () => {
  it('returns full content in full mode', async () => {
    const config = makeConfig({ defaultMode: 'full', overrides: { bash: 'full' } });
    const result = await applyToolContextMode('bash', { command: 'ls' }, 'file1\nfile2', true, config);
    expect(result.summarized).toBe(false);
    expect(result.content).toBe('file1\nfile2');
  });

  it('summarizes in summary mode', async () => {
    const config = makeConfig({ defaultMode: 'summary' });
    const result = await applyToolContextMode('bash', { command: 'ls' }, 'file1\nfile2', true, config);
    expect(result.summarized).toBe(true);
    expect(result.content).toContain('[bash]');
    expect(result.originalChars).toBe(11);
  });

  it('auto mode: small output stays full', async () => {
    const config = makeConfig({ autoThresholdChars: 100 });
    const result = await applyToolContextMode('read', { path: 'a.ts' }, 'short', true, config);
    expect(result.summarized).toBe(false);
    expect(result.content).toBe('short');
  });

  it('auto mode: large output gets summarized', async () => {
    const config = makeConfig({ autoThresholdChars: 10 });
    const result = await applyToolContextMode('read', { path: 'a.ts' }, 'x'.repeat(100), true, config);
    expect(result.summarized).toBe(true);
    expect(result.content).toContain('[read]');
  });

  it('protected tools always return full', async () => {
    const config = makeConfig({ defaultMode: 'summary' });
    const result = await applyToolContextMode('question', {}, 'question data', true, config);
    expect(result.summarized).toBe(false);
    expect(result.content).toBe('question data');
  });

  it('spills to disk when spillToDisk is provided', async () => {
    const config = makeConfig({
      defaultMode: 'summary',
      spillToDisk: async () => '.CodePapr/tool-output/test.txt',
    });
    const result = await applyToolContextMode('bash', { command: 'ls' }, 'output data', true, config);
    expect(result.summarized).toBe(true);
    expect(result.spilledPath).toBe('.CodePapr/tool-output/test.txt');
    expect(result.content).toContain('read 回读');
  });

  it('handles spillToDisk failure gracefully', async () => {
    const config = makeConfig({
      defaultMode: 'summary',
      spillToDisk: async () => { throw new Error('disk full'); },
    });
    const result = await applyToolContextMode('bash', { command: 'ls' }, 'output data', true, config);
    expect(result.summarized).toBe(true);
    expect(result.spilledPath).toBeUndefined();
  });
});
