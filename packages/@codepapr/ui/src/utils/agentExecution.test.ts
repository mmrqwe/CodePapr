import { describe, expect, it } from 'vitest';
import {
  accumulateCacheStats,
  buildAgentCompletionSummary,
  buildAgentExecutionContinuePrompt,
  buildExecutionContextSummary,
  buildLocalizedSystemPrompt,
  collectExecutedTools,
  isAgentResponseSuccessfullyFinalized,
  MAX_AGENT_AUTO_CONTINUE_PASSES,
  shouldAppendAgentCompletionSummary,
  shouldAutoContinueAgentResponse,
} from './agentExecution';

describe('shouldAutoContinueAgentResponse', () => {
  it('auto-continues agent replies that only describe next steps', () => {
    expect(
      shouldAutoContinueAgentResponse('agent', '按照你的想法进行修改', {
        content:
          '现在需要更新 script.js 导出测试函数、更新 index.html 加 type="module"、安装 happy-dom、更新 package.json：',
      })
    ).toBe(true);
  });

  it('does not auto-continue when the reply already indicates completion', () => {
    expect(
      shouldAutoContinueAgentResponse('agent', '修复这个问题并验证', {
        content: '已完成修改，并执行 npm run test 验证通过。',
      })
    ).toBe(false);
  });

  it('does not auto-continue ask mode replies', () => {
    expect(
      shouldAutoContinueAgentResponse('ask', '解释一下这个错误', {
        content: '现在需要更新 package.json：',
      })
    ).toBe(false);
  });

  it('auto-continues vague execution follow-ups in agent mode', () => {
    expect(
      shouldAutoContinueAgentResponse('agent', '按他的计划继续运行', {
        content: '我会先检查相关实现，然后继续修改这些文件。',
      })
    ).toBe(true);
  });

  it('does not auto-continue real blockers', () => {
    expect(
      shouldAutoContinueAgentResponse('agent', '继续修复', {
        content: '请先在设置中填写 API Key，否则无法初始化会话。',
      })
    ).toBe(false);
  });

  it('does not auto-continue empty agent replies', () => {
    expect(
      shouldAutoContinueAgentResponse('agent', '继续修改代码', {
        content: '',
      })
    ).toBe(false);
  });

  it('still auto-continues partial completion messages that mention remaining work', () => {
    expect(
      shouldAutoContinueAgentResponse('agent', '继续修改代码', {
        content: '已修改一部分，还需要继续处理剩余测试和验证。',
      })
    ).toBe(true);
  });

  it('does not auto-continue colloquial completion replies', () => {
    expect(
      shouldAutoContinueAgentResponse('agent', '继续修改代码', {
        content: '好了，改完了，没问题了。',
      })
    ).toBe(false);
  });

  it('does not treat a completion line ending with a colon as a new plan', () => {
    expect(
      shouldAutoContinueAgentResponse('agent', '继续修改代码', {
        content: '已修改文件：src/App.tsx',
      })
    ).toBe(false);
  });

  it('does not auto-continue merged content that includes earlier planning text but ends in clear completion', () => {
    expect(
      shouldAutoContinueAgentResponse('agent', '继续修改代码', {
        content: '让我确认最终文件状态：\n\n代码干净。最终检查通过。',
      })
    ).toBe(false);
  });
});

