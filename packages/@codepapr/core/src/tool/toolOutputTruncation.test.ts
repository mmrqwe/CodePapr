import { describe, it, expect } from 'vitest';
import {
  truncateToolOutput,
  stringifyToolResult,
  getByteSize,
  getCharLength,
  formatMiddleTruncated,
  formatOffloadedContent,
  generateToolOutputFilename,
  type ToolOutputTruncationOptions,
} from './toolOutputTruncation';

const TIERS: ToolOutputTruncationOptions = {
  interceptChars: 100,
  middleKeepChars: 40,
  offloadChars: 200,
  offloadPreviewChars: 20,
  ceilingChars: 1000,
};

describe('stringifyToolResult', () => {
  it('returns strings as-is', () => {
    expect(stringifyToolResult('hello')).toBe('hello');
  });

  it('stringifies objects with sorted keys', () => {
    const result = stringifyToolResult({ b: 2, a: 1 });
    expect(result).toBe(JSON.stringify({ a: 1, b: 2 }));
  });

  it('strips internal fields', () => {
    const result = stringifyToolResult({ data: 'ok', __question: true, __images: [] });
    expect(result).toBe(JSON.stringify({ data: 'ok' }));
  });
});

describe('getByteSize / getCharLength', () => {
  it('counts ASCII bytes correctly', () => {
    expect(getByteSize('hello')).toBe(5);
  });

  it('counts multi-byte UTF-8 correctly', () => {
    expect(getByteSize('你好')).toBe(6);
  });

  it('counts characters (not bytes) for multi-byte content', () => {
    expect(getCharLength('你好')).toBe(2);
    expect(getCharLength('hello')).toBe(5);
  });
});

describe('formatMiddleTruncated', () => {
  it('keeps head and tail with an omission marker', () => {
    const formatted = formatMiddleTruncated('HEAD', 'TAIL', 9999);
    expect(formatted).toContain('HEAD');
    expect(formatted).toContain('TAIL');
    expect(formatted).toContain('9999');
    expect(formatted).toContain('中间已省略');
  });
});

describe('formatOffloadedContent', () => {
  it('includes preview, char count, and spill path when provided', () => {
    const formatted = formatOffloadedContent('preview text', '.CodePapr/tool-output/tool_x.txt', 238000, 'git');
    expect(formatted).toContain('preview text');
    expect(formatted).toContain('238000');
    expect(formatted).toContain('.CodePapr/tool-output/tool_x.txt');
    expect(formatted).toContain('read(');
  });

  it('includes re-call hint when no spill path', () => {
    const formatted = formatOffloadedContent('preview', undefined, 50000, 'read');
    expect(formatted).toContain('preview');
    expect(formatted).toContain('50000');
    expect(formatted).toContain('重新调用');
  });
});

describe('truncateToolOutput', () => {
  it('returns content unchanged when under interceptChars', async () => {
    const result = await truncateToolOutput('x'.repeat(50), 'git', TIERS);
    expect(result.truncated).toBe(false);
    expect(result.content).toBe('x'.repeat(50));
    expect(result.originalChars).toBe(50);
  });

  it('middle-truncates (head + tail) when between intercept and offload', async () => {
    const content = 'a'.repeat(60) + 'b'.repeat(30) + 'c'.repeat(60); // 150 chars
    const result = await truncateToolOutput(content, 'git', TIERS);
    expect(result.truncated).toBe(true);
    expect(result.originalChars).toBe(150);
    expect(result.spilledPath).toBeUndefined();
    expect(result.content).toContain('a'.repeat(20)); // head half=20
    expect(result.content).toContain('c'.repeat(20)); // tail half=20
    expect(result.content).toContain('中间已省略');
    expect(result.content).not.toContain('b'.repeat(30)); // middle dropped
  });

  it('offloads to disk with preview + path when over offloadChars', async () => {
    const spillPath = '.CodePapr/tool-output/tool_123.txt';
    const options: ToolOutputTruncationOptions = {
      ...TIERS,
      spillToDisk: async () => spillPath,
    };
    const result = await truncateToolOutput('x'.repeat(250), 'git', options);
    expect(result.truncated).toBe(true);
    expect(result.spilledPath).toBe(spillPath);
    expect(result.content).toContain(spillPath);
    expect(result.content).toContain('read(');
    expect(result.content).toContain('x'.repeat(20)); // offload preview
  });

  it('offloads without path when no spillToDisk configured', async () => {
    const result = await truncateToolOutput('x'.repeat(250), 'git', TIERS);
    expect(result.truncated).toBe(true);
    expect(result.spilledPath).toBeUndefined();
    expect(result.content).toContain('重新调用');
  });

  it('falls back to no-spill mode when spillToDisk throws', async () => {
    const options: ToolOutputTruncationOptions = {
      ...TIERS,
      spillToDisk: async () => { throw new Error('disk full'); },
    };
    const result = await truncateToolOutput('x'.repeat(250), 'git', options);
    expect(result.truncated).toBe(true);
    expect(result.spilledPath).toBeUndefined();
    expect(result.content).toContain('重新调用');
  });

  it('falls back to no-spill when spillToDisk returns null', async () => {
    const options: ToolOutputTruncationOptions = {
      ...TIERS,
      spillToDisk: async () => null,
    };
    const result = await truncateToolOutput('x'.repeat(250), 'git', options);
    expect(result.truncated).toBe(true);
    expect(result.spilledPath).toBeUndefined();
  });

  it('enforces ceilingChars even when offloadChars is configured higher', async () => {
    const options: ToolOutputTruncationOptions = {
      interceptChars: 100,
      middleKeepChars: 40,
      offloadChars: 100_000, // configured far above ceiling
      offloadPreviewChars: 20,
      ceilingChars: 120, // clamps offload down to 120
    };
    const result = await truncateToolOutput('x'.repeat(150), 'git', options);
    expect(result.truncated).toBe(true);
    // 150 > effective offload (120) → offload branch, not middle-truncate
    expect(result.content).toContain('重新调用');
    expect(result.content).not.toContain('中间已省略');
  });

  it('treats thresholds as character counts (multi-byte safe)', async () => {
    // 150 Chinese chars = 150 chars but 450 bytes; char-based → middle-truncate tier
    const content = '你'.repeat(150);
    const result = await truncateToolOutput(content, 'read', TIERS);
    expect(result.truncated).toBe(true);
    expect(result.originalChars).toBe(150);
    expect(result.content).toContain('中间已省略');
  });

  it('handles object results', async () => {
    const largeObj = { data: 'x'.repeat(250) };
    const result = await truncateToolOutput(largeObj, 'read', TIERS);
    expect(result.truncated).toBe(true);
    expect(result.originalChars).toBeGreaterThan(250);
  });
});

describe('generateToolOutputFilename', () => {
  it('generates a filename with tool name', () => {
    const filename = generateToolOutputFilename('git_status');
    expect(filename).toMatch(/^tool_\d+_[a-f0-9]{8}_git_status\.txt$/);
  });

  it('sanitizes unsafe characters in tool name', () => {
    const filename = generateToolOutputFilename('read/file');
    expect(filename).not.toContain('/');
    expect(filename).toMatch(/^tool_\d+_[a-f0-9]{8}_.*\.txt$/);
  });
});
