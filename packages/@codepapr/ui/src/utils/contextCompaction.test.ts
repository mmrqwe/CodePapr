import { describe, expect, it } from 'vitest';
import type { IMessage } from '@codepapr/types';
import { AppendOnlyLog, Serializer, planSkeletonCompaction, roundsFromCoreMessages } from '@codepapr/core';
import {
  buildContextCompactionTranscript,
  buildEffectiveContextMessages,
  buildLocalContextCheckpointSections,
  insertCheckpointAtRetainedBoundary,
  measureWireTokens,
  renderContextCheckpointContent,
  renderContextCheckpointSummary,
  repairOrphanedToolCalls,
  toCoreTailMessages,
  TOOL_RESULT_MISSING_ERROR,
  TOOL_RESULT_MISSING_PLACEHOLDER,
  type ContextCheckpointPayload,
  type ContextMessageLike,
} from './contextCompaction';

function createUser(id: string, content: string): ContextMessageLike {
  return {
    id,
    role: 'user',
    content,
    timestamp: Number(id.replace(/\D/g, '')) || 1,
  };
}

function createAssistant(id: string, content: string): ContextMessageLike {
  return {
    id,
    role: 'assistant',
    content,
    timestamp: Number(id.replace(/\D/g, '')) || 1,
  };
}

function createAssistantWithTools(
  id: string,
  content: string,
  tools: Array<{ id: string; name: string; arguments: Record<string, unknown>; status: 'success' | 'error'; output?: string; error?: string }>,
  reasoningContent?: string,
): ContextMessageLike {
  return {
    id,
    role: 'assistant',
    content,
    reasoningContent,
    toolInvocations: tools.map((t) => ({
      id: t.id,
      name: t.name,
      arguments: t.arguments,
      status: t.status,
      output: t.output,
      error: t.error,
    })),
    timestamp: Number(id.replace(/\D/g, '')) || 1,
  };
}