describe('isAgentResponseSuccessfullyFinalized', () => {
  it('treats explicit completion plus successful validation as finalized', () => {
    expect(
      isAgentResponseSuccessfullyFinalized({
        content: '已完成全部修改，并执行 npm run test 验证通过。',
        executedTools: [
          {
            id: 'write',
            name: 'workspace_write_file',
            arguments: { relativePath: 'src/App.tsx' },
            success: true,
            result: {
              path: 'src/App.tsx',
              change: {
                kind: 'updated',
                added: 2,
                deleted: 1,
                beforeLines: 10,
                afterLines: 11,
              },
            },
          },
          {
            id: 'test',
            name: 'workspace_run_command',
            arguments: { command: 'npm', args: ['run', 'test'] },
            success: true,
            result: {
              command: 'npm',
              args: ['run', 'test'],
              status: 0,
              timedOut: false,
            },
          },
        ],
      })
    ).toBe(true);
  });

  it('does not finalize partial completion when remaining work is still described', () => {
    expect(
      isAgentResponseSuccessfullyFinalized({
        content: '已修改一部分，还需要继续补验证。',
        executedTools: [
          {
            id: 'write',
            name: 'workspace_write_file',
            arguments: { relativePath: 'src/App.tsx' },
            success: true,
            result: {
              path: 'src/App.tsx',
              change: {
                kind: 'updated',
                added: 2,
                deleted: 1,
                beforeLines: 10,
                afterLines: 11,
              },
            },
          },
          {
            id: 'test',
            name: 'workspace_run_command',
            arguments: { command: 'npm', args: ['run', 'test'] },
            success: true,
            result: {
              command: 'npm',
              args: ['run', 'test'],
              status: 0,
              timedOut: false,
            },
          },
        ],
      })
    ).toBe(false);
  });

  it('does not finalize changed work without successful validation evidence', () => {
    expect(
      isAgentResponseSuccessfullyFinalized({
        content: '已完成修改。',
        executedTools: [
          {
            id: 'write',
            name: 'workspace_write_file',
            arguments: { relativePath: 'src/App.tsx' },
            success: true,
            result: {
              path: 'src/App.tsx',
              change: {
                kind: 'updated',
                added: 2,
                deleted: 1,
                beforeLines: 10,
                afterLines: 11,
              },
            },
          },
        ],
      })
    ).toBe(true);
  });

  it('finalizes validated work even if merged content still contains earlier planning text', () => {
    expect(
      isAgentResponseSuccessfullyFinalized({
        content: '让我确认最终文件状态：\n\n代码干净。最终检查通过。',
        executedTools: [
          {
            id: 'write',
            name: 'workspace_write_file',
            arguments: { relativePath: 'src/App.tsx' },
            success: true,
            result: {
              path: 'src/App.tsx',
              change: {
                kind: 'updated',
                added: 2,
                deleted: 1,
                beforeLines: 10,
                afterLines: 11,
              },
            },
          },
          {
            id: 'test',
            name: 'workspace_run_command',
            arguments: { command: 'npm', args: ['run', 'test'] },
            success: true,
            result: {
              command: 'npm',
              args: ['run', 'test'],
              status: 0,
              timedOut: false,
            },
          },
          {
            id: 'patch-failed',
            name: 'workspace_apply_patch',
            arguments: { relativePath: 'src/App.tsx' },
            success: false,
            result: {
              error: '未找到要替换的文本块',
            },
            error: '未找到要替换的文本块',
          },
        ],
      })
    ).toBe(true);
  });

  it('finalizes clean completion even when earlier merged text mentioned remaining work', () => {
    expect(
      isAgentResponseSuccessfullyFinalized({
        content: '还需要继续处理剩余测试。\n\n现在已经全部搞定，最终检查通过。',
        executedTools: [
          {
            id: 'write',
            name: 'workspace_write_file',
            arguments: { relativePath: 'src/App.tsx' },
            success: true,
            result: {
              path: 'src/App.tsx',
              change: {
                kind: 'updated',
                added: 2,
                deleted: 1,
                beforeLines: 10,
                afterLines: 11,
              },
            },
          },
        ],
      })
    ).toBe(true);
  });

  it('does not finalize completion text when unresolved command failures remain', () => {
    expect(
      isAgentResponseSuccessfullyFinalized({
        content: '修好了。',
        executedTools: [
          {
            id: 'write',
            name: 'workspace_write_file',
            arguments: { relativePath: 'src/App.tsx' },
            success: true,
            result: {
              path: 'src/App.tsx',
              change: {
                kind: 'updated',
                added: 2,
                deleted: 1,
                beforeLines: 10,
                afterLines: 11,
              },
            },
          },
          {
            id: 'build',
            name: 'workspace_run_command',
            arguments: { command: 'npm', args: ['run', 'build'] },
            success: true,
            result: {
              command: 'npm',
              args: ['run', 'build'],
              status: 1,
              timedOut: false,
            },
          },
        ],
      })
    ).toBe(false);
  });
});

