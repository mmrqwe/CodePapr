#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = process.cwd();
const distDir = path.join(cwd, 'dist');

fs.rmSync(distDir, { recursive: true, force: true });

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const runModuleBin = path.join(scriptDir, 'run-module-bin.mjs');
const tscArgs = ['typescript/bin/tsc', ...process.argv.slice(2)];

const child = spawn(process.execPath, [runModuleBin, ...tscArgs], {
  cwd,
  env: process.env,
  stdio: 'inherit',
});

child.on('close', (code) => {
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
