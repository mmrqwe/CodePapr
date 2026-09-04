import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import {
  assertListingPermissions,
  assertOfficialRawUrl,
  downloadAppFiles,
  extractLocalAssetsFromHtml,
  fetchAppTreeFileList,
  installMarketApp,
  sanitizeRelativePath,
  uninstallMarketApp,
} from './marketAppInstall';
import type { PaprAppListing } from '../utils/marketAppTypes';
import { useAppRuntimeStore } from '../store/appRuntimeStore';

const mockListing: PaprAppListing = {
  id: 'weather-hud',
  name: 'Weather HUD',
  title: '天气小组件',
  version: '0.1.1',
  description: '悬浮天气插件',
  kind: 'plugin',
  tags: ['tools', 'weather'],
  directory: 'apps/weather-hud',
  entry: 'index.html',
};

describe('marketAppInstall helpers', () => {
  it('sanitizes relative paths safely', () => {
    expect(sanitizeRelativePath('js/vendor/react.min.js')).toBe('js/vendor/react.min.js');
    expect(sanitizeRelativePath('/css/theme.css?v=123')).toBe('css/theme.css');
    expect(sanitizeRelativePath('assets/logo.png#main')).toBe('assets/logo.png');
    expect(sanitizeRelativePath('https://cdn.example.com/lib.js')).toBeNull();
    expect(sanitizeRelativePath('//cdn.example.com/lib.js')).toBeNull();
    expect(sanitizeRelativePath('data:image/png;base64,...')).toBeNull();
    expect(sanitizeRelativePath('__papr_sdk.js')).toBeNull();
    expect(sanitizeRelativePath('../secret.txt')).toBeNull();
    expect(sanitizeRelativePath('..\\secret.txt')).toBeNull();
  });

  it('extracts local assets from HTML correctly', () => {
    const html = `
      <!doctype html>
      <html>
        <head>
          <link rel="stylesheet" href="css/theme.css?v=1" />
          <link rel="icon" href="assets/icon.png" />
          <script src="js/vendor/react.min.js"></script>
          <script src="https://cdn.example.com/other.js"></script>
          <script src="/__papr_sdk.js"></script>
        </head>
        <body>
          <img src="images/logo.svg" alt="logo" />
          <script src="js/main.js"></script>
        </body>
      </html>
    `;
    const assets = extractLocalAssetsFromHtml(html);
    expect(assets).toContain('css/theme.css');
    expect(assets).toContain('assets/icon.png');
    expect(assets).toContain('js/vendor/react.min.js');
    expect(assets).toContain('images/logo.svg');
    expect(assets).toContain('js/main.js');
    expect(assets).not.toContain('https://cdn.example.com/other.js');
    expect(assets).not.toContain('__papr_sdk.js');
  });
});

