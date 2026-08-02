import { describe, it, expect } from 'vitest';
import type { IMessage } from '@codepapr/types';
import {
  resolveToolContextMode,
  summarizeToolOutput,
  prepareHistorySummary,
  applyHistoryToolSummaries,
  headTailPreview,
  TOOL_SUMMARY_METADATA_KEY,
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
    const config = makeConfig({ overrides: { bash: 'summary' } });
    expect(resolveToolContextMode('bash', config)).toBe('summary');
  });

  it('falls back to defaultMode for tools without override', () => {
    const config = makeConfig({ defaultMode: 'full' });
    expect(resolveToolContextMode('bash', config)).toBe('full');
    expect(resolveToolContextMode('read', config)).toBe('full');
    expect(resolveToolContextMode('unknown_tool', config)).toBe('full');
  });
});

describe('headTailPreview', () => {
  it('shows a single block when output is short', () => {
    const preview = headTailPreview('a\nb\nc');
    expect(preview).toContain('全文 3 行:');
    expect(preview).toContain('a\nb\nc');
  });

  it('shows head and tail for long output', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    const preview = headTailPreview(lines.join('\n'));
    expect(preview).toContain('前 3 行:');
    expect(preview).toContain('line1');
    expect(preview).toContain('后 3 行:');
    expect(preview).toContain('line20');
    expect(preview).not.toContain('line10');
  });
});

describe('summarizeToolOutput', () => {
  it('summarizes bash output with head and tail', () => {
    const output = Array.from({ length: 20 }, (_, i) => `out${i + 1}`).join('\n');
    const summary = summarizeToolOutput('bash', { command: 'npm run build' }, output, true, 500);
    expect(summary).toContain('[bash] ✓ | npm run build');
    expect(summary).toContain('20 行');
    expect(summary).toContain('out1');
    expect(summary).toContain('out20');
  });

  it('summarizes failed bash output', () => {
    const summary = summarizeToolOutput('bash', { command: 'npm test' }, { error: 'Test failed' }, false, 500);
    expect(summary).toContain('✗');
  });

  it('summarizes read output with relativePath and range suffix', () => {
    const summary = summarizeToolOutput(
      'read',
      { relativePath: 'src/main.ts', startLine: 10, endLine: 40 },
      'line1\nline2\nline3',
      true,
      500
    );
    expect(summary).toContain('[read] ✓ | src/main.ts (L10-40)');
    expect(summary).toContain('3 行');
  });

  it('summarizes read output with symbol suffix', () => {
    const summary = summarizeToolOutput(
      'read',
      { relativePath: 'src/main.ts', symbol: 'buildAll' },
      'code',
      true,
      500
    );
    expect(summary).toContain('(symbol: buildAll)');
  });

  it('falls back to legacy path arg names', () => {
    const summary = summarizeToolOutput('read', { path: 'old.ts' }, 'x', true, 500);
    expect(summary).toContain('old.ts');
  });

  it('summarizes write output', () => {
    const summary = summarizeToolOutput(
      'write',
      { relativePath: 'src/utils.ts', content: 'hello world' },
      'OK',
      true,
      500
    );
    expect(summary).toContain('[write] ✓ | src/utils.ts');
    expect(summary).toContain('11 字符');
  });

  it('summarizes edit output with old/new char counts', () => {
    const summary = summarizeToolOutput(
      'edit',
      { relativePath: 'src/a.ts', search: 'foo', replace: 'barbaz' },
      'OK',
      true,
      500
    );
    expect(summary).toBe('[edit] ✓ | src/a.ts | -3/+6 字符');
  });

  it('summarizes patch output with file/block/char stats', () => {
    const summary = summarizeToolOutput(
      'patch',
      {
        patches: [
          { relativePath: 'a.ts', search: 'xx', replace: 'yyyy' },
          { relativePath: 'a.ts', search: 'z', replace: 'w' },
          { relativePath: 'b.ts', search: 'q', replace: '' },
        ],
      },
      'OK',
      true,
      500
    );
    expect(summary).toBe('[patch] ✓ | 2 个文件 / 3 块 | -4/+5 字符');
  });

  it('summarizes grep output using query arg', () => {
    const summary = summarizeToolOutput(
      'grep',
      { query: 'TODO' },
      'file1.ts:1: TODO fix\nfile2.ts:5: TODO cleanup',
      true,
      500
    );
    expect(summary).toContain('[grep] ✓ | TODO');
    expect(summary).toContain('2 条匹配');
  });

  it('marks semantic grep', () => {
    const summary = summarizeToolOutput('grep', { query: 'Agent', semantic: true }, 'a\nb', true, 500);
    expect(summary).toContain('(语义)');
  });

  it('summarizes glob output using query arg', () => {
    const summary = summarizeToolOutput('glob', { query: '**/*.ts' }, 'src/a.ts\nsrc/b.ts', true, 500);
    expect(summary).toContain('[glob] ✓ | **/*.ts');
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
    const summary = summarizeToolOutput('custom_tool', { foo: 'bar' }, 'some output', true, 500);
    expect(summary).toContain('[custom_tool]');
    expect(summary).toContain('✓');
  });

  it('respects maxChars limit', () => {
    const summary = summarizeToolOutput('bash', { command: 'echo test' }, 'x'.repeat(1000), true, 50);
    expect(summary.length).toBeLessThanOrEqual(51);
  });
});

