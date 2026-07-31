import { Serializer } from '@codepapr/core';
import { createId } from '../../utils/createId';
import type { AgentRuntimeStreamEvent } from '../../agent/WorkerBackedAgent';
import type { StoreSet, UIMessage, UIToolInvocation } from './types';

export function appendErrorMessage(set: StoreSet, content: string): void {
  const errorMsg: UIMessage = {
    id: createId(),
    role: 'error',
    content,
    timestamp: Date.now(),
  };

  set((s) => {
    const sessionId = s.activeSessionId;
    const currentSessionMessages = sessionId
      ? s.sessionMessages[sessionId] ?? s.messages
      : s.messages;
    const nextMessages = [...currentSessionMessages, errorMsg];

    return {
      messages: nextMessages,
      sessionMessages: sessionId
        ? {
            ...s.sessionMessages,
            [sessionId]: nextMessages,
          }
        : s.sessionMessages,
      isLoading: false,
    };
  });
}

/** 追加一条仅展示、不进入模型上下文的信息消息（用于 --help 等本地命令反馈）。 */
export function appendInfoMessage(set: StoreSet, content: string): void {
  const infoMsg: UIMessage = {
    id: createId(),
    role: 'assistant',
    content,
    timestamp: Date.now(),
    synthetic: true,
    carryForwardInContext: false,
  };

  set((s) => {
    const sessionId = s.activeSessionId;
    const currentSessionMessages = sessionId
      ? s.sessionMessages[sessionId] ?? s.messages
      : s.messages;
    const nextMessages = [...currentSessionMessages, infoMsg];

    return {
      messages: nextMessages,
      sessionMessages: sessionId
        ? {
            ...s.sessionMessages,
            [sessionId]: nextMessages,
          }
        : s.sessionMessages,
      isLoading: false,
    };
  });
}

export function updateAssistantMessage(
  set: StoreSet,
  sessionId: string,
  messageId: string,
  updater: (message: UIMessage) => UIMessage
): void {
  set((s) => {
    const currentSessionMessages = s.sessionMessages[sessionId] ?? s.messages;
    let changed = false;
    const nextMessages = currentSessionMessages.map((message) => {
      if (message.id !== messageId) {
        return message;
      }

      changed = true;
      return updater(message);
    });

    if (!changed) {
      return {};
    }

    return {
      messages: nextMessages,
      sessionMessages: {
        ...s.sessionMessages,
        [sessionId]: nextMessages,
      },
    };
  });
}

