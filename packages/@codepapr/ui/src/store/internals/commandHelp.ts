import { BUILTIN_PROMPT_COMMANDS, type CommandDefinition } from '@codepapr/core';

export function formatCommandSummary(command: Pick<CommandDefinition, 'name' | 'description'>): string {
  return `/${command.name}${command.description ? `: ${command.description}` : ''}`;
}

export function buildCommandHelpMessage(customCommands: readonly CommandDefinition[]): string {
  const lines = [
    '本地命令:',
    '/help: 查看命令说明',
    '/commands: 查看命令说明',
    '/compact: 强制压缩对话上下文',
    '/goal exec:<验证命令>: 启动 Goal 自主循环（Worker+Verifier 双模型，直到验证条件通过）',
  ];

  if (BUILTIN_PROMPT_COMMANDS.length > 0) {
    lines.push('', '内置任务命令:');
    for (const command of BUILTIN_PROMPT_COMMANDS) {
      lines.push(formatCommandSummary(command));
    }
  }

  if (customCommands.length > 0) {
    lines.push('', '项目命令:');
    for (const command of customCommands) {
      lines.push(formatCommandSummary(command));
    }
  } else {
    lines.push('', '项目命令: 当前没有自定义命令（在 .CodePapr/commands/ 添加 *.md）');
  }

  return lines.join('\n');
}