describe('prepareHistorySummary', () => {
  const input = {
    toolName: 'bash',
    args: { command: 'ls' },
    result: 'file1\nfile2',
    success: true,
    originalChars: 11,
  };

  it('returns undefined in full mode', () => {
    const config = makeConfig({ defaultMode: 'full' });
    expect(prepareHistorySummary(input, config)).toBeUndefined();
  });

  it('returns a frozen summary in summary mode', () => {
    const config = makeConfig({ defaultMode: 'summary' });
    const summary = prepareHistorySummary(input, config);
    expect(summary).toContain('[bash]');
  });

  it('auto mode: small output stays full (undefined)', () => {
    const config = makeConfig({ autoThresholdChars: 100 });
    expect(prepareHistorySummary(input, config)).toBeUndefined();
  });

  it('auto mode: large output gets summarized', () => {
    const config = makeConfig({ autoThresholdChars: 10 });
    const summary = prepareHistorySummary({ ...input, originalChars: 100 }, config);
    expect(summary).toContain('[bash]');
  });

  it('protected tools never get a summary', () => {
    const config = makeConfig({ defaultMode: 'summary' });
    expect(
      prepareHistorySummary({ ...input, toolName: 'question', originalChars: 10_000 }, config)
    ).toBeUndefined();
  });

  it('appends the reused spill path as a read-back pointer', () => {
    const config = makeConfig({ defaultMode: 'summary' });
    const summary = prepareHistorySummary(
      { ...input, spilledPath: '.CodePapr/tool-output/test.txt' },
      config
    );
    expect(summary).toContain('完整输出: .CodePapr/tool-output/test.txt（可用 read 回读）');
  });
});

function toolMsg(toolCallId: string, content: string, summary?: string): IMessage {
  return {
    id: `tool-${toolCallId}`,
    role: 'tool',
    content,
    timestamp: 1,
    toolResult: { toolCallId, success: true, result: content },
    ...(summary ? { metadata: { [TOOL_SUMMARY_METADATA_KEY]: summary } } : {}),
  };
}

function assistantMsg(id: string, toolCallIds: string[]): IMessage {
  return {
    id: `assistant-${id}`,
    role: 'assistant',
    content: '',
    timestamp: 1,
    toolCalls: toolCallIds.map((tcId) => ({ id: tcId, name: 'read', arguments: {} })),
  };
}

describe('applyHistoryToolSummaries', () => {
  it('keeps the latest tool batch full and summarizes older results', () => {
    const messages: IMessage[] = [
      assistantMsg('a1', ['t1']),
      toolMsg('t1', 'full-1', '[read] summary-1'),
      assistantMsg('a2', ['t2']),
      toolMsg('t2', 'full-2', '[read] summary-2'),
    ];
    const result = applyHistoryToolSummaries(messages);
    expect(result[1]!.content).toBe('[read] summary-1');
    expect(result[3]!.content).toBe('full-2');
  });

  it('also replaces toolResult.result for summarized messages', () => {
    const messages: IMessage[] = [
      assistantMsg('a1', ['t1']),
      toolMsg('t1', 'full-1', '[read] summary-1'),
      assistantMsg('a2', ['t2']),
      toolMsg('t2', 'full-2'),
    ];
    const result = applyHistoryToolSummaries(messages);
    expect(result[1]!.toolResult?.result).toBe('[read] summary-1');
    expect(result[3]!.toolResult?.result).toBe('full-2');
  });

  it('keeps the latest batch full even after a later user turn', () => {
    const messages: IMessage[] = [
      assistantMsg('a1', ['t1']),
      toolMsg('t1', 'full-1', '[read] summary-1'),
      { id: 'u2', role: 'user', content: 'next question', timestamp: 2 },
    ];
    const result = applyHistoryToolSummaries(messages);
    expect(result[1]!.content).toBe('full-1');
  });

  it('does not touch messages without a frozen summary', () => {
    const messages: IMessage[] = [
      assistantMsg('a1', ['t1']),
      toolMsg('t1', 'full-1'),
      assistantMsg('a2', ['t2']),
      toolMsg('t2', 'full-2'),
    ];
    const result = applyHistoryToolSummaries(messages);
    expect(result).toBe(messages);
  });

  it('keeps parallel tool calls of the latest round full together', () => {
    const messages: IMessage[] = [
      assistantMsg('a1', ['t1']),
      toolMsg('t1', 'full-1', '[read] summary-1'),
      assistantMsg('a2', ['t2', 't3']),
      toolMsg('t2', 'full-2', '[read] summary-2'),
      toolMsg('t3', 'full-3', '[read] summary-3'),
    ];
    const result = applyHistoryToolSummaries(messages);
    expect(result[1]!.content).toBe('[read] summary-1');
    expect(result[3]!.content).toBe('full-2');
    expect(result[4]!.content).toBe('full-3');
  });

  it('is deterministic for identical input (byte-stable requests)', () => {
    const messages: IMessage[] = [
      assistantMsg('a1', ['t1']),
      toolMsg('t1', 'full-1', '[read] summary-1'),
      assistantMsg('a2', ['t2']),
      toolMsg('t2', 'full-2', '[read] summary-2'),
    ];
    const first = JSON.stringify(applyHistoryToolSummaries(messages));
    const second = JSON.stringify(applyHistoryToolSummaries(messages));
    expect(first).toBe(second);
  });
});
