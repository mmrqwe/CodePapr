import { describe, expect, it } from 'vitest';
import {
  buildContextCompactionTranscript,
  buildEffectiveContextMessages,
  buildLocalContextCheckpointSections,
  parseContextCheckpointSections,
  planContextCompaction,
  renderContextCheckpointContent,
  renderContextCheckpointSummary,
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

  it('uses space placeholder for old assistant messages without toolInvocations and empty content', () => {
    const messages: ContextMessageLike[] = [
      createUser('u1', '修复 bug'),
      createAssistant('a1', ''),
      createAssistant('a2', '已修复。'),
    ];

    const effective = buildEffectiveContextMessages(messages);

    expect(effective).toHaveLength(3);
    expect(effective[1]?.role).toBe('assistant');
    expect(effective[1]?.content).toBe(' ');
    expect(effective[1]?.toolCalls).toBeUndefined();
  });

  it('plans compaction when conversation round count exceeds maxRounds', () => {
    const messages: ContextMessageLike[] = [];
    for (let index = 0; index < 14; index += 1) {
      messages.push(createUser(`u${index}`, `用户消息 ${index}`));
      messages.push(createAssistant(`a${index}`, `助手回复 ${index}`));
    }

    const plan = planContextCompaction(messages, { maxRounds: 5 });

    expect(plan.shouldCompact).toBe(true);
    expect(plan.sourceMessages.length).toBeGreaterThan(0);
    expect(plan.retainedMessages.length).toBeGreaterThanOrEqual(6);
    expect(plan.retainedMessages.length).toBeLessThanOrEqual(12);
  });

  it('does not compact when round count is below the threshold, even with many assistant tool-call messages', () => {
    const messages: ContextMessageLike[] = [];
    // 4 conversation rounds, each with user + 5 assistant tool-call steps
    for (let round = 0; round < 4; round += 1) {
      messages.push(createUser(`u${round}`, `用户问题 ${round}`));
      for (let step = 0; step < 5; step += 1) {
        messages.push(createAssistant(`a${round}-${step}`, `工具调用结果 ${step}`));
      }
    }

    const plan = planContextCompaction(messages, { maxRounds: 24 });

    expect(plan.shouldCompact).toBe(false);
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
    const messages: ContextMessageLike[] = [
      createUser('u1', '旧问题 1'),
      {
        id: 'checkpoint-1',
        role: 'assistant',
        content: priorCheckpoint.renderedContent,
        synthetic: true,
        hidden: true,
        contextCheckpoint: priorCheckpoint,
        timestamp: 101,
      },
      createUser('u2', '请把上下文压缩改成结构化 checkpoint'),
      createAssistant('a2', '会把旧 checkpoint 合并，不再做摘要套摘要。'),
    ];

    const plan = planContextCompaction(messages);
    const sections = buildLocalContextCheckpointSections({
      priorCheckpoint: plan.priorCheckpoint,
      sourceMessages: plan.sourceMessages,
      retainedMessages: plan.retainedMessages,
      lang: 'zh-CN',
    });

    expect(plan.priorCheckpoint?.sections?.constraints).toContain('缓存率要高');
    expect(plan.sourceMessages.some((message) => message.content.includes('上下文检查点'))).toBe(false);
    expect(sections.constraints).toContain('缓存率要高');
    expect(sections.assumptions).toContain('暂按 UI 与 CLI 共用一套 prompt 体系');
    expect(sections.validationNotes).toContain('npm run test -> 退出码 0');
    expect(sections.pendingWork.some((line) => line.includes('结构化 checkpoint'))).toBe(true);
  });

  it('parses structured checkpoint JSON and rejects empty payloads', () => {
    const parsed = parseContextCheckpointSections(`{
      "userGoal": ["修复缓存率"],
      "constraints": ["不要重复注入模式大 prompt"],
      "completedWork": ["已把稳定模式提示移到系统前缀"],
      "importantContext": ["ChatPanel 现在只发送原始用户输入"],
      "assumptions": ["暂按主线程运行"],
      "validationNotes": ["ui typecheck 通过"],
      "pendingWork": ["补跑聚焦单测"],
      "openQuestions": ["是否要压缩旧消息"]
    }`);

    expect(parsed?.userGoal).toEqual(['修复缓存率']);
    expect(parsed?.importantContext[0]).toContain('ChatPanel');
    expect(parsed?.validationNotes).toContain('ui typecheck 通过');
    expect(parseContextCheckpointSections('{"userGoal":[],"constraints":[],"completedWork":[],"importantContext":[],"assumptions":[],"validationNotes":[],"pendingWork":[],"openQuestions":[]}')).toBeNull();
  });
});