describe('contextCompaction', () => {
  it('builds effective context from the latest checkpoint plus tail messages', () => {
    const checkpoint: ContextCheckpointPayload = {
      version: 2,
      summary: renderContextCheckpointSummary(
        {
          userGoal: ['修复预览闪退'],
          constraints: [],
          completedWork: [],
          importantContext: ['PreviewSessionPanel.tsx 需要保留当前预览状态'],
          assumptions: [],
          validationNotes: [],
          pendingWork: ['验证崩溃复现路径'],
          openQuestions: [],
          todoList: [],
        },
        'zh-CN'
      ),
      renderedContent: renderContextCheckpointContent(
        renderContextCheckpointSummary(
          {
            userGoal: ['修复预览闪退'],
            constraints: [],
            completedWork: [],
            importantContext: ['PreviewSessionPanel.tsx 需要保留当前预览状态'],
            assumptions: [],
            validationNotes: [],
            pendingWork: ['验证崩溃复现路径'],
            openQuestions: [],
            todoList: [],
          },
          'zh-CN'
        ),
        'zh-CN'
      ),
      sourceMessageCount: 8,
      sourceChars: 1200,
      generatedAt: 100,
      modelName: 'deepseek-v4-flash',
      modelTier: 'fast',
        sections: {
          userGoal: ['修复预览闪退'],
          constraints: [],
          completedWork: [],
          importantContext: ['PreviewSessionPanel.tsx 需要保留当前预览状态'],
          assumptions: [],
          validationNotes: [],
          pendingWork: ['验证崩溃复现路径'],
          openQuestions: [],
          todoList: [],
        },
      };
    const messages: ContextMessageLike[] = [
      createUser('u1', '旧问题 1'),
      createAssistant('a1', '旧回答 1'),
      {
        id: 'checkpoint-1',
        role: 'assistant',
        content: checkpoint.renderedContent,
        synthetic: true,
        hidden: true,
        contextCheckpoint: checkpoint,
        timestamp: 100,
      },
      createUser('u2', '最新需求'),
      createAssistant('a2', '最新处理'),
    ];

    const effective = buildEffectiveContextMessages(messages);

    expect(effective).toHaveLength(3);
    expect(effective[0]?.content).toContain('上下文检查点');
    expect(effective[1]?.content).toBe('最新需求');
    expect(effective[2]?.content).toBe('最新处理');
  });

  it('keeps carry-forward synthetic assistant evidence in restored context', () => {
    const checkpoint: ContextCheckpointPayload = {
      version: 2,
      summary: '检查点摘要',
      renderedContent: '上下文检查点\n\n- 已处理旧上下文',
      sourceMessageCount: 4,
      sourceChars: 200,
      generatedAt: 100,
      modelName: 'deepseek-v4-flash',
      modelTier: 'fast',
    };
    const messages: ContextMessageLike[] = [
      createUser('u1', '旧需求'),
      {
        id: 'checkpoint-1',
        role: 'assistant',
        content: checkpoint.renderedContent,
        synthetic: true,
        hidden: true,
        contextCheckpoint: checkpoint,
        timestamp: 100,
      },
      createUser('u2', '继续修复缓存问题'),
      {
        id: 'carry-forward-1',
        role: 'assistant',
        content: '执行证据摘要\n- npm run test -> 退出码 0',
        synthetic: true,
        hidden: true,
        carryForwardInContext: true,
        timestamp: 101,
      },
      createAssistant('a2', '已继续处理。'),
    ];

    const effective = buildEffectiveContextMessages(messages);

    expect(effective).toHaveLength(4);
    expect(effective[0]?.content).toContain('上下文检查点');
    expect(effective[2]?.content).toContain('执行证据摘要');
    expect(effective[3]?.content).toBe('已继续处理。');
  });

  it('carries measured durations into rebuilt core messages (assistant + tool)', () => {
    const messages: ContextMessageLike[] = [
      createUser('u1', '跑一下测试'),
      {
        id: 'a1',
        role: 'assistant',
        content: '执行测试。',
        durationMs: 3200,
        toolInvocations: [
          {
            id: 't-1',
            name: 'bash',
            arguments: { command: 'npm test' },
            status: 'success',
            output: 'Tests passed',
            contextContent: 'Tests passed',
            durationMs: 8400,
          },
        ],
        timestamp: 100,
      },
    ];

    const effective = buildEffectiveContextMessages(messages);
    expect(effective).toHaveLength(3);
    const assistantMsg = effective.find((m) => m.role === 'assistant') as IMessage;
    const toolMsg = effective.find((m) => m.role === 'tool') as IMessage;
    expect(assistantMsg.durationMs).toBe(3200);
    expect(toolMsg.durationMs).toBe(8400);
  });

  it('omits durationMs from rebuilt user messages and duration-less assistants', () => {
    const messages: ContextMessageLike[] = [
      { ...createUser('u1', '你好'), durationMs: 999 },
      createAssistant('a1', '回复'),
    ];

    const effective = buildEffectiveContextMessages(messages);
    expect(effective[0]?.durationMs).toBeUndefined();
    expect(effective[1]?.durationMs).toBeUndefined();
  });

  it('marks UI-injected synthetic assistants with uiInjected metadata', () => {
    const messages: ContextMessageLike[] = [
      {
        id: 'mode-switch-1',
        role: 'assistant',
        content: '[Mode: APP] You are now in App mode.',
        synthetic: true,
        hidden: true,
        carryForwardInContext: true,
        timestamp: 10,
      },
      {
        id: 'evidence-1',
        role: 'assistant',
        content: '执行证据摘要\n- npm run test -> 退出码 0',
        synthetic: true,
        hidden: true,
        carryForwardInContext: true,
        timestamp: 11,
      },
      createAssistant('a1', '真实回复。'),
    ];

    const effective = buildEffectiveContextMessages(messages);
    expect(effective[0]?.metadata?.uiInjected).toBe(true);
    expect(effective[1]?.metadata?.uiInjected).toBe(true);
    expect(effective[2]?.metadata?.uiInjected).toBeUndefined();
  });

  it('does not mark real assistant output as uiInjected', () => {
    const messages: ContextMessageLike[] = [
      createUser('u1', '跑测试'),
      {
        id: 'a1',
        role: 'assistant',
        content: '执行中。',
        toolInvocations: [
          {
            id: 't-1',
            name: 'bash',
            arguments: { command: 'npm test' },
            status: 'success',
            output: 'ok',
            contextContent: 'ok',
          },
        ],
        timestamp: 100,
      },
    ];

    const effective = buildEffectiveContextMessages(messages);
    const assistantMsg = effective.find((m) => m.role === 'assistant') as IMessage;
    expect(assistantMsg.metadata?.uiInjected).toBeUndefined();
  });

  it('excludes ordinary synthetic display summaries from model context', () => {
    const messages: ContextMessageLike[] = [
      createUser('u1', '修复类型错误'),
      createAssistant('a1', '已完成真实修复。'),
      {
        id: 'display-summary-1',
        role: 'assistant',
        content: '展示用完成总结，不应该再次进入模型上下文。',
        synthetic: true,
        carryForwardInContext: false,
        timestamp: 3,
      },
      {
        id: 'evidence-1',
        role: 'assistant',
        content: '执行证据摘要：npm run verify -> 退出码 0',
        synthetic: true,
        hidden: true,
        carryForwardInContext: true,
        timestamp: 4,
      },
    ];

    const effective = buildEffectiveContextMessages(messages);

    expect(effective.map((message) => message.content)).toEqual([
      '修复类型错误',
      '已完成真实修复。',
      '执行证据摘要：npm run verify -> 退出码 0',
    ]);
  });

  it('keeps assistant reasoning in effective context for API round-tripping but excludes from compaction transcripts', () => {
    const messages: ContextMessageLike[] = [
      createUser('u1', '把系统回复改成 Copilot 风格'),
      {
        id: 'a1',
        role: 'assistant',
        content: '会把正式回答平铺显示，并单独折叠思考内容。',
        reasoningContent: '这里的内部思考需要回传给 DeepSeek 以保持工具调用链路完整。',
        timestamp: 2,
      },
    ];

    const effective = buildEffectiveContextMessages(messages);
    const transcript = buildContextCompactionTranscript(effective);

    // reasoningContent 必须保留在 effective context 中，DeepSeek 要求工具调用轮次回传 reasoning_content
    expect(effective[1]?.reasoningContent).toBe('这里的内部思考需要回传给 DeepSeek 以保持工具调用链路完整。');
    // 但 compaction transcript 不应包含 reasoning（仅用于摘要可读性）
    expect(transcript).toContain('会把正式回答平铺显示');
    expect(transcript).not.toContain('这里的内部思考需要回传给 DeepSeek');
  });

  it('includes tool calls and tool results in effective context for API continuity', () => {
    const messages: ContextMessageLike[] = [
      createUser('u1', '读取 src/index.ts'),
      createAssistantWithTools(
        'a1',
        '',
        [
          {
            id: 'call-1',
            name: 'read',
            arguments: { path: 'src/index.ts' },
            status: 'success',
            output: 'export default function main() { ... }',
          },
        ],
        '思考：先读取文件',
      ),
      createAssistant('a2', '文件已读取，内容是一个默认导出的函数。'),
    ];

    const effective = buildEffectiveContextMessages(messages);

    // user + assistant(toolCalls) + tool(result) + assistant(text)
    expect(effective).toHaveLength(4);
    expect(effective[0]?.role).toBe('user');
    expect(effective[0]?.content).toBe('读取 src/index.ts');

    const toolAssistant = effective[1];
    expect(toolAssistant?.role).toBe('assistant');
    expect(toolAssistant?.content).toBe('');
    expect(toolAssistant?.toolCalls).toHaveLength(1);
    expect(toolAssistant?.toolCalls?.[0]?.name).toBe('read');
    expect(toolAssistant?.reasoningContent).toBe('思考：先读取文件');

    const toolResult = effective[2];
    expect(toolResult?.role).toBe('tool');
    expect(toolResult?.toolResult?.toolCallId).toBe('call-1');
    expect(toolResult?.toolResult?.success).toBe(true);
    expect(toolResult?.toolResult?.result).toBe('export default function main() { ... }');

    expect(effective[3]?.role).toBe('assistant');
    expect(effective[3]?.content).toBe('文件已读取，内容是一个默认导出的函数。');
  });

  it('serializes empty assistant content as empty string to match the live path (cache stability)', () => {
    const messages: ContextMessageLike[] = [
      createUser('u1', '修复 bug'),
      createAssistant('a1', ''),
      createAssistant('a2', '已修复。'),
    ];

    const effective = buildEffectiveContextMessages(messages);

    expect(effective).toHaveLength(3);
    expect(effective[1]?.role).toBe('assistant');
    expect(effective[1]?.content).toBe('');
    expect(effective[1]?.toolCalls).toBeUndefined();
  });

  it('keeps the prior checkpoint as structured state instead of re-summarizing its rendered text', () => {
    const priorSections = {
      userGoal: ['修复缓存架构'],
      constraints: ['缓存率要高'],
      completedWork: ['已经定位主模型重复前缀问题'],
      importantContext: ['agentStore.ts 里会追加 context checkpoint'],
      assumptions: ['暂按 UI 与 CLI 共用一套 prompt 体系'],
      validationNotes: ['npm run test -> 退出码 0'],
      pendingWork: ['改长上下文压缩策略'],
      openQuestions: ['是否保留旧 prompt 兼容层'],
      todoList: [],
    };
    const priorCheckpoint: ContextCheckpointPayload = {
      version: 2,
      summary: renderContextCheckpointSummary(priorSections, 'zh-CN'),
      renderedContent: renderContextCheckpointContent(
        renderContextCheckpointSummary(priorSections, 'zh-CN'),
        'zh-CN'
      ),
      sourceMessageCount: 12,
      sourceChars: 3200,
      generatedAt: 100,
      modelName: 'deepseek-v4-flash',
      modelTier: 'fast',
      sections: priorSections,
    };
    // v4：prior checkpoint 文本由新引擎直接并入压缩块（见 contextCheckpoint），
    // sections 工具保留给 v2/v3 迁移路径——这里验证合并语义不丢约束/假设。
    const sourceMessages: IMessage[] = [
      { id: 'u2', role: 'user', content: '请把上下文压缩改成结构化 checkpoint', timestamp: 102 } as IMessage,
    ];
    const retainedMessages: IMessage[] = [
      { id: 'a2', role: 'assistant', content: '会把旧 checkpoint 合并，不再做摘要套摘要。', timestamp: 103 } as IMessage,
    ];
    const sections = buildLocalContextCheckpointSections({
      priorCheckpoint,
      sourceMessages,
      retainedMessages,
      lang: 'zh-CN',
    });

    expect(sections.constraints).toContain('缓存率要高');
    expect(sections.assumptions).toContain('暂按 UI 与 CLI 共用一套 prompt 体系');
    expect(sections.validationNotes).toContain('npm run test -> 退出码 0');
    expect(sections.pendingWork.some((line) => line.includes('结构化 checkpoint'))).toBe(true);
  });

  it('serializes object tool results with sorted keys to match the live path (cache stability)', () => {
    const messages: ContextMessageLike[] = [
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        timestamp: 1,
        toolInvocations: [
          {
            id: 't1',
            name: 'todo',
            arguments: {},
            status: 'success',
            output: { zebra: 1, apple: 2 } as unknown as string,
          },
        ],
      },
    ];

    const effective = buildEffectiveContextMessages(messages);
    const toolMsg = effective.find((m) => m.role === 'tool');
    // sortedStringify orders keys alphabetically; JSON.stringify would keep
    // insertion order ("zebra" first) and diverge from the live wire bytes.
    expect(toolMsg?.content).toBe('{"apple":2,"zebra":1}');
  });

  it('v4：重建保留工具结果原文（prune 层已删除，不再被占位符替换）', () => {
    const bigOutput = 'x'.repeat(300);
    const messages: ContextMessageLike[] = [
      createAssistantWithTools('a1', '', [
        { id: 't1', name: 'read', arguments: {}, status: 'success', output: bigOutput },
      ]),
      createAssistant('a2', '第二轮'),
      createAssistant('a3', '第三轮'),
    ];
    const effective = buildEffectiveContextMessages(messages);
    const toolMsg = effective.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toBe(bigOutput);
  });

  describe('tool message byte-faithfulness (contextContent, problem 1.2 fix)', () => {
    it('prefers contextContent (byte-exact log content) when rebuilding tool messages', () => {
      const truncated = 'x'.repeat(50) + '…[truncated]';
      const messages: ContextMessageLike[] = [
        createUser('u1', '运行命令'),
        {
          id: 'a1',
          role: 'assistant',
          content: '',
          timestamp: 2,
          toolInvocations: [
            {
              id: 'call-1',
              name: 'run',
              arguments: {},
              status: 'success',
              output: 'x'.repeat(5000),
              contextContent: truncated,
            },
          ],
        },
      ];

      const effective = buildEffectiveContextMessages(messages);
      const toolMsg = effective.find((m) => m.role === 'tool');
      expect(toolMsg?.content).toBe(truncated);
    });

    it('falls back to output when contextContent is absent (legacy data)', () => {
      const messages: ContextMessageLike[] = [
        {
          id: 'a1',
          role: 'assistant',
          content: '',
          timestamp: 1,
          toolInvocations: [
            { id: 'call-1', name: 'run', arguments: {}, status: 'success', output: 'plain output' },
          ],
        },
      ];

      const effective = buildEffectiveContextMessages(messages);
      const toolMsg = effective.find((m) => m.role === 'tool');
      expect(toolMsg?.content).toBe('plain output');
    });

    it('emits a placeholder for interrupted invocations without output/contextContent', () => {
      const messages: ContextMessageLike[] = [
        createUser('u1', '运行命令'),
        {
          id: 'a1',
          role: 'assistant',
          content: '',
          timestamp: 2,
          toolInvocations: [
            {
              id: 'tool-call_00_interrupted',
              name: 'run',
              arguments: {},
              status: 'error',
              error: '未完成的工具调用',
            },
          ],
        },
      ];

      const effective = buildEffectiveContextMessages(messages);
      const toolMsg = effective.find((m) => m.role === 'tool');
      expect(toolMsg?.content).toBe(TOOL_RESULT_MISSING_PLACEHOLDER);
      expect(toolMsg?.toolResult?.success).toBe(false);
      expect(toolMsg?.toolResult?.result).toBe(TOOL_RESULT_MISSING_PLACEHOLDER);
      expect(toolMsg?.toolResult?.error).toBe('未完成的工具调用');
    });

    it('fills a default error when the interrupted invocation has none', () => {
      const messages: ContextMessageLike[] = [
        {
          id: 'a1',
          role: 'assistant',
          content: '',
          timestamp: 1,
          toolInvocations: [
            { id: 'c1', name: 'run', arguments: {}, status: 'running' },
          ],
        },
      ];

      const effective = buildEffectiveContextMessages(messages);
      const toolMsg = effective.find((m) => m.role === 'tool');
      expect(toolMsg?.content).toBe(TOOL_RESULT_MISSING_PLACEHOLDER);
      expect(toolMsg?.toolResult?.error).toBe(TOOL_RESULT_MISSING_ERROR);
    });

    it('rebuilt history with an interrupted invocation loads into AppendOnlyLog', () => {
      const messages: ContextMessageLike[] = [
        createUser('u1', '运行命令'),
        {
          id: 'a1',
          role: 'assistant',
          content: '',
          timestamp: 2,
          toolInvocations: [
            { id: 'tool-call_00_interrupted', name: 'run', arguments: {}, status: 'error' },
          ],
        },
      ];

      const effective = buildEffectiveContextMessages(messages);
      const log = new AppendOnlyLog('session-under-test');
      expect(() =>
        log.loadFromSnapshot({
          messages: effective,
          lastMessageIndex: effective.length - 1,
          totalBytes: effective.reduce((sum, message) => sum + Serializer.getByteLength(message), 0),
        })
      ).not.toThrow();
      expect(log.length()).toBe(effective.length);
    });
  });

  describe('history summaries on rebuild (tool context mode)', () => {
    function assistantWithSummary(
      id: string,
      callId: string,
      full: string,
      summary?: string
    ): ContextMessageLike {
      return {
        id,
        role: 'assistant',
        content: '',
        timestamp: Number(id.replace(/\D/g, '')) || 1,
        toolInvocations: [
          {
            id: callId,
            name: 'read',
            arguments: {},
            status: 'success',
            output: full,
            contextContent: full,
            ...(summary ? { contextSummary: summary } : {}),
          },
        ],
      };
    }

    it('carries the frozen summary into rebuilt tool message metadata', () => {
      const messages: ContextMessageLike[] = [
        assistantWithSummary('a1', 'c1', 'full-1', '[read] summary-1'),
      ];
      const effective = buildEffectiveContextMessages(messages);
      const toolMsg = effective.find((m) => m.role === 'tool');
      expect(toolMsg?.metadata?.toolSummary).toBe('[read] summary-1');
      // The rebuilt log content itself stays the full (byte-exact) content;
      // summarization is applied at request-build time, not in the log.
      expect(toolMsg?.content).toBe('full-1');
    });

    it('summarizes older results but keeps the latest batch full (live-path parity)', () => {
      const messages: ContextMessageLike[] = [
        assistantWithSummary('a1', 'c1', 'full-1', '[read] summary-1'),
        assistantWithSummary('a2', 'c2', 'full-2', '[read] summary-2'),
      ];
      const effective = buildEffectiveContextMessages(messages);
      const toolMsgs = effective.filter((m) => m.role === 'tool');
      expect(toolMsgs[0]?.content).toBe('[read] summary-1');
      expect(toolMsgs[1]?.content).toBe('full-2');
    });

    it('keeps full-mode results (no contextSummary) untouched', () => {
      const messages: ContextMessageLike[] = [
        assistantWithSummary('a1', 'c1', 'full-1'),
        assistantWithSummary('a2', 'c2', 'full-2'),
      ];
      const effective = buildEffectiveContextMessages(messages);
      const toolMsgs = effective.filter((m) => m.role === 'tool');
      expect(toolMsgs[0]?.content).toBe('full-1');
      expect(toolMsgs[1]?.content).toBe('full-2');
      });
  });

  describe('orphaned tool-call repair (problem 2.2 fix)', () => {
    it('repairs an assistant tool call that has no matching tool result', () => {
      const messages: IMessage[] = [
        { id: 'u1', role: 'user', content: '运行命令', timestamp: 1 },
        {
          id: 'a1',
          role: 'assistant',
          content: '',
          timestamp: 2,
          toolCalls: [{ id: 'c1', name: 'run', arguments: {} }],
        },
      ];

      const repaired = repairOrphanedToolCalls(messages);
      const toolMsg = repaired.find((m) => m.role === 'tool');
      expect(toolMsg?.toolResult?.toolCallId).toBe('c1');
      expect(toolMsg?.toolResult?.success).toBe(false);
    });

    it('leaves well-formed tool-call pairing untouched', () => {
      const messages: IMessage[] = [
        {
          id: 'a1',
          role: 'assistant',
          content: '',
          timestamp: 1,
          toolCalls: [{ id: 'c1', name: 'run', arguments: {} }],
        },
        {
          id: 't1',
          role: 'tool',
          content: 'ok',
          timestamp: 2,
          toolResult: { toolCallId: 'c1', success: true, result: 'ok' },
        },
      ];

      const repaired = repairOrphanedToolCalls(messages);
      expect(repaired).toHaveLength(2);
      expect(repaired.filter((m) => m.role === 'tool')).toHaveLength(1);
    });
  });

  describe('retained-tail insertion boundary (problem 1 fix)', () => {
    function createCheckpoint(id: string, content: string): ContextMessageLike {
      return {
        id,
        role: 'assistant',
        content: '',
        synthetic: true,
        hidden: true,
        timestamp: 999,
        contextCheckpoint: {
          version: 2,
          summary: content,
          renderedContent: content,
          sourceMessageCount: 0,
          sourceChars: 0,
          generatedAt: 999,
          modelName: 'test-model',
          modelTier: 'fast',
        },
      };
    }

    it('clamps insertIndex into bounds', () => {
      const arr = [1, 2, 3];
      expect(insertCheckpointAtRetainedBoundary(arr, 9, 0)).toEqual([9, 1, 2, 3]);
      expect(insertCheckpointAtRetainedBoundary(arr, 9, 3)).toEqual([1, 2, 3, 9]);
      expect(insertCheckpointAtRetainedBoundary(arr, 9, 99)).toEqual([1, 2, 3, 9]);
      expect(insertCheckpointAtRetainedBoundary(arr, 9, -5)).toEqual([9, 1, 2, 3]);
    });

    it('v4：checkpoint 插在保留回合的 user 边界之前，工具组不拆散', () => {
      const messages: ContextMessageLike[] = [];
      for (let r = 0; r < 10; r += 1) {
        messages.push(createUser(`u${r}`, `用户消息 ${r} ${'u'.repeat(60)}`));
        messages.push(
          createAssistantWithTools(`a${r}`, `处理 ${r}`, [
            { id: `call-${r}`, name: 'read', arguments: { r }, status: 'success', output: `x`.repeat(1200) },
          ]),
        );
      }
      const plan = planSkeletonCompaction({
        rounds: roundsFromCoreMessages(toCoreTailMessages(messages)),
        priorFoldedText: '',
        fixedOverheadTokens: 0,
        triggerTokens: 1_800,
        summaryInputTokens: 1_800,
        lang: 'zh-CN',
      })!;
      expect(plan.needsSummary).toBe(false);
      const insertIndex = messages.findIndex((m) => m.id === plan.boundaryMessageId);
      expect(insertIndex).toBeGreaterThan(0);
      // 边界必须落在 user 消息上（回合级 tail）
      expect(messages[insertIndex]?.role).toBe('user');

      const withCheckpoint = insertCheckpointAtRetainedBoundary(
        messages,
        createCheckpoint('cp1', '检查点摘要内容'),
        insertIndex,
      );
      const effective = buildEffectiveContextMessages(withCheckpoint);
      expect(effective[0]?.role).toBe('user');
      expect(effective[0]?.content).toContain('检查点摘要内容');

      const toolCallMsgs = effective.filter(
        (m) => m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0,
      );
      const toolResultMsgs = effective.filter((m) => m.role === 'tool');
      expect(toolCallMsgs.length).toBeGreaterThan(0);
      const resultIds = new Set(toolResultMsgs.map((m) => m.toolResult?.toolCallId));
      for (const tc of toolCallMsgs) {
        for (const call of tc.toolCalls ?? []) {
          expect(resultIds.has(call.id)).toBe(true);
        }
      }
      const callIds = new Set(toolCallMsgs.flatMap((m) => (m.toolCalls ?? []).map((c) => c.id)));
      for (const tr of toolResultMsgs) {
        expect(callIds.has(tr.toolResult?.toolCallId ?? '')).toBe(true);
      }
      // 预算内尽量多留：至少 3 个 assistant+tools 组逐字成对保留
      expect(toolCallMsgs.length).toBeGreaterThanOrEqual(3);
      expect(messages.length - insertIndex).toBeGreaterThanOrEqual(6);
    });

    it('emits the checkpoint as a user turn in effective context (problem 2 fix)', () => {
      const messages: ContextMessageLike[] = [
        createUser('u1', '旧需求'),
        createCheckpoint('cp1', '检查点摘要'),
        createUser('u2', '新需求'),
      ];
      const effective = buildEffectiveContextMessages(messages);
      expect(effective[0]?.role).toBe('user');
      expect(effective[0]?.content).toContain('检查点摘要');
    });

    it('v4：checkpoint 插在保留回合的 user 边界之前，工具组不拆散', () => {
      const messages: ContextMessageLike[] = [];
      for (let r = 0; r < 10; r += 1) {
        messages.push(createUser(`u${r}`, `用户消息 ${r} ${'u'.repeat(60)}`));
        messages.push(
          createAssistantWithTools(`a${r}`, `处理 ${r}`, [
            { id: `call-${r}`, name: 'read', arguments: { r }, status: 'success', output: `x`.repeat(1200) },
          ]),
        );
      }
      const plan = planSkeletonCompaction({
        rounds: roundsFromCoreMessages(toCoreTailMessages(messages)),
        priorFoldedText: '',
        fixedOverheadTokens: 0,
        triggerTokens: 1_800,
        summaryInputTokens: 1_800,
        lang: 'zh-CN',
      })!;
      expect(plan.needsSummary).toBe(false);
      const insertIndex = messages.findIndex((m) => m.id === plan.boundaryMessageId);
      expect(insertIndex).toBeGreaterThan(0);
      // 边界必须落在 user 消息上（回合级 tail）
      expect(messages[insertIndex]?.role).toBe('user');

      const withCheckpoint = insertCheckpointAtRetainedBoundary(
        messages,
        createCheckpoint('cp1', '检查点摘要内容'),
        insertIndex,
      );
      const effective = buildEffectiveContextMessages(withCheckpoint);
      expect(effective[0]?.role).toBe('user');
      expect(effective[0]?.content).toContain('检查点摘要内容');

      const toolCallMsgs = effective.filter(
        (m) => m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0,
      );
      const toolResultMsgs = effective.filter((m) => m.role === 'tool');
      expect(toolCallMsgs.length).toBeGreaterThan(0);
      const resultIds = new Set(toolResultMsgs.map((m) => m.toolResult?.toolCallId));
      for (const tc of toolCallMsgs) {
        for (const call of tc.toolCalls ?? []) {
          expect(resultIds.has(call.id)).toBe(true);
        }
      }
      const callIds = new Set(toolCallMsgs.flatMap((m) => (m.toolCalls ?? []).map((c) => c.id)));
      for (const tr of toolResultMsgs) {
        expect(callIds.has(tr.toolResult?.toolCallId ?? '')).toBe(true);
      }
      // 预算内尽量多留：至少 3 个 assistant+tools 组逐字成对保留
      expect(toolCallMsgs.length).toBeGreaterThanOrEqual(3);
      expect(messages.length - insertIndex).toBeGreaterThanOrEqual(6);
    });

    it('emits the checkpoint as a user turn in effective context (problem 2 fix)', () => {
      const messages: ContextMessageLike[] = [
        createUser('u1', '旧需求'),
        createCheckpoint('cp1', '检查点摘要'),
        createUser('u2', '新需求'),
      ];
      const effective = buildEffectiveContextMessages(messages);
      expect(effective[0]?.role).toBe('user');
      expect(effective[0]?.content).toContain('检查点摘要');
    });

    it('轮内折叠：边界落在回合内部首个保留 turn 上，effective context 不以孤立 tool 开头', () => {
      // 单个巨型回合（Goal 循环形态）：1 user + 8 个 assistant+tool 组。
      const messages: ContextMessageLike[] = [createUser('u1', 'long running task')];
      for (let r = 0; r < 8; r += 1) {
        messages.push(
          createAssistantWithTools(`a${r}`, `step ${r}`, [
            { id: `call-${r}`, name: 'bash', arguments: { c: r }, status: 'success', output: 'x'.repeat(1200) },
          ]),
        );
      }
      const plan = planSkeletonCompaction({
        rounds: roundsFromCoreMessages(toCoreTailMessages(messages)),
        priorFoldedText: '',
        fixedOverheadTokens: 0,
        triggerTokens: 1200,
        summaryInputTokens: 1200,
        lang: 'zh-CN',
      })!;
      expect(plan.inRoundFold).not.toBeNull();
      const insertIndex = messages.findIndex((m) => m.id === plan.boundaryMessageId);
      expect(insertIndex).toBeGreaterThan(0);
      // 边界消息是 assistant turn（回合内部），其工具结果成组保留
      expect(messages[insertIndex]?.role).toBe('assistant');

      const withCheckpoint = insertCheckpointAtRetainedBoundary(
        messages,
        createCheckpoint('cp1', '摘要'),
        insertIndex,
      );
      const effective = buildEffectiveContextMessages(withCheckpoint);
      // After the leading checkpoint, the first tail message is never an orphan tool.
      expect(effective[1]?.role).toBe('assistant');
      expect(effective[1]?.toolCalls?.length).toBeGreaterThan(0);
    });
  });

  describe('checkpoint preamble', () => {
    it('defers to the latest user message and never orders the model to restore old task lists', () => {
      const zh = renderContextCheckpointContent('用户目标：\n- 旧任务', 'zh-CN');
      expect(zh).toContain('当前回合的任务以用户最新消息为准');
      expect(zh).toContain('除非用户明确要求继续先前的工作');
      expect(zh).not.toContain('立即调用');
      expect(zh).not.toContain('todo(action: list)');

      const tw = renderContextCheckpointContent('用戶目標：\n- 舊任務', 'zh-TW');
      expect(tw).toContain('當前回合的任務以用戶最新訊息為準');
      expect(tw).not.toContain('立即調用');
      expect(tw).not.toContain('todo(action: list)');

      const en = renderContextCheckpointContent('User Goal:\n- old task', 'en');
      expect(en).toContain("governed by the user's latest message");
      expect(en).toContain('unless the user explicitly asks to continue');
      expect(en).not.toContain('todo(action: list)');
    });
  });
});

