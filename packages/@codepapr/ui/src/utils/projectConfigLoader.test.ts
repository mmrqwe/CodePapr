import { describe, expect, it, vi } from 'vitest';
import type { RevertAction } from '@codepapr/core';
import {
  applyRevertAction,
  listCommandNames,
  loadAgentDefinitions,
  loadCommandDefinition,
  loadProjectRulesSection,
  ensureProjectAgentsFile,
  ensureDefaultSearchSkill,
  loadSkillDefinitions,
  loadSkillsSection,
  resolveSkillFilePath,
  collectSkillEntryRefs,
  readWorkspaceTextFile,
  runWorkspaceInlineCommand,
  type InvokeFn,
} from './projectConfigLoader';

/**
 * 用内存中的文件表模拟 Tauri invoke：
 * - read_text_file: 命中 files 返回内容，否则抛错（模拟文件不存在）
 * - list_workspace_files: 返回 dir 下的条目
 * - write_text_file / delete_workspace_file / delete_workspace_dir: 记录调用以供断言
 */
function createInvoke(files: Record<string, string>): {
  invoke: InvokeFn;
  calls: Array<{ command: string; args?: Record<string, unknown> }>;
} {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === 'read_text_file') {
      const relativePath = String(args?.relativePath ?? '');
      if (relativePath in files) {
        return { path: relativePath, content: files[relativePath], bytes: files[relativePath].length };
      }
      throw new Error(`not found: ${relativePath}`);
    }
    if (command === 'list_workspace_files') {
      const dir = String(args?.relativePath ?? '').replace(/\/+$/, '');
      const prefix = dir ? `${dir}/` : '';
      const maxDepth = Number(args?.maxDepth ?? 1);
      const entriesMap = new Map<string, { path: string; name: string; kind: 'file' | 'dir' }>();
      for (const filePath of Object.keys(files)) {
        if (!filePath.startsWith(prefix)) {
          continue;
        }

        const rest = filePath.slice(prefix.length);
        if (!rest) {
          continue;
        }

        const parts = rest.split('/');
        for (let depth = 1; depth <= Math.min(parts.length, maxDepth); depth += 1) {
          const relativePath = parts.slice(0, depth).join('/');
          const fullPath = prefix ? `${prefix}${relativePath}` : relativePath;
          const isLeaf = depth === parts.length;
          entriesMap.set(fullPath, {
            path: fullPath,
            name: parts[depth - 1] ?? '',
            kind: isLeaf ? 'file' : 'dir',
          });
        }
      }
      const entries = [...entriesMap.values()];
      return { root: dir, entries, truncated: false };
    }
    if (command === 'write_text_file') {
      files[String(args?.relativePath ?? '')] = String(args?.content ?? '');
      return true;
    }
    if (command === 'delete_workspace_file' || command === 'delete_workspace_dir') {
      return true;
    }
    if (command === 'run_workspace_command') {
      return {
        command: args?.command,
        args: args?.args,
        status: 0,
        stdout: 'main\n',
        stderr: '',
        timedOut: false,
      };
    }
    throw new Error(`unexpected command: ${command}`);
  }) as unknown as InvokeFn;
  return { invoke, calls };
}

