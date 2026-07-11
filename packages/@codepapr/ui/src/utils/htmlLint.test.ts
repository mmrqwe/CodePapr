import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../../..', import.meta.url));
const uiIndexHtml = path.join(repoRoot, 'packages/@codepapr/ui/index.html');

async function createEslint(): Promise<ESLint> {
  return new ESLint({ cwd: repoRoot });
}

describe('root lint configuration', () => {
  it('includes html files in the root lint script', async () => {
    const packageJsonPath = path.join(repoRoot, 'package.json');
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
      scripts?: { lint?: string };
    };

    expect(packageJson.scripts?.lint).toContain('html');
  });

  it('lints the shipped ui index.html without parse errors', async () => {
    const eslint = await createEslint();
    const [result] = await eslint.lintFiles([uiIndexHtml]);

    expect(result.fatalErrorCount).toBe(0);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });

  it('catches duplicate attributes and missing doctype in html snippets', async () => {
    const eslint = await createEslint();
    const [result] = await eslint.lintText(
      '<html lang="zh-CN"><body><div id="a" id="b"></div></body></html>',
      { filePath: path.join(repoRoot, 'packages/@codepapr/ui/test-fixture.html') },
    );

    const ruleIds = result.messages.map((message) => message.ruleId);
    expect(ruleIds).toContain('@html-eslint/no-duplicate-attrs');
    expect(ruleIds).toContain('@html-eslint/require-doctype');
  });
});