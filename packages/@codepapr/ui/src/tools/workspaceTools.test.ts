import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '@codepapr/core';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(
    async (_command: string, _args?: Record<string, unknown>) => ({})
  ),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import { registerWorkspaceTools } from './workspaceTools';
import type { RegisterWorkspaceToolsOptions } from './workspaceTools';
import { registerWorkspaceFileTools } from './workspaceFileTools';
import { registerWorkspaceAppTools } from './workspaceAppTools';
import { registerWorkspaceExecTools } from './workspaceExecTools';
import { registerWorkspaceSearchWebTools } from './workspaceSearchWebTools';
import { registerWorkspaceBrowserTools } from './workspaceBrowserTools';
import { registerWorkspaceGraphLspTools } from './workspaceGraphLspTools';
import { registerWorkspaceGitTools } from './workspaceGitTools';
import { registerWorkspaceMiscTools } from './workspaceMiscTools';
import type { WorkspaceToolContext } from './workspaceToolContext';

const names = (registry: ToolRegistry): string[] =>
  registry.getAll().map((tool) => tool.name).sort();

function build(options: RegisterWorkspaceToolsOptions = {}): ToolRegistry {
  const registry = new ToolRegistry();
  registerWorkspaceTools(registry, '/tmp/ws', undefined, undefined, options);
  return registry;
}

// 构造一个只含注册所需的最小 ctx：各域注册器在注册阶段仅读取 ctx.registry 与
// ctx.options（handler 体不会在此时执行），其余成员以桩占位即可。
function stubContext(registry: ToolRegistry, options: RegisterWorkspaceToolsOptions = {}): WorkspaceToolContext {
  return { registry, options } as unknown as WorkspaceToolContext;
}

