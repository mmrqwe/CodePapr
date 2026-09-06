import fsp from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SMOKE_DIR,
  WORKSPACE_PATH,
  isRecord,
  logSection,
  readStoredSettings,
  runScenario,
  type SmokeResult,
  type SmokeScenario,
} from './agent-feedback-eval/lib/smokeHarness';

describe('agent tool smoke', () => {
  it(
    'uses the expected search, download, browser, and shell tools with a real model',
    async () => {
      if (process.env.CODEPAPR_REAL_SMOKE !== '1') {
        console.log('skip: set CODEPAPR_REAL_SMOKE=1 to run the real-model smoke test');
        return;
      }

      await fsp.mkdir(SMOKE_DIR, { recursive: true });
      const settings = readStoredSettings();
      const absoluteAnchorRelativePath = path.posix.join('.CodePapr', 'smoke', 'absolute-anchor.txt');
      const absoluteAnchorFilePath = path.join(WORKSPACE_PATH, absoluteAnchorRelativePath);
      const absoluteAnchorReference = `${absoluteAnchorFilePath}#L1`;
      const absoluteAnchorContent = 'absolute anchor smoke line 1\nabsolute anchor smoke line 2\n';
      await fsp.writeFile(absoluteAnchorFilePath, absoluteAnchorContent, 'utf8');
      const scenarios: SmokeScenario[] = [
        {
          name: 'search',
          prompt:
            '你在 Agent 模式。不要展开整棵文件树。请按文件名或路径搜索 PreviewSessionPanel.tsx 在哪里，只告诉我相对路径。',
          expected: ['workspace_search_files'],
        },
        {
          name: 'download',
          prompt:
            '你在 Agent 模式。把 https://github.com/robots.txt 下载到 .scratch/smoke/robots.txt，然后告诉我保存路径。',
          expected: ['web_download_file'],
        },
        {
          name: 'browser',
          prompt:
            '你在 Agent 模式。打开 https://smoke.local/form，在输入框 #query 输入 browser smoke，点击 #go，读取 #result 的文本，再把当前页面截图保存到 .scratch/smoke/form.png，最后关闭页面。不要用普通打开浏览器替代页面交互工具。',
          expected: [
            'browser_open_page',
            'browser_input_text',
            'browser_click',
            'browser_read_dom',
            'browser_take_screenshot',
            'browser_close_page',
          ],
        },
        {
          name: 'shell',
          prompt:
            '你在 Agent 模式。这个任务需要持续 shell 上下文。请打开一个 shell 会话，先执行 pwd，再执行 ls packages/@codepapr/ui/src/components | head -n 3，读取输出尾部确认结果，然后关闭会话。不要用一次性的 workspace_run_command 代替。',
          expected: ['shell_open_session', 'shell_send_input', 'shell_read_output', 'shell_close_session'],
        },
        {
          name: 'diagnostics-and-anchored-read',
          prompt:
            `你在 Agent 模式。先调用 workspace_project_diagnostics 获取当前项目的项目级诊断摘要。然后必须直接调用 workspace_read_file 读取这个绝对路径锚点：${absoluteAnchorReference}。不要把这个路径改写成相对路径，不要先搜索文件，也不要省略锚点。最后告诉我 diagnostics 的 overallStatus，以及该文件第一行是否等于 absolute anchor smoke line 1。`,
          expected: ['workspace_project_diagnostics', 'workspace_read_file'],
          validate: (result) => {
            const issues: string[] = [];
            const diagnosticsCall = result.toolInvocations.find(
              (invocation) => invocation.name === 'workspace_project_diagnostics'
            );
            if (!diagnosticsCall) {
              return issues;
            }
            if (diagnosticsCall.success !== true) {
              issues.push('workspace_project_diagnostics 未成功返回结果');
            } else if (!isRecord(diagnosticsCall.result) || diagnosticsCall.result.available !== true) {
              issues.push('workspace_project_diagnostics 结果缺少 available=true');
            }

            const anchoredReadCall = result.toolInvocations.find(
              (invocation) =>
                invocation.name === 'workspace_read_file' &&
                invocation.arguments.relativePath === absoluteAnchorReference
            );
            if (!anchoredReadCall) {
              issues.push('workspace_read_file 没有使用指定的绝对路径锚点参数');
              return issues;
            }
            if (anchoredReadCall.success !== true) {
              issues.push('workspace_read_file 未成功读取绝对路径锚点文件');
              return issues;
            }
            if (!isRecord(anchoredReadCall.result)) {
              issues.push('workspace_read_file 结果不是对象');
              return issues;
            }
            if (anchoredReadCall.result.path !== absoluteAnchorRelativePath) {
              issues.push('workspace_read_file 返回的相对路径不符合预期');
            }
            if (typeof anchoredReadCall.result.content !== 'string') {
              issues.push('workspace_read_file 结果缺少文本内容');
            } else if (!anchoredReadCall.result.content.startsWith('absolute anchor smoke line 1')) {
              issues.push('workspace_read_file 读取内容没有命中锚点文件首行');
            }

            return issues;
          },
        },
      ];

      const results: SmokeResult[] = [];
      for (const scenario of scenarios) {
        results.push(await runScenario(settings, scenario));
      }

      logSection('Smoke Summary');
      for (const result of results) {
        console.log(
          `${result.passed ? 'PASS' : 'FAIL'} ${result.name}: ${result.toolCalls.join(', ')}${result.issues.length ? ` | ${result.issues.join('; ')}` : ''}`
        );
      }

      const failed = results.filter((result) => !result.passed);
      expect(
        failed,
        failed
          .map((result) => {
            const failures = [...result.missing.map((item) => `missing ${item}`), ...result.issues];
            return `${result.name}: ${failures.join('; ')}`;
          })
          .join('\n')
      ).toEqual([]);
    },
    600_000
  );
});
