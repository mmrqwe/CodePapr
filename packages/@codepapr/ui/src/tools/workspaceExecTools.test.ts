import { afterEach, describe, expect, it } from 'vitest';
import { __workspaceExecToolsTestUtils } from './workspaceExecTools';

const { extractAbsoluteCommandPaths, buildSandboxAlignedSkipPrefixes } =
  __workspaceExecToolsTestUtils;

const originalHome = process.env.HOME;
const originalPath = process.env.PATH;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
});

describe('buildSandboxAlignedSkipPrefixes (#18)', () => {
  it('includes system paths, PATH entries, home tool dirs and Homebrew', () => {
    process.env.HOME = '/Users/tester';
    process.env.PATH = '/usr/local/bin:/Users/tester/.cargo/bin:/Users/tester/.local/bin';
    const prefixes = buildSandboxAlignedSkipPrefixes();

    for (const required of [
      '/bin/',
      '/usr/bin/',
      '/opt/homebrew/bin/',
      '/opt/homebrew/',
      '/usr/local/bin/',
      '/Users/tester/.cargo/bin/',
      '/Users/tester/.local/bin/',
      '/Users/tester/.npm/',
      '/Users/tester/.cache/',
      '/Users/tester/.local/share/',
      '/Users/tester/.nvm/',
      '/Users/tester/.volta/',
    ]) {
      expect(prefixes).toContain(required);
    }
    // ~/.local 整体不放行（bin/ 可写即能植入持久化二进制），只放行数据目录
    expect(prefixes.some((p) => p === '/Users/tester/.local/')).toBe(false);
  });
});

describe('extractAbsoluteCommandPaths 沙箱对齐跳过集 (#18)', () => {
  it('skips sandbox-aligned roots: PATH tools, cargo, nvm, Homebrew Cellar', () => {
    process.env.HOME = '/Users/tester';
    process.env.PATH = '/usr/local/bin:/Users/tester/.cargo/bin';
    const command = [
      '/Users/tester/.cargo/bin/rustfmt',
      '/Users/tester/.nvm/versions/node/v20/bin/node',
      '/opt/homebrew/Cellar/openssl/3.0/bin/openssl',
      '/usr/local/bin/python3',
    ].join(' ');
    expect(extractAbsoluteCommandPaths(command)).toEqual([]);
  });

  it('still flags untrusted external paths (first token included)', () => {
    process.env.HOME = '/Users/tester';
    process.env.PATH = '/usr/local/bin';
    const paths = extractAbsoluteCommandPaths('/tmp/evil/bin --in /var/tmp/data.txt');
    expect(paths).toEqual(['/tmp/evil/bin', '/var/tmp/data.txt']);
  });

  it('does not skip ~/.local/bin unless it is on PATH', () => {
    process.env.HOME = '/Users/tester';
    process.env.PATH = '/usr/local/bin';
    const paths = extractAbsoluteCommandPaths('/Users/tester/.local/bin/tool');
    expect(paths).toEqual(['/Users/tester/.local/bin/tool']);
  });

  it('dedupes candidates', () => {
    process.env.HOME = '/Users/tester';
    process.env.PATH = '/usr/local/bin';
    const paths = extractAbsoluteCommandPaths('/tmp/a.sh /tmp/a.sh && /tmp/a.sh');
    expect(paths).toEqual(['/tmp/a.sh']);
  });
});