describe('shouldAppendAgentCompletionSummary', () => {
  it('does not append a summary when no tools ran', () => {
    expect(shouldAppendAgentCompletionSummary([])).toBe(false);
  });

  it('does not append a summary for read-only tool combinations', () => {
    expect(
      shouldAppendAgentCompletionSummary([
        {
          id: 'read-file',
          name: 'workspace_read_file',
          arguments: { relativePath: 'README.md' },
          success: true,
          result: { path: 'README.md', content: '# CodePapr' },
        },
        {
          id: 'search',
          name: 'workspace_search_text',
          arguments: { query: 'React' },
          success: true,
          result: { matches: [] },
        },
        {
          id: 'list',
          name: 'workspace_list_files',
          arguments: {},
          success: true,
          result: { entries: [] },
        },
        {
          id: 'map',
          name: 'workspace_project_graph',
          arguments: {},
          success: true,
          result: { summary: 'Vite + React + TypeScript' },
        },
      ])
    ).toBe(false);
  });

  it('appends a summary for project diagnostics', () => {
    expect(
      shouldAppendAgentCompletionSummary([
        {
          id: 'diagnostics',
          name: 'workspace_project_diagnostics',
          arguments: {},
          success: true,
          result: { available: true, overallStatus: 'passed', stages: [] },
        },
      ])
    ).toBe(true);
  });

  it('appends a summary for command execution', () => {
    expect(
      shouldAppendAgentCompletionSummary([
        {
          id: 'command',
          name: 'workspace_run_command',
          arguments: { command: 'npm', args: ['test'] },
          success: true,
          result: { command: 'npm', args: ['test'], status: 0, timedOut: false },
        },
      ])
    ).toBe(true);
  });

  it('appends a summary for background or preview sessions', () => {
    expect(
      shouldAppendAgentCompletionSummary([
        {
          id: 'background',
          name: 'workspace_start_background_command',
          arguments: { command: 'npm', args: ['run', 'dev'] },
          success: true,
          result: { command: 'npm', args: ['run', 'dev'], pid: 1234, started: true },
        },
      ])
    ).toBe(true);

    expect(
      shouldAppendAgentCompletionSummary([
        {
          id: 'preview',
          name: 'workspace_start_preview_session',
          arguments: { command: 'npm', args: ['run', 'dev'] },
          success: true,
          result: { command: 'npm', args: ['run', 'dev'], pid: 1234, started: true },
        },
      ])
    ).toBe(true);
  });

  it('appends a summary for file writes or patches', () => {
    expect(
      shouldAppendAgentCompletionSummary([
        {
          id: 'write',
          name: 'workspace_write_file',
          arguments: { relativePath: 'src/App.tsx' },
          success: true,
          result: { path: 'src/App.tsx' },
        },
      ])
    ).toBe(true);

    expect(
      shouldAppendAgentCompletionSummary([
        {
          id: 'patch',
          name: 'workspace_apply_patch',
          arguments: { relativePath: 'src/App.tsx' },
          success: true,
          result: { path: 'src/App.tsx' },
        },
      ])
    ).toBe(true);
  });

  it('appends a summary when read-only work is mixed with file changes', () => {
    expect(
      shouldAppendAgentCompletionSummary([
        {
          id: 'read-file',
          name: 'workspace_read_file',
          arguments: { relativePath: 'README.md' },
          success: true,
          result: { path: 'README.md', content: '# CodePapr' },
        },
        {
          id: 'write',
          name: 'workspace_write_file',
          arguments: { relativePath: 'src/App.tsx' },
          success: true,
          result: { path: 'src/App.tsx' },
        },
      ])
    ).toBe(true);
  });

  it('appends a summary for new LLM-facing tool names (write, edit, patch)', () => {
    expect(
      shouldAppendAgentCompletionSummary([
        { id: '1', name: 'write', arguments: {}, success: true, result: { path: 'a.ts' } },
      ])
    ).toBe(true);

    expect(
      shouldAppendAgentCompletionSummary([
        { id: '1', name: 'edit', arguments: {}, success: true, result: { path: 'a.ts' } },
      ])
    ).toBe(true);

    expect(
      shouldAppendAgentCompletionSummary([
        { id: '1', name: 'patch', arguments: {}, success: true, result: { path: 'a.ts' } },
      ])
    ).toBe(true);
  });

  it('appends a summary for git and exec tools', () => {
    expect(
      shouldAppendAgentCompletionSummary([
        { id: '1', name: 'git', arguments: {}, success: true, result: { ok: true } },
      ])
    ).toBe(true);

    expect(
      shouldAppendAgentCompletionSummary([
        { id: '1', name: 'exec', arguments: {}, success: true, result: { status: 0 } },
      ])
    ).toBe(true);
  });
});

