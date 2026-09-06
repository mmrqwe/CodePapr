import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { registerWorkspaceAppTools, syncRunningBackendsToAccess, validateManifestInbox, summarizeManifestInbox } from './workspaceAppTools';
import { registerWorkspaceExecTools } from './workspaceExecTools';
import { registerWorkspaceSearchWebTools } from './workspaceSearchWebTools';
import { registerWorkspaceBrowserTools } from './workspaceBrowserTools';
import { registerWorkspaceGraphLspTools } from './workspaceGraphLspTools';
import { registerWorkspaceGitTools } from './workspaceGitTools';
import { registerWorkspaceMiscTools } from './workspaceMiscTools';
import type { WorkspaceToolContext } from './workspaceToolContext';
import { useAppRuntimeStore } from '../store/appRuntimeStore';
import { usePermissionStore as usePaprPermissionStore } from '../papr/permissionStore';
import { registerAppPoster, clearAppPosters, type AppChannelEnvelope } from '../papr/appChannelHub';

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
    // app_list 已从 app-only 移出，对 agent/plan/ask 只读可见（T1）。
    expect(names(registry)).toEqual([
      'app_list',
      'app_publish',
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

  it('exposes app_publish in all writable modes (not app-mode-only)', () => {
    // 看板/面板推送是 Agent 日常能力，不限于 App 模式；ask 只读由
    // FilteringToolRegistry 按 MUTATING_TOOL_NAMES 硬拦（见 agent-config 测试）。
    expect(names(build())).toContain('app_publish');
    expect(names(build({ mode: 'plan' }))).toContain('app_publish');
    expect(names(build({ mode: 'app' }))).toContain('app_publish');
  });

  it('exposes question only in plan mode', () => {
    expect(names(build())).not.toContain('question');
    expect(names(build({ mode: 'plan' }))).toContain('question');
  });

  it('exposes read_image only when multimodal is enabled', () => {
    expect(names(build())).not.toContain('read_image');
    expect(names(build({ multimodalEnabled: true }))).toContain('read_image');
  });

  it('supports path alias when executing workspace_read_image', async () => {
    invokeMock.mockImplementationOnce(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'read_image_file') {
        expect(args?.relativePath).toBe('assets/logo.png');
        return {
          path: 'assets/logo.png',
          mediaType: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          bytes: 68,
        };
      }
      return {};
    });
    const registry = build({ multimodalEnabled: true });
    // Execute with `path` parameter instead of `relativePath`
    const result = (await registry.execute('read_image', {
      path: 'assets/logo.png',
    })) as { path: string; mediaType: string; bytes: number; __images: Array<{ mediaType: string; data: string }> };
    expect(result.path).toBe('assets/logo.png');
    expect(result.mediaType).toBe('image/png');
    expect(result.__images?.[0]?.data).toContain('iVBORw0KGgoAAAANSUhEUg');
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
      'app_delete', 'app_list', 'app_publish', 'app_render', 'app_start', 'app_stop',
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
  function appRegistry(options: RegisterWorkspaceToolsOptions = {}): ToolRegistry {
    return build({ mode: 'app', ...options });
  }

  function demoManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      spec: 'papr/0.1',
      name: 'Demo App',
      version: '0.1.0',
      entry: 'index.html',
      kind: 'app',
      local: 'none',
      network: false,
      ...overrides,
    };
  }

  function seedAppDisk(
    appId: string,
    manifest: Record<string, unknown>,
    files: Record<string, string> = {},
  ): void {
    const prefix = `.CodePapr/apps/${appId}/`;
    const entry = typeof manifest.entry === 'string' ? manifest.entry : 'index.html';
    const disk: Record<string, string> = {
      [`${prefix}manifest.json`]: JSON.stringify(manifest),
      [`${prefix}${entry}`]: '<!DOCTYPE html><html><body></body></html>',
      ...Object.fromEntries(
        Object.entries(files).map(([relative, content]) => [
          relative.startsWith('.CodePapr/') ? relative : `${prefix}${relative}`,
          content,
        ]),
      ),
    };
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'read_text_file') {
        const relativePath = String(args?.relativePath ?? '');
        const content = disk[relativePath];
        if (content == null) throw new Error(`not found: ${relativePath}`);
        return {
          path: `/tmp/ws/${relativePath}`,
          content,
          bytes: content.length,
          startLine: 1,
          endLine: 1,
          totalLines: 1,
          truncatedByRange: false,
          truncatedByBytes: false,
        };
      }
      if (command === 'write_text_file' || command === 'papr_snapshot_app') {
        throw new Error(`${command} should not be called by app_render`);
      }
      return {};
    });
  }

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({});
    useAppRuntimeStore.setState({
      apps: [],
      openedAppId: null,
      pinnedPluginIds: [],
      overlayLayouts: {},
    });
  });

  it('rejects write payloads and never writes files', async () => {
    await expect(
      appRegistry().execute('app_render', {
        appId: 'demo-app',
        title: 'Demo App',
        html: '<!DOCTYPE html><html><body></body></html>',
      }),
    ).rejects.toThrow(/只打开已落盘|不能写入文件/);
    expect(invokeMock.mock.calls.some(([command]) => command === 'write_text_file')).toBe(false);
    expect(invokeMock.mock.calls.some(([command]) => command === 'read_text_file')).toBe(false);
  });

  it('rejects extra write fields even when only some are present', async () => {
    await expect(
      appRegistry().execute('app_render', {
        appId: 'demo-app',
        files: [{ relativePath: 'app.css', content: 'body{}' }],
      }),
    ).rejects.toThrow(/files/);
    await expect(
      appRegistry().execute('app_render', { appId: 'demo-app', kind: 'plugin' }),
    ).rejects.toThrow(/kind/);
  });

  it('errors when the app is not on disk yet', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'read_text_file') throw new Error('not found');
      return {};
    });
    await expect(appRegistry().execute('app_render', { appId: 'missing-app' })).rejects.toThrow(
      /找不到.*manifest\.json/,
    );
  });

  it('rejects websearch in agent tools when network is off', async () => {
    seedAppDisk(
      'demo-app',
      demoManifest({
        local: 'read',
        network: false,
        agents: [{ name: 'searcher', tools: ['websearch'] }],
      }),
    );
    await expect(appRegistry().execute('app_render', { appId: 'demo-app' })).rejects.toThrow(
      /网络.*关闭|不在当前访问档/,
    );
  });

  it('accepts websearch in agent tools when network is on', async () => {
    seedAppDisk(
      'demo-app',
      demoManifest({
        local: 'read',
        network: true,
        agents: [{ name: 'searcher', tools: ['websearch'] }],
      }),
    );
    await expect(appRegistry().execute('app_render', { appId: 'demo-app' })).resolves.toMatchObject({
      appId: 'demo-app',
      mounted: true,
    });
    expect(invokeMock.mock.calls.some(([command]) => command === 'write_text_file')).toBe(false);
  });

  it('rejects websearch when MCP search is enabled', async () => {
    seedAppDisk(
      'demo-app',
      demoManifest({
        local: 'read',
        network: true,
        agents: [{ name: 'searcher', tools: ['websearch'] }],
      }),
    );
    await expect(
      appRegistry({ disableWebSearchTools: true }).execute('app_render', { appId: 'demo-app' }),
    ).rejects.toThrow(/MCP 搜索/);
  });

  it('rejects unknown tool names', async () => {
    seedAppDisk(
      'demo-app',
      demoManifest({
        agents: [{ name: 'searcher', tools: ['web_search'] }],
      }),
    );
    await expect(appRegistry().execute('app_render', { appId: 'demo-app' })).rejects.toThrow(
      /未知工具|不在当前访问档/,
    );
  });

  it('rejects task and app_render in agent tools', async () => {
    seedAppDisk(
      'demo-app',
      demoManifest({
        local: 'read',
        agents: [{ name: 'helper', tools: ['read', 'task'] }],
      }),
    );
    await expect(appRegistry().execute('app_render', { appId: 'demo-app' })).rejects.toThrow(/始终排除/);
  });

  it('rejects MCP tools when network is off', async () => {
    seedAppDisk(
      'demo-app',
      demoManifest({
        local: 'read',
        network: false,
        agents: [{ name: 'searcher', tools: ['mcp__search__web_search'] }],
      }),
    );
    await expect(appRegistry().execute('app_render', { appId: 'demo-app' })).rejects.toThrow(
      /MCP 工具需要 network/,
    );
  });

  it('rejects write tools below local write', async () => {
    seedAppDisk(
      'demo-app',
      demoManifest({
        local: 'read',
        agents: [{ name: 'editor', tools: ['read', 'write'] }],
      }),
    );
    await expect(appRegistry().execute('app_render', { appId: 'demo-app' })).rejects.toThrow(
      /不在当前访问档/,
    );
  });

  it('rejects bash below local write', async () => {
    seedAppDisk(
      'demo-app',
      demoManifest({
        local: 'read',
        agents: [{ name: 'runner', tools: ['bash'] }],
      }),
    );
    await expect(appRegistry().execute('app_render', { appId: 'demo-app' })).rejects.toThrow(
      /不在当前访问档/,
    );
  });

  it('accepts high-risk tools at local write', async () => {
    seedAppDisk(
      'demo-app',
      demoManifest({
        local: 'write',
        agents: [{ name: 'runner', tools: ['write', 'bash'] }],
      }),
    );
    await expect(appRegistry().execute('app_render', { appId: 'demo-app' })).resolves.toMatchObject({
      appId: 'demo-app',
      mounted: true,
    });
  });

  it('rejects backend command below local read', async () => {
    seedAppDisk(
      'demo-app',
      demoManifest({
        local: 'none',
        command: 'node',
        args: ['server.js'],
        port: 3456,
      }),
    );
    await expect(appRegistry().execute('app_render', { appId: 'demo-app' })).rejects.toThrow(
      /后端服务.*local/,
    );
  });

  it('accepts backend command at local read', async () => {
    seedAppDisk(
      'demo-app',
      demoManifest({
        local: 'read',
        network: false,
        command: 'node',
        args: ['server.js'],
        port: 3456,
      }),
    );
    await expect(appRegistry().execute('app_render', { appId: 'demo-app' })).resolves.toMatchObject({
      appId: 'demo-app',
      mounted: true,
      hasBackend: true,
    });
  });

  it('maps legacy level to two-axis access in manifest', async () => {
    seedAppDisk(
      'demo-app',
      demoManifest({
        local: undefined,
        network: undefined,
        level: 2,
        agents: [{ name: 'searcher', tools: ['websearch', 'read'] }],
      }),
    );
    await expect(appRegistry().execute('app_render', { appId: 'demo-app' })).resolves.toMatchObject({
      appId: 'demo-app',
      mounted: true,
    });
  });

  it('mounts icon from disk so a later scan can restore it', async () => {
    seedAppDisk('demo-app', demoManifest({ icon: '📊' }));
    await appRegistry().execute('app_render', { appId: 'demo-app' });
    expect(invokeMock.mock.calls.some(([command]) => command === 'write_text_file')).toBe(false);
    expect(useAppRuntimeStore.getState().apps.find((a) => a.appId === 'demo-app')?.icon).toBe('📊');
  });

  it('renders a plugin overlay, auto-pins, and reads kind/surface from disk', async () => {
    seedAppDisk(
      'stock-ticker',
      demoManifest({
        name: '股票看板',
        kind: 'plugin',
        local: 'none',
        network: true,
        surface: { type: 'overlay', width: 320, height: 180, position: 'top-right' },
      }),
    );
    await expect(appRegistry().execute('app_render', { appId: 'stock-ticker' })).resolves.toMatchObject({
      appId: 'stock-ticker',
      kind: 'plugin',
      pinned: true,
      hasBackend: false,
    });
    expect(invokeMock.mock.calls.some(([command]) => command === 'write_text_file')).toBe(false);
    expect(useAppRuntimeStore.getState().pinnedPluginIds).toEqual(['stock-ticker']);
  });

  it('rejects plugin backends, write access, and non-overlay surfaces from the manifest', async () => {
    seedAppDisk(
      'bad-plugin',
      demoManifest({
        kind: 'plugin',
        command: 'node',
        args: ['server.js'],
        port: 3456,
        local: 'read',
      }),
    );
    await expect(appRegistry().execute('app_render', { appId: 'bad-plugin' })).rejects.toThrow(/后端/);

    seedAppDisk(
      'write-plugin',
      demoManifest({
        kind: 'plugin',
        local: 'write',
      }),
    );
    await expect(appRegistry().execute('app_render', { appId: 'write-plugin' })).rejects.toThrow(/write/);

    seedAppDisk(
      'hud-plugin',
      demoManifest({
        kind: 'plugin',
        surface: { type: 'hud' },
      }),
    );
    await expect(appRegistry().execute('app_render', { appId: 'hud-plugin' })).rejects.toThrow(/overlay/);
  });

  it('remounts without stopping a running backend or snapshotting', async () => {
    useAppRuntimeStore.setState({
      apps: [
        {
          appId: 'demo-app',
          title: 'Demo App',
          html: '',
          filePath: '.CodePapr/apps/demo-app/index.html',
          command: 'node',
          args: ['server.js'],
          port: 3456,
          pid: 12345,
          url: 'http://localhost:3456/',
          manifestJson: '{}',
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      openedAppId: null,
      pinnedPluginIds: [],
      overlayLayouts: {},
    });
    seedAppDisk(
      'demo-app',
      demoManifest({
        local: 'read',
        command: 'node',
        args: ['server.js'],
        port: 3456,
      }),
    );
    await appRegistry().execute('app_render', { appId: 'demo-app' });
    expect(useAppRuntimeStore.getState().apps.find((a) => a.appId === 'demo-app')?.pid).toBe(12345);
    expect(invokeMock.mock.calls.some(([command]) => command === 'stop_background_process')).toBe(false);
    expect(invokeMock.mock.calls.some(([command]) => command === 'papr_snapshot_app')).toBe(false);
  });

  it('app_delete 先停止运行中的后端进程再删文件（工具定义承诺会停）', async () => {
    invokeMock.mockClear();
    // 预置运行中的后端（store 有 pid）
    useAppRuntimeStore.setState((state) => ({
      ...state,
      apps: [
        {
          appId: 'demo-app',
          title: 'Demo App',
          html: '<html></html>',
          filePath: '.CodePapr/apps/demo-app/index.html',
          command: 'node',
          args: ['server.js'],
          port: 3456,
          pid: 12345,
          url: 'http://localhost:3456/',
          manifestJson: '{}',
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    }));

    await expect(
      build({ mode: 'app' }).execute('app_delete', { appId: 'demo-app' }),
    ).resolves.toMatchObject({ appId: 'demo-app', deleted: true });

    // 旧实现：直接 papr_delete_app 删文件，运行中的后端变孤儿进程占端口
    expect(
      invokeMock.mock.calls.some(
        ([command, args]) => command === 'stop_background_process' && args?.pid === 12345,
      ),
    ).toBe(true);
    const paprDeleteIndex = invokeMock.mock.calls.findIndex(
      ([command]) => command === 'papr_delete_app',
    );
    const stopIndex = invokeMock.mock.calls.findIndex(
      ([command]) => command === 'stop_background_process',
    );
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(paprDeleteIndex).toBeGreaterThan(stopIndex);
  });
});

describe('D-13 app_stop / app_list 运行态对账', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({});
    usePaprPermissionStore.getState().clearAll();
    useAppRuntimeStore.setState((state) => ({
      ...state,
      apps: [
        {
          appId: 'orphan-app',
          title: 'Orphan',
          html: '<html></html>',
          filePath: '.CodePapr/apps/orphan-app/index.html',
          command: 'node',
          args: ['server.js'],
          port: 3456,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    }));
  });

  afterEach(() => {
    useAppRuntimeStore.setState((state) => ({ ...state, apps: [] }));
  });

  it('store 无 pid 时按端口从 Rust 注册表找回 pid 并停止（不再误报未在运行）', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'list_background_processes') {
        // 后端登记的是 127.0.0.1，store 丢 pid（webview reload 场景）
        return [{ pid: 5555, previewUrl: 'http://127.0.0.1:3456/' }];
      }
      if (command === 'stop_background_process') return { stopped: true };
      return {};
    });

    await expect(
      build({ mode: 'app' }).execute('app_stop', { appId: 'orphan-app' }),
    ).resolves.toMatchObject({ appId: 'orphan-app', stopped: true, pid: 5555 });

    const stopCall = invokeMock.mock.calls.find(
      ([command, args]) => command === 'stop_background_process' && args?.pid === 5555,
    );
    expect(stopCall).toBeTruthy();
  });

  it('app_list 的 isRunning 与 app_stop 口径一致（127.0.0.1 vs localhost 容错）', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'list_background_processes') {
        return [{ pid: 5555, previewUrl: 'http://127.0.0.1:3456/' }];
      }
      if (command === 'scan_workspace_apps') return [];
      return {};
    });

    const list = (await build({ mode: 'app' }).execute('app_list', {})) as Array<{
      appId: string;
      isRunning: boolean;
      url: string | null;
    }>;
    const entry = list.find((a) => a.appId === 'orphan-app');
    expect(entry?.isRunning).toBe(true);
    expect(entry?.url).toBe('http://127.0.0.1:3456/');
  });

  it('注册表无活进程时 app_stop 仍报未在运行', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'list_background_processes') return [];
      return {};
    });
    await expect(
      build({ mode: 'app' }).execute('app_stop', { appId: 'orphan-app' }),
    ).rejects.toThrow(/未在运行/);
  });
});

