import { describe, expect, it } from 'vitest';
import {
  findPreviewProcessForPort,
  previewUrlMatchesPort,
  processPreviewUrl,
} from './loopbackPreview';

describe('processPreviewUrl', () => {
  it('prefers camelCase previewUrl from Rust serde', () => {
    expect(processPreviewUrl({ previewUrl: 'http://127.0.0.1:3000/' })).toBe(
      'http://127.0.0.1:3000/',
    );
  });

  it('falls back to snake_case for older callers', () => {
    expect(processPreviewUrl({ preview_url: 'http://localhost:3000/' })).toBe(
      'http://localhost:3000/',
    );
  });
});

describe('previewUrlMatchesPort', () => {
  it('treats localhost and 127.0.0.1 as the same loopback host', () => {
    expect(previewUrlMatchesPort('http://127.0.0.1:5173/', 5173)).toBe(true);
    expect(previewUrlMatchesPort('http://localhost:5173/', 5173)).toBe(true);
    expect(previewUrlMatchesPort('http://[::1]:5173/', 5173)).toBe(true);
  });

  it('ignores path and query', () => {
    expect(previewUrlMatchesPort('http://127.0.0.1:8080/app?x=1', 8080)).toBe(true);
  });

  it('rejects a different port or a non-loopback host', () => {
    expect(previewUrlMatchesPort('http://127.0.0.1:8080/', 3000)).toBe(false);
    expect(previewUrlMatchesPort('http://example.com:8080/', 8080)).toBe(false);
  });
});

describe('findPreviewProcessForPort', () => {
  it('matches a 127.0.0.1 registry entry against an app on localhost', () => {
    const match = findPreviewProcessForPort(
      [{ pid: 42, previewUrl: 'http://127.0.0.1:3456/' }],
      3456,
    );
    expect(match?.pid).toBe(42);
  });
});
