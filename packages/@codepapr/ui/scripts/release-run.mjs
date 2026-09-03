#!/usr/bin/env node

import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(uiDir, '../../..');
const tauriCliScript = path.resolve(scriptDir, 'tauri-cli.mjs');

function resolveCargoTargetDir() {
  if (process.env.CARGO_TARGET_DIR) {
    return path.resolve(process.env.CARGO_TARGET_DIR);
  }
  return path.resolve(repoRoot, 'target');
}

const cargoTargetDir = resolveCargoTargetDir();
const macOsAppBundlePath = path.join(cargoTargetDir, 'release/bundle/macos/CodePapr.app');
const releaseBinaryPath = path.join(
  cargoTargetDir,
  process.platform === 'win32' ? 'release/codepapr.exe' : 'release/codepapr'
);

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmCliCandidatePaths = [
  typeof process.env.npm_execpath === 'string' ? process.env.npm_execpath : '',
  path.resolve(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
].filter(Boolean);

function resolveNpmInvocation() {
  if (process.platform !== 'win32') {
    return { command: npmCommand, args: ['run', 'build'] };
  }

  const npmCliPath = npmCliCandidatePaths.find((candidate) => fs.existsSync(candidate));
  if (npmCliPath) {
    return { command: process.execPath, args: [npmCliPath, 'run', 'build'] };
  }

  return { command: npmCommand, args: ['run', 'build'], shell: true };
}

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

function runCommand(command, args, cwd, extraOptions = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: sanitizeSpawnEnv(process.env),
      stdio: 'inherit',
      ...extraOptions,
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }

      if ((code ?? 1) !== 0) {
        reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code ?? 1}`));
        return;
      }

      resolve();
    });
  });
}

console.log('[release-run] Rebuilding workspace packages and frontend bundle...');
const npmBuildInvocation = resolveNpmInvocation();
await runCommand(
  npmBuildInvocation.command,
  npmBuildInvocation.args,
  repoRoot,
  npmBuildInvocation.shell ? { shell: npmBuildInvocation.shell } : undefined
);

console.log('[release-run] Building release desktop app bundle...');
await runCommand(
  process.execPath,
  process.platform === 'darwin'
    ? [tauriCliScript, 'build', '--bundles', 'app']
    : [tauriCliScript, 'build'],
  uiDir
);

if (process.platform === 'darwin') {
  if (!fs.existsSync(macOsAppBundlePath)) {
    throw new Error(`Expected app bundle not found: ${macOsAppBundlePath}`);
  }

  console.log(`[release-run] Opening ${macOsAppBundlePath}...`);
  await runCommand('open', ['-n', macOsAppBundlePath], uiDir);
} else {
  if (!fs.existsSync(releaseBinaryPath)) {
    throw new Error(`Expected release binary not found: ${releaseBinaryPath}`);
  }

  console.log(`[release-run] Launching ${releaseBinaryPath}...`);
  await runCommand(releaseBinaryPath, [], uiDir);
}