describe('registerWorkspaceTools (domain split)', () => {
  it('registers without duplicate or unresolved tool definitions', () => {
    // ToolRegistry.register 对重复注册抛错、toolByName 对缺失定义抛错；
    // 能完整跑通即说明 8 个域注册器 + 合并分发器无重复、无遗漏定义。
    expect(() => build()).not.toThrow();
  });

  it('exposes exactly the merged LLM surface under default options', () => {
    const registry = build();
    // hideFromLlm 会把细粒度工具从 getAll() 删除，默认只留下合并工具 + websearch。
    expect(names(registry)).toEqual([
      'bash', 'browser', 'diagnostics', 'edit', 'git', 'glob', 'graph', 'grep',
      'list', 'lsp', 'lsp_edit', 'patch', 'read', 'skill', 'webfetch', 'websearch', 'write',
    ]);
  });

  it('soft-hides graph from the main-agent LLM by default but keeps it executable', () => {
    const registry = build();
    const llmNames = registry.getLlmTools().map((tool) => tool.name).sort();
    expect(llmNames).not.toContain('graph');
    // 软隐藏保留定义与 handler：getAll()/execute() 仍可用。
    expect(registry.has('graph')).toBe(true);
  });

  it('exposes graph to the LLM when exposeGraphToLlm is set', () => {
    const registry = build({ exposeGraphToLlm: true });
    expect(registry.getLlmTools().map((tool) => tool.name)).toContain('graph');
  });

  it('hides webfetch when web search tools are disabled', () => {
    const registry = build({ disableWebSearchTools: true });
    expect(names(registry)).not.toContain('webfetch');
    expect(names(registry)).not.toContain('websearch');
  });

  it('exposes app tools only in app mode', () => {
    const defaultRegistry = build();
    expect(names(defaultRegistry)).not.toContain('app_render');
    const appRegistry = build({ mode: 'app' });
    expect(names(appRegistry)).toContain('app_render');
  });

  it('exposes question only in plan mode', () => {
    expect(names(build())).not.toContain('question');
    expect(names(build({ mode: 'plan' }))).toContain('question');
  });

  it('exposes read_image only when multimodal is enabled', () => {
    expect(names(build())).not.toContain('read_image');
    expect(names(build({ multimodalEnabled: true }))).toContain('read_image');
  });

  it('keeps hidden fine-grained tools executable (handler survives hideFromLlm)', async () => {
    const registry = build();
    // hideFromLlm 只从 getAll() 移除定义，不删 handler——子代理仍可执行。
    expect(registry.has('local_time_now')).toBe(false);
    const result = (await registry.execute('local_time_now', {})) as { iso: string; unixMs: number };
    expect(typeof result.iso).toBe('string');
    expect(typeof result.unixMs).toBe('number');
  });

  it('wires the merged question dispatcher to a structured result', async () => {
    const registry = build({ mode: 'plan' });
    const result = (await registry.execute('question', {
      question: 'Proceed?',
      header: 'Confirm',
      options: [{ label: 'Yes', description: 'continue' }],
    })) as { __question: boolean; question: string; header: string };
    expect(result).toMatchObject({
      __question: true,
      question: 'Proceed?',
      header: 'Confirm',
    });
    expect(result).not.toHaveProperty('status');
  });

  it('tolerates string options and drops invalid option items', async () => {
    const registry = build({ mode: 'plan' });
    const result = (await registry.execute('question', {
      question: 'Pick one?',
      header: 'Pick',
      options: ['plain', 42, null, {}, { label: '' }, { label: 123 }, { label: 'valid', description: 99 }],
    })) as { options: Array<{ label: string; description?: string }> };
    expect(result.options).toEqual([
      { label: 'plain' },
      { label: 'valid' },
    ]);
  });

  it('caps option count and truncates long labels/descriptions safely', async () => {
    const registry = build({ mode: 'plan' });
    const filler = Array.from({ length: 20 }, (_, i) => ({ label: `opt-${i}` }));
    const longDescription = 'a'.repeat(500);
    const result = (await registry.execute('question', {
      question: 'Pick?',
      header: 'Pick',
      options: [
        ...filler.slice(0, 7),
        { label: '😀'.repeat(60), description: longDescription },
        ...filler.slice(7),
      ],
    })) as {
      options: Array<{ label: string; description?: string }>;
    };
    expect(result.options).toHaveLength(8);
    const emojiOption = result.options[7];
    // 截断按码点进行，不切开代理对：不含 U+FFFD 替换符，总码点数 ≤ 50
    expect(emojiOption?.label).not.toContain('\uFFFD');
    expect(Array.from(emojiOption?.label ?? '').length).toBeLessThanOrEqual(50);
    // 截断后以省略号结尾
    expect(emojiOption?.label?.endsWith('…')).toBe(true);
    // description 也被限制在 200 码点内
    expect(Array.from(emojiOption?.description ?? '').length).toBeLessThanOrEqual(200);
    expect(emojiOption?.description?.endsWith('…')).toBe(true);
  });

  it('omits options entirely when the model sends an empty array', async () => {
    const registry = build({ mode: 'plan' });
    const result = (await registry.execute('question', {
      question: 'Free text?',
      header: 'Free',
      options: [],
    })) as { options?: unknown; multiple?: boolean };
    expect(result.options).toBeUndefined();
    expect(result.multiple).toBeUndefined();
  });

  it('only includes multiple when options exist', async () => {
    const registry = build({ mode: 'plan' });
    const result = (await registry.execute('question', {
      question: 'Multi?',
      header: 'Multi',
      multiple: true,
    })) as { multiple?: boolean };
    expect(result.multiple).toBeUndefined();
  });
});

