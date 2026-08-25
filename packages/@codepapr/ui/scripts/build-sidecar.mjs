#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(uiDir, 'src/agent/agentRuntime.sidecar.ts');
const outfile = path.join(uiDir, 'dist-sidecar/agent-runtime.mjs');

await esbuild.build({
  absWorkingDir: uiDir,
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
});

console.error(`[sidecar] wrote ${outfile}`);
