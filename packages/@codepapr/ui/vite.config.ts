import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { sharedCoverageConfig, sharedTestExclude } from '../../../vitest.shared';

const tauriDebugRaw = process.env.TAURI_ENV_DEBUG ?? process.env.TAURI_DEBUG;
const isTauriDebug = tauriDebugRaw === 'true' || tauriDebugRaw === '1';

export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    // Tauri 2 CLI 注入 TAURI_ENV_PLATFORM / TAURI_ENV_DEBUG（值为 "true"/"false"
    // 字符串，必须显式比较；旧名仅作回退）
    target: (process.env.TAURI_ENV_PLATFORM ?? process.env.TAURI_PLATFORM) === 'windows'
      ? 'chrome105'
      : 'safari15',
    minify: isTauriDebug ? false : 'esbuild',
    sourcemap: isTauriDebug,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('monaco-editor')) {
            return 'monaco-editor';
          }
          if (id.includes('/node_modules/typescript/')) {
            return 'workspace-project-map-typescript';
          }
          if (id.includes('node_modules')) {
            return 'vendor';
          }
          return undefined;
        },
      },
    },
  },
  test: {
    exclude: [...sharedTestExclude],
    coverage: sharedCoverageConfig,
  },
}));