describe('renderContextCheckpointContent：任务清单跨压缩存活（D）', () => {
  const digest = [
    '[TodoList] 目标: 修太阳过曝',
    '  ✓ scale-research: 搜索距离比例依据',
    '  ▶ fix-sun-v2: 二轮修正太阳光效果 ← current',
    '  ○ verify-v2: 验证二轮修改',
  ].join('\n');

  it('带权威清单时用「继续原清单」前言，并把清单整块渲染进正文', () => {
    const content = renderContextCheckpointContent('摘要正文', 'zh-CN', digest);
    expect(content).toContain('当前任务清单（权威状态）');
    expect(content).toContain('fix-sun-v2');
    expect(content).toContain('← current');
    expect(content).toContain('依然有效');
    expect(content).toContain('不要重建或重新规划');
    // 不能再出现「不要主动恢复旧任务清单」的指令——它正是模型重排计划的诱因
    expect(content).not.toContain('否则不要主动恢复或继续检查点中的旧任务');
  });

  it('没有可继续的清单时用中性前言，且不渲染空清单分区', () => {
    const content = renderContextCheckpointContent('摘要正文', 'zh-CN');
    expect(content).not.toContain('当前任务清单（权威状态）');
    expect(content).toContain('否则不要主动恢复或继续检查点中的旧任务');
  });

  it('空白 digest 不改变前言与结构', () => {
    expect(renderContextCheckpointContent('摘要正文', 'en', '   ')).toBe(
      renderContextCheckpointContent('摘要正文', 'en')
    );
  });

  it('wire 口径：已消费的图片 base64 不计入（缩容有效性看得见真实体量）', () => {
    const bigBase64 = 'iVBORw0KGgo'.repeat(30_000);
    const withImage: ContextMessageLike = {
      id: 'img1',
      role: 'user',
      content: '[Image from tool read_image]',
      timestamp: 1,
      images: [{ mediaType: 'image/png', data: bigBase64, path: 'shots/a.png' }],
    };
    const answered: ContextMessageLike = { id: 'a1', role: 'assistant', content: '看过', timestamp: 2 };
    expect(measureWireTokens([withImage, answered])).toBeLessThan(200);
    expect(measureWireTokens([withImage])).toBeGreaterThanOrEqual(2048);
    expect(measureWireTokens([withImage])).toBeLessThan(3_000);
  });
});

