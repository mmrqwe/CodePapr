import {
  BUILTIN_PROMPT_COMMANDS,
  resolveCommandDescription,
  type CommandDefinition,
} from '@codepapr/core';
import { getTranslation, type Lang } from '../../utils/i18n';

export function formatCommandSummary(command: CommandDefinition, lang?: Lang): string {
  const description = resolveCommandDescription(command, lang);
  return `/${command.name}${description ? `: ${description}` : ''}`;
}

export function buildCommandHelpMessage(
  customCommands: readonly CommandDefinition[],
  lang: Lang = 'zh-CN'
): string {
  const t = getTranslation(lang);
  const lines = [
    `${t.commandHelpLocalLabel}`,
    t.commandHelpHelp,
    t.commandHelpCompact,
    t.commandHelpUndo,
    t.commandHelpGoal,
  ];

  if (BUILTIN_PROMPT_COMMANDS.length > 0) {
    lines.push('', t.commandHelpBuiltinLabel);
    for (const command of BUILTIN_PROMPT_COMMANDS) {
      lines.push(formatCommandSummary(command, lang));
    }
  }

  if (customCommands.length > 0) {
    lines.push('', t.commandHelpProjectLabel);
    for (const command of customCommands) {
      lines.push(formatCommandSummary(command, lang));
    }
  } else {
    lines.push('', t.commandHelpProjectEmpty);
  }

  return lines.join('\n');
}
