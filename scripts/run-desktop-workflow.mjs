#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const uiDir = path.resolve(repoRoot, 'packages/@codepapr/ui');
const workflow = process.argv[2];
const extraArgs = process.argv.slice(3);

if (!workflow) {
  console.error('Missing desktop workflow name');
  process.exit(1);
}

const BOOTSTRAP_ENV_KEY = 'CODEPAPR_DESKTOP_BOOTSTRAPPED';

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

function uniquePaths(entries) {
  const seen = new Set();
  const ordered = [];
  for (const entry of entries) {
    if (!entry) {
      continue;
    }
    const normalized = process.platform === 'win32' ? entry.toLowerCase() : entry;
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    ordered.push(entry);
  }
  return ordered;
}

function prependToPath(dirPath) {
  if (!dirPath) {
    return;
  }
  const currentPath = typeof process.env.PATH === 'string' ? process.env.PATH : '';
  const segments = currentPath ? currentPath.split(path.delimiter) : [];
  process.env.PATH = uniquePaths([dirPath, ...segments]).join(path.delimiter);
}

function resolveExecutable(executable) {
  const pathExts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  const hasPathSeparator = executable.includes(path.sep) || (path.posix.sep !== path.sep && executable.includes(path.posix.sep));
  const candidateDirs = hasPathSeparator
    ? ['']
    : ((typeof process.env.PATH === 'string' ? process.env.PATH : '').split(path.delimiter).filter(Boolean));

  for (const dirPath of candidateDirs) {
    const basePath = dirPath ? path.join(dirPath, executable) : executable;
    const candidates = process.platform === 'win32' && path.extname(basePath) === ''
      ? [basePath, ...pathExts.map((ext) => `${basePath}${ext}`)]
      : [basePath];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function resolveNpmInvocation(args) {
  const npmCliCandidates = [
    typeof process.env.npm_execpath === 'string' ? process.env.npm_execpath : '',
    path.resolve(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
  ].filter(Boolean);
  const npmCliPath = npmCliCandidates.find((candidate) => fs.existsSync(candidate));

  if (npmCliPath) {
    return { command: process.execPath, args: [npmCliPath, ...args] };
  }

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return {
    command: npmCommand,
    args,
    shell: process.platform === 'win32',
  };
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      stdio: options.stdio ?? 'inherit',
      shell: options.shell ?? false,
      env: sanitizeSpawnEnv(options.env ?? process.env),
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited due to signal ${signal}`));
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

/** Hide the auto-generated .VolumeIcon.icns file inside the DMG bundle so
 *  the icon is still used as the volume's icon, but the file itself doesn't
 *  show up in Finder. This logic now lives in
 *  packages/@codepapr/ui/scripts/tauri-cli.mjs (hideDmgVolumeIcons) and runs
 *  before the DMG is staged into Release/. */

async function runNpm(args, cwd, envOverride) {
  const invocation = resolveNpmInvocation(args);
  await runCommand(invocation.command, invocation.args, {
    cwd,
    shell: invocation.shell,
    env: envOverride ?? process.env,
  });
}

async function downloadFileWindows(url, outputPath) {
  await runCommand('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '${url}' -OutFile '${outputPath.replace(/'/g, "''")}'`,
  ]);
}

async function ensureNodeDependencies() {
  const requiredPackages = [
    path.resolve(repoRoot, 'node_modules/typescript/package.json'),
    path.resolve(repoRoot, 'node_modules/@tauri-apps/cli/package.json'),
  ];

  if (requiredPackages.every((packagePath) => fs.existsSync(packagePath))) {
    return;
  }

  console.log('[desktop-workflow] Installing workspace npm dependencies...');
  await runNpm(['install'], repoRoot);
}

function resolveCargoExecutable() {
  const candidates = [
    resolveExecutable(process.platform === 'win32' ? 'cargo.exe' : 'cargo'),
    path.resolve(os.homedir(), '.cargo/bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo'),
  ].filter(Boolean);
  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  if (resolved) {
    prependToPath(path.dirname(resolved));
    return resolved;
  }
  return null;
}

function resolveRustupExecutable() {
  const commandName = process.platform === 'win32' ? 'rustup.exe' : 'rustup';
  const candidates = [
    resolveExecutable(commandName),
    path.resolve(os.homedir(), '.cargo/bin', commandName),
    path.resolve(os.homedir(), '.cargo/bin', process.platform === 'win32' ? 'rustup-init.exe' : 'rustup-init'),
  ].filter(Boolean);
  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  if (resolved) {
    prependToPath(path.dirname(resolved));
    return resolved;
  }
  return null;
}

function resolveRustcExecutable() {
  const candidates = [
    resolveExecutable(process.platform === 'win32' ? 'rustc.exe' : 'rustc'),
    path.resolve(os.homedir(), '.cargo/bin', process.platform === 'win32' ? 'rustc.exe' : 'rustc'),
  ].filter(Boolean);
  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  if (resolved) {
    prependToPath(path.dirname(resolved));
    return resolved;
  }
  return null;
}

async function runWithRetries(actionLabel, attempts, fn) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fn(attempt);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        console.warn(`[desktop-workflow] ${actionLabel} failed (attempt ${attempt}/${attempts}), retrying...`);
      }
    }
  }

  throw lastError;
}

