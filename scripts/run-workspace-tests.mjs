#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

function sanitizeSpawnEnv(env) {
  const nextEnv = { ...env };
  delete nextEnv.VSCODE_INSPECTOR_OPTIONS;

  const nodeOptions = typeof nextEnv.NODE_OPTIONS === 'string' ? nextEnv.NODE_OPTIONS : '';
  const sanitizedNodeOptions = nodeOptions
    .replace(/\s*--require\s+"[^"]*ms-vscode\.js-debug[^"]*bootloader\.js"/g, '')
    .replace(/\s*--require\s+'[^']*ms-vscode\.js-debug[^']*bootloader\.js'/g, '')
    .replace(/\s*--inspect-publish-uid(?:=\S+|\s+\S+)/g, '')
    .trim();

  if (sanitizedNodeOptions) {
    nextEnv.NODE_OPTIONS = sanitizedNodeOptions;
  } else {
    delete nextEnv.NODE_OPTIONS;
  }

  return nextEnv;
}

function dedupeTestArgs(args) {
  const seen = new Set();
  return args.filter((arg) => {
    if (arg !== '--run') {
      return true;
    }
    if (seen.has(arg)) {
      return false;
    }
    seen.add(arg);
    return true;
  });
}

function resolveNpmInvocation(args) {
  const npmCliCandidates = [
    typeof process.env.npm_execpath === 'string' ? process.env.npm_execpath : '',
    path.resolve(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
  ].filter(Boolean);
  const npmCliPath = npmCliCandidates.find((candidate) => fs.existsSync(candidate));

  if (npmCliPath) {
    return { command: process.execPath, args: [npmCliPath, ...args], shell: false };
  }

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return {
    command: npmCommand,
    args,
    shell: process.platform === 'win32',
  };
}

const forwardedArgs = process.argv.slice(2);
const testArgs = dedupeTestArgs(forwardedArgs.length > 0 ? forwardedArgs : ['--run']);
const invocation = resolveNpmInvocation(['run', 'test', '--workspaces', '--if-present', '--', ...testArgs]);
const child = spawn(invocation.command, invocation.args, {
  stdio: 'inherit',
  shell: invocation.shell,
  env: sanitizeSpawnEnv(process.env),
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});