describe('projectConfigLoader', () => {
  it('只读取 AGENTS.md，忽略 rules.md', async () => {
    const { invoke } = createInvoke({
      '.CodePapr/AGENTS.md': '# 团队规则\n始终使用 TypeScript。',
      '.CodePapr/rules.md': '保持函数简短。',
    });

    const section = await loadProjectRulesSection(invoke, '/ws');

    expect(section).toContain('.CodePapr/AGENTS.md');
    expect(section).toContain('始终使用 TypeScript。');
    expect(section).not.toContain('rules.md');
    expect(section).not.toContain('保持函数简短。');
  });

  it('无规则文件时回退到默认约定', async () => {
    const { invoke } = createInvoke({});
    const section = await loadProjectRulesSection(invoke, '/ws');
    expect(section).toContain('.CodePapr/AGENTS.md');
    expect(section).toContain('先读再改');
  });

  it('无规则文件时按语言回退英文默认约定', async () => {
    const { invoke } = createInvoke({});
    const section = await loadProjectRulesSection(invoke, '/ws', 'en');
    expect(section).toContain('Read existing code first');
  });

  it('缺省 AGENTS.md 时写出默认模板并填入 npm 验证命令', async () => {
    const { invoke, calls } = createInvoke({
      'package.json': JSON.stringify({
        scripts: { test: 'vitest', lint: 'eslint .', build: 'tsc -b' },
      }),
      'package-lock.json': '{}',
    });

    await expect(ensureProjectAgentsFile(invoke, '/ws')).resolves.toBe('created');
    const write = calls.find((call) => call.command === 'write_text_file');
    expect(write?.args).toMatchObject({
      workspacePath: '/ws',
      relativePath: '.CodePapr/AGENTS.md',
    });
    const content = String(write?.args?.content ?? '');
    expect(content).toContain('- 测试：npm test');
    expect(content).toContain('- Lint：npm run lint');
    expect(content).toContain('- 构建：npm run build');

    const section = await loadProjectRulesSection(invoke, '/ws');
    expect(section).toContain('npm test');
    expect(section).not.toMatch(/^\s*-\s*技术栈：\s*$/m);
  });

  it('已有 AGENTS.md 只填空验证行，空白文件不覆盖', async () => {
    const custom = '# 团队规则\n## 验证\n- 测试：pytest\n- Lint：\n- 构建：\n';
    const { invoke, calls } = createInvoke({
      '.CodePapr/AGENTS.md': custom,
      'package.json': JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .' } }),
    });
    await expect(ensureProjectAgentsFile(invoke, '/ws')).resolves.toBe('updated');
    const content = String(calls.find((call) => call.command === 'write_text_file')?.args?.content ?? '');
    expect(content).toContain('- 测试：pytest');
    expect(content).toContain('- Lint：npm run lint');

    const { invoke: blankInvoke, calls: blankCalls } = createInvoke({
      '.CodePapr/AGENTS.md': '  \n',
      'package.json': JSON.stringify({ scripts: { test: 'vitest' } }),
    });
    await expect(ensureProjectAgentsFile(blankInvoke, '/ws')).resolves.toBe('unchanged');
    expect(blankCalls.some((call) => call.command === 'write_text_file')).toBe(false);
  });

  it('规则文件存在但空白时不回退', async () => {
    const { invoke } = createInvoke({
      '.CodePapr/AGENTS.md': '  \n  ',
    });
    expect(await loadProjectRulesSection(invoke, '/ws')).toBe('');
  });

  it('加载 .CodePapr/agents 下的子代理定义', async () => {
    const { invoke } = createInvoke({
      '.CodePapr/agents/reviewer.md': '---\ndescription: 代码评审\ntools: read_text_file\n---\n你是评审员。',
      '.CodePapr/agents/tester.md': '你负责写测试。',
    });

    const agents = await loadAgentDefinitions(invoke, '/ws');

    expect(agents.map((a) => a.name).sort()).toEqual(['reviewer', 'tester']);
    const reviewer = agents.find((a) => a.name === 'reviewer');
    expect(reviewer?.prompt).toContain('你是评审员。');
  });

  it('加载 .CodePapr/skills 下的 Skill 摘要目录', async () => {
    const { invoke } = createInvoke({
      '.CodePapr/skills/search/SKILL.md':
        '---\ndescription: 搜索资料\n---\n优先查官方文档。',
      '.CodePapr/skills/suite/article-illustrator/SKILL.md':
        '---\ndescription: 配图\n---\n生成配图流程。',
      '.CodePapr/skills/suite/article-illustrator/references/style-guide.md': '# style',
    });

    const section = await loadSkillsSection(invoke, '/ws');

    expect(section).toContain('## 项目 Skills');
    expect(section).toContain('`search`: 搜索资料');
    expect(section).toContain('`suite/article-illustrator`: 配图');
    expect(section).not.toContain('优先查官方文档。');
  });

  it('递归加载嵌套 skill 并保留包路径元数据', async () => {
    const { invoke } = createInvoke({
      '.CodePapr/skills/suite/article-illustrator/SKILL.md':
        '---\ndescription: 配图\n---\n生成配图流程。',
      '.CodePapr/skills/suite/article-illustrator/scripts/render.py': 'print("ok")',
    });

    const skills = await loadSkillDefinitions(invoke, '/ws');

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: 'article-illustrator',
      id: 'suite/article-illustrator',
      displayName: 'article-illustrator',
      rootPath: '.CodePapr/skills/suite/article-illustrator',
      sourcePath: '.CodePapr/skills/suite/article-illustrator/SKILL.md',
    });
  });

  it('解析 skill 路径时支持完整 id 和唯一叶子名', async () => {
    const { invoke } = createInvoke({
      '.CodePapr/skills/suite/article-illustrator/SKILL.md': '---\n---\nA',
      '.CodePapr/skills/search/SKILL.md': '---\n---\nB',
    });

    await expect(resolveSkillFilePath(invoke, '/ws', 'suite/article-illustrator')).resolves.toBe(
      '.CodePapr/skills/suite/article-illustrator/SKILL.md'
    );
    await expect(resolveSkillFilePath(invoke, '/ws', 'article-illustrator')).resolves.toBe(
      '.CodePapr/skills/suite/article-illustrator/SKILL.md'
    );
  });

  it('忽略 skill frontmatter 里的 enabled，并保留目录摘要所需元数据', async () => {
    const { invoke } = createInvoke({
      '.CodePapr/skills/search/SKILL.md':
        '---\nname: 搜索\ndescription: 搜索资料\nenabled: false\n---\n优先查官方文档。',
      '.CodePapr/skills/docs/SKILL.md':
        '---\nname: 文档\ndescription: 维护文档\nenabled: true\n---\n更新 README。',
    });

    const section = await loadSkillsSection(invoke, '/ws');
    const skills = await loadSkillDefinitions(invoke, '/ws');

    expect(section).toContain('`docs` (文档): 维护文档');
    expect(section).toContain('`search` (搜索): 搜索资料');
    expect(skills.find((skill) => skill.id === 'search')?.enabled).toBeUndefined();
    expect(skills.find((skill) => skill.id === 'search')?.name).toBe('搜索');
  });

  it('忽略技能包 references/agents 下的 SKILL.md，不登记成独立 Skill', async () => {
    const { invoke } = createInvoke({
      '.CodePapr/skills/search/SKILL.md': '---\ndescription: 搜索\n---\nA',
      '.CodePapr/skills/search/references/SKILL.md': '---\ndescription: 幽灵\n---\nB',
      '.CodePapr/skills/search/agents/helper/SKILL.md': '---\ndescription: 子代理\n---\nC',
    });

    const skills = await loadSkillDefinitions(invoke, '/ws');
    expect(skills.map((skill) => skill.id)).toEqual(['search']);
  });

  it('collectSkillEntryRefs 从列表结果收集包根 Skill', () => {
    const refs = collectSkillEntryRefs([
      { path: '.CodePapr/skills/search', kind: 'dir', isDir: true },
      { path: '.CodePapr/skills/search/SKILL.md', name: 'SKILL.md', kind: 'file' },
      { path: '.CodePapr/skills/search/references/SKILL.md', name: 'SKILL.md', kind: 'file' },
      { path: '.CodePapr/skills/notes.md', name: 'notes.md', kind: 'file' },
    ]);
    expect(refs.map((ref) => ref.id)).toEqual(['notes', 'search']);
  });

  it('列出可用命令名称', async () => {
    const { invoke } = createInvoke({
      '.CodePapr/commands/fix.md': '修复：$ARGUMENTS',
      '.CodePapr/commands/explain.md': '解释代码',
    });

    const names = await listCommandNames(invoke, '/ws');
    expect(names.sort()).toEqual(['explain', 'fix']);
  });

  it('按名称加载命令定义', async () => {
    const { invoke } = createInvoke({
      '.CodePapr/commands/fix.md': '---\ndescription: 快速修复\n---\n请修复：$ARGUMENTS',
    });

    const def = await loadCommandDefinition(invoke, '/ws', 'fix');
    expect(def?.name).toBe('fix');
    expect(def?.description).toBe('快速修复');
    expect(def?.template).toContain('$ARGUMENTS');
  });

  it('拒绝非法命令名称', async () => {
    const { invoke } = createInvoke({});
    expect(await loadCommandDefinition(invoke, '/ws', '../evil')).toBeNull();
    expect(await loadCommandDefinition(invoke, '/ws', 'a/b')).toBeNull();
  });

  it('readWorkspaceTextFile 在文件缺失时抛错', async () => {
    const { invoke } = createInvoke({ 'a.txt': 'hi' });
    expect(await readWorkspaceTextFile(invoke, '/ws', 'a.txt')).toBe('hi');
    await expect(readWorkspaceTextFile(invoke, '/ws', 'missing.txt')).rejects.toThrow();
  });

  it('runWorkspaceInlineCommand 通过受控命令执行内联命令', async () => {
    const { invoke, calls } = createInvoke({});

    await expect(runWorkspaceInlineCommand(invoke, '/ws', 'git branch --show-current')).resolves.toBe('main');

    expect(calls[0]).toEqual({
      command: 'run_workspace_command',
      args: {
        workspacePath: '/ws',
        command: 'git',
        args: ['branch', '--show-current'],
        timeoutSeconds: 30,
      },
    });
  });

  it('applyRevertAction 在 content 为 null 时删除文件', async () => {
    const { invoke, calls } = createInvoke({});
    const action: RevertAction = { path: 'src/new.ts', content: null };

    await applyRevertAction(invoke, '/ws', action);

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('delete_workspace_file');
    expect(calls[0].args).toMatchObject({ workspacePath: '/ws', relativePath: 'src/new.ts' });
  });

  it('applyRevertAction 在 content 非 null 时写回文件', async () => {
    const { invoke, calls } = createInvoke({});
    const action: RevertAction = { path: 'src/a.ts', content: 'export const a = 1;' };

    await applyRevertAction(invoke, '/ws', action);

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('write_text_file');
    expect(calls[0].args).toMatchObject({
      workspacePath: '/ws',
      relativePath: 'src/a.ts',
      content: 'export const a = 1;',
    });
  });
});