describe('individual domain registrars register their exact tool sets', () => {
  const register = (
    registrar: (ctx: WorkspaceToolContext) => void,
    options: RegisterWorkspaceToolsOptions = {},
  ): string[] => {
    const registry = new ToolRegistry();
    registrar(stubContext(registry, options));
    return names(registry);
  };

  it('file tools', () => {
    expect(register(registerWorkspaceFileTools)).toEqual([
      'workspace_apply_diff', 'workspace_apply_patch', 'workspace_list_files',
      'workspace_read_file', 'workspace_read_image', 'workspace_write_file',
    ]);
  });

  it('app tools', () => {
    expect(register(registerWorkspaceAppTools)).toEqual([
      'app_delete', 'app_list', 'app_render', 'app_start', 'app_stop',
    ]);
  });

  it('exec/shell/background tools', () => {
    expect(register(registerWorkspaceExecTools)).toEqual([
      'shell_close_session', 'shell_list_sessions', 'shell_open_session',
      'shell_read_output', 'shell_send_input',
      'workspace_list_background_processes', 'workspace_run_command',
      'workspace_run_shell_command', 'workspace_start_background_command',
      'workspace_start_preview_session', 'workspace_start_shell_background_command',
      'workspace_stop_all_background_processes', 'workspace_stop_background_process',
    ]);
  });

  it('search/web/skill tools (web enabled)', () => {
    expect(register(registerWorkspaceSearchWebTools)).toEqual([
      'skill_load', 'web_download_file', 'web_fetch_url', 'websearch',
      'workspace_search_files', 'workspace_search_text',
    ]);
  });

  it('search/web/skill tools (web disabled)', () => {
    expect(register(registerWorkspaceSearchWebTools, { disableWebSearchTools: true })).toEqual([
      'skill_load', 'workspace_search_files', 'workspace_search_text',
    ]);
  });

  it('browser tools', () => {
    expect(register(registerWorkspaceBrowserTools)).toEqual([
      'browser_click', 'browser_close_page', 'browser_close_preview',
      'browser_get_preview_session', 'browser_input_text', 'browser_navigate_page',
      'browser_navigate_preview', 'browser_open_page', 'browser_open_preview',
      'browser_read_dom', 'browser_reload_page', 'browser_reload_preview',
      'browser_take_screenshot',
    ]);
  });

  it('graph/lsp tools', () => {
    expect(register(registerWorkspaceGraphLspTools)).toEqual([
      'workspace_apply_code_action', 'workspace_change_impact',
      'workspace_dependency_subgraph', 'workspace_document_symbol',
      'workspace_entrypoints', 'workspace_fix_diagnostics', 'workspace_format_files',
      'workspace_implementation', 'workspace_incoming_calls', 'workspace_lsp_diagnostics',
      'workspace_organize_imports', 'workspace_outgoing_calls',
      'workspace_prepare_call_hierarchy', 'workspace_project_graph',
      'workspace_rename_symbol', 'workspace_smart_context', 'workspace_symbol_definition',
      'workspace_symbol_hover', 'workspace_symbol_implementations', 'workspace_symbol_lookup',
      'workspace_symbol_references', 'workspace_workspace_symbol',
    ]);
  });

  it('git tools', () => {
    expect(register(registerWorkspaceGitTools)).toEqual([
      'workspace_git_branch_checkout', 'workspace_git_commit', 'workspace_git_diff',
      'workspace_git_history', 'workspace_git_reset', 'workspace_git_restore',
      'workspace_git_stage', 'workspace_git_status', 'workspace_restore_undo',
    ]);
  });

  it('misc tools', () => {
    expect(register(registerWorkspaceMiscTools)).toEqual([
      'local_time_now', 'workspace_project_diagnostics',
    ]);
  });
});

describe('exec tools check command paths including the executable token', () => {
  function execRegistry() {
    const registry = new ToolRegistry();
    const ensureExternalPathAllowed = vi.fn(async () => {});
    const ctx = {
      registry,
      workspace: () => '/tmp/ws',
      ensureExternalPathAllowed,
      options: {},
    } as unknown as WorkspaceToolContext;
    registerWorkspaceExecTools(ctx);
    return { registry, ensureExternalPathAllowed };
  }

  const checkedPaths = (mock: ReturnType<typeof vi.fn>): string[] =>
    mock.mock.calls.map((call) => call[0]).filter((p): p is string => typeof p === 'string');

  beforeEach(() => {
    invokeMock.mockClear();
    invokeMock.mockResolvedValue({});
  });

  it('checks the first token (executable body) of workspace_run_command', async () => {
    // 回归：首 token 是可执行文件本体，绝不能跳过授权检查
    const { registry, ensureExternalPathAllowed } = execRegistry();
    await registry.execute('workspace_run_command', {
      command: '/opt/tools/mytool --flag /tmp/data.txt',
    });
    expect(checkedPaths(ensureExternalPathAllowed)).toEqual(
      expect.arrayContaining(['/opt/tools/mytool', '/tmp/data.txt']),
    );
  });

  it('skips system paths and relative commands', async () => {
    const { registry, ensureExternalPathAllowed } = execRegistry();
    await registry.execute('workspace_run_command', {
      command: '/usr/bin/python3 script.py',
    });
    expect(checkedPaths(ensureExternalPathAllowed)).toEqual([]);
  });

  it('checks absolute paths in args', async () => {
    const { registry, ensureExternalPathAllowed } = execRegistry();
    await registry.execute('workspace_run_command', {
      command: 'node',
      args: ['server.js', '--config', '/etc/myapp/conf.json'],
    });
    expect(checkedPaths(ensureExternalPathAllowed)).toEqual(['/etc/myapp/conf.json']);
  });

  it('checks the executable token in shell commands', async () => {
    const { registry, ensureExternalPathAllowed } = execRegistry();
    await registry.execute('workspace_run_shell_command', {
      command: '/tmp/evil/run.sh && /usr/local/bin/node ok.js',
    });
    expect(checkedPaths(ensureExternalPathAllowed)).toEqual(
      expect.arrayContaining(['/tmp/evil/run.sh']),
    );
  });

  it('checks shell_send_input payload paths', async () => {
    const { registry, ensureExternalPathAllowed } = execRegistry();
    await registry.execute('shell_send_input', {
      sessionId: 's1',
      input: '/tmp/evil/run.sh',
    });
    expect(checkedPaths(ensureExternalPathAllowed)).toEqual(['/tmp/evil/run.sh']);
  });

  it('blocks execution when path authorization is denied', async () => {
    const registry = new ToolRegistry();
    const ensureExternalPathAllowed = vi.fn(async () => {
      throw new Error('用户拒绝访问外部路径：/tmp/evil/run.sh');
    });
    const ctx = {
      registry,
      workspace: () => '/tmp/ws',
      ensureExternalPathAllowed,
      options: {},
    } as unknown as WorkspaceToolContext;
    registerWorkspaceExecTools(ctx);

    await expect(
      registry.execute('workspace_run_command', { command: '/tmp/evil/run.sh' }),
    ).rejects.toThrow(/拒绝访问/);
    const invoked = invokeMock.mock.calls.some(([command]) => command === 'run_workspace_command');
    expect(invoked).toBe(false);
  });
});

