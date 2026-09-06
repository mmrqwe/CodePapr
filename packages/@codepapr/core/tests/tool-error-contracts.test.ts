import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tool/ToolRegistry';
import { registerSharedToolDispatchers } from '../src/tool/workspace/registerSharedWorkspaceTools';
import {
  applySearchReplaceDiff,
  applySearchReplacePatch,
} from '../src/tool/searchReplaceDiff';
import {
  formatMiddleTruncated,
  formatOffloadedContent,
} from '../src/tool/toolOutputTruncation';
import { readOnlyModeBlockMessage, GIT_READ_ONLY_ACTIONS } from '../src/agent/agentConfig';
import type { IToolDefinition } from '@codepapr/types';
import { assertErrorContract, captureReject, captureThrow } from './error-contract';

function stub(name: string) {
  const def: IToolDefinition = {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
  };
  return def;
}

function buildDispatchRegistry() {
  const registry = new ToolRegistry();
  for (const name of [
    'workspace_read_file',
    'workspace_write_file',
    'workspace_apply_patch',
    'workspace_apply_diff',
    'workspace_search_text',
    'workspace_search_files',
    'workspace_list_files',
    'workspace_lsp_diagnostics',
    'workspace_project_diagnostics',
    'workspace_workspace_symbol',
    'workspace_rename_symbol',
    'workspace_apply_code_action',
    'workspace_format_files',
    'workspace_symbol_definition',
    'workspace_run_shell_command',
    'workspace_start_shell_background_command',
    'workspace_list_background_processes',
    'workspace_stop_background_process',
    'workspace_stop_all_background_processes',
    'web_fetch_url',
    'skill_load',
  ]) {
    registry.register(stub(name), async () => ({ ok: true }));
  }
  registerSharedToolDispatchers({ registry });
  return registry;
}

describe('tool error contracts: search/replace (edit & patch 内核)', () => {
  it('无匹配错误给出核对指引（可行动），而非只说找不到', () => {
    const message = captureThrow(() =>
      applySearchReplacePatch('hello world\n', { search: 'nope', replace: 'x' })
    );
    assertErrorContract(message, {
      locate: [/要替换的文本块/],
      explain: [/未找到/],
      action: [/read|核对/],
    });
  });

  it('CRLF/LF 换行不匹配时点名两侧的换行风格', () => {
    const crlfFile = captureThrow(() =>
      applySearchReplacePatch('a\r\nb\r\n', { search: 'x\ny', replace: 'z' })
    );
    assertErrorContract(crlfFile, {
      locate: [/search/],
      explain: [/CRLF 换行，但 search 使用了 LF/],
      action: [/换行|read|核对/],
    });
    const lfFile = captureThrow(() =>
      applySearchReplacePatch('a\nb\n', { search: 'x\r\ny', replace: 'z' })
    );
    assertErrorContract(lfFile, {
      explain: [/LF 换行，但 search 使用了 CRLF/],
      action: [/换行|read|核对/],
    });
  });

  it('歧义匹配报出数量并给出两种消歧路径；expectedOccurrences 的误区被预先澄清', () => {
    const content = 'dup\ndup\ndup\n';
    const bare = captureThrow(() =>
      applySearchReplacePatch(content, { search: 'dup', replace: 'x' })
    );
    assertErrorContract(bare, {
      locate: [/匹配到 3 处/],
      explain: [/无法唯一确定|匹配到/],
      action: [/更精确的 search|replaceAll=true/],
    });
    const withExpected = captureThrow(() =>
      applySearchReplacePatch(content, {
        search: 'dup',
        replace: 'x',
        expectedOccurrences: 3,
      })
    );
    assertErrorContract(withExpected, {
      action: [/不能消歧/, /加长 search|replaceAll=true/],
    });
  });

  it('expectedOccurrences 校验失败时报出预期与实际两个数字', () => {
    const message = captureThrow(() =>
      applySearchReplacePatch('dup\ndup\n', {
        search: 'dup',
        replace: 'x',
        replaceAll: true,
        expectedOccurrences: 5,
      })
    );
    assertErrorContract(message, {
      explain: [/预期匹配 5 处，实际匹配 2 处/],
      action: [/read|核对|实际/],
    });
  });

  it('search 与 replace 相同被拒时能看懂原因', () => {
    const message = captureThrow(() =>
      applySearchReplacePatch('hello\n', { search: 'hello', replace: 'hello' })
    );
    assertErrorContract(message, { explain: [/完全一致|不能相同/] });
  });

  it('多文件 patch 失败定位到补丁序号与文件路径', () => {
    const message = captureThrow(() =>
      applySearchReplaceDiff(
        { 'src/a.ts': 'one\n', 'src/b.ts': 'two\n' },
        [
          { relativePath: 'src/a.ts', search: 'one', replace: 'ONE' },
          { relativePath: 'src/b.ts', search: 'missing', replace: 'TWO' },
        ]
      )
    );
    assertErrorContract(message, {
      locate: [/补丁 2/, /src\/b\.ts/],
      explain: [/未找到/],
      action: [/read|核对/],
    });
  });
});