describe('marketAppInstall download and installation strategies', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Strategy 1: downloads files directly when listing.files is explicitly provided in registry', async () => {
    const listingWithFiles: PaprAppListing = {
      ...mockListing,
      id: 'custom-app',
      directory: 'apps/custom-app',
      files: ['js/vendor/react.min.js', 'js/vendor/react-dom.min.js', 'assets/logo.png'],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('manifest.json')) {
          return { ok: true, status: 200, text: async () => '{"name":"Custom"}' };
        }
        if (u.includes('index.html')) {
          return { ok: true, status: 200, text: async () => '<html>Custom</html>' };
        }
        if (u.includes('js/vendor/react.min.js')) {
          return { ok: true, status: 200, text: async () => '/* react */' };
        }
        if (u.includes('js/vendor/react-dom.min.js')) {
          return { ok: true, status: 200, text: async () => '/* react-dom */' };
        }
        if (u.includes('assets/logo.png')) {
          return { ok: true, status: 200, text: async () => '/* png */' };
        }
        return { ok: false, status: 404 };
      }),
    );

    const downloaded = await downloadAppFiles(listingWithFiles);
    const paths = downloaded.map((f) => f.relativePath);
    expect(paths).toContain('manifest.json');
    expect(paths).toContain('index.html');
    expect(paths).toContain('js/vendor/react.min.js');
    expect(paths).toContain('js/vendor/react-dom.min.js');
    expect(paths).toContain('assets/logo.png');
  });

  it('Strategy 2: parses file list from GitHub git tree response including nested directories', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('api.github.com')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              tree: [
                { path: 'apps/weather-hud/manifest.json', type: 'blob' },
                { path: 'apps/weather-hud/index.html', type: 'blob' },
                { path: 'apps/weather-hud/js/vendor/lib.js', type: 'blob' },
                { path: 'apps/other-app/index.html', type: 'blob' },
              ],
            }),
          };
        }
        return { ok: false, status: 404 };
      }),
    );

    const files = await fetchAppTreeFileList('apps/weather-hud');
    expect(files).toEqual(['manifest.json', 'index.html', 'js/vendor/lib.js']);
  });

  it('Strategy 3: smart HTML asset scanner discovers referenced scripts/styles when GitHub tree fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('api.github.com')) {
          return { ok: false, status: 403 };
        }
        if (u.includes('manifest.json')) {
          return { ok: true, status: 200, text: async () => '{"name":"Weather"}' };
        }
        if (u.includes('index.html')) {
          return {
            ok: true,
            status: 200,
            text: async () => `
              <!doctype html>
              <html>
                <head>
                  <link rel="stylesheet" href="css/theme.css" />
                  <script src="js/vendor/htm.umd.js"></script>
                </head>
                <body>
                  <script src="js/main.js"></script>
                </body>
              </html>
            `,
          };
        }
        if (u.includes('css/theme.css')) {
          return { ok: true, status: 200, text: async () => 'body { color: #000; }' };
        }
        if (u.includes('js/vendor/htm.umd.js')) {
          return { ok: true, status: 200, text: async () => '/* htm */' };
        }
        if (u.includes('js/main.js')) {
          return { ok: true, status: 200, text: async () => 'console.log("ready");' };
        }
        return { ok: false, status: 404 };
      }),
    );

    const downloaded = await downloadAppFiles(mockListing);
    const paths = downloaded.map((f) => f.relativePath);
    expect(paths).toContain('manifest.json');
    expect(paths).toContain('index.html');
    expect(paths).toContain('css/theme.css');
    expect(paths).toContain('js/vendor/htm.umd.js');
    expect(paths).toContain('js/main.js');
  });

  it('validates workspacePath requirement for workspace install', async () => {
    const res = await installMarketApp({
      listing: mockListing,
      scope: 'workspace',
      workspacePath: null,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('工作区');
  });

  it('calls uninstallMarketApp gracefully', async () => {
    const res = await uninstallMarketApp({
      appId: 'weather-hud',
      scope: 'global',
    });
    expect(res.ok).toBe(true);
  });
});

