import { Serializer } from '@codepapr/core';
import { createId } from '../../utils/createId';
import type { AgentRuntimeStreamEvent } from '../../agent/WorkerBackedAgent';
import type { StoreSet, UIMessage, UIToolInvocation } from './types';

export function appendErrorMessage(set: StoreSet, content: string, sessionId?: string | null): void {
  const errorMsg: UIMessage = {
    id: createId(),
    role: 'error',
    content,
    timestamp: Date.now(),
  };

  set((s) => {
    const targetId = sessionId ?? s.activeSessionId;
    // 会话已被删除时禁止写入：否则会把已删会话的 sessionMessages 条目重新
    // 写活（孤儿复活），并被项目快照持久化为幽灵数据。回合已结束（无目标
    // 会话）时同样只复位 loading 状态。
    if (targetId && !s.sessions.some((x) => x.id === targetId)) {
      return {
        isLoading: false,
        loadingSessionId: null,
      };
    }
    const currentSessionMessages = targetId
      ? s.sessionMessages[targetId] ?? s.messages
      : s.messages;
    const nextMessages = [...currentSessionMessages, errorMsg];

    return {
      // 仅当目标会话仍是当前查看的会话时才同步扁平镜像，
      // 避免后台会话的消息覆盖用户正在查看的列表。
      messages: targetId && targetId === s.activeSessionId ? nextMessages : s.messages,
      sessionMessages: targetId
        ? {
            ...s.sessionMessages,
            [targetId]: nextMessages,
          }
        : s.sessionMessages,
      isLoading: false,
      loadingSessionId: null,
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
      messages: sessionId === s.activeSessionId ? nextMessages : s.messages,
      sessionMessages: sessionId
        ? {
            ...s.sessionMessages,
            [sessionId]: nextMessages,
          }
        : s.sessionMessages,
      isLoading: false,
      loadingSessionId: null,
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
      messages: sessionId === s.activeSessionId ? nextMessages : s.messages,
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
      // toolCallId 是权威标识：带了 id 却没命中任何 invocation 时，绝不能退回
      // "仅按工具名"匹配——那会把事件错配到同名的其它调用上（例如 question
      // 中断补发的占位 end 事件会污染同批已执行的同名工具结果）。此时应返回
      // -1 走"新建 invocation"分支。名字兜底只留给缺 toolCallId 的旧/兜底路径。
      if (event.toolCallId !== '') {
        return -1;
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
          // 占位 end 事件（question/取消中断）携带原始参数；缺失时保持旧行为
          arguments: event.arguments ?? {},
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
    contextSummary: event.contextSummary ?? baseInvocation.contextSummary,
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
    // 会话已删除时禁止写入（与 appendErrorMessage 一致，防孤儿条目复活）。
    if (!s.sessions.some((x) => x.id === sessionId)) {
      return {};
    }
    const currentSessionMessages = s.sessionMessages[sessionId] ?? s.messages;
    const nextMessages = [...currentSessionMessages, ...newMessages];

    return {
      messages: sessionId === s.activeSessionId ? nextMessages : s.messages,
      sessionMessages: {
        ...s.sessionMessages,
        [sessionId]: nextMessages,
      },
    };
  });
}

/** N10：取消/出错收尾时把仍显示"执行中"的工具调用标记为已取消。
 *  取消后晚到的 tool-call-end 事件会被丢弃（pending 请求已移除），
 *  不清理的话 UI 永远显示琥珀色脉冲点。 */
export function finalizeCancelledToolInvocations(message: UIMessage): UIMessage {
  const invocations = message.toolInvocations;
  if (!invocations || !invocations.some((inv) => inv.status === 'running')) {
    return message;
  }
  return {
    ...message,
    statusText: undefined,
    toolInvocations: invocations.map((inv) =>
      inv.status === 'running'
        ? { ...inv, status: 'cancelled' as const, statusText: undefined }
        : inv
    ),
  };
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
          message.id === messageId
            ? finalizeCancelledToolInvocations({ ...message, isStreaming: false })
            : message
        );

    return {
      messages: sessionId === s.activeSessionId ? nextMessages : s.messages,
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
