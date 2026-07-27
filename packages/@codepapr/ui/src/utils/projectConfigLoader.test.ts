import { describe, expect, it, vi } from 'vitest';
import type { RevertAction } from '@codepapr/core';
import {
  applyRevertAction,
  listCommandNames,
  loadAgentDefinitions,
  loadCommandDefinition,
  loadProjectRulesSection,
  loadSkillDefinitions,
  loadSkillsSection,
  resolveSkillFilePath,
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
    if (
      command === 'write_text_file' ||
      command === 'delete_workspace_file' ||
      command === 'delete_workspace_dir'
    ) {
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

  it('无规则文件时返回空串', async () => {
    const { invoke } = createInvoke({});
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
