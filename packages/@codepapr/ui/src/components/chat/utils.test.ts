import { describe, expect, it } from 'vitest';
import {
  slashCommandNameFilter,
  findAtTriggerIndex,
  resolveComposerFilters,
  buildUserPromptWithFiles,
  classifyIncomingFile,
  collectDataTransferFiles,
  formatBytesAsMbLabel,
  inferImageMediaType,
  looksLikeBinaryText,
  partitionIncomingFiles,
  buildExecutionProcessGroups,
} from './utils';

describe('slashCommandNameFilter', () => {
  it('输入命令名时返回过滤串', () => {
    expect(slashCommandNameFilter('/')).toBe('');
    expect(slashCommandNameFilter('/rev')).toBe('rev');
    expect(slashCommandNameFilter('/review')).toBe('review');
    expect(slashCommandNameFilter('--goal')).toBeNull();
  });

  it('开始写参数或换行后关闭过滤（Enter 应发送）', () => {
    expect(slashCommandNameFilter('/review src/')).toBeNull();
    expect(slashCommandNameFilter('/goal exec:npm test')).toBeNull();
    expect(slashCommandNameFilter('/help ')).toBeNull();
    expect(slashCommandNameFilter('/review\nfoo')).toBeNull();
    expect(slashCommandNameFilter('hello')).toBeNull();
  });
});

describe('resolveComposerFilters', () => {
  it('finds a leading or space-delimited @ mention', () => {
    expect(findAtTriggerIndex('@ex')).toBe(0);
    expect(findAtTriggerIndex('hello @ex')).toBe(6);
    expect(findAtTriggerIndex('email@ex')).toBe(-1);
  });

  it('opens the @ dropdown and suppresses slash while mentioning', () => {
    expect(resolveComposerFilters('@exp', 4)).toEqual({
      atFilter: 'exp',
      atTriggerIndex: 0,
      slashFilter: null,
    });
  });

  it('opens slash filter when not in an @ mention', () => {
    expect(resolveComposerFilters('/rev', 4)).toEqual({
      atFilter: null,
      atTriggerIndex: -1,
      slashFilter: 'rev',
    });
  });
});

describe('incoming file classification', () => {
  it('treats supported images by MIME or extension, including empty MIME', () => {
    expect(classifyIncomingFile({ name: 'a.png', type: 'image/png' })).toBe('image');
    expect(classifyIncomingFile({ name: 'shot.JPG', type: '' })).toBe('image');
    expect(inferImageMediaType({ name: 'shot.JPG', type: '' })).toBe('image/jpeg');
  });

  it('does not ingest HEIC/PDF as text', () => {
    expect(classifyIncomingFile({ name: 'x.heic', type: 'image/heic' })).toBe('unsupported-image');
    expect(classifyIncomingFile({ name: 'doc.pdf', type: 'application/pdf' })).toBe('binary');
    expect(classifyIncomingFile({ name: 'pack.zip', type: '' })).toBe('binary');
  });

  it('keeps SVG and source files as text', () => {
    expect(classifyIncomingFile({ name: 'icon.svg', type: 'image/svg+xml' })).toBe('text');
    expect(classifyIncomingFile({ name: 'main.ts', type: '' })).toBe('text');
  });

  it('partitions a mixed drop', () => {
    const png = new File(['x'], 'a.png', { type: 'image/png' });
    const pdf = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    const ts = new File(['export {}'], 'a.ts', { type: '' });
    const heic = new File(['x'], 'a.heic', { type: 'image/heic' });
    const result = partitionIncomingFiles([png, pdf, ts, heic]);
    expect(result.images.map((f) => f.name)).toEqual(['a.png']);
    expect(result.textFiles.map((f) => f.name)).toEqual(['a.ts']);
    expect(result.binaries).toEqual(['a.pdf']);
    expect(result.unsupportedImages).toEqual(['a.heic']);
  });
});

describe('collectDataTransferFiles', () => {
  it('dedupes files that appear in both files and items', () => {
    const file = new File(['hello'], 'note.txt', { type: 'text/plain', lastModified: 1 });
    const data = {
      files: [file],
      items: [{ kind: 'file', type: file.type, getAsFile: () => file }],
    } as unknown as DataTransfer;
    expect(collectDataTransferFiles(data)).toEqual([file]);
  });

  it('picks up screenshot items that are missing from files', () => {
    const shot = new File(['png'], 'image.png', { type: 'image/png', lastModified: 2 });
    const data = {
      files: [],
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => shot }],
    } as unknown as DataTransfer;
    expect(collectDataTransferFiles(data)).toEqual([shot]);
  });
});

describe('looksLikeBinaryText', () => {
  it('flags NUL and replacement-heavy payloads', () => {
    expect(looksLikeBinaryText('hello\nworld')).toBe(false);
    expect(looksLikeBinaryText('abc\0def')).toBe(true);
    expect(looksLikeBinaryText(`${'\uFFFD'.repeat(20)}ok`)).toBe(true);
  });
});

describe('buildUserPromptWithFiles', () => {
  it('joins user text with named file blocks', () => {
    expect(buildUserPromptWithFiles('看这个', [
      { id: '1', name: 'a.ts', content: 'export const x = 1;', size: 18 },
    ])).toBe('看这个\n\n--- a.ts ---\nexport const x = 1;');
  });

  it('escapes delimiter-like file names', () => {
    const prompt = buildUserPromptWithFiles('', [
      { id: '1', name: 'a---b.ts', content: 'x', size: 1 },
    ]);
    expect(prompt).toContain('--- a\\-\\-\\-b.ts ---');
  });
});

