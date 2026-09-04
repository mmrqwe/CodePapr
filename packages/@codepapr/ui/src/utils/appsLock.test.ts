import { describe, expect, it } from 'vitest';
import {
  effectiveInstalledVersion,
  emptyAppsLock,
  parseAppsLock,
  removeAppFromLock,
  serializeAppsLock,
  upsertAppLockEntry,
  type AppLockEntry,
} from './appsLock';

const entry: AppLockEntry = {
  listingId: 'demo-app',
  version: '1.2.0',
  source: 'mmrqwe/codepapr-apps',
  scope: 'workspace',
  files: { 'index.html': 'abc123' },
  installedAt: 1,
};

describe('appsLock (D-16)', () => {
  it('serialize/parse roundtrip', () => {
    const lock = upsertAppLockEntry(emptyAppsLock(), entry);
    const parsed = parseAppsLock(serializeAppsLock(lock));
    expect(parsed.apps['demo-app']).toEqual(entry);
  });

  it('parse 容错：垃圾数据不炸', () => {
    expect(parseAppsLock(null).apps).toEqual({});
    expect(parseAppsLock('not json').apps).toEqual({});
    expect(parseAppsLock('[1,2]').apps).toEqual({});
    expect(parseAppsLock('{"version":1,"apps":{"x":{"listingId":"x"}}}').apps).toEqual({});
    expect(
      parseAppsLock('{"version":1,"apps":{"x":{"listingId":"x","version":"1.0","files":{"a":1,"b":"hash"}}}}')
        .apps['x']?.files,
    ).toEqual({ b: 'hash' });
  });

  it('removeAppFromLock 无变化时保持原引用', () => {
    const lock = emptyAppsLock();
    expect(removeAppFromLock(lock, 'missing')).toBe(lock);
    const withEntry = upsertAppLockEntry(lock, entry);
    expect(removeAppFromLock(withEntry, 'demo-app').apps['demo-app']).toBeUndefined();
  });

  it('effectiveInstalledVersion：锁优先，无锁回退 manifest，双缺为空串', () => {
    const manifest = JSON.stringify({ version: '0.9.0' });
    expect(effectiveInstalledVersion(entry, manifest)).toBe('1.2.0');
    expect(effectiveInstalledVersion(undefined, manifest)).toBe('0.9.0');
    expect(effectiveInstalledVersion(undefined, undefined)).toBe('');
  });
});
