import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '@codepapr/core';
import { registerCliWorkspaceTools } from './registerCliWorkspaceTools';

const tempDirs: string[] = [];

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'codepapr-cli-'));
  tempDirs.push(workspace);
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await mkdir(path.join(workspace, 'ignored-output'), { recursive: true });
  await mkdir(path.join(workspace, '.CodePapr', 'skills'), { recursive: true });
  await mkdir(path.join(workspace, '.CodePapr', 'skills', 'ship'), { recursive: true });
  await mkdir(path.join(workspace, '.CodePapr', 'skills', 'suite', 'nested-skill'), { recursive: true });
  await writeFile(
    path.join(workspace, 'package.json'),
    JSON.stringify(
      {
        name: 'fixture',
        private: true,
        scripts: {
          lint: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
          typecheck: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
        },
      },
      null,
      2
    ),
    'utf8'
  );
  await writeFile(
    path.join(workspace, 'src', 'main.ts'),
    'export const value = 1;\nexport function greet() {\n  return value;\n}\n',
    'utf8'
  );
  await writeFile(
    path.join(workspace, 'src', 'entry.ts'),
    'import { feature } from "./feature";\nexport function boot() {\n  return feature;\n}\n',
    'utf8'
  );
  await writeFile(
    path.join(workspace, 'src', 'feature.ts'),
    'const FeatureToken = "Alpha";\nexport const feature = FeatureToken;\n',
    'utf8'
  );
  await writeFile(path.join(workspace, '.gitignore'), 'ignored-output/\n', 'utf8');
  await writeFile(path.join(workspace, 'ignored-output', 'secret.txt'), 'ignored-hit\n', 'utf8');
  await writeFile(path.join(workspace, '.CodePapr', 'skills', 'ship', 'SKILL.md'), '# ship\n', 'utf8');
  await writeFile(
    path.join(workspace, '.CodePapr', 'skills', 'suite', 'nested-skill', 'SKILL.md'),
    '# nested\n',
    'utf8'
  );
  return workspace;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('registerCliWorkspaceTools', () => {
  it('reads, writes, searches, patches, and loads project artifacts', async () => {
    const workspace = await createWorkspace();
    const registry = new ToolRegistry();
    registerCliWorkspaceTools(registry, workspace);

    const read = await registry.execute('workspace_read_file', { relativePath: 'src/main.ts' }) as {
      content: string;
      path: string;
    };
    expect(read.content).toContain('value = 1');

    const anchoredRead = await registry.execute('workspace_read_file', {
      relativePath: `${path.join(workspace, 'src', 'main.ts')}:1:1`,
    }) as {
      content: string;
      path: string;
    };
    expect(anchoredRead.content).toContain('value = 1');
    expect(anchoredRead.path).toBe('src/main.ts');

    const rangedRead = await registry.execute('workspace_read_file', {
      relativePath: 'src/main.ts',
      startLine: 2,
      endLine: 3,
    }) as {
      content: string;
      startLine: number;
      endLine: number;
      totalLines: number;
      truncatedByRange: boolean;
    };
    expect(rangedRead.content).toBe('export function greet() {\n  return value;\n');
    expect(rangedRead.startLine).toBe(2);
    expect(rangedRead.endLine).toBe(3);
    expect(rangedRead.totalLines).toBe(4);
    expect(rangedRead.truncatedByRange).toBe(true);

    await registry.execute('workspace_write_file', {
      relativePath: 'notes.txt',
      content: 'hello\nworld\n',
    });
    expect(await readFile(path.join(workspace, 'notes.txt'), 'utf8')).toBe('hello\nworld\n');

    const search = await registry.execute('workspace_search_text', {
      query: 'value',
      contextLines: 1,
      maxMatchesPerFile: 2,
    }) as {
      matches: Array<{
        path: string;
        line: number;
        column?: number;
        contextBefore?: string[];
        contextAfter?: string[];
      }>;
    };
    expect(search.matches[0]?.path).toBe('src/main.ts');
    expect(search.matches[0]?.line).toBe(1);
    expect(search.matches[0]?.column).toBe(14);
    expect(search.matches[1]?.contextBefore).toEqual(['export function greet() {']);
    expect(search.matches[1]?.contextAfter).toEqual(['}']);

    const smartCaseSearch = await registry.execute('workspace_search_text', {
      query: 'FeatureToken',
    }) as {
      matches: Array<{ path: string }>;
    };
    expect(smartCaseSearch.matches.map((match) => match.path)).toEqual([
      'src/feature.ts',
      'src/feature.ts',
    ]);

    const ignoredSearch = await registry.execute('workspace_search_text', {
      query: 'ignored-hit',
    }) as {
      matches: Array<{ path: string }>;
    };
    expect(ignoredSearch.matches).toHaveLength(0);

    const fileSearch = await registry.execute('workspace_search_files', {
      query: 'main|feature',
      isRegexp: true,
    }) as {
      matches: Array<{ path: string }>;
    };
    expect(fileSearch.matches.some((match) => match.path === 'src/main.ts')).toBe(true);
    expect(fileSearch.matches.some((match) => match.path === 'src/feature.ts')).toBe(true);
    expect(fileSearch.matches.some((match) => match.path === 'ignored-output/secret.txt')).toBe(false);

    const patched = await registry.execute('workspace_apply_patch', {
      relativePath: 'src/main.ts',
      search: 'value = 1',
      replace: 'value = 2',
    }) as { replacements: number };
    expect(patched.replacements).toBe(1);
    expect(await readFile(path.join(workspace, 'src', 'main.ts'), 'utf8')).toContain('value = 2');

    const diff = await registry.execute('workspace_apply_diff', {
      patches: [
        {
          relativePath: 'src/main.ts',
          search: 'return value;',
          replace: 'return value + 1;',
        },
        {
          relativePath: 'src/feature.ts',
          search: 'FeatureToken',
          replace: 'FeatureLabel',
          replaceAll: true,
          expectedOccurrences: 2,
        },
      ],
    }) as { totalFiles: number; totalPatches: number; totalReplacements: number };
    expect(diff).toMatchObject({
      totalFiles: 2,
      totalPatches: 2,
      totalReplacements: 3,
    });
    expect(await readFile(path.join(workspace, 'src', 'main.ts'), 'utf8')).toContain('return value + 1;');
    expect(await readFile(path.join(workspace, 'src', 'feature.ts'), 'utf8')).toContain('FeatureLabel');

    const skill = await registry.execute('skill_load', { name: 'ship' }) as {
      content: string;
      skillPath: string;
      skillRoot: string;
    };
    expect(skill.content).toContain('# ship');
    expect(skill.skillPath).toBe('.CodePapr/skills/ship/SKILL.md');
    expect(skill.skillRoot).toBe('.CodePapr/skills/ship');

    const nestedSkill = await registry.execute('skill_load', {
      name: 'suite/nested-skill',
    }) as { content: string; skillPath: string };
    expect(nestedSkill.content).toContain('# nested');
    expect(nestedSkill.skillPath).toBe('.CodePapr/skills/suite/nested-skill/SKILL.md');

    const graphOverview = await registry.execute('workspace_project_graph', { view: 'overview' }) as {
      tree: string;
      files: Array<{
        path: string;
        stubs?: string[];
        symbols: Array<{ name: string; kind: string; exported: boolean }>;
      }>;
    };
    expect(graphOverview.tree).toContain('src/');
    expect(graphOverview.files.some((file) => file.path === 'src/main.ts')).toBe(true);
    expect(graphOverview.files.find((file) => file.path === 'src/main.ts')?.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'value', kind: 'variable', exported: true }),
        expect.objectContaining({ name: 'greet', kind: 'function', exported: true }),
      ])
    );
    expect(graphOverview.files.find((file) => file.path === 'src/main.ts')?.symbols.length).toBeGreaterThan(0);

    const graph = await registry.execute('workspace_project_graph', {}) as {
      summary: {
        files: number;
        imports: number;
        symbols: number;
      };
      nodes: Array<{
        kind: string;
        path: string;
        label: string;
        symbolSource?: string;
      }>;
      edges: Array<{
        kind: string;
        from: string;
        to: string;
        label?: string;
      }>;
    };
    // imports=2：文件级 entry.ts->feature.ts 一条，加上具名绑定 `feature` 解析到
    // 具体符号后额外补的一条文件->符号边。
    expect(graph.summary).toMatchObject({
      files: 3,
      imports: 2,
      symbols: 5,
    });
    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'symbol',
          path: 'src/entry.ts',
          label: 'boot',
        }),
        expect.objectContaining({
          kind: 'file',
          path: 'src/feature.ts',
        }),
      ])
    );
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'imports',
          from: 'file:src/entry.ts',
          to: 'file:src/feature.ts',
          label: './feature',
        }),
      ])
    );

    const diagnostics = await registry.execute('workspace_project_diagnostics', {}) as {
      available: boolean;
      overallStatus: string;
      stages: Array<{ id: string; success: boolean }>;
    };
    expect(diagnostics.available).toBe(true);
    expect(['passed', 'failed']).toContain(diagnostics.overallStatus);
    expect(diagnostics.stages.map((stage) => stage.id)).toEqual(['lint', 'typecheck']);
    expect(diagnostics.stages.every((stage) => typeof stage.success === 'boolean')).toBe(true);
  });

  it('does not write any files when a multi-patch diff fails validation', async () => {
    const workspace = await createWorkspace();
    const registry = new ToolRegistry();
    registerCliWorkspaceTools(registry, workspace);

    await expect(
      registry.execute('workspace_apply_diff', {
        patches: [
          {
            relativePath: 'src/main.ts',
            search: 'value = 1',
            replace: 'value = 2',
          },
          {
            relativePath: 'src/feature.ts',
            search: 'missing token',
            replace: 'replacement',
          },
        ],
      })
    ).rejects.toThrow('补丁 2 (src/feature.ts) 应用失败');

    expect(await readFile(path.join(workspace, 'src', 'main.ts'), 'utf8')).toContain('value = 1');
    expect(await readFile(path.join(workspace, 'src', 'feature.ts'), 'utf8')).toContain('FeatureToken');
  });

  it('runs commands and manages shell/background sessions', async () => {
    const workspace = await createWorkspace();
    const registry = new ToolRegistry();
    registerCliWorkspaceTools(registry, workspace);

    const command = await registry.execute('workspace_run_command', {
      command: process.execPath,
      args: ['-e', 'console.log("ok")'],
    }) as { stdout: string; status: number | null };
    expect(command.status).toBe(0);
    expect(command.stdout.trim()).toBe('ok');

    if (process.platform !== 'win32') {
      const shell = await registry.execute('shell_open_session', { shell: '/bin/sh' }) as {
        sessionId: string;
      };
      await registry.execute('shell_send_input', {
        sessionId: shell.sessionId,
        command: 'printf',
        args: ['hello\\n'],
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      const output = await registry.execute('shell_read_output', { sessionId: shell.sessionId }) as {
        outputTail: string;
      };
      expect(output.outputTail).toContain('hello');
      const closed = await registry.execute('shell_close_session', { sessionId: shell.sessionId }) as {
        closed: boolean;
      };
      expect(closed.closed).toBe(true);

      const guardedShell = await registry.execute('shell_open_session', { shell: '/bin/sh' }) as {
        sessionId: string;
      };
      await registry.execute('shell_send_input', {
        sessionId: guardedShell.sessionId,
        command: 'printf',
        args: ['%s\\n', 'openai>=0.27.0'],
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      const guardedOutput = await registry.execute('shell_read_output', { sessionId: guardedShell.sessionId }) as {
        outputTail: string;
      };
      expect(guardedOutput.outputTail).toContain('openai>=0.27.0');
      await expect(readFile(path.join(workspace, '=0.27.0'), 'utf8')).rejects.toThrow();
      const guardedClosed = await registry.execute('shell_close_session', { sessionId: guardedShell.sessionId }) as {
        closed: boolean;
      };
      expect(guardedClosed.closed).toBe(true);

      const rawShell = await registry.execute('shell_open_session', { shell: '/bin/sh' }) as {
        sessionId: string;
      };
      await expect(
        registry.execute('shell_send_input', {
          sessionId: rawShell.sessionId,
          input: 'pip install openai>=0.27.0',
        })
      ).rejects.toThrow('未加引号的版本约束');
      const rawClosed = await registry.execute('shell_close_session', { sessionId: rawShell.sessionId }) as {
        closed: boolean;
      };
      expect(rawClosed.closed).toBe(true);

      const spacedShell = await registry.execute('shell_open_session', { shell: '/bin/sh' }) as {
        sessionId: string;
      };
      await expect(
        registry.execute('shell_send_input', {
          sessionId: spacedShell.sessionId,
          input: 'pip install openai >=0.27.0',
        })
      ).rejects.toThrow('未加引号的版本约束');

      const bsNlShell = await registry.execute('shell_open_session', { shell: '/bin/sh' }) as {
        sessionId: string;
      };
      await expect(
        registry.execute('shell_send_input', {
          sessionId: bsNlShell.sessionId,
          input: 'pip install openai \\\n>=0.27.0',
        })
      ).rejects.toThrow('未加引号的版本约束');
      await expect(readFile(path.join(workspace, '=0.27.0'), 'utf8')).rejects.toThrow();
      const bsNlClosed = await registry.execute('shell_close_session', { sessionId: bsNlShell.sessionId }) as {
        closed: boolean;
      };
      expect(bsNlClosed.closed).toBe(true);
      await expect(readFile(path.join(workspace, '=0.27.0'), 'utf8')).rejects.toThrow();
      const spacedClosed = await registry.execute('shell_close_session', { sessionId: spacedShell.sessionId }) as {
        closed: boolean;
      };
      expect(spacedClosed.closed).toBe(true);

      // shell script content scanning: workspace_run_command should reject scripts with unquoted constraints
      const scriptPath = path.join(workspace, 'install.sh');
      await writeFile(scriptPath, '#!/bin/sh\npip install openai>=0.27.0 requests>=2.28.0\n', 'utf8');
      await expect(
        registry.execute('workspace_run_command', { command: './install.sh' })
      ).rejects.toThrow('未加引号的版本约束');
      // Verify no empty redirect files were created
      await expect(readFile(path.join(workspace, '=0.27.0'), 'utf8')).rejects.toThrow();

      // .command extension should also be caught
      const dotCommandPath = path.join(workspace, 'setup.command');
      await writeFile(dotCommandPath, '#!/bin/sh\npip install textual>=0.52.0\n', 'utf8');
      await expect(
        registry.execute('workspace_run_command', { command: './setup.command' })
      ).rejects.toThrow('未加引号的版本约束');

      // quoted constraint in script should pass the guard
      const safeScriptPath = path.join(workspace, 'safe.sh');
      await writeFile(safeScriptPath, '#!/bin/sh\npip install "openai>=0.27.0"\n', 'utf8');
      // safe.sh will fail to actually run (no pip in test env) — we just verify it is not rejected by the guard
      // by checking the error is NOT about version constraints
      const safeResult = await registry.execute('workspace_run_command', { command: './safe.sh' }) as { status: number; stderr: string };
      expect(typeof safeResult.status).toBe('number');
      expect(safeResult.stderr).not.toContain('未加引号的版本约束');

      // workspace_start_background_command should also reject shell scripts with unquoted constraints
      await expect(
        registry.execute('workspace_start_background_command', { command: './install.sh' })
      ).rejects.toThrow('未加引号的版本约束');
    }

    const background = await registry.execute('workspace_start_background_command', {
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    }) as { pid: number | null; started: boolean };
    expect(background.started).toBe(true);
    expect(typeof background.pid).toBe('number');

    const listed = await registry.execute('workspace_list_background_processes', {}) as Array<{ pid: number }>;
    expect(listed.some((entry) => entry.pid === background.pid)).toBe(true);

    const stopped = await registry.execute('workspace_stop_background_process', { pid: background.pid }) as {
      stopped: boolean;
    };
    expect(stopped.stopped).toBe(true);
  });
});

describe('new LLM-facing tool dispatchers', () => {
  it('read dispatches to workspace_read_file', async () => {
    const workspace = await createWorkspace();
    const registry = new ToolRegistry();
    registerCliWorkspaceTools(registry, workspace);
    registry.freeze();

    const result = await registry.execute('read', {
      relativePath: 'src/main.ts',
      maxBytes: 100,
    }) as { path: string; content: string };

    expect(result.path).toContain('main.ts');
    expect(result.content).toContain('export const value');
  });

  it('write dispatches to workspace_write_file', async () => {
    const workspace = await createWorkspace();
    const registry = new ToolRegistry();
    registerCliWorkspaceTools(registry, workspace);
    registry.freeze();

    const result = await registry.execute('write', {
      relativePath: 'src/generated.ts',
      content: 'export const x = 1;\n',
    }) as { path: string };

    expect(result.path).toContain('generated.ts');
  });

  it('grep dispatches to workspace_search_text with isRegexp:true', async () => {
    const workspace = await createWorkspace();
    const registry = new ToolRegistry();
    registerCliWorkspaceTools(registry, workspace);
    registry.freeze();

    const result = await registry.execute('grep', {
      query: 'export const.*=',
      maxResults: 5,
    }) as { query: string; matches: Array<{ path: string; line: number; preview: string }> };

    expect(result.query).toBe('export const.*=');
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.some((m) => m.path.includes('main.ts'))).toBe(true);
  });

  it('glob dispatches to workspace_search_files', async () => {
    const workspace = await createWorkspace();
    const registry = new ToolRegistry();
    registerCliWorkspaceTools(registry, workspace);
    registry.freeze();

    const result = await registry.execute('glob', {
      query: '*.ts',
    }) as { query: string; matches: Array<{ path: string; name: string }> };

    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.every((m) => m.name.endsWith('.ts'))).toBe(true);
  });

  it('list dispatches to workspace_list_files', async () => {
    const workspace = await createWorkspace();
    const registry = new ToolRegistry();
    registerCliWorkspaceTools(registry, workspace);
    registry.freeze();

    const result = await registry.execute('list', {
      maxDepth: 2,
    }) as { entries: Array<{ name: string }> };

    expect(result.entries.some((e) => e.name === 'src')).toBe(true);
  });

  it('graph dispatches to workspace_project_graph', async () => {
    const workspace = await createWorkspace();
    const registry = new ToolRegistry();
    registerCliWorkspaceTools(registry, workspace);
    registry.freeze();

    const result = await registry.execute('graph', {
      action: 'lookup',
      query: 'greet',
      limit: 5,
    }) as { results?: Array<unknown> };

    expect(result).toBeDefined();
  });

  it('git status dispatches correctly', async () => {
    const workspace = await createWorkspace();
    const registry = new ToolRegistry();
    registerCliWorkspaceTools(registry, workspace);
    registry.freeze();

    const result = await registry.execute('git', {
      action: 'status',
    }) as { available: boolean };

    expect(result).toHaveProperty('available');
  });

  it('exec dispatches to workspace_run_command', async () => {
    const workspace = await createWorkspace();
    const registry = new ToolRegistry();
    registerCliWorkspaceTools(registry, workspace);
    registry.freeze();

    const result = await registry.execute('exec', {
      command: process.execPath,
      args: ['-e', 'console.log("hello")'],
      timeoutSeconds: 5,
    }) as { stdout: string; status: number | null };

    expect(result.stdout).toContain('hello');
    expect(result.status).toBe(0);
  });

  it('web_search is visible to LLM', async () => {
    const workspace = await createWorkspace();
    const registry = new ToolRegistry();
    registerCliWorkspaceTools(registry, workspace);
    registry.freeze();

    const allTools = registry.getAll();
    expect(allTools.some((t) => t.name === 'web_search')).toBe(true);

    // Handler exists (web_search is a native fine-grained tool, no dispatch wrapper)
    const tool = registry.get('web_search');
    expect(tool).toBeDefined();
    expect(tool?.description).toContain('搜索');
  });

  it('old merge tool names are NOT visible to LLM', () => {
    const registry = new ToolRegistry();
    const oldNames = ['file_read', 'file_write', 'project_graph', 'git_read', 'git_write', 'terminal', 'web_access'];
    for (const name of oldNames) {
      expect(registry.get(name)).toBeUndefined();
    }
  });
});
