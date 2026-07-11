import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { sharedCoverageConfig } from '../../../vitest.shared';

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
    target: process.env.TAURI_PLATFORM === 'windows' ? 'chrome105' : 'safari15',
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
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
    coverage: sharedCoverageConfig,
  },
}));
