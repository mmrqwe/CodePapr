import { describe, it, expect } from 'vitest';
import {
  truncateToolOutput,
  stringifyToolResult,
  getByteSize,
  formatTruncatedContent,
  generateToolOutputFilename,
  type ToolOutputTruncationOptions,
} from './toolOutputTruncation';

const NO_SPILL: ToolOutputTruncationOptions = {
  maxBytes: 100,
  previewChars: 20,
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

describe('getByteSize', () => {
  it('counts ASCII bytes correctly', () => {
    expect(getByteSize('hello')).toBe(5);
  });

  it('counts multi-byte UTF-8 correctly', () => {
    expect(getByteSize('你好')).toBe(6);
  });
});

describe('formatTruncatedContent', () => {
  it('includes preview, size, and spill path when provided', () => {
    const formatted = formatTruncatedContent('preview text', '.CodePapr/tool-output/tool_x.txt', 238000, 'git');
    expect(formatted).toContain('preview text');
    expect(formatted).toContain('238KB');
    expect(formatted).toContain('.CodePapr/tool-output/tool_x.txt');
    expect(formatted).toContain('read(');
  });

  it('includes re-call hint when no spill path', () => {
    const formatted = formatTruncatedContent('preview', undefined, 50000, 'read');
    expect(formatted).toContain('preview');
    expect(formatted).toContain('50KB');
    expect(formatted).toContain('read');
    expect(formatted).toContain('重新调用');
  });
});

describe('truncateToolOutput', () => {
  it('returns content unchanged when under maxBytes', async () => {
    const result = await truncateToolOutput('small', 'git', NO_SPILL);
    expect(result.truncated).toBe(false);
    expect(result.content).toBe('small');
    expect(result.originalSize).toBe(5);
  });

  it('truncates content when over maxBytes without spill', async () => {
    const large = 'x'.repeat(200);
    const result = await truncateToolOutput(large, 'git', NO_SPILL);
    expect(result.truncated).toBe(true);
    expect(result.originalSize).toBe(200);
    expect(result.content).toContain('xxxxxxxxxxxxxxxxxxxx');
    expect(result.content).toContain('已截断');
    expect(result.content).toContain('重新调用');
    expect(result.spilledPath).toBeUndefined();
  });

  it('spills to disk and includes path when spillToDisk is provided', async () => {
    const large = 'x'.repeat(200);
    const spillPath = '.CodePapr/tool-output/tool_123.txt';
    const options: ToolOutputTruncationOptions = {
      maxBytes: 100,
      previewChars: 20,
      spillToDisk: async () => spillPath,
    };
    const result = await truncateToolOutput(large, 'git', options);
    expect(result.truncated).toBe(true);
    expect(result.spilledPath).toBe(spillPath);
    expect(result.content).toContain(spillPath);
    expect(result.content).toContain('read(');
  });

  it('falls back to no-spill mode when spillToDisk throws', async () => {
    const large = 'x'.repeat(200);
    const options: ToolOutputTruncationOptions = {
      maxBytes: 100,
      previewChars: 20,
      spillToDisk: async () => { throw new Error('disk full'); },
    };
    const result = await truncateToolOutput(large, 'git', options);
    expect(result.truncated).toBe(true);
    expect(result.spilledPath).toBeUndefined();
    expect(result.content).toContain('重新调用');
  });

  it('falls back to no-spill when spillToDisk returns null', async () => {
    const large = 'x'.repeat(200);
    const options: ToolOutputTruncationOptions = {
      maxBytes: 100,
      previewChars: 20,
      spillToDisk: async () => null,
    };
    const result = await truncateToolOutput(large, 'git', options);
    expect(result.truncated).toBe(true);
    expect(result.spilledPath).toBeUndefined();
  });

  it('handles object results', async () => {
    const largeObj = { data: 'x'.repeat(200) };
    const result = await truncateToolOutput(largeObj, 'read', NO_SPILL);
    expect(result.truncated).toBe(true);
    expect(result.originalSize).toBeGreaterThan(200);
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
