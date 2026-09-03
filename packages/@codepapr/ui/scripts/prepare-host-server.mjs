#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(uiDir, '../../..');
const srcTauriDir = path.join(uiDir, 'src-tauri');
const binariesDir = path.join(srcTauriDir, 'binaries');
const manifestPath = path.join(srcTauriDir, 'Cargo.toml');
const profile = process.argv.includes('--debug') ? 'debug' : 'release';

function rustcHostTriple() {
  const output = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  const match = output.match(/^host:\s*(.+)$/m);
  if (!match) {
    throw new Error('Could not determine rustc host triple');
  }
  return match[1].trim();
}

function cargoTargetDir() {
  const output = execSync(
    `cargo metadata --format-version 1 --no-deps --manifest-path ${JSON.stringify(manifestPath)}`,
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const metadata = JSON.parse(output);
  if (typeof metadata.target_directory !== 'string' || !metadata.target_directory.trim()) {
    throw new Error('cargo metadata did not return target_directory');
  }
  return metadata.target_directory;
}

const exeName = process.platform === 'win32' ? 'codepapr-server.exe' : 'codepapr-server';
const triple = rustcHostTriple();
const destName = process.platform === 'win32'
  ? `codepapr-server-${triple}.exe`
  : `codepapr-server-${triple}`;

const cargoArgs = ['build', '-p', 'codepapr-server'];
if (profile === 'release') {
  cargoArgs.push('--release');
}

console.log(`[host-server] Building codepapr-server (${profile}) for ${triple}...`);
execFileSync('cargo', cargoArgs, { cwd: repoRoot, stdio: 'inherit' });

const source = path.join(cargoTargetDir(), profile, exeName);
if (!fs.existsSync(source)) {
  throw new Error(`Expected host server binary at ${source}`);
}

fs.mkdirSync(binariesDir, { recursive: true });
const destination = path.join(binariesDir, destName);
fs.copyFileSync(source, destination);
if (process.platform !== 'win32') {
  fs.chmodSync(destination, 0o755);
}

console.log(`[host-server] Staged ${destination}`);
