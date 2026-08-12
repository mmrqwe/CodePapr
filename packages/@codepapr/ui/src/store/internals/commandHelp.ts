import { BUILTIN_PROMPT_COMMANDS, type CommandDefinition } from '@codepapr/core';
import { getTranslation, type Lang } from '../../utils/i18n';

export function formatCommandSummary(command: Pick<CommandDefinition, 'name' | 'description'>): string {
  return `/${command.name}${command.description ? `: ${command.description}` : ''}`;
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
    t.commandHelpGoal,
  ];

  if (BUILTIN_PROMPT_COMMANDS.length > 0) {
    lines.push('', t.commandHelpBuiltinLabel);
    for (const command of BUILTIN_PROMPT_COMMANDS) {
      lines.push(formatCommandSummary(command));
    }
  }

  if (customCommands.length > 0) {
    lines.push('', t.commandHelpProjectLabel);
    for (const command of customCommands) {
      lines.push(formatCommandSummary(command));
    }
  } else {
    lines.push('', t.commandHelpProjectEmpty);
  }

  return lines.join('\n');
}
