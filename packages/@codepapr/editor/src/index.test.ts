import { describe, it, expect } from 'vitest';
import {
  createPromptEditorConfig,
  createWorkflowEditorConfig,
  validateStaticPrompt,
  markerSeverityToValue,
  type MonacoExternalMarker,
} from './index';

describe('createPromptEditorConfig', () => {
  it('returns defaults when no options provided', () => {
    const cfg = createPromptEditorConfig();
    expect(cfg.language).toBe('markdown');
    expect(cfg.theme).toBe('vs-dark');
    expect(cfg.fontSize).toBe(14);
    expect(cfg.wordWrap).toBe('on');
  });

  it('honours partial overrides', () => {
    const cfg = createPromptEditorConfig({ language: 'typescript', fontSize: 18 });
    expect(cfg.language).toBe('typescript');
    expect(cfg.fontSize).toBe(18);
    expect(cfg.theme).toBe('vs-dark'); // untouched
  });
});

describe('createWorkflowEditorConfig', () => {
  it('returns defaults when no options provided', () => {
    const cfg = createWorkflowEditorConfig();
    expect(cfg.language).toBe('yaml');
    expect(cfg.theme).toBe('vs-dark');
    expect(cfg.fontSize).toBe(13);
    expect(cfg.wordWrap).toBe('off');
  });
});

describe('validateStaticPrompt', () => {
  it('passes for plain text', () => {
    const result = validateStaticPrompt('You are a helpful coding agent.');
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('detects ${var} templates', () => {
    const result = validateStaticPrompt('Hello ${name}');
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBe(1);
    expect(result.issues[0]).toContain('${var}');
  });

  it('detects {{var}} templates', () => {
    const result = validateStaticPrompt('Hello {{name}}');
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBe(1);
  });

  it('detects [TIMESTAMP] placeholder', () => {
    const result = validateStaticPrompt('Time: [TIMESTAMP]');
    expect(result.valid).toBe(false);
    expect(result.issues[0]).toContain('TIMESTAMP');
  });

  it('detects [DATE] placeholder', () => {
    const result = validateStaticPrompt('Date: [DATE]');
    expect(result.valid).toBe(false);
    expect(result.issues[0]).toContain('DATE');
  });

  it('detects ISO timestamps like the core ImmutablePrefix guard', () => {
    const result = validateStaticPrompt('示例时间：2024-01-01T12:00');
    expect(result.valid).toBe(false);
    expect(result.issues[0]).toContain('ISO');
  });

  it('detects multiple patterns at once', () => {
    // 注意 [TIMESTAMP] 同时命中 [TIMESTAMP] 与 [TIME 两条模式，故为 6 条
    const result = validateStaticPrompt('${a} {{b}} [TIMESTAMP] [DATE] [SESSION_ID]');
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBe(6);
  });

  it('repeated calls give stable results (no lastIndex drift from /g flags)', () => {
    const prompt = 'Hello ${name}';
    for (let i = 0; i < 3; i++) {
      expect(validateStaticPrompt(prompt).valid).toBe(false);
    }
  });
});

describe('markerSeverityToValue', () => {
  it('maps error to 8', () => {
    expect(markerSeverityToValue('error')).toBe(8);
  });

  it('maps warning to 4', () => {
    expect(markerSeverityToValue('warning')).toBe(4);
  });

  it('maps info to 2', () => {
    expect(markerSeverityToValue('info')).toBe(2);
  });

  it('maps hint to 1', () => {
    expect(markerSeverityToValue('hint')).toBe(1);
  });

  it('falls back to info (2) for unknown', () => {
    expect(markerSeverityToValue('unknown' as never)).toBe(2);
  });
});

describe('MonacoExternalMarker type', () => {
  it('can be constructed as a plain object', () => {
    const marker: MonacoExternalMarker = {
      severity: 'error',
      message: 'syntax error',
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 5,
      source: 'test',
    };
    expect(marker.severity).toBe('error');
    expect(marker.source).toBe('test');
  });
});
