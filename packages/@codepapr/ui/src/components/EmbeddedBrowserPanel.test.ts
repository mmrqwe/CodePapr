import { describe, expect, it } from 'vitest';
import { normalizeEmbeddedBrowserUrl } from './EmbeddedBrowserPanel';

describe('normalizeEmbeddedBrowserUrl（N19）', () => {
  it('localhost 默认 http（不再强升 https）', () => {
    expect(normalizeEmbeddedBrowserUrl('localhost:5173')).toBe('http://localhost:5173');
    expect(normalizeEmbeddedBrowserUrl('localhost')).toBe('http://localhost');
    expect(normalizeEmbeddedBrowserUrl('localhost:3000/docs?a=1')).toBe('http://localhost:3000/docs?a=1');
  });

  it('127.0.0.1 / [::1] 环回地址默认 http', () => {
    expect(normalizeEmbeddedBrowserUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(normalizeEmbeddedBrowserUrl('[::1]:8080')).toBe('http://[::1]:8080');
  });

  it('显式 scheme 原样保留', () => {
    expect(normalizeEmbeddedBrowserUrl('https://localhost:5173')).toBe('https://localhost:5173');
    expect(normalizeEmbeddedBrowserUrl('http://example.com')).toBe('http://example.com');
  });

  it('外部域名默认 https', () => {
    expect(normalizeEmbeddedBrowserUrl('example.com')).toBe('https://example.com');
  });

  it('空白输入原样返回（调用方自行拦截空值）', () => {
    expect(normalizeEmbeddedBrowserUrl('  ')).toBe('');
  });
});
