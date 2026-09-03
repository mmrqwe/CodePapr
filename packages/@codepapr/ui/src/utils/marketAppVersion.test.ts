import { describe, expect, it } from 'vitest';
import {
  compareAppVersions,
  isMarketUpdateAvailable,
  readInstalledAppVersion,
} from './marketAppVersion';

describe('compareAppVersions', () => {
  it('orders dotted versions', () => {
    expect(compareAppVersions('0.1.0', '0.1.1')).toBe(-1);
    expect(compareAppVersions('0.2.0', '0.1.9')).toBe(1);
    expect(compareAppVersions('1.0.0', '1.0.0')).toBe(0);
  });
});

describe('isMarketUpdateAvailable', () => {
  it('treats a missing installed version as outdated', () => {
    expect(isMarketUpdateAvailable('', '0.1.1')).toBe(true);
  });

  it('is false when the installed copy already matches the market', () => {
    expect(isMarketUpdateAvailable('0.1.1', '0.1.1')).toBe(false);
  });

  it('is true when the market version is newer', () => {
    expect(isMarketUpdateAvailable('0.1.0', '0.1.1')).toBe(true);
  });
});

describe('readInstalledAppVersion', () => {
  it('reads version from a plugin manifest', () => {
    expect(readInstalledAppVersion('{"spec":"papr/0.1","version":"0.1.1"}')).toBe('0.1.1');
  });

  it('returns empty when the manifest has no version', () => {
    expect(readInstalledAppVersion('{"spec":"papr/0.1","name":"看板"}')).toBe('');
  });
});