describe('buildEffectiveContextMessages 存量工具图片 base64 重建 redact', () => {
  const legacyOutput = JSON.stringify({
    path: 'assets/x.png',
    __images: [{ mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg'.repeat(60), path: 'assets/x.png' }],
  });

  it('contextContent 缺失走 output 回退时，base64 不再进模型上下文', () => {
    const messages: ContextMessageLike[] = [
      createAssistantWithTools('a1', '看图', [
        { id: 't1', name: 'read_image', arguments: {}, status: 'success', output: legacyOutput },
      ]),
    ];
    const effective = buildEffectiveContextMessages(messages);
    const toolMsg = effective.find((m) => m.role === 'tool') as IMessage;
    expect(toolMsg.content).not.toContain('iVBORw0KGgo');
    expect(toolMsg.content).toContain('"data":""');
    expect(toolMsg.content).toContain('assets/x.png');
  });

  it('contextContent 存在（新路径优先）时行为不变', () => {
    const messages: ContextMessageLike[] = [
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        timestamp: 1,
        toolInvocations: [
          {
            id: 't1',
            name: 'read_image',
            arguments: {},
            status: 'success',
            output: legacyOutput,
            contextContent: '{"bytes":780000,"path":"assets/x.png"}',
          },
        ],
      },
    ];
    const effective = buildEffectiveContextMessages(messages);
    const toolMsg = effective.find((m) => m.role === 'tool') as IMessage;
    expect(toolMsg.content).toBe('{"bytes":780000,"path":"assets/x.png"}');
  });
});
