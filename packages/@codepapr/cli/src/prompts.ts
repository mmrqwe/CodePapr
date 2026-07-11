import {
  buildModeSystemPrompt as buildSharedModeSystemPrompt,
  buildSessionBootstrapPrompt,
  buildRuntimeUserPrompt,
  DEFAULT_CODING_SYSTEM_PROMPT,
  DEFAULT_PROMPT_TOOL_NAMES,
} from '@codepapr/core';

export type CliMode = 'ask' | 'plan' | 'agent';

export { DEFAULT_CODING_SYSTEM_PROMPT };

export function buildModeSystemPrompt(mode: CliMode, workspacePath: string): string {
  return buildSharedModeSystemPrompt({
    mode,
    workspacePath,
    lang: 'zh-CN',
    toolNames: DEFAULT_PROMPT_TOOL_NAMES,
  });
}

export function buildModePrompt(mode: CliMode, workspacePath: string, input: string): string {
  return buildRuntimeUserPrompt({
    mode,
    input,
    workspacePath,
    lang: 'zh-CN',
  });
}

export function buildCliSessionBootstrapPrompt(
  workspacePath: string,
  customPrompt: string,
  skillsSection?: string,
  projectGraphSummary?: string
): string {
  return buildSessionBootstrapPrompt({
    workspacePath,
    lang: 'zh-CN',
    skillsSection,
    customPromptSection: customPrompt,
    projectGraphSummary,
  });
}
