import { describe, it, expect } from 'vitest';
import { resolveVerifierTier } from './verifierRunner';

describe('resolveVerifierTier', () => {
  it('主观目标在 fast 档自动升级为 mentor（已配置）', () => {
    expect(resolveVerifierTier('fast', true, true)).toBe('mentor');
  });

  it('主观目标升级 mentor 但未配置时静默降级 primary', () => {
    expect(resolveVerifierTier('fast', true, false)).toBe('primary');
  });

  it('客观目标保持 fast 档', () => {
    expect(resolveVerifierTier('fast', false, true)).toBe('fast');
  });

  it('显式选择 primary 时主观目标不升级', () => {
    expect(resolveVerifierTier('primary', true, true)).toBe('primary');
  });

  it('显式选择 mentor 且已配置时对客观目标也生效', () => {
    expect(resolveVerifierTier('mentor', false, true)).toBe('mentor');
  });

  it('显式选择 mentor 但未配置时静默降级 primary', () => {
    expect(resolveVerifierTier('mentor', false, false)).toBe('primary');
  });
});