export function applyToolStreamEvent(
  message: UIMessage,
  event: Extract<AgentRuntimeStreamEvent, { type: 'tool-call-start' | 'tool-call-progress' | 'tool-call-end' }>
): UIMessage {
  const currentInvocations = message.toolInvocations ?? [];

  const resolveInvocationIndex = (): number => {
    if ('toolCallId' in event && typeof event.toolCallId === 'string') {
      const exactIndex = currentInvocations.findIndex((invocation) => invocation.id === event.toolCallId);
      if (exactIndex >= 0) {
        return exactIndex;
      }
    }

    const eventArguments = 'arguments' in event ? Serializer.stringify(event.arguments ?? {}) : null;
    for (let index = currentInvocations.length - 1; index >= 0; index -= 1) {
      const invocation = currentInvocations[index];
      if (
        invocation?.name === event.toolName &&
        (eventArguments === null || Serializer.stringify(invocation.arguments ?? {}) === eventArguments)
      ) {
        return index;
      }
    }

    return -1;
  };

  const existingIndex = resolveInvocationIndex();

  const deriveMessageStatusText = (toolInvocations: UIToolInvocation[]): string | undefined => {
    const runningInvocation = [...toolInvocations].reverse().find(
      (invocation) => invocation.status === 'running' && invocation.statusText?.trim()
    );
    return runningInvocation?.statusText;
  };

  if (event.type === 'tool-call-start') {
    const nextInvocation: UIToolInvocation = {
      id: event.toolCallId,
      name: event.toolName,
      arguments: event.arguments,
      status: 'running',
    };

    if (existingIndex === -1) {
      const nextToolInvocations = [...currentInvocations, nextInvocation];
      return {
        ...message,
        statusText: deriveMessageStatusText(nextToolInvocations),
        toolInvocations: nextToolInvocations,
      };
    }

    const nextToolInvocations = currentInvocations.map((invocation, index) =>
      index === existingIndex ? nextInvocation : invocation
    );
    return {
      ...message,
      statusText: deriveMessageStatusText(nextToolInvocations),
      toolInvocations: nextToolInvocations,
    };
  }

  if (event.type === 'tool-call-progress') {
    if (existingIndex === -1) {
      return message;
    }

    const nextToolInvocations = currentInvocations.map((invocation, index) =>
      index === existingIndex
        ? {
            ...invocation,
            statusText: event.statusText ?? invocation.statusText,
            output: typeof event.output === 'string' ? event.output : invocation.output,
          }
        : invocation
    );

    return {
      ...message,
      statusText: event.statusText ?? deriveMessageStatusText(nextToolInvocations),
      toolInvocations: nextToolInvocations,
    };
  }

  const baseInvocation: UIToolInvocation =
    existingIndex === -1
      ? {
          id: event.toolCallId,
          name: event.toolName,
          arguments: {},
          status: event.success ? 'success' : 'error',
        }
      : currentInvocations[existingIndex]!;
  const nextInvocation: UIToolInvocation = {
    ...baseInvocation,
    name: event.toolName,
    status: event.success ? 'success' : 'error',
    statusText: undefined,
    output: event.output ?? baseInvocation.output,
    contextContent: event.contextContent ?? baseInvocation.contextContent,
    ...(event.error ? { error: event.error } : {}),
    ...(event.subagentToolInvocations ? { subagentToolInvocations: event.subagentToolInvocations } : {}),
  };

  if (existingIndex === -1) {
    const nextToolInvocations = [...currentInvocations, nextInvocation];
    return {
      ...message,
      statusText: deriveMessageStatusText(nextToolInvocations),
      toolInvocations: nextToolInvocations,
    };
  }

  const nextToolInvocations = currentInvocations.map((invocation, index) =>
    index === existingIndex ? nextInvocation : invocation
  );
  return {
    ...message,
    statusText: deriveMessageStatusText(nextToolInvocations),
    toolInvocations: nextToolInvocations,
  };
}

export function appendSessionMessages(
  set: StoreSet,
  sessionId: string,
  newMessages: UIMessage[]
): void {
  set((s) => {
    const currentSessionMessages = s.sessionMessages[sessionId] ?? s.messages;
    const nextMessages = [...currentSessionMessages, ...newMessages];

    return {
      messages: nextMessages,
      sessionMessages: {
        ...s.sessionMessages,
        [sessionId]: nextMessages,
      },
    };
  });
}

export function cleanupStreamingAssistantMessage(
  set: StoreSet,
  sessionId: string,
  messageId: string
): void {
  set((s) => {
    const currentSessionMessages = s.sessionMessages[sessionId] ?? s.messages;
    const target = currentSessionMessages.find((message) => message.id === messageId);
    if (!target) {
      return {};
    }

    const shouldRemove =
      !target.content &&
      !target.reasoningContent &&
      (!target.toolInvocations || target.toolInvocations.length === 0);
    const nextMessages = shouldRemove
      ? currentSessionMessages.filter((message) => message.id !== messageId)
      : currentSessionMessages.map((message) =>
          message.id === messageId ? { ...message, isStreaming: false } : message
        );

    return {
      messages: nextMessages,
      sessionMessages: {
        ...s.sessionMessages,
        [sessionId]: nextMessages,
      },
    };
  });
}

export function mergeMessageText(
  current: string | undefined,
  incoming: string | undefined
): string | undefined {
  const currentText = current?.trim() ? current : undefined;
  const incomingText = incoming?.trim() ? incoming : undefined;

  if (!currentText) return incomingText;
  if (!incomingText) return currentText;
  if (currentText.includes(incomingText)) return currentText;
  if (incomingText.includes(currentText)) return incomingText;

  return `${currentText}\n\n${incomingText}`;
}

export function appendStreamingAssistantMessage(
  set: StoreSet,
  sessionId: string,
  message: UIMessage
): void {
  appendSessionMessages(set, sessionId, [message]);
}