describe('app_start 后端启动工作目录', () => {
  beforeEach(() => {
    invokeMock.mockClear();
    invokeMock.mockResolvedValue({});
    usePaprPermissionStore.getState().clearAll();
    useAppRuntimeStore.setState((state) => ({
      ...state,
      apps: [
        {
          appId: 'demo-app',
          title: 'Demo App',
          html: '<html></html>',
          filePath: '.CodePapr/apps/demo-app/index.html',
          command: 'node',
          args: ['server.js'],
          port: 3456,
          manifestJson: JSON.stringify({ spec: 'papr/0.1', name: 'Demo App', local: 'read', network: true }),
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    }));
  });

  it('以 app 目录为 workdir 启动后端（相对 args 才能解析；math-mentor 回归）', async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'install_app_npm_deps') return 'skipped';
      if (command === 'allocate_app_port') return typeof args?.preferred === 'number' ? args.preferred : 3456;
      if (command === 'start_app_background_command') {
        return { pid: 4242, started: true, previewUrl: args?.previewUrl ?? null };
      }
      if (command === 'check_port_available_structured') return { v4: true, v6: false };
      if (command === 'check_port_available_detail') return 'v4=conn v6=refused';
      if (command === 'check_port_owned_by') return true;
      if (command === 'check_port_bind_address') return ['127.0.0.1'];
      return {};
    });

    await expect(
      build({ mode: 'app' }).execute('app_start', { appId: 'demo-app' }),
    ).resolves.toMatchObject({ appId: 'demo-app', pid: 4242, started: true });

    const spawnCall = invokeMock.mock.calls.find(
      ([command]) => command === 'start_app_background_command',
    );
    // 旧实现不带 workdir，Rust 侧 cwd=工作区根，`node server.js` 找不到模块秒退。
    // 新实现改走 start_app_background_command：cwd 由服务端按 appId resolve_app_dir
    // 解析（workspace/global 都对），前端不再传 workdir 字符串。
    expect(spawnCall?.[1]).toMatchObject({
      command: 'node',
      args: ['server.js'],
      appId: 'demo-app',
      sandbox: { network: true, workspaceWrite: false, allowBind: true },
      env: { PORT: '3456', HOST: '127.0.0.1' },
    });
    expect(spawnCall?.[1]).not.toHaveProperty('workdir');

    const installCall = invokeMock.mock.calls.find(
      ([command]) => command === 'install_app_npm_deps',
    );
    expect(installCall?.[1]).toMatchObject({ allowNetwork: true });
  });

  it('后端沙箱使用设置覆盖后的生效档（覆盖只能收窄）', async () => {
    useAppRuntimeStore.setState((state) => ({
      ...state,
      apps: state.apps.map((app) =>
        app.appId === 'demo-app'
          ? {
              ...app,
              manifestJson: JSON.stringify({
                spec: 'papr/0.1',
                name: 'Demo App',
                local: 'write',
                network: true,
              }),
            }
          : app,
      ),
    }));
    usePaprPermissionStore.getState().setAppSettings({
      defaultLocal: 'none',
      defaultNetwork: false,
      appOverrides: { 'demo-app': { local: 'read', network: false } },
    });

    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'install_app_npm_deps') return 'skipped';
      if (command === 'allocate_app_port') return typeof args?.preferred === 'number' ? args.preferred : 3456;
      if (command === 'start_app_background_command') {
        return { pid: 4242, started: true, previewUrl: args?.previewUrl ?? null };
      }
      if (command === 'check_port_available_structured') return { v4: true, v6: false };
      if (command === 'check_port_owned_by') return true;
      if (command === 'check_port_bind_address') return ['127.0.0.1'];
      return {};
    });

    await expect(
      build({ mode: 'app' }).execute('app_start', { appId: 'demo-app' }),
    ).resolves.toMatchObject({ appId: 'demo-app', pid: 4242, started: true });

    const spawnCall = invokeMock.mock.calls.find(
      ([command]) => command === 'start_app_background_command',
    );
    expect(spawnCall?.[1]).toMatchObject({
      sandbox: { network: false, workspaceWrite: false, allowBind: true },
    });

    // C-4 回归：离线生效档必须把 network=false 传给依赖安装，禁止静默联网 npm 拉包
    const installCall = invokeMock.mock.calls.find(
      ([command]) => command === 'install_app_npm_deps',
    );
    expect(installCall?.[1]).toMatchObject({ allowNetwork: false });
  });

  it('权限变更后停掉并按新沙箱重启正在运行的后端', async () => {
    useAppRuntimeStore.setState((state) => ({
      ...state,
      apps: state.apps.map((app) =>
        app.appId === 'demo-app'
          ? {
              ...app,
              pid: 111,
              url: 'http://localhost:3456/',
              manifestJson: JSON.stringify({
                spec: 'papr/0.1',
                name: 'Demo App',
                local: 'write',
                network: true,
              }),
            }
          : app,
      ),
    }));

    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'stop_background_process') return { stopped: true };
      if (command === 'install_app_npm_deps') return 'skipped';
      if (command === 'allocate_app_port') return typeof args?.preferred === 'number' ? args.preferred : 3456;
      if (command === 'start_app_background_command') {
        return { pid: 222, started: true, previewUrl: args?.previewUrl ?? null };
      }
      if (command === 'check_port_available_structured') return { v4: true, v6: false };
      if (command === 'check_port_owned_by') return true;
      if (command === 'check_port_bind_address') return ['127.0.0.1'];
      return {};
    });

    const prev = { defaultLocal: 'none' as const, defaultNetwork: false, appOverrides: {} };
    const next = {
      defaultLocal: 'none' as const,
      defaultNetwork: false,
      appOverrides: { 'demo-app': { local: 'read' as const, network: false } },
    };
    usePaprPermissionStore.getState().setAppSettings(next);

    const result = await syncRunningBackendsToAccess(prev, next, '/tmp/ws');
    expect(result.restarted).toEqual(['demo-app']);
    expect(
      invokeMock.mock.calls.some(
        ([command, args]) => command === 'stop_background_process' && args?.pid === 111,
      ),
    ).toBe(true);
    const spawnCall = invokeMock.mock.calls.find(
      ([command]) => command === 'start_app_background_command',
    );
    expect(spawnCall?.[1]).toMatchObject({
      sandbox: { network: false, workspaceWrite: false, allowBind: true },
    });
    expect(useAppRuntimeStore.getState().apps.find((a) => a.appId === 'demo-app')?.pid).toBe(222);
  });

  it('权限未变则不重启后端；local 收到 none 时只停不启', async () => {
    useAppRuntimeStore.setState((state) => ({
      ...state,
      apps: state.apps.map((app) =>
        app.appId === 'demo-app'
          ? {
              ...app,
              pid: 111,
              url: 'http://localhost:3456/',
              manifestJson: JSON.stringify({
                spec: 'papr/0.1',
                name: 'Demo App',
                local: 'write',
                network: true,
              }),
            }
          : app,
      ),
    }));

    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'stop_background_process') return { stopped: true };
      return {};
    });

    const unchanged = { defaultLocal: 'none' as const, defaultNetwork: false, appOverrides: {} };
    const same = await syncRunningBackendsToAccess(unchanged, unchanged, '/tmp/ws');
    expect(same.restarted).toEqual([]);
    expect(same.stoppedOnly).toEqual([]);
    expect(invokeMock.mock.calls.some(([command]) => command === 'stop_background_process')).toBe(false);

    const narrowed = {
      defaultLocal: 'none' as const,
      defaultNetwork: false,
      appOverrides: { 'demo-app': { local: 'none' as const, network: false } },
    };
    usePaprPermissionStore.getState().setAppSettings(narrowed);
    const stopped = await syncRunningBackendsToAccess(unchanged, narrowed, '/tmp/ws');
    expect(stopped.restarted).toEqual([]);
    expect(stopped.stoppedOnly).toEqual(['demo-app']);
    expect(useAppRuntimeStore.getState().apps.find((a) => a.appId === 'demo-app')?.pid).toBeUndefined();
  });

  it('启动失败时把退出码与进程真实输出返回给 agent（自愈诊断证据）', async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'install_app_npm_deps') return 'skipped';
      if (command === 'allocate_app_port') return typeof args?.preferred === 'number' ? args.preferred : 3456;
      if (command === 'start_app_background_command') {
        return { pid: 4242, started: true, previewUrl: args?.previewUrl ?? null };
      }
      // math-mentor 场景：进程秒退，端口始终无人监听（v4/v6 都 refused）
      if (command === 'check_port_available_structured') return { v4: false, v6: false };
      if (command === 'check_port_available_detail') return 'v4=refused v6=refused';
      if (command === 'background_process_exit_info') {
        return {
          pid: 4242,
          command: 'node',
          args: ['server.js'],
          exitCode: 1,
          signal: null,
          logTail: "[err] Error: Cannot find module '/tmp/ws/server.js'",
        };
      }
      return {};
    });

    // 快进 Date.now 越过 20s 轮询上限：首轮探测（端口仍空闲）后即判失败，
    // 避免测试真等 20 秒。每次调用步进 25s（> 20000ms 上限）。
    let clock = 1_000_000;
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      clock += 25_000;
      return clock;
    });

    try {
      const promise = build({ mode: 'app' }).execute('app_start', { appId: 'demo-app' });
      await expect(promise).rejects.toThrow(/exit=1/);
      await expect(promise).rejects.toThrow(/Cannot find module/);
    } finally {
      dateSpy.mockRestore();
    }

    // 失败后必须清理 spawned 进程，不留孤儿占端口
    expect(
      invokeMock.mock.calls.some(
        ([command, args]) => command === 'stop_background_process' && args?.pid === 4242,
      ),
    ).toBe(true);
  });
});

