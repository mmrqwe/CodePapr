import type { IChatRequest, IChatResponse, ILLMProvider, IMessage } from '@codepapr/types';

function buildResponse(
  request: IChatRequest,
  content: string,
  toolCalls?: IChatResponse['choices'][0]['message']['toolCalls']
): IChatResponse {
  return {
    id: `test-${Date.now()}`,
    choices: [
      {
        message: {
          role: 'assistant',
          content,
          toolCalls,
        },
        finishReason: toolCalls?.length ? 'tool_calls' : 'stop',
      },
    ],
    usage: {
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      input_tokens: Math.max(1, request.messages.length * 8),
      output_tokens: Math.max(1, Math.ceil(content.length / 4)),
    },
  };
}

function findLastMessage(messages: readonly IMessage[], role: IMessage['role']): IMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === role) {
      return messages[index] ?? null;
    }
  }

  return null;
}

function parseJsonContent(message: IMessage | null): unknown {
  if (!message) {
    return null;
  }

  try {
    return JSON.parse(message.content) as unknown;
  } catch {
    return message.content;
  }
}

function formatSearchResult(result: unknown): string {
  if (!result || typeof result !== 'object' || !('matches' in result)) {
    return '未找到目标文件';
  }

  const matches = Array.isArray((result as { matches?: unknown }).matches)
    ? ((result as { matches: Array<{ path?: unknown }> }).matches ?? [])
    : [];
  const firstPath = matches.find((entry) => typeof entry.path === 'string')?.path;
  return typeof firstPath === 'string' ? `已找到文件：${firstPath}` : '未找到目标文件';
}

function formatCommandResult(result: unknown): string {
  if (!result || typeof result !== 'object') {
    return '命令已执行，但没有输出';
  }

  const stdout = typeof (result as { stdout?: unknown }).stdout === 'string' ? (result as { stdout: string }).stdout : '';
  const trimmed = stdout.trim();
  return trimmed ? `命令输出：${trimmed}` : '命令已执行，但没有输出';
}

export class ScriptedTestProvider implements ILLMProvider {
  readonly name = 'scripted-test-provider';
  readonly models = ['test-scripted'];

  validate(): boolean {
    return true;
  }

  async chat(request: IChatRequest): Promise<IChatResponse> {
    const lastUser = findLastMessage(request.messages, 'user');
    const lastTool = findLastMessage(request.messages, 'tool');
    const lastToolCallId = lastTool?.toolResult?.toolCallId;

    if (lastToolCallId === 'tool-search-file') {
      return buildResponse(request, formatSearchResult(parseJsonContent(lastTool)));
    }

    if (lastToolCallId === 'tool-run-command') {
      return buildResponse(request, formatCommandResult(parseJsonContent(lastTool)));
    }

    const prompt = String(lastUser?.content ?? '');
    if (prompt.includes('needle.txt')) {
      return buildResponse(request, '', [
        {
          id: 'tool-search-file',
          name: 'workspace_search_files',
          arguments: {
            query: 'needle.txt',
          },
        },
      ]);
    }

    if (prompt.includes('pwd')) {
      return buildResponse(request, '', [
        {
          id: 'tool-run-command',
          name: 'workspace_run_command',
          arguments: {
            command: 'pwd',
          },
        },
      ]);
    }

    return buildResponse(request, 'scripted test provider ready');
  }
}
