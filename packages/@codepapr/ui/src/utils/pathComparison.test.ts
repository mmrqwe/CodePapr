import { afterEach, describe, expect, it } from 'vitest';
import { isCaseInsensitiveFilesystem, pathsEquivalent, pathUnderDir } from './pathComparison';

const originalPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
});

function withPlatform(platform: NodeJS.Platform, fn: () => void): void {
  Object.defineProperty(process, 'platform', { value: platform });
  fn();
}

describe('pathsEquivalent', () => {
  it('exact match is always equivalent', () => {
    expect(pathsEquivalent('/Users/example/x', '/Users/example/x')).toBe(true);
  });

  it('case differs only matters on case-insensitive filesystems', () => {
    withPlatform('darwin', () => {
      expect(pathsEquivalent('/Users/EXAMPLE/x', '/Users/example/x')).toBe(true);
    });
    withPlatform('win32', () => {
      expect(pathsEquivalent('C:\\Users\\EXAMPLE', 'c:\\users\\example')).toBe(true);
    });
    withPlatform('linux', () => {
      expect(pathsEquivalent('/Users/EXAMPLE/x', '/Users/example/x')).toBe(false);
    });
  });
});

describe('pathUnderDir', () => {
  it('matches the dir itself and children, platform-aware case', () => {
    withPlatform('darwin', () => {
      expect(pathUnderDir('/Users/EXAMPLE/work', '/Users/example/work')).toBe(true);
      expect(pathUnderDir('/Users/EXAMPLE/work/src/a.ts', '/Users/example/work')).toBe(true);
      expect(pathUnderDir('/Users/EXAMPLE/elsewhere', '/Users/example/work')).toBe(false);
    });
  });

  it('keeps exact semantics on case-sensitive platforms', () => {
    withPlatform('linux', () => {
      expect(pathUnderDir('/Users/EXAMPLE/work', '/Users/example/work')).toBe(false);
      expect(pathUnderDir('/Users/example/work/src/a.ts', '/Users/example/work')).toBe(true);
    });
  });
});

describe('isCaseInsensitiveFilesystem', () => {
  it('reports true only for darwin/win32', () => {
    withPlatform('darwin', () => expect(isCaseInsensitiveFilesystem()).toBe(true));
    withPlatform('win32', () => expect(isCaseInsensitiveFilesystem()).toBe(true));
    withPlatform('linux', () => expect(isCaseInsensitiveFilesystem()).toBe(false));
  });
});
