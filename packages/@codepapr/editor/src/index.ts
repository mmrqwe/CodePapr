/**
 * @codepapr/editor: Monaco Editor 抽象层
 *
 * 编辑器域类型、配置工厂与纯逻辑。所有 Monaco 渲染（React 组件）留在 @codepapr/ui；
 * 本包仅提供与框架无关的类型与配置，作为 ui / cli / 未来其它入口共享的编辑器契约。
 */

// ─── 编辑器配置 ───────────────────────────────────────────────

export interface MonacoConfig {
  language: 'typescript' | 'json' | 'yaml' | 'markdown';
  theme: 'vs' | 'vs-dark' | 'hc-black';
  fontSize?: number;
  wordWrap?: 'on' | 'off';
}

export interface PromptEditorOptions extends MonacoConfig {
  initialValue: string;
  onChange: (value: string) => void;
  onSave: (value: string) => Promise<void>;
}

export interface WorkflowEditorOptions extends MonacoConfig {
  initialWorkflow: string;
  schema?: object;
  onValidate: (errors: string[]) => void;
}

export function createPromptEditorConfig(opts: Partial<PromptEditorOptions> = {}): MonacoConfig {
  return {
    language: opts.language ?? 'markdown',
    theme: opts.theme ?? 'vs-dark',
    fontSize: opts.fontSize ?? 14,
    wordWrap: opts.wordWrap ?? 'on',
  };
}

export function createWorkflowEditorConfig(opts: Partial<WorkflowEditorOptions> = {}): MonacoConfig {
  return {
    language: opts.language ?? 'yaml',
    theme: opts.theme ?? 'vs-dark',
    fontSize: opts.fontSize ?? 13,
    wordWrap: opts.wordWrap ?? 'off',
  };
}

// ─── 外部标记 / 位置 / 导航（与 Monaco 枚举解耦的纯类型）────────

export type MarkerSeverity = 'error' | 'warning' | 'info' | 'hint';

export interface MonacoExternalMarker {
  severity: MarkerSeverity;
  message: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  source?: string;
}

export interface MonacoEditorPosition {
  lineNumber: number;
  column: number;
}

export interface MonacoEditorNavigationLocation {
  uri: string;
  lineNumber: number;
  column: number;
  endLineNumber?: number;
  endColumn?: number;
}

export interface MonacoLspHoverResult {
  contents: string[];
  range?: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
}

// ─── 提示词校验 ───────────────────────────────────────────────

import { STATIC_CONTENT_FORBIDDEN_PATTERNS } from '@codepapr/common';

/**
 * 校验提示词不包含模板占位符（缓存破坏者）
 *
 * 与 `@codepapr/core` 的 `ImmutablePrefix.validateStaticContent` 共用同一份
 * 模式表（`STATIC_CONTENT_FORBIDDEN_PATTERNS`），两处关卡语义保持一致。
 */
export function validateStaticPrompt(prompt: string): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  for (const { re, name } of STATIC_CONTENT_FORBIDDEN_PATTERNS) {
    if (re.test(prompt)) {
      issues.push(`检测到动态内容: ${name} — 会破坏缓存一致性`);
    }
  }
  return { valid: issues.length === 0, issues };
}

// ─── 工具：标记严重程度数值映射 ─────────────────────────────────

/**
 * 将字符串严重程度映射为数值（与 monaco.MarkerSeverity 枚举一致）。
 * 让 ui 包不必重复维护这份映射，同时不直接依赖 monaco-editor 类型。
 */
export function markerSeverityToValue(severity: MarkerSeverity): number {
  switch (severity) {
    case 'error':
      return 8;
    case 'warning':
      return 4;
    case 'info':
      return 2;
    case 'hint':
      return 1;
    default:
      return 2;
  }
}
