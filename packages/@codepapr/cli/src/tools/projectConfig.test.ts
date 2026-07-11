import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DSDatabase } from '@codepapr/db';
import {
  loadSkillDefinitions,
  loadSkillsSection,
  resolveSkillFilePath,
  runWorkspaceInlineCommand,
} from './projectConfig';

describe('projectConfig slash inline commands', () => {
  it('runs inline commands through the controlled workspace command path', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'codepapr-slash-'));
    const previousNodeOptions = process.env.NODE_OPTIONS;
    const previousInspectorOptions = process.env.VSCODE_INSPECTOR_OPTIONS;
    try {
      process.env.NODE_OPTIONS =
        '--require "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/ms-vscode.js-debug/src/bootloader.js" --inspect-publish-uid=http';
      process.env.VSCODE_INSPECTOR_OPTIONS = '{"mock":true}';
      const nodePath = process.execPath.replace(/"/g, '\\"');
      await expect(
        runWorkspaceInlineCommand(
          workspace,
          `"${nodePath}" -e "process.stdout.write('slash-ok')"`
        )
      ).resolves.toBe('slash-ok');
    } finally {
      if (typeof previousNodeOptions === 'string') {
        process.env.NODE_OPTIONS = previousNodeOptions;
      } else {
        delete process.env.NODE_OPTIONS;
      }
      if (typeof previousInspectorOptions === 'string') {
        process.env.VSCODE_INSPECTOR_OPTIONS = previousInspectorOptions;
      } else {
        delete process.env.VSCODE_INSPECTOR_OPTIONS;
      }
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('rejects composite shell operators before spawning a command', async () => {
    await expect(runWorkspaceInlineCommand('/tmp', 'git status | cat')).rejects.toThrow('不支持');
  });

  it('loads project skill catalog from .CodePapr/skills', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'codepapr-skills-'));
    try {
      const skillsDir = join(workspace, '.CodePapr', 'skills');
      await mkdir(skillsDir, { recursive: true });
      await mkdir(join(skillsDir, 'search'), { recursive: true });
      await mkdir(join(skillsDir, 'suite', 'article-illustrator'), { recursive: true });
      await writeFile(
        join(skillsDir, 'search', 'SKILL.md'),
        '---\ndescription: 搜索资料\n---\n优先查官方文档。',
        'utf8'
      );
      await writeFile(
        join(skillsDir, 'suite', 'article-illustrator', 'SKILL.md'),
        '---\ndescription: 配图\n---\n生成配图流程。',
        'utf8'
      );

      const section = await loadSkillsSection(workspace);

      expect(section).toContain('## 项目 Skills');
      expect(section).toContain('`search`: 搜索资料');
      expect(section).toContain('`suite/article-illustrator`: 配图');
      expect(section).not.toContain('优先查官方文档。');

      const definitions = await loadSkillDefinitions(workspace);
      expect(definitions.find((skill) => skill.id === 'suite/article-illustrator')).toMatchObject({
        name: 'article-illustrator',
        rootPath: '.CodePapr/skills/suite/article-illustrator',
      });

      await expect(resolveSkillFilePath(workspace, 'suite/article-illustrator')).resolves.toBe(
        join(skillsDir, 'suite', 'article-illustrator', 'SKILL.md')
      );
      await expect(resolveSkillFilePath(workspace, 'article-illustrator')).resolves.toBe(
        join(skillsDir, 'suite', 'article-illustrator', 'SKILL.md')
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('reads disabled skills from project sqlite instead of skill frontmatter', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'codepapr-skills-disabled-'));
    try {
      const skillsDir = join(workspace, '.CodePapr', 'skills');
      await mkdir(join(skillsDir, 'search'), { recursive: true });
      await mkdir(join(skillsDir, 'docs'), { recursive: true });
      await writeFile(
        join(skillsDir, 'search', 'SKILL.md'),
        '---\nname: 搜索\ndescription: 搜索资料\nenabled: false\n---\n优先查官方文档。',
        'utf8'
      );
      await writeFile(
        join(skillsDir, 'docs', 'SKILL.md'),
        '---\nname: 文档\ndescription: 维护文档\nenabled: true\n---\n更新 README。',
        'utf8'
      );

      const db = new DSDatabase(join(workspace, '.CodePapr', 'project.sqlite'));
      try {
        db.getRaw().exec(
          'CREATE TABLE IF NOT EXISTS project_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)'
        );
        db.getRaw()
          .prepare(
            `INSERT INTO project_state (key, value, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
          )
          .run(
            'project.state',
            JSON.stringify({ skillEnabledById: { search: false } }),
            Date.now()
          );
      } finally {
        db.close();
      }

      const section = await loadSkillsSection(workspace);
      const definitions = await loadSkillDefinitions(workspace);

      expect(section).toContain('`docs` (文档): 维护文档');
      expect(section).not.toContain('`search`');
      expect(definitions.find((skill) => skill.id === 'search')?.enabled).toBe(false);
      expect(definitions.find((skill) => skill.id === 'docs')?.enabled).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
