import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { DSDatabase, SessionRepository } from '../packages/@codepapr/db/src/index';

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ['packages/@codepapr/cli/bin/codepapr.mjs', ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env,
      FORCE_COLOR: '0',
    },
    encoding: 'utf8',
  });
}

async function createFixture() {
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codepapr-home-'));
  const workspaceDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codepapr-workspace-'));
  const sourceDir = path.join(workspaceDir, 'src');
  await fsp.mkdir(sourceDir, { recursive: true });
  await fsp.writeFile(path.join(sourceDir, 'needle.txt'), 'hello e2e\n', 'utf8');

  const dataDir = path.join(homeDir, '.codepapr');
  await fsp.mkdir(dataDir, { recursive: true });
  const db = new DSDatabase(path.join(dataDir, 'codepapr.sqlite'));
  db.init();
  db.prepare('INSERT OR REPLACE INTO settings (key, value, data_type, updated_at) VALUES (?, ?, ?, ?)').run(
    'ui.settings',
    JSON.stringify({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      apiKey: 'stored-test-key',
    }),
    'json',
    Date.now()
  );
  db.close();

  return { homeDir, workspaceDir, dbPath: path.join(dataDir, 'codepapr.sqlite') };
}

async function removeDir(target: string): Promise<void> {
  await fsp.rm(target, { recursive: true, force: true });
}

describe('cli e2e', () => {
  const cleanupTargets: string[] = [];

  afterEach(async () => {
    while (cleanupTargets.length > 0) {
      const target = cleanupTargets.pop();
      if (target) {
        await removeDir(target);
      }
    }
  });

  it('runs config, agent, session and stats against an isolated home directory', async () => {
    const fixture = await createFixture();
    cleanupTargets.push(fixture.homeDir, fixture.workspaceDir);

    const env = {
      HOME: fixture.homeDir,
      USERPROFILE: fixture.homeDir,
      CODEPAPR_TEST_PROVIDER: 'scripted',
    };

    const configResult = runCli(['config'], env);
    expect(configResult.status).toBe(0);
    expect(configResult.stdout).toContain('Provider: deepseek');
    expect(configResult.stdout).toContain('SQLite API Key: ✓');

    const agentResult = runCli(
      ['agent', '--workspace', fixture.workspaceDir, '--provider', 'deepseek', '--api-key', 'test-key', '请按文件名搜索 needle.txt 并告诉我相对路径'],
      env
    );
    expect(agentResult.status).toBe(0);
    expect(agentResult.stdout).toContain('已找到文件：src/needle.txt');
    expect(agentResult.stdout).toContain('[缓存]');

    const db = new DSDatabase(fixture.dbPath);
    db.init();
    const sessionRepo = new SessionRepository(db);
    const sessions = sessionRepo.list();
    db.close();

    expect(sessions).toHaveLength(1);
    const sessionId = sessions[0]?.sessionId;
    expect(sessionId).toBeTruthy();

    const sessionResult = runCli(['session'], env);
    expect(sessionResult.status).toBe(0);
    expect(sessionResult.stdout).toContain(String(sessionId).slice(0, 8));

    const statsResult = runCli(['stats', String(sessionId)], env);
    expect(statsResult.status).toBe(0);
    expect(statsResult.stdout).toContain('轮次:     1');
  }, 60_000);

  it('can drive a workspace command through the deterministic provider path', async () => {
    const fixture = await createFixture();
    cleanupTargets.push(fixture.homeDir, fixture.workspaceDir);

    const env = {
      HOME: fixture.homeDir,
      USERPROFILE: fixture.homeDir,
      CODEPAPR_TEST_PROVIDER: 'scripted',
    };

    const agentResult = runCli(
      ['agent', '--workspace', fixture.workspaceDir, '--provider', 'deepseek', '--api-key', 'test-key', '请打开 shell 并执行 pwd'],
      env
    );

    expect(agentResult.status).toBe(0);
    const hasCommandOutput = agentResult.stdout.includes('命令输出：');
    const hasNoOutputNotice = agentResult.stdout.includes('命令已执行，但没有输出');
    expect(hasCommandOutput || hasNoOutputNotice).toBe(true);
    if (hasCommandOutput) {
      expect(agentResult.stdout).toContain(path.basename(fixture.workspaceDir));
    }
  }, 60_000);
});