describe('workspace_apply_diff 写入原子性', () => {
  beforeEach(() => {
    useAppRuntimeStore.setState((state) => ({ ...state, apps: [] }));
  });

  it('#25 多文件写入中途失败时回滚已写入的文件，不留部分应用状态', async () => {
    const originalContents = new Map<string, string>([
      ['a.txt', 'AAA\n'],
      ['b.txt', 'BBB\n'],
    ]);
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'read_text_file') {
        const rel = String(args?.relativePath);
        return {
          path: rel,
          content: originalContents.get(rel) ?? '',
          bytes: (originalContents.get(rel) ?? '').length,
        };
      }
      if (command === 'write_text_file') {
        const rel = String(args?.relativePath);
        if (rel === 'b.txt') {
          throw new Error('磁盘写入失败: b.txt');
        }
        // 模拟写生效：后续验证重读能读到新内容
        originalContents.set(rel, String(args?.content ?? ''));
        return { path: rel, bytes: String(args?.content ?? '').length, encoding: null };
      }
      if (command === 'check_syntax') {
        return { supported: false, errorCount: 0, errors: [] };
      }
      if (command === 'extract_project_map_symbols') {
        return [];
      }
      throw new Error(`Unexpected invoke: ${command}`);
    });

    const registry = build();
    await expect(
      registry.execute('patch', {
        patches: [
          { relativePath: 'a.txt', search: 'AAA', replace: 'AAA-new' },
          { relativePath: 'b.txt', search: 'BBB', replace: 'BBB-new' },
        ],
      }),
    ).rejects.toThrow('磁盘写入失败: b.txt');

    // 旧实现：逐文件写盘，b.txt 失败后 a.txt 的新内容已落地（部分应用）。
    // 修复后：回滚 a.txt 到写前内容。
    const memoryWrites = invokeMock.mock.calls.filter(
      ([command, args]) => command === 'write_text_file' && args?.relativePath === 'a.txt',
    );
    const rollbackWrite = memoryWrites.find(([, args]) => args?.content === 'AAA\n');
    expect(rollbackWrite).toBeDefined();
    // 最新一次写 a.txt 必须恢复原内容（最后落盘的是回滚而非补丁结果）
    const lastWrite = memoryWrites[memoryWrites.length - 1];
    expect(lastWrite?.[1]?.content).toBe('AAA\n');
  });

  it('#25 写成功但验证失败的文件也必须回滚（不能只回滚写失败前的文件）', async () => {
    const originalContents = new Map<string, string>([
      ['a.txt', 'AAA\n'],
      ['b.txt', 'BBB\n'],
    ]);
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'read_text_file') {
        const rel = String(args?.relativePath);
        return {
          path: rel,
          content: originalContents.get(rel) ?? '',
          bytes: (originalContents.get(rel) ?? '').length,
        };
      }
      if (command === 'write_text_file') {
        const rel = String(args?.relativePath);
        // a.txt：写"成功"但不生效（回读仍是旧内容）→ 验证失败；
        // 旧实现此时 a.txt 未登记进 applied，回滚会漏掉它。
        if (rel !== 'a.txt') {
          originalContents.set(rel, String(args?.content ?? ''));
        }
        return { path: rel, bytes: String(args?.content ?? '').length, encoding: null };
      }
      if (command === 'check_syntax') {
        return { supported: false, errorCount: 0, errors: [] };
      }
      if (command === 'extract_project_map_symbols') {
        return [];
      }
      throw new Error(`Unexpected invoke: ${command}`);
    });

    const registry = build();
    await expect(
      registry.execute('patch', {
        patches: [
          { relativePath: 'a.txt', search: 'AAA', replace: 'AAA-new' },
          { relativePath: 'b.txt', search: 'BBB', replace: 'BBB-new' },
        ],
      }),
    ).rejects.toThrow('文件写入验证失败');

    // a.txt 写成功但验证失败：必须登记并回滚（最后一次写为原内容）
    const aWrites = invokeMock.mock.calls.filter(
      ([command, args]) => command === 'write_text_file' && args?.relativePath === 'a.txt',
    );
    expect(aWrites.length).toBeGreaterThanOrEqual(2);
    expect(aWrites[aWrites.length - 1]?.[1]?.content).toBe('AAA\n');
  });

  it('#25 全部写入成功时不回滚，正常返回所有文件结果', async () => {
    const originalContents = new Map<string, string>([
      ['a.txt', 'AAA\n'],
      ['b.txt', 'BBB\n'],
    ]);
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'read_text_file') {
        const rel = String(args?.relativePath);
        return {
          path: rel,
          content: originalContents.get(rel) ?? '',
          bytes: (originalContents.get(rel) ?? '').length,
        };
      }
      if (command === 'write_text_file') {
        const rel = String(args?.relativePath);
        // 模拟写生效：后续验证重读能读到新内容
        originalContents.set(rel, String(args?.content ?? ''));
        return { path: rel, bytes: String(args?.content ?? '').length, encoding: null };
      }
      if (command === 'check_syntax') {
        return { supported: false, errorCount: 0, errors: [] };
      }
      if (command === 'extract_project_map_symbols') {
        return [];
      }
      throw new Error(`Unexpected invoke: ${command}`);
    });

    const result = await build().execute('patch', {
      patches: [
        { relativePath: 'a.txt', search: 'AAA', replace: 'AAA-new' },
        { relativePath: 'b.txt', search: 'BBB', replace: 'BBB-new' },
      ],
    });

    expect(result).toMatchObject({
      totalFiles: 2,
      totalReplacements: 2,
      files: [
        expect.objectContaining({ path: 'a.txt' }),
        expect.objectContaining({ path: 'b.txt' }),
      ],
    });
  });
});