describe('tool error contracts: dispatcher 参数与 action 校验', () => {
  it('未知 git action 枚举全部可用 action', async () => {
    const registry = buildDispatchRegistry();
    const message = await captureReject(registry.execute('git', { action: 'push' }));
    assertErrorContract(message, {
      locate: [/action: push/],
      explain: [/无此 action/],
      action: [/可用 action：status/, /commit/, /restore/],
    });
  });

  it('未知 bash action 枚举 run/list/stop/stop_all', async () => {
    const registry = buildDispatchRegistry();
    const message = await captureReject(
      registry.execute('bash', { command: 'ls', action: 'killall' })
    );
    assertErrorContract(message, {
      locate: [/action: killall/],
      action: [/可用 action：run \/ list \/ stop \/ stop_all/],
    });
  });

  it('未知 lsp_edit action 枚举可用 action', async () => {
    const registry = buildDispatchRegistry();
    const message = await captureReject(registry.execute('lsp_edit', { action: 'refactor' }));
    assertErrorContract(message, {
      locate: [/action: refactor/],
      action: [/rename/, /code_action/, /format/],
    });
  });

  it('缺参数错误点名参数并给出期望（glob query）', async () => {
    const registry = buildDispatchRegistry();
    const message = await captureReject(registry.execute('glob', {}));
    assertErrorContract(message, {
      locate: [/query/],
      explain: [/必须是非空字符串/],
    });
  });

  it('semantic grep 降级时说明降级原因与所需条件', async () => {
    const registry = buildDispatchRegistry();
    const result = (await registry.execute('grep', { query: 'handler', semantic: true })) as {
      note?: string;
      degraded?: boolean;
    };
    expect(result.degraded).toBe(true);
    assertErrorContract(result.note ?? '', {
      explain: [/语义搜索不可用/],
      action: [/relativePath|降级/],
    });
  });
});

describe('tool error contracts: 只读模式拦截', () => {
  it('git 变更 action 的拦截文案列出允许的只读 action', () => {
    const tool = { name: 'git', description: '', parameters: {} } as IToolDefinition;
    const message = readOnlyModeBlockMessage(tool, { action: 'commit' });
    assertErrorContract(message, {
      locate: [/git\(action: commit\)/],
      explain: [/只读模式/],
      action: GIT_READ_ONLY_ACTIONS.has('status')
        ? [/仅允许只读查看类 action：status \/ diff \/ log/]
        : [/仅允许/],
    });
  });

  it('ask 模式下 webfetch save 给出专门报错而非 tool not found', async () => {
    const registry = new ToolRegistry();
    registry.register(stub('web_fetch_url'), async () => ({ ok: true }));
    registerSharedToolDispatchers({ registry });
    const message = await captureReject(
      registry.execute('webfetch', { url: 'https://x.dev/a.txt', save: true })
    );
    assertErrorContract(message, {
      locate: [/webfetch/],
      explain: [/只读模式/],
      action: [/save/],
    });
  });
});

describe('tool error contracts: 大输出截断的自救路径', () => {
  it('落盘截断给出完整路径与 read 回读示例（可行动）', () => {
    const message = formatOffloadedContent('preview...', '.CodePapr/tool-output/abc.txt', 250_000, 'bash');
    assertErrorContract(message, {
      locate: [/.CodePapr\/tool-output\/abc\.txt/],
      explain: [/已截断，原始 250000 字符/],
      action: [/可用 read 工具查看完整内容/, /read\("\.CodePapr\/tool-output\/abc\.txt"\)/],
    });
  });

  it('未落盘时提示重新调用或缩小范围，不留死胡同', () => {
    const message = formatOffloadedContent('preview...', undefined, 120_000, 'bash');
    assertErrorContract(message, {
      explain: [/已截断，原始 120000 字符/],
      action: [/重新调用 bash/, /缩小查询范围/],
    });
  });

  it('中间截断保留头尾并声明省略量与恢复手段', () => {
    const message = formatMiddleTruncated('HEAD', 'TAIL', 300_000);
    assertErrorContract(message, {
      explain: [/中间已省略：原始 300000 字符/],
      action: [/缩小查询范围|重新调用/],
    });
  });
});