/**
 * 模拟 Rust 端语义：list 不存在的目录会抛错（createInvoke 的宽松版本不会），
 * 用于验证“skills 目录缺失才引导初始 Skill”的判定。
 */
function createStrictFsInvoke(files: Record<string, string>, existingDirs: string[]) {
  const dirs = new Set(existingDirs);
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === 'list_workspace_files') {
      const dir = String(args?.relativePath ?? '');
      if (dir && !dirs.has(dir)) {
        throw new Error(`路径不存在: ${dir}`);
      }
      const prefix = dir ? `${dir}/` : '';
      const entries = Object.keys(files)
        .filter((path) => path.startsWith(prefix))
        .map((path) => ({ path, name: path.split('/').pop() ?? path, kind: 'file' as const }));
      return { root: dir, entries, truncated: false };
    }
    if (command === 'write_text_file') {
      const relativePath = String(args?.relativePath ?? '');
      files[relativePath] = String(args?.content ?? '');
      dirs.add(relativePath.split('/').slice(0, -1).join('/'));
      return true;
    }
    throw new Error(`unexpected command: ${command}`);
  }) as unknown as InvokeFn;
  return { invoke, calls };
}

describe('ensureDefaultSearchSkill', () => {
  it('skills 目录不存在时写入内置 search Skill', async () => {
    const { invoke, calls } = createStrictFsInvoke({}, []);

    expect(await ensureDefaultSearchSkill(invoke, '/ws')).toBe(true);

    const write = calls.find((call) => call.command === 'write_text_file');
    expect(write?.args?.relativePath).toBe('.CodePapr/skills/search/SKILL.md');
    expect(String(write?.args?.content)).toContain('name: search');
  });

  it('按语言选择内置模板', async () => {
    const { invoke, calls } = createStrictFsInvoke({}, []);

    await ensureDefaultSearchSkill(invoke, '/ws', 'en');

    const write = calls.find((call) => call.command === 'write_text_file');
    expect(String(write?.args?.content)).toContain('Verifiable research');
  });

  it('目录已存在（含空目录）时不复活、不写盘', async () => {
    const emptyDir = createStrictFsInvoke({}, ['.CodePapr/skills']);
    expect(await ensureDefaultSearchSkill(emptyDir.invoke, '/ws')).toBe(false);
    expect(emptyDir.calls.some((call) => call.command === 'write_text_file')).toBe(false);

    const withSkill = createStrictFsInvoke({ '.CodePapr/skills/notes/SKILL.md': '# n' }, ['.CodePapr/skills']);
    expect(await ensureDefaultSearchSkill(withSkill.invoke, '/ws')).toBe(false);
    expect(withSkill.calls.some((call) => call.command === 'write_text_file')).toBe(false);
  });
});