describe('workspace search tools includeIgnoredDirs passthrough', () => {
  const emptySearchResult = {
    query: 'x',
    matches: [],
    truncated: false,
    regexDegraded: false,
    note: null,
    skippedFiles: 0,
  };

  beforeEach(() => {
    invokeMock.mockClear();
  });

  function makeRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    const ctx = {
      registry,
      workspace: () => '/tmp/ws',
      options: { disableWebSearchTools: true },
    } as unknown as WorkspaceToolContext;
    registerWorkspaceSearchWebTools(ctx);
    return registry;
  }

  it('forwards includeIgnoredDirs to the text search command', async () => {
    invokeMock.mockResolvedValueOnce(emptySearchResult);
    const registry = makeRegistry();
    await registry.execute('workspace_search_text', { query: 'foo', includeIgnoredDirs: true });
    const call = invokeMock.mock.calls.find(([command]) => command === 'search_workspace_text');
    expect(call?.[1]).toMatchObject({ includeIgnoredDirs: true });
  });

  it('leaves includeIgnoredDirs undefined when the agent does not pass it', async () => {
    invokeMock.mockResolvedValueOnce(emptySearchResult);
    const registry = makeRegistry();
    await registry.execute('workspace_search_text', { query: 'foo' });
    const call = invokeMock.mock.calls.find(([command]) => command === 'search_workspace_text');
    expect(call?.[1]?.includeIgnoredDirs).toBeUndefined();
  });

  it('forwards includeIgnoredDirs to the path search command', async () => {
    invokeMock.mockResolvedValueOnce({
      query: 'x',
      matches: [],
      truncated: false,
      regexDegraded: false,
      note: null,
    });
    const registry = makeRegistry();
    await registry.execute('workspace_search_files', { query: 'foo', includeIgnoredDirs: true });
    const call = invokeMock.mock.calls.find(([command]) => command === 'search_workspace_paths');
    expect(call?.[1]).toMatchObject({ includeIgnoredDirs: true });
  });
});