describe('accumulateCacheStats', () => {
  it('merges token counts across auto-continued agent passes', () => {
    const merged = accumulateCacheStats(
      {
        cacheCreationTokens: 10,
        cacheReadTokens: 20,
        newInputTokens: 30,
        outputTokens: 40,
      },
      {
        cacheCreationTokens: 1,
        cacheReadTokens: 2,
        newInputTokens: 3,
        outputTokens: 4,
      }
    );

    expect(merged).toEqual({
      cacheCreationTokens: 11,
      cacheReadTokens: 22,
      newInputTokens: 33,
      outputTokens: 44,
      cacheHitRate: 22 / (11 + 22 + 33),
      calls: 0,
    });
  });

  it('retains prompt cache hit/miss aggregates when present', () => {
    const merged = accumulateCacheStats(
      {
        cacheCreationTokens: 0,
        cacheReadTokens: 20,
        newInputTokens: 10,
        outputTokens: 4,
        promptCacheHitTokens: 20,
        promptCacheMissTokens: 10,
      },
      {
        cacheCreationTokens: 0,
        cacheReadTokens: 5,
        newInputTokens: 7,
        outputTokens: 2,
        promptCacheHitTokens: 5,
        promptCacheMissTokens: 7,
      }
    );

    expect(merged).toEqual({
      cacheCreationTokens: 0,
      cacheReadTokens: 25,
      newInputTokens: 17,
      outputTokens: 6,
      promptCacheHitTokens: 25,
      promptCacheMissTokens: 17,
      cacheHitRate: 25 / 42,
      calls: 0,
    });
  });

  it('builds a stronger internal continue prompt', () => {
    expect(buildAgentExecutionContinuePrompt('我会先检查文件再修改。', 2, 'zh-CN')).toContain(
      '第 2 次继续执行提醒'
    );
    expect(buildAgentExecutionContinuePrompt('我会先检查文件再修改。', 2, 'zh-CN')).toContain(
      '不要再解释计划'
    );
  });

  it('limits auto-continue retries to a small bounded count', () => {
    expect(MAX_AGENT_AUTO_CONTINUE_PASSES).toBe(6);
  });

  it('injects a localized language directive into the system prompt', () => {
    expect(buildLocalizedSystemPrompt('Base prompt', 'en')).toContain('use English');
    expect(buildLocalizedSystemPrompt('Base prompt', 'zh-TW')).toContain('繁體中文');
  });

  it('builds an execution summary from tool results and final reply', () => {
    const executedTools = collectExecutedTools([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'calling tools',
        timestamp: 1,
        toolCalls: [
          {
            id: 'tool-write',
            name: 'workspace_write_file',
            arguments: { relativePath: 'src/App.tsx' },
          },
          {
            id: 'tool-command',
            name: 'workspace_run_command',
            arguments: { command: 'npm', args: ['run', 'test'] },
          },
          {
            id: 'tool-search-file',
            name: 'workspace_search_files',
            arguments: { query: 'App.tsx' },
          },
          {
            id: 'tool-download',
            name: 'web_download_file',
            arguments: { url: 'https://example.com/logo.png' },
          },
          {
            id: 'tool-dom',
            name: 'browser_read_dom',
            arguments: { selector: '#app', contentType: 'html' },
          },
          {
            id: 'tool-screenshot',
            name: 'browser_take_screenshot',
            arguments: { relativePath: '.CodePapr/screenshots/home.png' },
          },
          {
            id: 'tool-background',
            name: 'workspace_start_background_command',
            arguments: { command: 'npm', args: ['run', 'dev'] },
          },
          {
            id: 'tool-diagnostics',
            name: 'workspace_project_diagnostics',
            arguments: {},
          },
        ],
      },
      {
        id: 'tool-message-1',
        role: 'tool',
        content: '{}',
        timestamp: 2,
        toolResult: {
          toolCallId: 'tool-write',
          success: true,
          result: {
            path: 'src/App.tsx',
            bytes: 200,
            change: {
              kind: 'updated',
              added: 12,
              deleted: 3,
              beforeLines: 20,
              afterLines: 29,
            },
          },
        },
      },
      {
        id: 'tool-message-2',
        role: 'tool',
        content: '{}',
        timestamp: 3,
        toolResult: {
          toolCallId: 'tool-command',
          success: true,
          result: {
            command: 'npm',
            args: ['run', 'test'],
            status: 0,
            timedOut: false,
          },
        },
      },
      {
        id: 'tool-message-2b',
        role: 'tool',
        content: '{}',
        timestamp: 3,
        toolResult: {
          toolCallId: 'tool-search-file',
          success: true,
          result: {
            query: 'App.tsx',
            matches: [{ path: 'src/App.tsx', name: 'App.tsx', isDir: false, bytes: 200 }],
            truncated: false,
          },
        },
      },
      {
        id: 'tool-message-2c',
        role: 'tool',
        content: '{}',
        timestamp: 3,
        toolResult: {
          toolCallId: 'tool-download',
          success: true,
          result: {
            path: 'assets/logo.png',
            bytes: 1024,
            fileName: 'logo.png',
            url: 'https://example.com/logo.png',
          },
        },
      },
      {
        id: 'tool-message-2d',
        role: 'tool',
        content: '{}',
        timestamp: 3,
        toolResult: {
          toolCallId: 'tool-dom',
          success: true,
          result: {
            url: 'http://localhost:3000',
            title: 'Home',
            contentType: 'html',
            content: '<div id="app"></div>',
            truncated: false,
          },
        },
      },
      {
        id: 'tool-message-2e',
        role: 'tool',
        content: '{}',
        timestamp: 3,
        toolResult: {
          toolCallId: 'tool-screenshot',
          success: true,
          result: {
            path: '.CodePapr/screenshots/home.png',
            bytes: 2048,
            format: 'png',
            url: 'http://localhost:3000',
            title: 'Home',
          },
        },
      },
      {
        id: 'tool-message-3',
        role: 'tool',
        content: '{}',
        timestamp: 4,
        toolResult: {
          toolCallId: 'tool-background',
          success: true,
          result: {
            command: 'npm',
            args: ['run', 'dev'],
            pid: 43210,
            started: true,
          },
        },
      },
      {
        id: 'tool-message-4',
        role: 'tool',
        content: '{}',
        timestamp: 5,
        toolResult: {
          toolCallId: 'tool-diagnostics',
          success: true,
          result: {
            available: true,
            overallStatus: 'failed',
            stages: [
              {
                label: 'lint',
                command: 'npm',
                args: ['run', 'lint'],
                status: 0,
                timedOut: false,
                success: true,
                fallback: false,
              },
              {
                label: 'typecheck',
                command: 'npm',
                args: ['run', 'build'],
                status: 1,
                timedOut: false,
                success: false,
                fallback: true,
              },
            ],
          },
        },
      },
    ]);

    const summary = buildAgentCompletionSummary({
      lang: 'zh-CN',
      finalResponseContent: '已完成修改，并执行 npm run test 验证通过。',
      executedTools,
    });

    expect(summary).toContain('执行总结');
    expect(summary).toContain('已编辑 3 个文件（新增 2、修改 1），+12/-3');
    expect(summary).toContain('撤销状态：本轮未执行自动撤销');
    expect(summary).toContain('[src/App.tsx](codepapr-file:src%2FApp.tsx) (+12/-3');
    expect(summary).toContain('20 -> 29 行');
    expect(summary).toContain('[new] [assets/logo.png](codepapr-file:assets%2Flogo.png) (+0/-0)');
    expect(summary).toContain('[new] [.CodePapr/screenshots/home.png](codepapr-file:.CodePapr%2Fscreenshots%2Fhome.png) (+0/-0)');
    expect(summary).toContain('已完成 2 次上下文读取/搜索/目录检查');
    expect(summary).toContain('npm run test -> 退出码 0');
    expect(summary).toContain('npm run dev -> 已在后台启动 (PID 43210)');
    expect(summary).toContain('项目级诊断存在失败项');
    expect(summary).toContain('lint -> 退出码 0');
    expect(summary).toContain('typecheck -> 退出码 1（build fallback）');
    expect(summary).toContain('已完成修改，并执行 npm run test 验证通过');
  });

  it('builds a carry-forward execution evidence summary with command output excerpts', () => {
    const summary = buildExecutionContextSummary({
      lang: 'zh-CN',
      executedTools: [
        {
          id: 'write',
          name: 'workspace_write_file',
          arguments: { relativePath: 'src/App.tsx' },
          success: true,
          result: {
            path: 'src/App.tsx',
            change: {
              kind: 'updated',
              added: 8,
              deleted: 2,
              beforeLines: 40,
              afterLines: 46,
            },
          },
        },
        {
          id: 'command',
          name: 'workspace_run_command',
          arguments: { command: 'npm', args: ['run', 'test'] },
          success: true,
          result: {
            command: 'npm',
            args: ['run', 'test'],
            status: 0,
            timedOut: false,
            stdout: 'PASS src/App.test.tsx\nTests: 4 passed',
            stderr: '',
          },
        },
        {
          id: 'diag',
          name: 'workspace_project_diagnostics',
          arguments: {},
          success: true,
          result: {
            available: true,
            overallStatus: 'failed',
            stages: [
              {
                label: 'lint',
                command: 'npm',
                args: ['run', 'lint'],
                status: 1,
                timedOut: false,
                success: false,
                fallback: false,
                excerpt: 'src/App.tsx:12 no-unused-vars',
              },
            ],
          },
        },
        {
          id: 'tool-failed',
          name: 'workspace_read_file',
          arguments: { relativePath: 'missing.ts' },
          success: false,
          result: {
            message: 'ENOENT: no such file or directory',
          },
          error: 'ENOENT: no such file or directory',
        },
      ],
    });

    expect(summary).toContain('执行证据摘要');
    expect(summary).not.toContain('最终回复');
    expect(summary).not.toContain('已修复构建脚本并重新验证');
    expect(summary).toContain('src/App.tsx');
    expect(summary).toContain('npm run test -> 退出码 0');
    expect(summary).toContain('stdout: PASS src/App.test.tsx Tests: 4 passed');
    expect(summary).toContain('项目诊断失败');
    expect(summary).toContain('src/App.tsx:12 no-unused-vars');
    expect(summary).toContain('workspace_read_file 失败');
  });
  it('includes patch-based file changes and git status in the execution summary', () => {
    const executedTools = collectExecutedTools([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'calling tools',
        timestamp: 1,
        toolCalls: [
          {
            id: 'tool-patch',
            name: 'workspace_apply_patch',
            arguments: { relativePath: 'src/App.tsx' },
          },
          {
            id: 'tool-git-status',
            name: 'workspace_git_status',
            arguments: {},
          },
          {
            id: 'tool-diff',
            name: 'workspace_apply_diff',
            arguments: { patches: [] },
          },
        ],
      },
      {
        id: 'tool-message-1',
        role: 'tool',
        content: '{}',
        timestamp: 2,
        toolResult: {
          toolCallId: 'tool-patch',
          success: true,
          result: {
            path: 'src/App.tsx',
            bytes: 220,
            replacements: 1,
            change: {
              kind: 'updated',
              added: 2,
              deleted: 1,
              beforeLines: 20,
              afterLines: 21,
            },
          },
        },
      },
      {
        id: 'tool-message-2',
        role: 'tool',
        content: '{}',
        timestamp: 3,
        toolResult: {
          toolCallId: 'tool-diff',
          success: true,
          result: {
            files: [
              {
                path: 'src/utils.ts',
                bytes: 120,
                patches: 2,
                replacements: 2,
                change: {
                  kind: 'updated',
                  added: 3,
                  deleted: 1,
                  beforeLines: 10,
                  afterLines: 12,
                },
              },
            ],
            totalFiles: 1,
            totalPatches: 2,
            totalReplacements: 2,
          },
        },
      },
      {
        id: 'tool-message-3',
        role: 'tool',
        content: '{}',
        timestamp: 4,
        toolResult: {
          toolCallId: 'tool-git-status',
          success: true,
          result: {
            available: true,
            isRepo: true,
            branch: 'main...origin/main',
            files: [
              {
                path: 'src/App.tsx',
                indexStatus: 'M',
                worktreeStatus: '',
              },
              {
                path: 'README.md',
                indexStatus: '',
                worktreeStatus: 'M',
              },
            ],
            raw: '## main...origin/main\nM  src/App.tsx\n M README.md\n',
          },
        },
      },
    ]);

    const summary = buildAgentCompletionSummary({
      lang: 'zh-CN',
      finalResponseContent: '已完成局部补丁并检查当前 Git 变更。',
      executedTools,
    });

    expect(summary).toContain('[src/App.tsx](codepapr-file:src%2FApp.tsx) (+2/-1');
    expect(summary).toContain('[src/utils.ts](codepapr-file:src%2Futils.ts) (+3/-1');
    expect(summary).toContain('20 -> 21 行');
    expect(summary).toContain('10 -> 12 行');
    expect(summary).toContain('Git 变更');
    expect(summary).toContain('已读取 Git 工作区状态（main...origin/main）');
    expect(summary).toContain('撤销状态：未自动撤销');
    expect(summary).toContain('M  src/App.tsx');
    expect(summary).toContain(' M README.md');
  });

  it('marks duplicate background starts as already running', () => {
    const executedTools = collectExecutedTools([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'calling tools',
        timestamp: 1,
        toolCalls: [
          {
            id: 'tool-background',
            name: 'workspace_start_background_command',
            arguments: { command: 'npm', args: ['run', 'dev'] },
          },
        ],
      },
      {
        id: 'tool-message-1',
        role: 'tool',
        content: '{}',
        timestamp: 2,
        toolResult: {
          toolCallId: 'tool-background',
          success: true,
          result: {
            command: 'npm',
            args: ['run', 'dev'],
            pid: 43210,
            started: false,
          },
        },
      },
    ]);

    const summary = buildAgentCompletionSummary({
      lang: 'zh-CN',
      finalResponseContent: '已检查后台服务状态。',
      executedTools,
    });

    expect(summary).toContain('npm run dev -> 已在后台运行 (PID 43210)');
  });

  it('suppresses earlier tool failures after the same background command later succeeds', () => {
    const executedTools = collectExecutedTools([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'calling tools',
        timestamp: 1,
        toolCalls: [
          {
            id: 'tool-background-fail',
            name: 'workspace_start_background_command',
            arguments: { command: 'python', args: ['main.py'] },
          },
          {
            id: 'tool-background-ok',
            name: 'workspace_start_background_command',
            arguments: { command: 'python', args: ['main.py'] },
          },
        ],
      },
      {
        id: 'tool-message-1',
        role: 'tool',
        content: '{}',
        timestamp: 2,
        toolResult: {
          toolCallId: 'tool-background-fail',
          success: false,
          result: {
            command: 'python',
            args: ['main.py'],
            message: '启动后台命令失败: address already in use',
          },
          error: '启动后台命令失败: address already in use',
        },
      },
      {
        id: 'tool-message-2',
        role: 'tool',
        content: '{}',
        timestamp: 3,
        toolResult: {
          toolCallId: 'tool-background-ok',
          success: true,
          result: {
            command: 'python',
            args: ['main.py'],
            pid: 3100,
            started: true,
          },
        },
      },
    ]);

    const summary = buildAgentCompletionSummary({
      lang: 'zh-CN',
      finalResponseContent: '已重新启动后台服务并完成验证。',
      executedTools,
    });
    const evidence = buildExecutionContextSummary({
      lang: 'zh-CN',
      executedTools,
    });

    expect(summary).toContain('python main.py -> 已在后台启动 (PID 3100)');
    expect(summary).not.toContain('检查失败工具调用：workspace_start_background_command');
    expect(evidence).not.toContain('workspace_start_background_command 失败');
  });

  it('does not keep setup-like command failures as remaining risk after later successful validation', () => {
    const executedTools = collectExecutedTools([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'calling tools',
        timestamp: 1,
        toolCalls: [
          {
            id: 'tool-instantiation',
            name: 'workspace_run_command',
            arguments: {
              command: 'python',
              args: ['-c', 'from agent_tui.ui.app import AgentTUI; AgentTUI()'],
            },
          },
          {
            id: 'tool-syntax',
            name: 'workspace_run_command',
            arguments: { command: 'python', args: ['-m', 'py_compile', 'main.py'] },
          },
          {
            id: 'tool-url',
            name: 'workspace_run_command',
            arguments: { command: 'python', args: ['-c', 'print("url ok")'] },
          },
        ],
      },
      {
        id: 'tool-message-1',
        role: 'tool',
        content: '{}',
        timestamp: 2,
        toolResult: {
          toolCallId: 'tool-instantiation',
          success: true,
          result: {
            command: 'python',
            args: ['-c', 'from agent_tui.ui.app import AgentTUI; AgentTUI()'],
            status: 1,
            timedOut: false,
            stderr: "ModuleNotFoundError: No module named 'textual'",
          },
        },
      },
      {
        id: 'tool-message-2',
        role: 'tool',
        content: '{}',
        timestamp: 3,
        toolResult: {
          toolCallId: 'tool-syntax',
          success: true,
          result: {
            command: 'python',
            args: ['-m', 'py_compile', 'main.py'],
            status: 0,
            timedOut: false,
          },
        },
      },
      {
        id: 'tool-message-3',
        role: 'tool',
        content: '{}',
        timestamp: 4,
        toolResult: {
          toolCallId: 'tool-url',
          success: true,
          result: {
            command: 'python',
            args: ['-c', 'print("url ok")'],
            status: 0,
            timedOut: false,
          },
        },
      },
    ]);

    const summary = buildAgentCompletionSummary({
      lang: 'zh-CN',
      finalResponseContent: '已完成修复，后续独立验证均正常。',
      executedTools,
    });

    expect(summary).toContain('有 1 个早期依赖/环境型失败命令已被后续成功验证覆盖');
    expect(summary).not.toContain(
      '检查并处理失败命令：python -c from agent_tui.ui.app import AgentTUI; AgentTUI()'
    );
    expect(summary).toContain('python -c from agent_tui.ui.app import AgentTUI; AgentTUI() -> 退出码 1');
    expect(summary).toContain('python -m py_compile main.py -> 退出码 0');
  });

  it('treats preview sessions as background command summaries', () => {
    const executedTools = collectExecutedTools([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'calling tools',
        timestamp: 1,
        toolCalls: [
          {
            id: 'tool-preview',
            name: 'workspace_start_preview_session',
            arguments: { command: 'npm', args: ['run', 'dev'], previewUrl: 'http://localhost:3000' },
          },
        ],
      },
      {
        id: 'tool-message-1',
        role: 'tool',
        content: '{}',
        timestamp: 2,
        toolResult: {
          toolCallId: 'tool-preview',
          success: true,
          result: {
            command: 'npm',
            args: ['run', 'dev'],
            pid: 3100,
            started: true,
            previewUrl: 'http://localhost:3000',
          },
        },
      },
    ]);

    const summary = buildAgentCompletionSummary({
      lang: 'zh-CN',
      finalResponseContent: '已打开应用内预览。',
      executedTools,
    });

    expect(summary).toContain('npm run dev -> 已在后台启动 (PID 3100)');
  });
});
