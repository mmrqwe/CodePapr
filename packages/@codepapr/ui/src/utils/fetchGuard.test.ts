import { describe, expect, it } from 'vitest';
import { isBlockedFetchTarget } from './fetchGuard';

describe('fetchGuard 目标守卫（#67：http://** 放行 + 全局 fetch 绕过 CORS）', () => {
  it('阻止链路本地与云元数据地址', () => {
    expect(isBlockedFetchTarget('http://169.254.169.254/latest/meta-data/')).toBe(true);
    expect(isBlockedFetchTarget('http://169.254.0.1/')).toBe(true);
    expect(isBlockedFetchTarget('https://169.254.169.254/')).toBe(true);
    expect(isBlockedFetchTarget('http://0.0.0.0/')).toBe(true);
    expect(isBlockedFetchTarget('http://[fe80::1]/')).toBe(true);
    expect(isBlockedFetchTarget('http://[febf::1]/')).toBe(true);
  });

  it('阻止 IPv4-mapped / compatible 形式的链路本地地址', () => {
    expect(isBlockedFetchTarget('http://[::ffff:169.254.169.254]/')).toBe(true);
    expect(isBlockedFetchTarget('http://[::169.254.169.254]/')).toBe(true);
    // 同形式的公网/回环地址放行
    expect(isBlockedFetchTarget('http://[::ffff:127.0.0.1]:8080/')).toBe(false);
    expect(isBlockedFetchTarget('http://[::ffff:8.8.8.8]/')).toBe(false);
  });

  it('放行回环与私网（app 后端 / LAN LLM 端点等合法用途）', () => {
    expect(isBlockedFetchTarget('http://localhost:3456/')).toBe(false);
    expect(isBlockedFetchTarget('http://127.0.0.1:11434/v1/chat/completions')).toBe(false);
    expect(isBlockedFetchTarget('http://[::1]:8080/')).toBe(false);
    expect(isBlockedFetchTarget('http://192.168.1.10:8000/')).toBe(false);
    expect(isBlockedFetchTarget('http://10.0.0.5:8080/')).toBe(false);
    expect(isBlockedFetchTarget('http://172.16.0.2:8080/')).toBe(false);
    expect(isBlockedFetchTarget('http://100.64.0.1:8080/')).toBe(false);
  });

  it('放行公网域名与 https 常规目标', () => {
    expect(isBlockedFetchTarget('https://api.deepseek.com/v1/chat/completions')).toBe(false);
    expect(isBlockedFetchTarget('https://example.com/')).toBe(false);
    expect(isBlockedFetchTarget('https://8.8.8.8/')).toBe(false);
    expect(isBlockedFetchTarget('https://[2606:4700:4700::1111]/')).toBe(false);
  });

  it('非 http(s) 与非法 URL 不拦截', () => {
    expect(isBlockedFetchTarget('asset://localhost/foo.png')).toBe(false);
    expect(isBlockedFetchTarget('data:text/plain,hi')).toBe(false);
    expect(isBlockedFetchTarget('not a url')).toBe(false);
  });
});