describe('marketAppInstall supply-chain guards', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue('/home/.codepapr/apps/weather-hud');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function sha256Hex(text: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  function stubManifestAndEntry(manifestContent: string) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('api.github.com')) return { ok: false, status: 403 };
        if (u.includes('manifest.json')) {
          return { ok: true, status: 200, text: async () => manifestContent };
        }
        if (u.includes('index.html')) {
          return { ok: true, status: 200, text: async () => '<html>ok</html>' };
        }
        return { ok: false, status: 404 };
      }),
    );
  }

  it('rejects listing.directory that escapes the official repo', async () => {
    await expect(
      downloadAppFiles({ ...mockListing, directory: '../../../evil/repo/main' }),
    ).rejects.toThrow(/不合法|遍历/);
  });

  it('assertOfficialRawUrl blocks cross-repo URLs and allows official ones', () => {
    expect(() =>
      assertOfficialRawUrl('https://raw.githubusercontent.com/evil/repo/main/x.js'),
    ).toThrow(/官方仓库/);
    expect(() =>
      assertOfficialRawUrl('https://raw.githubusercontent.com/mmrqwe/codepapr-apps/main/apps/a/manifest.json'),
    ).not.toThrow();
  });

  it('aborts install when a declared sha256 does not match', async () => {
    stubManifestAndEntry('{"spec":"papr/0.1","name":"Weather"}');
    await expect(
      downloadAppFiles({
        ...mockListing,
        sha256: { 'manifest.json': '00'.repeat(32) },
      }),
    ).rejects.toThrow(/校验和不匹配/);
  });

  it('accepts install when declared sha256 matches', async () => {
    const manifest = '{"spec":"papr/0.1","name":"Weather"}';
    stubManifestAndEntry(manifest);
    const files = await downloadAppFiles({
      ...mockListing,
      sha256: { 'manifest.json': await sha256Hex(manifest) },
    });
    expect(files.map((f) => f.relativePath)).toContain('manifest.json');
  });

  it('assertListingPermissions blocks manifest over-granting vs listing', () => {
    expect(() =>
      assertListingPermissions(
        { ...mockListing, permissions: { local: 'read', network: false } },
        { spec: 'papr/0.1', name: 'X', local: 'write', network: true },
      ),
    ).toThrow(/local/);
    expect(() =>
      assertListingPermissions(
        { ...mockListing, permissions: { local: 'write', network: false } },
        { spec: 'papr/0.1', name: 'X', level: 3 },
      ),
    ).toThrow(/网络|local/);
    expect(() =>
      assertListingPermissions(
        { ...mockListing, permissions: { local: 'write', network: true } },
        { spec: 'papr/0.1', name: 'X', local: 'read', network: false },
      ),
    ).not.toThrow();
    expect(() =>
      assertListingPermissions(mockListing, { spec: 'papr/0.1', name: 'X', local: 'write', network: true }),
    ).not.toThrow();
  });

  it('installMarketApp aborts when manifest over-grants vs listing.permissions', async () => {
    stubManifestAndEntry('{"spec":"papr/0.1","name":"Weather","local":"write","network":true}');
    const res = await installMarketApp({
      listing: { ...mockListing, permissions: { local: 'none', network: false } },
      scope: 'global',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/local|网络/);
    expect(invokeMock).not.toHaveBeenCalledWith('papr_install_app_files', expect.anything());
  });
});

describe('uninstallMarketApp stops the backend process (B3)', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue('');
  });

  it('stops the running backend by pid before removing files', async () => {
    useAppRuntimeStore.setState((state) => ({
      ...state,
      apps: [
        {
          appId: 'weather-hud',
          title: 'Weather HUD',
          html: '',
          filePath: '.CodePapr/apps/weather-hud/index.html',
          command: 'node',
          args: ['server.js'],
          port: 3456,
          pid: 9001,
          url: 'http://127.0.0.1:3456/',
          updatedAt: 0,
          mountSignal: 0,
          scope: 'workspace',
        } as unknown as (typeof state.apps)[number],
      ],
    }));

    const res = await uninstallMarketApp({
      appId: 'weather-hud',
      scope: 'workspace',
      workspacePath: '/tmp/ws',
      purgeData: true,
    });
    expect(res.ok).toBe(true);

    const stopIdx = invokeMock.mock.calls.findIndex(
      ([command, args]) => command === 'stop_background_process' && args?.pid === 9001,
    );
    const uninstallIdx = invokeMock.mock.calls.findIndex(
      ([command]) => command === 'papr_uninstall_app',
    );
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(uninstallIdx).toBeGreaterThanOrEqual(0);
    // 必须先停进程再删文件，否则孤儿进程继续从已删除目录服务旧代码。
    expect(stopIdx).toBeLessThan(uninstallIdx);
  });
});