describe('app_render agent tools validation', () => {
  const BASE_ARGS = {
    appId: 'demo-app',
    title: 'Demo App',
    html: '<!DOCTYPE html><html><body></body></html>',
  };

  function appRegistry(options: RegisterWorkspaceToolsOptions = {}): ToolRegistry {
    return build({ mode: 'app', ...options });
  }

  it('rejects websearch in agent tools when network is off', async () => {
    await expect(
      appRegistry().execute('app_render', {
        ...BASE_ARGS,
        local: 'read',
        network: false,
        agents: [{ name: 'searcher', tools: ['websearch'] }],
      }),
    ).rejects.toThrow(/网络.*关闭|不在当前访问档/);
  });

  it('accepts websearch in agent tools when network is on', async () => {
    await expect(
      appRegistry().execute('app_render', {
        ...BASE_ARGS,
        local: 'read',
        network: true,
        agents: [{ name: 'searcher', tools: ['websearch'] }],
      }),
    ).resolves.toMatchObject({ appId: 'demo-app', mounted: true });
  });

  it('rejects websearch when MCP search is enabled', async () => {
    await expect(
      appRegistry({ disableWebSearchTools: true }).execute('app_render', {
        ...BASE_ARGS,
        local: 'read',
        network: true,
        agents: [{ name: 'searcher', tools: ['websearch'] }],
      }),
    ).rejects.toThrow(/MCP 搜索/);
  });

  it('rejects unknown tool names', async () => {
    await expect(
      appRegistry().execute('app_render', {
        ...BASE_ARGS,
        agents: [{ name: 'searcher', tools: ['web_search'] }],
      }),
    ).rejects.toThrow(/未知工具|不在当前访问档/);
  });

  it('rejects task and app_render in agent tools', async () => {
    await expect(
      appRegistry().execute('app_render', {
        ...BASE_ARGS,
        local: 'read',
        agents: [{ name: 'helper', tools: ['read', 'task'] }],
      }),
    ).rejects.toThrow(/始终排除/);
  });

  it('rejects MCP tools when network is off', async () => {
    await expect(
      appRegistry().execute('app_render', {
        ...BASE_ARGS,
        local: 'read',
        network: false,
        agents: [{ name: 'searcher', tools: ['mcp__search__web_search'] }],
      }),
    ).rejects.toThrow(/MCP 工具需要 network/);
  });

  it('rejects write tools below local write', async () => {
    await expect(
      appRegistry().execute('app_render', {
        ...BASE_ARGS,
        local: 'read',
        agents: [{ name: 'editor', tools: ['read', 'write'] }],
      }),
    ).rejects.toThrow(/不在当前访问档/);
  });

  it('rejects bash below local write', async () => {
    await expect(
      appRegistry().execute('app_render', {
        ...BASE_ARGS,
        local: 'read',
        agents: [{ name: 'runner', tools: ['bash'] }],
      }),
    ).rejects.toThrow(/不在当前访问档/);
  });

  it('accepts high-risk tools at local write', async () => {
    await expect(
      appRegistry().execute('app_render', {
        ...BASE_ARGS,
        local: 'write',
        agents: [{ name: 'runner', tools: ['write', 'bash'] }],
      }),
    ).resolves.toMatchObject({ appId: 'demo-app', mounted: true });
  });

  it('rejects backend command below local read', async () => {
    await expect(
      appRegistry().execute('app_render', {
        ...BASE_ARGS,
        local: 'none',
        command: 'node',
        args: ['server.js'],
        port: 3456,
        files: [{ relativePath: 'server.js', content: 'console.log(1)' }],
      }),
    ).rejects.toThrow(/后端服务.*local/);
  });

  it('accepts backend command at local read', async () => {
    await expect(
      appRegistry().execute('app_render', {
        ...BASE_ARGS,
        local: 'read',
        network: false,
        command: 'node',
        args: ['server.js'],
        port: 3456,
        files: [{ relativePath: 'server.js', content: 'console.log(1)' }],
      }),
    ).resolves.toMatchObject({ appId: 'demo-app', mounted: true, hasBackend: true });
  });

  it('maps legacy level to two-axis access in manifest', async () => {
    await expect(
      appRegistry().execute('app_render', {
        ...BASE_ARGS,
        level: 2,
        agents: [{ name: 'searcher', tools: ['websearch', 'read'] }],
      }),
    ).resolves.toMatchObject({ appId: 'demo-app', mounted: true });
  });

  it.each(['manifest.json', 'index.html', 'db.sqlite', 'db.sqlite-wal', 'db.sqlite-shm', './db.sqlite'])(
    'rejects reserved file %s in files parameter',
    async (relativePath) => {
      await expect(
        appRegistry().execute('app_render', {
          ...BASE_ARGS,
          files: [{ relativePath, content: 'x' }],
        }),
      ).rejects.toThrow(/保留文件/);
    },
  );

  it('accepts non-reserved files', async () => {
    await expect(
      appRegistry().execute('app_render', {
        ...BASE_ARGS,
        files: [{ relativePath: 'server.js', content: 'console.log(1)' }],
      }),
    ).resolves.toMatchObject({ appId: 'demo-app', mounted: true });
  });
});