describe('formatBytesAsMbLabel', () => {
  it('rounds 1MB-class limits to a whole number', () => {
    expect(formatBytesAsMbLabel(1_000_000)).toBe('1');
    expect(formatBytesAsMbLabel(8 * 1024 * 1024)).toBe('8');
  });
});

describe('buildExecutionProcessGroups', () => {
  it('groups intermediate execution steps and sets summaryMessage to the final assistant message', () => {
    const messages = [
      {
        id: 'u-1',
        role: 'user' as const,
        content: '重构这个模块并修复 bug',
        timestamp: 1000,
      },
      {
        id: 'a-1',
        role: 'assistant' as const,
        content: '正在读取文件...',
        workMode: 'agent' as const,
        timestamp: 2000,
      },
      {
        id: 'a-2',
        role: 'assistant' as const,
        content: '已完成重构与修复：1. 提取工具类 2. 补齐单元测试。',
        workMode: 'agent' as const,
        timestamp: 3000,
      },
    ];

    const groups = buildExecutionProcessGroups(messages);
    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    expect(group.userMessageId).toBe('u-1');
    expect(group.summaryMessageId).toBe('a-2');
    expect(group.messages).toHaveLength(1);
    expect(group.messages[0]?.id).toBe('a-1');
    expect(group.durationMs).toBe(2000);
  });

  it('returns no groups if there are fewer than 3 messages (single round / direct reply)', () => {
    const messages = [
      {
        id: 'u-1',
        role: 'user' as const,
        content: '你好',
        timestamp: 1000,
      },
      {
        id: 'a-1',
        role: 'assistant' as const,
        content: '你好！有什么可以帮你的？',
        workMode: 'agent' as const,
        timestamp: 2000,
      },
    ];

    expect(buildExecutionProcessGroups(messages)).toEqual([]);
  });

  it('skips a round whose summary message is still streaming', () => {
    const messages = [
      {
        id: 'u-1',
        role: 'user' as const,
        content: '重构这个模块',
        timestamp: 1000,
      },
      {
        id: 'a-1',
        role: 'assistant' as const,
        content: '正在处理...',
        workMode: 'agent' as const,
        timestamp: 2000,
      },
      {
        id: 'a-2',
        role: 'assistant' as const,
        content: '正在输出最终结果...',
        workMode: 'agent' as const,
        isStreaming: true,
        timestamp: 3000,
      },
    ];

    expect(buildExecutionProcessGroups(messages)).toEqual([]);
  });

  it('skips non-execution rounds in ask mode', () => {
    const messages = [
      {
        id: 'u-1',
        role: 'user' as const,
        content: '请解释一下这个函数的作用',
        timestamp: 1000,
      },
      {
        id: 'a-1',
        role: 'assistant' as const,
        content: '这是第一段分析。',
        workMode: 'ask' as const,
        timestamp: 2000,
      },
      {
        id: 'a-2',
        role: 'assistant' as const,
        content: '这是总结。',
        workMode: 'ask' as const,
        timestamp: 3000,
      },
    ];

    expect(buildExecutionProcessGroups(messages)).toEqual([]);
  });

  it('keeps earlier rounds grouped once a new round starts', () => {
    const messages = [
      {
        id: 'u-1',
        role: 'user' as const,
        content: '重构这个模块',
        timestamp: 1000,
      },
      {
        id: 'a-1',
        role: 'assistant' as const,
        content: '第一轮过程消息。',
        workMode: 'agent' as const,
        timestamp: 2000,
      },
      {
        id: 'a-2',
        role: 'assistant' as const,
        content: '第一轮总结。',
        workMode: 'agent' as const,
        timestamp: 3000,
      },
      {
        id: 'u-2',
        role: 'user' as const,
        content: '再补一些测试',
        timestamp: 4000,
      },
      {
        id: 'a-3',
        role: 'assistant' as const,
        content: '第二轮正在输出...',
        workMode: 'agent' as const,
        isStreaming: true,
        timestamp: 5000,
      },
    ];

    const groups = buildExecutionProcessGroups(messages);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.summaryMessageId).toBe('a-2');
    expect(groups[0]?.messages.map((message) => message.id)).toEqual(['a-1']);
  });

  it('groups every completed agent round independently', () => {
    const messages = [
      {
        id: 'u-1',
        role: 'user' as const,
        content: '第一轮任务',
        timestamp: 1000,
      },
      {
        id: 'a-1',
        role: 'assistant' as const,
        content: '第一轮过程。',
        workMode: 'agent' as const,
        timestamp: 2000,
      },
      {
        id: 'a-2',
        role: 'assistant' as const,
        content: '第一轮总结。',
        workMode: 'agent' as const,
        timestamp: 3000,
      },
      {
        id: 'u-2',
        role: 'user' as const,
        content: '第二轮任务',
        timestamp: 4000,
      },
      {
        id: 'a-3',
        role: 'assistant' as const,
        content: '第二轮过程。',
        workMode: 'agent' as const,
        timestamp: 5000,
      },
      {
        id: 'a-4',
        role: 'assistant' as const,
        content: '第二轮总结。',
        workMode: 'agent' as const,
        timestamp: 6000,
      },
    ];

    const groups = buildExecutionProcessGroups(messages);
    expect(groups.map((group) => group.summaryMessageId)).toEqual(['a-2', 'a-4']);
    expect(groups[0]?.messages.map((message) => message.id)).toEqual(['a-1']);
    expect(groups[1]?.messages.map((message) => message.id)).toEqual(['a-3']);
  });
});
