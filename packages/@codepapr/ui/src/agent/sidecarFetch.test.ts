import { describe, expect, it } from 'vitest';
import { createSidecarFetch, isDeniedFetchUrl } from './sidecarFetch';

describe('sidecarFetch deny list', () => {
  it('allows public https LLM endpoints', () => {
    expect(isDeniedFetchUrl('https://api.deepseek.com/v1/chat/completions')).toBe(false);
    expect(isDeniedFetchUrl('http://127.0.0.1:11434/api/chat')).toBe(false);
    expect(isDeniedFetchUrl('http://localhost:8080/v1')).toBe(false);
  });

  it('blocks link-local and 0.x hosts', () => {
    expect(isDeniedFetchUrl('http://169.254.169.254/latest/meta-data')).toBe(true);
    expect(isDeniedFetchUrl('https://0.0.0.0/')).toBe(true);
    expect(isDeniedFetchUrl('http://0.1.2.3/')).toBe(true);
    expect(isDeniedFetchUrl('http://[fe80::1]/')).toBe(true);
  });

  it('blocks non-http schemes and invalid URLs', () => {
    expect(isDeniedFetchUrl('file:///etc/passwd')).toBe(true);
    expect(isDeniedFetchUrl('not a url')).toBe(true);
  });

  it('createSidecarFetch rejects denied URLs without calling base fetch', async () => {
    const fetchFn = createSidecarFetch(() => {
      throw new Error('base fetch should not run');
    });
    await expect(fetchFn('http://169.254.1.1/')).rejects.toThrow(/Blocked fetch/);
  });
});