describe('app_publish (agent → app/plugin 推送)', () => {
  function kanbanManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      spec: 'papr/0.1',
      name: 'Kanban',
      kind: 'plugin',
      local: 'none',
      network: false,
      ...overrides,
    };
  }

  /** 模拟磁盘 manifest + Rust 侧 papr_inbox_append（返回 seq/ts）。 */
  function seed(manifest: Record<string, unknown>): { seqs: number[] } {
    const state = { seqs: [] as number[] };
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'read_text_file') {
        const relativePath = String(args?.relativePath ?? '');
        if (relativePath.endsWith('manifest.json')) {
          return { path: relativePath, content: JSON.stringify(manifest), bytes: 1 };
        }
        throw new Error(`not found: ${relativePath}`);
      }
      if (command === 'papr_inbox_append') {
        state.seqs.push(state.seqs.length + 1);
        return { seq: state.seqs.length, ts: 1000 + state.seqs.length };
      }
      throw new Error(`Unexpected invoke: ${command}`);
    });
    return state;
  }

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({});
    clearAppPosters();
  });

  it('manifest 不存在时报错并指引先创建应用', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'read_text_file') throw new Error('not found');
      return {};
    });
    await expect(
      build().execute('app_publish', { appId: 'ghost', channel: 'cards', payload: { a: 1 } }),
    ).rejects.toThrow(/找不到.*manifest\.json/);
  });

  it('校验 appId / channel / payload', async () => {
    seed(kanbanManifest());
    const registry = build();
    await expect(
      registry.execute('app_publish', { appId: 'Bad-Case', channel: 'cards', payload: {} }),
    ).rejects.toThrow(/kebab-case/);
    await expect(
      registry.execute('app_publish', { appId: 'kanban', channel: '-bad', payload: {} }),
    ).rejects.toThrow(/channel/);
    await expect(
      registry.execute('app_publish', { appId: 'kanban', channel: 'cards' }),
    ).rejects.toThrow(/payload/);
  });

  it('payload 超过 256KB 拒绝', async () => {
    seed(kanbanManifest());
    const huge = { text: 'x'.repeat(300 * 1024) };
    await expect(
      build().execute('app_publish', { appId: 'kanban', channel: 'cards', payload: huge }),
    ).rejects.toThrow(/256KB/);
  });

  it('声明 inbox 时拒绝未声明频道并列出可用频道', async () => {
    seed(kanbanManifest({
      inbox: {
        cards: { description: '看板卡片操作', example: { op: 'add' } },
        activity: { description: '动态流' },
      },
    }));
    await expect(
      build().execute('app_publish', { appId: 'kanban', channel: 'wrong', payload: { op: 'add' } }),
    ).rejects.toThrow(/未声明频道 'wrong'[\s\S]*cards：看板卡片操作[\s\S]*activity/);
    // 校验失败不得触达存储层
    expect(invokeMock.mock.calls.some(([command]) => command === 'papr_inbox_append')).toBe(false);
  });

  it('声明 inbox 时命中频道正常落库', async () => {
    seed(kanbanManifest({ inbox: { cards: { description: '看板卡片' } } }));
    const result = await build().execute('app_publish', {
      appId: 'kanban',
      channel: 'cards',
      payload: { op: 'add', card: { title: '修复登录' } },
    });
    expect(result).toMatchObject({ appId: 'kanban', channel: 'cards', seq: 1, delivered: false, queued: true });
    expect(String((result as Record<string, unknown>).hint)).toContain('排队');
    const appendCall = invokeMock.mock.calls.find(([command]) => command === 'papr_inbox_append');
    expect(appendCall?.[1]).toMatchObject({
      appId: 'kanban',
      channel: 'cards',
      payload: { op: 'add', card: { title: '修复登录' } },
    });
  });

  it('未声明 inbox 的应用不限制频道（向后兼容）', async () => {
    seed(kanbanManifest());
    const result = await build().execute('app_publish', {
      appId: 'kanban',
      channel: 'anything',
      payload: { ok: true },
    });
    expect(result).toMatchObject({ channel: 'anything', seq: 1 });
  });

  it('store 中残缺 manifest（旧 Rust 剥离 inbox）时校验仍回落到磁盘原文', async () => {
    // 回归：global 插件冷启动挂载的 manifestJson 曾被 Rust scan 剥掉 inbox，
    // resolveAppManifest store 优先导致频道校验被静默绕过。现在磁盘原文优先。
    const fullManifest = kanbanManifest({ inbox: { board: { description: '推送看板' } } });
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'read_text_file') throw new Error(`not found: ${String(args?.relativePath ?? '')}`);
      if (command === 'scan_workspace_apps') {
        return [{ app_id: 'kanban', manifest_json: JSON.stringify(fullManifest), scope: 'global' }];
      }
      if (command === 'papr_inbox_append') return { seq: 1, ts: 1000 };
      throw new Error(`Unexpected invoke: ${command}`);
    });
    useAppRuntimeStore.setState({ apps: [], pinnedPluginIds: [], pluginChrome: {} });
    useAppRuntimeStore.getState().mountApp({
      appId: 'kanban',
      title: 'Kanban',
      html: '',
      filePath: '~/.codepapr/apps/kanban/index.html',
      manifestJson: JSON.stringify(kanbanManifest()),
      scope: 'global',
    });

    const registry = build();
    await expect(
      registry.execute('app_publish', { appId: 'kanban', channel: 'wrong', payload: { op: 'add' } }),
    ).rejects.toThrow(/未声明频道 'wrong'[\s\S]*board：推送看板/);
    await expect(
      registry.execute('app_publish', { appId: 'kanban', channel: 'board', payload: { op: 'add' } }),
    ).resolves.toMatchObject({ channel: 'board', seq: 1 });
  });

  it('应用已挂载时实时推送 papr://event 信封', async () => {
    seed(kanbanManifest({ inbox: { cards: {} } }));
    const received: AppChannelEnvelope[] = [];
    registerAppPoster('kanban', (envelope) => received.push(envelope));

    const result = await build().execute('app_publish', {
      appId: 'kanban',
      channel: 'cards',
      payload: { op: 'done', id: 'c1' },
    });

    expect(result).toMatchObject({ delivered: true, seq: 1 });
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      __papr: true,
      type: 'papr://event',
      payload: { channel: 'cards', seq: 1, ts: 1001, payload: { op: 'done', id: 'c1' } },
    });
  });

  it('已启用的 onDemand 插件隐藏时 app_publish 会揭开 overlay', async () => {
    const manifest = kanbanManifest({ inbox: { cards: {} } });
    seed(manifest);
    useAppRuntimeStore.setState({ apps: [], pinnedPluginIds: [], pluginChrome: {} });
    useAppRuntimeStore.getState().mountApp({
      appId: 'kanban',
      title: 'Kanban',
      html: '',
      filePath: '.CodePapr/apps/kanban/index.html',
      manifestJson: JSON.stringify(manifest),
    });
    useAppRuntimeStore.getState().enablePlugin('kanban');
    expect(useAppRuntimeStore.getState().pinnedPluginIds).toEqual([]);

    const revealResult = (await build().execute('app_publish', {
      appId: 'kanban',
      channel: 'cards',
      payload: { op: 'add' },
    })) as Record<string, unknown>;
    // 挂载竞态：广播时零挂载 → delivered=false，事件排队待自动打开后补发。
    expect(revealResult).toMatchObject({ delivered: false, queued: true, autoOpened: true });
    expect(String(revealResult.hint)).toContain('自动打开');
    expect(useAppRuntimeStore.getState().pinnedPluginIds).toEqual(['kanban']);
    expect(useAppRuntimeStore.getState().pluginChrome.kanban).toMatchObject({
      enabled: true,
      visible: true,
    });
  });

  it('未启用的 onDemand 插件 app_publish 不揭开 overlay', async () => {
    const manifest = kanbanManifest({
      inbox: { cards: {} },
      lifecycle: { autostart: false },
    });
    seed(manifest);
    useAppRuntimeStore.setState({ apps: [], pinnedPluginIds: [], pluginChrome: {} });
    useAppRuntimeStore.getState().mountApp({
      appId: 'kanban',
      title: 'Kanban',
      html: '',
      filePath: '.CodePapr/apps/kanban/index.html',
      manifestJson: JSON.stringify(manifest),
    });
    useAppRuntimeStore.getState().disablePlugin('kanban');

    const result = (await build().execute('app_publish', {
      appId: 'kanban',
      channel: 'cards',
      payload: { op: 'add' },
    })) as Record<string, unknown>;
    expect(useAppRuntimeStore.getState().pinnedPluginIds).toEqual([]);
    expect(useAppRuntimeStore.getState().pluginChrome.kanban.enabled).toBe(false);
    // T6：停用的插件仍落库（保留下次启用回放），但回 disabledTarget 告警，避免模型误认为已生效。
    expect(result.disabledTarget).toBe(true);
    expect(String(result.hint)).toContain('停用');
  });
});

