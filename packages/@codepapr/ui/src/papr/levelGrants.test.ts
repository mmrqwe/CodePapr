import { describe, expect, it } from 'vitest';
import {
  accessAllows,
  accessMeetsTool,
  agentToolsFor,
  intersectAccess,
  legacyLevelToAccess,
  legacyAccessToLevel,
  manifestAccess,
  minAccessForAgentTool,
  resolveEffectiveAccess,
} from './levelGrants';
import type { PaprAppSettings, PaprManifest } from '@codepapr/types';

function makeManifest(overrides: Partial<PaprManifest> = {}): PaprManifest {
  return { spec: 'papr/0.1', name: 'Test', agents: [], ...overrides } as PaprManifest;
}

const settings: PaprAppSettings = { defaultLocal: 'none', defaultNetwork: false, appOverrides: {} };

describe('two-axis levelGrants', () => {
  it('legacy level maps to two-axis access', () => {
    expect(legacyLevelToAccess(0)).toEqual({ local: 'none', network: false });
    expect(legacyLevelToAccess(1)).toEqual({ local: 'read', network: false });
    expect(legacyLevelToAccess(2)).toEqual({ local: 'read', network: true });
    expect(legacyLevelToAccess(3)).toEqual({ local: 'write', network: true });
    expect(legacyAccessToLevel({ local: 'read', network: false })).toBe(1);
    expect(legacyAccessToLevel({ local: 'write', network: false })).toBe(3);
  });

  it('intersect only narrows', () => {
    const full = { local: 'write' as const, network: true };
    expect(intersectAccess(full, { local: 'read', network: false })).toEqual({
      local: 'read',
      network: false,
    });
    expect(intersectAccess({ local: 'read', network: false }, full)).toEqual({
      local: 'read',
      network: false,
    });
  });

  it('manifest access prefers local/network over legacy level', () => {
    expect(manifestAccess(makeManifest({ local: 'read', network: true }), settings)).toEqual({
      local: 'read',
      network: true,
    });
    expect(manifestAccess(makeManifest({ level: 2 }), settings)).toEqual({
      local: 'read',
      network: true,
    });
    expect(manifestAccess(null, settings)).toEqual({ local: 'none', network: false });
  });

  it('effective access = manifest ∩ override', () => {
    const manifest = makeManifest({ local: 'write', network: true });
    expect(resolveEffectiveAccess(manifest, settings, 'app-x')).toEqual({
      local: 'write',
      network: true,
    });
    const narrowed: PaprAppSettings = {
      defaultLocal: 'none',
      defaultNetwork: false,
      appOverrides: { 'app-x': { local: 'read', network: false } },
    };
    expect(resolveEffectiveAccess(manifest, narrowed, 'app-x')).toEqual({
      local: 'read',
      network: false,
    });
  });

  it('accessAllows: storage/fs always, http needs network, agent needs declared agent', () => {
    const off = { local: 'read' as const, network: false };
    expect(accessAllows(off, 'storage:read', null)).toBe(true);
    expect(accessAllows(off, 'fs:write', null)).toBe(true);
    expect(accessAllows(off, 'http:get', null)).toBe(false);
    expect(accessAllows({ ...off, network: true }, 'http:get', null)).toBe(true);
    const manifest = makeManifest({ agents: [{ name: 'assistant' }] });
    expect(accessAllows(off, 'agent:run:assistant', manifest)).toBe(true);
    expect(accessAllows(off, 'agent:run:nobody', manifest)).toBe(false);
  });

  it('agentToolsFor derives tools from axes', () => {
    expect(agentToolsFor('none', false)).toEqual(new Set(['todo', 'local_time_now']));
    const readOff = agentToolsFor('read', false);
    expect(readOff.has('read')).toBe(true);
    expect(readOff.has('write')).toBe(false);
    expect(readOff.has('websearch')).toBe(false);
    const writeOn = agentToolsFor('write', true);
    expect(writeOn.has('bash')).toBe(true);
    expect(writeOn.has('websearch')).toBe(true);
  });

  it('minAccessForAgentTool + accessMeetsTool', () => {
    expect(minAccessForAgentTool('read')).toEqual({ local: 'read', network: false });
    expect(minAccessForAgentTool('bash')).toEqual({ local: 'write', network: false });
    expect(minAccessForAgentTool('webfetch')).toEqual({ local: 'none', network: true });
    expect(minAccessForAgentTool('unknown')).toBeNull();
    expect(accessMeetsTool({ local: 'read', network: false }, 'read')).toBe(true);
    expect(accessMeetsTool({ local: 'read', network: false }, 'bash')).toBe(false);
    expect(accessMeetsTool({ local: 'read', network: true }, 'webfetch')).toBe(true);
    expect(accessMeetsTool({ local: 'read', network: false }, 'webfetch')).toBe(false);
  });
});
