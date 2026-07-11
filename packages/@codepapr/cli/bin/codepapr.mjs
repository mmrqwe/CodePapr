#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const entrypoint = path.resolve(__dirname, '../dist/index.js');
const loaderRegister = path.resolve(__dirname, './register-loader.mjs');
const loaderRegisterUrl = pathToFileURL(loaderRegister).href;

const child = spawn(
  process.execPath,
  ['--import', loaderRegisterUrl, entrypoint, ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: process.env,
  }
);

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