describe('manifest inbox 契约校验与摘要', () => {
  type ManifestLike = Parameters<typeof validateManifestInbox>[0];

  function manifestWithInbox(inbox: unknown): ManifestLike {
    return { spec: 'papr/0.1', name: 'X', inbox } as unknown as ManifestLike;
  }

  it('未声明 inbox 合法', () => {
    expect(() => validateManifestInbox({ spec: 'papr/0.1', name: 'X' })).not.toThrow();
  });

  it('inbox 必须是对象', () => {
    expect(() => validateManifestInbox(manifestWithInbox(['cards']))).toThrow(/对象/);
    expect(() => validateManifestInbox(manifestWithInbox('cards'))).toThrow(/对象/);
  });

  it('频道名必须合法', () => {
    expect(() => validateManifestInbox(manifestWithInbox({ '-bad': {} }))).toThrow(/频道名/);
    expect(() => validateManifestInbox(manifestWithInbox({ ['a'.repeat(65)]: {} }))).toThrow(/频道名/);
    expect(() => validateManifestInbox(manifestWithInbox({ cards: {} }))).not.toThrow();
  });

  it('频道定义必须是对象且 description 必须是字符串', () => {
    expect(() => validateManifestInbox(manifestWithInbox({ cards: 'x' }))).toThrow(/必须是对象/);
    expect(() => validateManifestInbox(manifestWithInbox({ cards: { description: 42 } }))).toThrow(/description/);
    expect(() =>
      validateManifestInbox(manifestWithInbox({ cards: { description: '看板', example: { op: 'add' } } })),
    ).not.toThrow();
  });

  it('summarizeManifestInbox 提取频道/描述/示例', () => {
    const summary = summarizeManifestInbox(manifestWithInbox({
      cards: { description: '看板卡片', example: { op: 'add' } },
      bare: {},
    }));
    expect(summary).toEqual([
      { channel: 'cards', description: '看板卡片', example: { op: 'add' } },
      { channel: 'bare' },
    ]);
  });

  it('summarizeManifestInbox 无 inbox 返回 undefined', () => {
    expect(summarizeManifestInbox({ spec: 'papr/0.1', name: 'X' })).toBeUndefined();
    expect(summarizeManifestInbox(manifestWithInbox({}))).toBeUndefined();
    expect(summarizeManifestInbox(null)).toBeUndefined();
  });
});