function cleanupBrokenRustToolchain(stableSpecifier) {
  const rustupHome = process.env.RUSTUP_HOME
    ? path.resolve(process.env.RUSTUP_HOME)
    : path.resolve(os.homedir(), '.rustup');
  const toolchainDir = path.resolve(rustupHome, 'toolchains', stableSpecifier);
  const downloadsDir = path.resolve(rustupHome, 'downloads');

  fs.rmSync(toolchainDir, { recursive: true, force: true });

  if (fs.existsSync(downloadsDir)) {
    for (const name of fs.readdirSync(downloadsDir)) {
      if (!name.endsWith('.partial')) {
        continue;
      }
      fs.rmSync(path.join(downloadsDir, name), { force: true });
    }
  }
}

async function hasUsableRustToolchain() {
  const cargo = resolveCargoExecutable();
  const rustc = resolveRustcExecutable();
  if (!cargo || !rustc) {
    return false;
  }

  try {
    await runCommand(cargo, ['-V'], { stdio: 'ignore' });
    await runCommand(rustc, ['-vV'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function ensureStableRustToolchainSelected() {
  const rustup = resolveRustupExecutable();
  if (!rustup) {
    return false;
  }

  const stableToolchain = (() => {
    if (process.platform === 'win32') {
      const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
      return `${arch}-pc-windows-msvc`;
    }
    if (process.platform === 'darwin') {
      const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
      return `${arch}-apple-darwin`;
    }
    return 'stable';
  })();
  const stableSpecifier = stableToolchain === 'stable' ? 'stable' : `stable-${stableToolchain}`;

  console.log('[desktop-workflow] Ensuring stable Rust toolchain is initialized...');
  await runWithRetries('Rust toolchain install', 3, async (attempt) => {
    if (attempt > 1) {
      cleanupBrokenRustToolchain(stableSpecifier);
    }

    await runCommand(rustup, ['toolchain', 'install', stableSpecifier, '--profile', 'minimal']);
  });
  await runCommand(rustup, ['default', stableSpecifier]);
  return true;
}

function resolveDotnetExecutable() {
  const candidates = [
    resolveExecutable(process.platform === 'win32' ? 'dotnet.exe' : 'dotnet'),
    path.resolve(process.env.ProgramFiles || 'C:/Program Files', 'dotnet', 'dotnet.exe'),
    path.resolve(os.homedir(), '.dotnet', process.platform === 'win32' ? 'dotnet.exe' : 'dotnet'),
    '/usr/local/share/dotnet/dotnet',
    '/opt/homebrew/share/dotnet/dotnet',
  ].filter(Boolean);
  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  if (resolved) {
    prependToPath(path.dirname(resolved));
    return resolved;
  }
  return null;
}

async function installRustToolchain() {
  if (process.platform === 'win32') {
    const installerPath = path.resolve(os.tmpdir(), 'codepapr-rustup-init.exe');
    console.log('[desktop-workflow] Downloading rustup-init...');
    await downloadFileWindows(
      'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe',
      installerPath,
    );
    console.log('[desktop-workflow] Installing Rust toolchain via rustup-init...');
    await runCommand(installerPath, ['-y', '--default-toolchain', 'stable', '--profile', 'minimal']);
    return;
  }

  if (process.platform === 'darwin') {
    const cargo = resolveCargoExecutable();
    if (cargo) {
      return;
    }

    const xcodeSelect = resolveExecutable('xcode-select');
    if (xcodeSelect) {
      try {
        await runCommand(xcodeSelect, ['-p'], { stdio: 'ignore' });
      } catch {
        console.log('[desktop-workflow] Requesting Xcode Command Line Tools installation...');
        try {
          await runCommand(xcodeSelect, ['--install']);
        } catch {
          // The installer may already be in progress.
        }
        throw new Error('Xcode Command Line Tools are required. Installation was triggered; rerun after it completes.');
      }
    }

    const rustup = resolveRustupExecutable();
    if (rustup) {
      await ensureStableRustToolchainSelected();
      return;
    }

    const installerPath = path.resolve(os.tmpdir(), 'codepapr-rustup-init.sh');
    console.log('[desktop-workflow] Downloading Rustup installer...');
    await runCommand('curl', ['-fsSL', 'https://sh.rustup.rs', '-o', installerPath]);
    await runCommand('sh', [installerPath, '-y', '--profile', 'minimal']);
    return;
  }

  throw new Error(`Automatic Rust installation is not implemented for ${process.platform}.`);
}

async function installDotnetSdk() {
  if (process.platform === 'win32') {
    const installerPath = path.resolve(os.tmpdir(), 'codepapr-dotnet-install.ps1');
    const installDir = path.resolve(os.homedir(), '.dotnet');
    console.log('[desktop-workflow] Downloading .NET SDK installer...');
    await downloadFileWindows('https://dot.net/v1/dotnet-install.ps1', installerPath);
    console.log('[desktop-workflow] Installing .NET SDK...');
    await runCommand('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      installerPath,
      '-Channel',
      '10.0',
      '-InstallDir',
      installDir,
    ]);
    prependToPath(installDir);
    return;
  }

  if (process.platform === 'darwin') {
    const installerPath = path.resolve(os.tmpdir(), 'codepapr-dotnet-install.sh');
    console.log('[desktop-workflow] Downloading .NET SDK installer...');
    await runCommand('curl', ['-fsSL', 'https://dot.net/v1/dotnet-install.sh', '-o', installerPath]);
    await runCommand('bash', [installerPath, '--channel', '10.0']);
    prependToPath(path.resolve(os.homedir(), '.dotnet'));
    return;
  }

  throw new Error(`Automatic .NET SDK installation is not implemented for ${process.platform}.`);
}

async function ensureRustToolchain() {
  if (await hasUsableRustToolchain()) {
    return;
  }

  if (resolveRustupExecutable()) {
    await ensureStableRustToolchainSelected();
    if (await hasUsableRustToolchain()) {
      return;
    }
  }

  await installRustToolchain();

  if (!(await hasUsableRustToolchain())) {
    throw new Error('Rust toolchain installation did not produce a usable cargo/rustc. Check network/proxy access to static.rust-lang.org and rerun.');
  }
}

async function ensureDotnetSdk() {
  if (resolveDotnetExecutable()) {
    return;
  }

  await installDotnetSdk();

  if (!resolveDotnetExecutable()) {
    throw new Error('.NET SDK installation finished, but dotnet is still unavailable.');
  }
}

async function ensureNoLockedCodePaprExecutable() {
  if (process.platform !== 'win32') {
    return;
  }

  try {
    await runCommand('taskkill', ['/F', '/IM', 'codepapr.exe', '/T'], { stdio: 'ignore' });
  } catch {
    // Ignore if codepapr.exe is not currently running.
  }
}

const workflows = {
  'root-debug': {
    needsRust: true,
    needsDotnet: false,
    run: () => runNpm(['run', 'debug', '--workspace=@codepapr/ui'], repoRoot),
  },
  'root-release': {
    needsRust: true,
    needsDotnet: true,
    run: () => runNpm(['run', 'release:run', '--workspace=@codepapr/ui'], repoRoot),
  },
  'root-publish': {
    needsRust: true,
    needsDotnet: true,
    run: () => runNpm(['run', 'release:desktop'], repoRoot),
  },
  'root-check-tauri': {
    needsRust: true,
    needsDotnet: false,
    run: () => runCommand('cargo', ['check', '--manifest-path', 'packages/@codepapr/ui/src-tauri/Cargo.toml', '--all'], { cwd: repoRoot }),
  },
  'ui-tauri': {
    needsRust: true,
    needsDotnet: false,
    run: () => runCommand(process.execPath, [path.resolve(uiDir, 'scripts/tauri-cli.mjs'), ...extraArgs], { cwd: uiDir }),
  },
  'ui-debug': {
    needsRust: true,
    needsDotnet: false,
    run: () => runCommand(process.execPath, [path.resolve(uiDir, 'scripts/tauri-cli.mjs'), 'dev', ...extraArgs], { cwd: uiDir }),
  },
  'ui-release-dev': {
    needsRust: true,
    needsDotnet: true,
    run: () => runCommand(process.execPath, [path.resolve(uiDir, 'scripts/tauri-cli.mjs'), 'dev', '--release', ...extraArgs], { cwd: uiDir }),
  },
  'ui-release-run': {
    needsRust: true,
    needsDotnet: true,
    run: async () => {
      await ensureNoLockedCodePaprExecutable();
      await runCommand(process.execPath, [path.resolve(uiDir, 'scripts/release-run.mjs'), ...extraArgs], { cwd: uiDir });
    },
  },
  'ui-build-tauri': {
    needsRust: true,
    needsDotnet: true,
    run: async () => {
      await ensureNoLockedCodePaprExecutable();
      await runCommand(process.execPath, [path.resolve(uiDir, 'scripts/tauri-cli.mjs'), 'build', ...extraArgs], { cwd: uiDir });
    },
  },
};

const selectedWorkflow = workflows[workflow];
if (!selectedWorkflow) {
  console.error(`Unknown desktop workflow: ${workflow}`);
  process.exit(1);
}

if (process.env[BOOTSTRAP_ENV_KEY] !== '1') {
  await ensureNodeDependencies();
  if (selectedWorkflow.needsRust) {
    await ensureRustToolchain();
  }
  if (selectedWorkflow.needsDotnet) {
    await ensureDotnetSdk();
  }
}

process.env[BOOTSTRAP_ENV_KEY] = '1';

try {
  await selectedWorkflow.run();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}