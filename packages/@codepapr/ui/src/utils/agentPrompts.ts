import {
  buildModeSystemPrompt as buildSharedModeSystemPrompt,
  buildRuntimeUserPrompt,
  DEFAULT_PROMPT_TOOL_NAMES,
  type PromptLang,
} from '@codepapr/core';
import type { Lang } from './i18n';
import type { ProjectDiagnosticsReport } from './projectDiagnostics';
import { parseProjectDiagnosticLocations } from './projectDiagnosticLocations';

export type WorkMode = 'agent' | 'plan' | 'ask';

const SECTION_LABELS: Record<
  PromptLang,
  {
    diagnostics: string;
  }
> = {
  'zh-CN': {
    diagnostics: '## 项目诊断',
  },
  'zh-TW': {
    diagnostics: '## 項目診斷',
  },
  en: {
    diagnostics: '## Project Diagnostics',
  },
};

const PROJECT_DIAGNOSTICS_COPY: Record<
  PromptLang,
  {
    overall: (status: ProjectDiagnosticsReport['overallStatus']) => string;
    unavailable: (message: string) => string;
    stage: (params: {
      label: string;
      command: string;
      status: number | null;
      timedOut: boolean;
      success: boolean;
      fallback: boolean;
    }) => string;
    locations: string;
  }
> = {
  'zh-CN': {
    overall: (status) =>
      status === 'passed'
        ? '最新项目诊断：通过。'
        : status === 'failed'
        ? '最新项目诊断：失败。'
        : '最新项目诊断：不可用。',
    unavailable: (message) => `项目诊断不可用：${message}`,
    stage: ({ label, command, status, timedOut, success, fallback }) =>
      `- ${label}: ${success ? '通过' : '失败'}（${command}，${timedOut ? '超时' : `退出码 ${status ?? 'unknown'}`}${fallback ? '，build fallback' : ''}）`,
    locations: '- 关键定位：',
  },
  'zh-TW': {
    overall: (status) =>
      status === 'passed'
        ? '最新項目診斷：通過。'
        : status === 'failed'
        ? '最新項目診斷：失敗。'
        : '最新項目診斷：不可用。',
    unavailable: (message) => `項目診斷不可用：${message}`,
    stage: ({ label, command, status, timedOut, success, fallback }) =>
      `- ${label}: ${success ? '通過' : '失敗'}（${command}，${timedOut ? '超時' : `退出碼 ${status ?? 'unknown'}`}${fallback ? '，build fallback' : ''}）`,
    locations: '- 關鍵定位：',
  },
  en: {
    overall: (status) =>
      status === 'passed'
        ? 'Latest project diagnostics: passed.'
        : status === 'failed'
        ? 'Latest project diagnostics: failed.'
        : 'Latest project diagnostics: unavailable.',
    unavailable: (message) => `Project diagnostics unavailable: ${message}`,
    stage: ({ label, command, status, timedOut, success, fallback }) =>
      `- ${label}: ${success ? 'passed' : 'failed'} (${command}, ${timedOut ? 'timed out' : `exit ${status ?? 'unknown'}`}${fallback ? ', build fallback' : ''})`,
    locations: '- Key locations:',
  },
};

function normalizeLang(lang: Lang = 'zh-CN'): PromptLang {
  return lang === 'en' || lang === 'zh-TW' ? lang : 'zh-CN';
}

export const MODE_PROMPTS: Record<WorkMode, string> = {
  ask: buildSharedModeSystemPrompt({
    mode: 'ask',
    workspacePath: '/tmp/project',
    lang: 'zh-CN',
    toolNames: DEFAULT_PROMPT_TOOL_NAMES,
  }),
  plan: buildSharedModeSystemPrompt({
    mode: 'plan',
    workspacePath: '/tmp/project',
    lang: 'zh-CN',
    toolNames: DEFAULT_PROMPT_TOOL_NAMES,
  }),
  agent: buildSharedModeSystemPrompt({
    mode: 'agent',
    workspacePath: '/tmp/project',
    lang: 'zh-CN',
    toolNames: DEFAULT_PROMPT_TOOL_NAMES,
  }),
};

export function buildProjectDiagnosticsPromptSection(params: {
  lang: Lang;
  workspacePath: string;
  projectDiagnosticsReport?: ProjectDiagnosticsReport | null;
}): string[] {
  const promptLang = normalizeLang(params.lang);
  const report = params.projectDiagnosticsReport;
  if (!report) {
    return [];
  }

  const copy = PROJECT_DIAGNOSTICS_COPY[promptLang];
  const lines = [SECTION_LABELS[promptLang].diagnostics];

  if (!report.available) {
    lines.push(copy.overall(report.overallStatus));
    lines.push(copy.unavailable(report.message ?? 'unknown'));
    return lines;
  }

  lines.push(copy.overall(report.overallStatus));
  for (const stage of report.stages) {
    lines.push(
      copy.stage({
        label: stage.label,
        command: [stage.command, ...stage.args].join(' '),
        status: stage.status,
        timedOut: stage.timedOut,
        success: stage.success,
        fallback: stage.fallback,
      })
    );
  }

  const locations = report.stages
    .flatMap((stage) => parseProjectDiagnosticLocations(params.workspacePath, stage))
    .slice(0, 8);
  if (locations.length > 0) {
    lines.push(copy.locations);
    for (const location of locations) {
      lines.push(`- ${location.path}:${location.line}:${location.column} ${location.message}`);
    }
  }

  return lines;
}

function buildProjectDiagnosticsPromptBody(params: {
  lang: Lang;
  workspacePath: string;
  projectDiagnosticsReport?: ProjectDiagnosticsReport | null;
}): string {
  const lines = buildProjectDiagnosticsPromptSection(params);
  return lines.length > 1 ? lines.slice(1).join('\n') : '';
}

export function buildModeSystemPrompt(
  mode: WorkMode,
  workspacePath: string,
  lang: Lang = 'zh-CN',
  projectDiagnosticsReport?: ProjectDiagnosticsReport | null
): string {
  const promptLang = normalizeLang(lang);
  const diagnosticsSection =
    mode === 'ask'
      ? []
      : buildProjectDiagnosticsPromptSection({
          lang: promptLang,
          workspacePath,
          projectDiagnosticsReport,
        });

  return [
    buildSharedModeSystemPrompt({
      mode,
      workspacePath,
      lang: promptLang,
      toolNames: DEFAULT_PROMPT_TOOL_NAMES,
    }),
    ...diagnosticsSection,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function buildModePrompt(
  mode: WorkMode,
  workspacePath: string,
  input: string,
  lang: Lang = 'zh-CN',
  projectDiagnosticsReport?: ProjectDiagnosticsReport | null
): string {
  const promptLang = normalizeLang(lang);
  const diagnosticsSection =
    mode === 'ask'
      ? ''
      : buildProjectDiagnosticsPromptBody({
          lang: promptLang,
          workspacePath,
          projectDiagnosticsReport,
        });

  return buildRuntimeUserPrompt({
    mode,
    input,
    workspacePath,
    lang: promptLang,
    diagnosticsSection,
  });
}