describe('Agent .CodePapr isolation', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({
      root: '',
      entries: [],
      truncated: false,
      path: 'ok',
      content: 'ok',
      bytes: 2,
    });
  });

  it('blocks list/read/write/bash of internal .CodePapr in agent mode', async () => {
    const registry = build();
    await expect(registry.execute('list', { relativePath: '.CodePapr' })).rejects.toThrow(/运行时管理/);
    await expect(registry.execute('read', { relativePath: '.CodePapr/project.sqlite' })).rejects.toThrow(
      /运行时管理/
    );
    await expect(
      registry.execute('write', { relativePath: '.CodePapr/AGENTS.md', content: 'x' })
    ).rejects.toThrow(/运行时管理/);
    await expect(registry.execute('bash', { command: 'ls .CodePapr' })).rejects.toThrow(/运行时管理/);
    await expect(
      registry.execute('bash', { command: 'node server.js', workdir: '.CodePapr/apps/demo' })
    ).rejects.toThrow(/运行时管理/);
  });

  it('allows scratch dirs and skill-pack reads', async () => {
    const registry = build();
    await expect(registry.execute('list', { relativePath: '.CodePapr/tmp' })).resolves.toBeTruthy();
    await expect(
      registry.execute('read', { relativePath: '.CodePapr/tool-output/tool_1.txt' })
    ).resolves.toBeTruthy();
    await expect(
      registry.execute('read', { relativePath: '.CodePapr/skills/search/references/a.md' })
    ).resolves.toBeTruthy();
    await expect(registry.execute('bash', { command: 'ls .CodePapr/tmp' })).resolves.toBeTruthy();
  });

  it('allows .CodePapr/apps only in app mode', async () => {
    await expect(
      build().execute('list', { relativePath: '.CodePapr/apps/demo' })
    ).rejects.toThrow(/运行时管理/);
    await expect(
      build({ mode: 'app' }).execute('list', { relativePath: '.CodePapr/apps/demo' })
    ).resolves.toBeTruthy();
    await expect(
      build({ mode: 'app' }).execute('bash', { command: 'node server.js', workdir: '.CodePapr/apps/demo' })
    ).resolves.toBeTruthy();
  });

  it('allows .CodePapr/apps for in-app agents via appAccess even outside app mode', async () => {
    const appAccess = { network: false, workspaceWrite: true, allowCodepaprApps: true };
    await expect(
      build().execute('list', { relativePath: '.CodePapr/apps/demo' }, { appAccess })
    ).resolves.toBeTruthy();
    await expect(
      build().execute('bash', { command: 'node server.js', workdir: '.CodePapr/apps/demo' }, { appAccess })
    ).resolves.toBeTruthy();
  });

  it('blocks download/screenshot writes into internal .CodePapr in agent mode', async () => {
    const registry = build();
    await expect(
      registry.execute('web_download_file', {
        url: 'https://example.com/f.md',
        relativePath: '.CodePapr/AGENTS.md',
      })
    ).rejects.toThrow(/运行时管理/);
    await expect(
      registry.execute('browser_take_screenshot', { relativePath: '.CodePapr/apps/demo/x.png' })
    ).rejects.toThrow(/运行时管理/);
    // webfetch(save) 经分发器落到同一闸门
    await expect(
      registry.execute('webfetch', {
        url: 'https://example.com/f.md',
        save: true,
        relativePath: '.CodePapr/AGENTS.md',
      })
    ).rejects.toThrow(/运行时管理/);
    // 草稿区与 app 模式放行
    await expect(
      registry.execute('web_download_file', {
        url: 'https://example.com/f.bin',
        relativePath: '.CodePapr/downloads/f.bin',
      })
    ).resolves.toBeTruthy();
    await expect(
      build({ mode: 'app' }).execute('web_download_file', {
        url: 'https://example.com/i.png',
        relativePath: '.CodePapr/apps/demo/i.png',
      })
    ).resolves.toBeTruthy();
  });

  it('blocks git pathspecs touching internal .CodePapr in agent mode', async () => {
    const registry = build();
    await expect(
      registry.execute('git', { action: 'stage', pathspecs: ['.CodePapr/AGENTS.md'] })
    ).rejects.toThrow(/运行时管理/);
    await expect(
      registry.execute('git', { action: 'restore', pathspecs: ['.CodePapr/project.sqlite'] })
    ).rejects.toThrow(/运行时管理/);
    await expect(
      registry.execute('git', { action: 'stage', pathspecs: ['src/a.ts'] })
    ).resolves.toBeTruthy();
  });
});
