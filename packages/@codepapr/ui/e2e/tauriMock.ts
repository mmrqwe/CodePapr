/**
 * Stub the Tauri runtime API surface so the SPA can boot inside a regular
 * Chromium tab driven by Playwright. The real Tauri webview injects
 * `__TAURI_INTERNALS__` before any user script; we replicate enough of it
 * for our `@tauri-apps/api/*` calls and plugin shims to resolve.
 *
 * This script must run via `page.addInitScript(...)` so it lands before
 * the Vite-served app modules execute.
 */
export const tauriMockInitScript = String.raw`
(() => {
  if (window.__TAURI_INTERNALS__) return;

  const noop = () => {};
  const okPromise = (value) => Promise.resolve(value);

  // Map of registered command handlers, keyed by command name.
  const handlers = new Map();

  function registerDefaults() {
    handlers.set('plugin:os|platform', () => 'web-e2e');
    handlers.set('plugin:os|version', () => '0.0.0');
    handlers.set('plugin:dialog|open', () => null);
    handlers.set('plugin:http|fetch', () => ({ status: 200, body: '' }));
    // Boot-time stores expect shaped payloads; null would throw and surface an
    // error toast, breaking the "clean boot" invariant of the e2e suite.
    handlers.set('load_app_characters', () => ({ charactersJson: null }));
    handlers.set('get_external_access_policy', () => ({ yolo: false, allowedDirs: [], allowedFiles: [] }));
  }
  registerDefaults();

  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    plugins: {},
    invoke: (cmd, _args) => {
      const handler = handlers.get(cmd);
      if (handler) {
        try {
          return Promise.resolve(handler(_args));
        } catch (err) {
          return Promise.reject(err);
        }
      }
      // Default: resolve with null so the UI can degrade gracefully.
      return okPromise(null);
    },
    transformCallback: (cb) => {
      if (typeof cb !== 'function') return 0;
      const id = Math.floor(Math.random() * 1e9);
      window['_' + id] = cb;
      return id;
    },
  };

  // Tauri 2 plugin SDKs check for these globals as well.
  window.__TAURI_OS_PLUGIN_INTERNALS__ = {
    platform: 'web-e2e',
    version: '0.0.0',
    family: 'unix',
    arch: 'x86_64',
    hostname: 'e2e',
    locale: 'en-US',
  };

  // Tauri 2 event API unlisten() requires this internals registry.
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {},
  };

  // Some packages eagerly call window.__TAURI__ helpers; provide a stub.
  window.__TAURI__ = window.__TAURI__ ?? { event: { listen: () => Promise.resolve(noop) } };

  // Allow tests to extend or override behaviour at runtime.
  window.__CODEPAPR_E2E__ = {
    setHandler(cmd, handler) { handlers.set(cmd, handler); },
    clearHandler(cmd) { handlers.delete(cmd); },
    listHandlers() { return Array.from(handlers.keys()); },
  };
})();
`;
