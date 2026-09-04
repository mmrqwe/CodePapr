import { describe, expect, it } from 'vitest';
import { platformSandboxWarning, sandboxEnforcedOnThisPlatform } from './platformSandbox';

describe('platformSandboxWarning (C-5)', () => {
  it('macOS 沙箱生效，不告警', () => {
    expect(sandboxEnforcedOnThisPlatform('darwin')).toBe(true);
    expect(platformSandboxWarning({ local: 'none', network: false }, 'darwin')).toBeNull();
    expect(platformSandboxWarning({ local: 'read', network: false }, 'darwin')).toBeNull();
  });

  it('Windows/Linux 收窄档触发告警', () => {
    expect(platformSandboxWarning({ local: 'read', network: false }, 'win32')).toContain(
      '仅 macOS 生效',
    );
    const warn = platformSandboxWarning({ local: 'read', network: false }, 'linux');
    expect(warn).toContain('断网');
    expect(warn).toContain('工作区只读');
  });

  it('全权档（write + network）不告警', () => {
    expect(platformSandboxWarning({ local: 'write', network: true }, 'win32')).toBeNull();
    // 只有单轴收窄时也点名对应轴
    expect(platformSandboxWarning({ local: 'read', network: true }, 'linux')).toContain(
      '工作区只读',
    );
    const networkOnly = platformSandboxWarning({ local: 'write', network: false }, 'win32');
    expect(networkOnly).toContain('断网');
    expect(networkOnly).not.toContain('工作区只读');
  });
});
