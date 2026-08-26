import { describe, expect, it } from 'vitest';
import {
  agentSandboxArgs,
  assertAgentCodePaprAccess,
  assertShellCodePaprAccess,
  codePaprSuffix,
  effectiveCodePaprMode,
} from './codepaprAgentAccess';

describe('codePaprSuffix', () => {
  it('returns null outside .CodePapr', () => {
    expect(codePaprSuffix(undefined)).toBeNull();
    expect(codePaprSuffix('src/main.ts')).toBeNull();
    expect(codePaprSuffix('/tmp/ws/src')).toBeNull();
  });

  it('returns empty suffix for the directory itself', () => {
    expect(codePaprSuffix('.CodePapr')).toBe('');
    expect(codePaprSuffix('/tmp/ws/.CodePapr')).toBe('');
    expect(codePaprSuffix('.codepapr')).toBe('');
  });

  it('returns the inner relative path', () => {
    expect(codePaprSuffix('.CodePapr/tmp/a.js')).toBe('tmp/a.js');
    expect(codePaprSuffix('/tmp/ws/.CodePapr/apps/demo/index.html')).toBe('apps/demo/index.html');
    expect(codePaprSuffix('.CodePapr\\skills\\search\\SKILL.md')).toBe('skills/search/SKILL.md');
  });
});

describe('assertAgentCodePaprAccess', () => {
  it('allows ordinary project paths', () => {
    expect(() => assertAgentCodePaprAccess('src/main.ts', 'write')).not.toThrow();
    expect(() => assertAgentCodePaprAccess(undefined, 'list')).not.toThrow();
  });

  it('denies the .CodePapr root and internal state', () => {
    expect(() => assertAgentCodePaprAccess('.CodePapr', 'list')).toThrow(/运行时管理/);
    expect(() => assertAgentCodePaprAccess('.CodePapr/project.sqlite', 'read')).toThrow(/运行时管理/);
    expect(() => assertAgentCodePaprAccess('.CodePapr/git/HEAD', 'read')).toThrow(/运行时管理/);
    expect(() => assertAgentCodePaprAccess('.CodePapr/AGENTS.md', 'write')).toThrow(/运行时管理/);
    expect(() => assertAgentCodePaprAccess('.CodePapr/agents/reviewer.md', 'read')).toThrow(
      /运行时管理/
    );
    expect(() => assertAgentCodePaprAccess('.CodePapr/commands/ship.md', 'read')).toThrow(
      /运行时管理/
    );
    expect(() => assertAgentCodePaprAccess('.CodePapr/chat-images/a.png', 'read')).toThrow(
      /运行时管理/
    );
  });

  it('allows scratch dirs in every mode', () => {
    for (const path of [
      '.CodePapr/tmp/validate.mjs',
      '.CodePapr/tool-output/tool_1.txt',
      '.CodePapr/downloads/page.html',
    ]) {
      expect(() => assertAgentCodePaprAccess(path, 'read')).not.toThrow();
      expect(() => assertAgentCodePaprAccess(path, 'write')).not.toThrow();
      expect(() => assertAgentCodePaprAccess(path, 'execute')).not.toThrow();
    }
  });

  it('allows reading skill packs but not writing them', () => {
    expect(() =>
      assertAgentCodePaprAccess('.CodePapr/skills/search/references/a.md', 'read')
    ).not.toThrow();
    expect(() => assertAgentCodePaprAccess('.CodePapr/skills/search', 'list')).not.toThrow();
    expect(() =>
      assertAgentCodePaprAccess('.CodePapr/skills/search/SKILL.md', 'write')
    ).toThrow(/运行时管理/);
  });

  it('allows apps only in app mode', () => {
    expect(() =>
      assertAgentCodePaprAccess('.CodePapr/apps/demo/index.html', 'write', 'agent')
    ).toThrow(/运行时管理/);
    expect(() =>
      assertAgentCodePaprAccess('.CodePapr/apps/demo/index.html', 'write', 'app')
    ).not.toThrow();
    expect(() =>
      assertAgentCodePaprAccess('.CodePapr/apps/demo', 'list', 'app')
    ).not.toThrow();
  });
});

describe('assertShellCodePaprAccess', () => {
  it('blocks ls .CodePapr and allows ls of scratch', () => {
    expect(() => assertShellCodePaprAccess('ls .CodePapr')).toThrow(/运行时管理/);
    expect(() => assertShellCodePaprAccess('ls -la .CodePapr/')).toThrow(/运行时管理/);
    expect(() => assertShellCodePaprAccess('ls .CodePapr/tmp')).not.toThrow();
    expect(() => assertShellCodePaprAccess('node validate.mjs', 'agent', '.CodePapr/tmp')).not.toThrow();
    expect(() =>
      assertShellCodePaprAccess('node server.js', 'agent', '.CodePapr/apps/demo')
    ).toThrow(/运行时管理/);
    expect(() =>
      assertShellCodePaprAccess('node server.js', 'app', '.CodePapr/apps/demo')
    ).not.toThrow();
  });
});

describe('agentSandboxArgs', () => {
  it('does not grant apps to the main agent outside app mode', () => {
    expect(agentSandboxArgs('agent').allowCodepaprApps).toBe(false);
    expect(agentSandboxArgs('plan').allowCodepaprApps).toBe(false);
    expect(agentSandboxArgs('app').allowCodepaprApps).toBe(true);
  });

  it('grants apps to in-app agents', () => {
    expect(
      agentSandboxArgs('agent', { network: false, workspaceWrite: true }).allowCodepaprApps
    ).toBe(true);
  });

  it('promotes file-gate mode to app when allowCodepaprApps is set', () => {
    expect(effectiveCodePaprMode('agent')).toBe('agent');
    expect(effectiveCodePaprMode('app')).toBe('app');
    expect(effectiveCodePaprMode('agent', { allowCodepaprApps: true })).toBe('app');
  });
});
