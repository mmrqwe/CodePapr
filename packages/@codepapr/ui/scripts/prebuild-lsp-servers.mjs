#!/usr/bin/env node
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  createWriteStream, mkdirSync, existsSync, writeFileSync,
  createReadStream, readdirSync, statSync, copyFileSync, rmSync, cpSync
} from 'fs';
import { finished } from 'stream/promises';
import { execSync, spawnSync } from 'child_process';
import os from 'os';
import zlib from 'zlib';
import https from 'https';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tar = require('tar');
const AdmZip = require('adm-zip');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const GENERATED_DIR = join(__dirname, '..', 'generated', 'lsp-tools');
const NODE_PACKAGES_DIR = join(GENERATED_DIR, 'node-packages');

const NODE_RUNTIME_VERSION = 'v20.12.2';
const CLANGD_VERSION = '22.1.6';
const JAVA_RUNTIME_VERSION = '21';
const JDTLS_DOWNLOAD_URL =
  'https://download.eclipse.org/jdtls/snapshots/jdt-language-server-latest.tar.gz';

const NODE_PACKAGES = [
  'typescript-language-server',
  'typescript',
  'vscode-langservers-extracted',
  'yaml-language-server',
  'pyright',
  'bash-language-server',
];

// ── helpers ──────────────────────────────────────────────────────────

async function downloadFile(url, destination, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const doRequest = (targetUrl) => {
          https
            .get(targetUrl, { headers: { 'User-Agent': 'CodePapr/0.1' } }, (response) => {
              if (
                response.statusCode >= 300 &&
                response.statusCode < 400 &&
                response.headers.location
              ) {
                doRequest(response.headers.location);
                return;
              }
              if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
                reject(new Error(`Failed to download ${targetUrl}: HTTP ${response.statusCode}`));
                return;
              }
              const fileStream = createWriteStream(destination);
              finished(fileStream).then(resolve).catch(reject);
              response.pipe(fileStream);
            })
            .on('error', reject);
        };
        doRequest(url);
      });
      return;
    } catch (err) {
      if (attempt < retries) {
        console.log(`  Download attempt ${attempt} failed (${err.code ?? err.message}), retrying...`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      } else {
        throw err;
      }
    }
  }
}

function getPlatform() {
  const p = os.platform();
  if (p === 'darwin') return 'darwin';
  if (p === 'linux') return 'linux';
  if (p === 'win32') return 'win';
  throw new Error(`Unsupported platform: ${p}`);
}

function getArch() {
  const a = os.arch();
  if (a === 'arm64') return 'arm64';
  if (a === 'x64') return 'x64';
  throw new Error(`Unsupported architecture: ${a}`);
}

function copyDirRecursive(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

function rmDirRecursive(dir) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

// ── extraction ───────────────────────────────────────────────────────

async function extractTarGz(filePath, targetDir) {
  mkdirSync(targetDir, { recursive: true });
  await tar.extract({ file: filePath, cwd: targetDir, strip: 1 });
}

async function extractTarGzKeepRoot(filePath, targetDir) {
  const staging = join(GENERATED_DIR, `.stage-${Date.now()}`);
  mkdirSync(staging, { recursive: true });
  await tar.extract({ file: filePath, cwd: staging });
  // tar may extract into a single top-level directory
  const entries = readdirSync(staging);
  if (entries.length === 1) {
    const single = join(staging, entries[0]);
    if (statSync(single).isDirectory()) {
      mkdirSync(targetDir, { recursive: true });
      rmDirRecursive(targetDir);
      copyDirRecursive(single, targetDir);
      rmDirRecursive(staging);
      return;
    }
  }
  mkdirSync(targetDir, { recursive: true });
  rmDirRecursive(targetDir);
  copyDirRecursive(staging, targetDir);
  rmDirRecursive(staging);
}

async function extractZip(filePath, targetDir) {
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries();
  mkdirSync(targetDir, { recursive: true });

  if (entries.length === 0) return;

  const rootDir = entries[0].entryName.split('/')[0];
  const allInRoot = entries.every((e) => e.entryName.startsWith(rootDir + '/'));

  if (allInRoot && entries.length > 1) {
    const staging = join(GENERATED_DIR, `.stage-zip-${Date.now()}`);
    zip.extractAllTo(staging, true);
    const extractedDir = join(staging, rootDir);
    if (existsSync(extractedDir)) {
      rmDirRecursive(targetDir);
      copyDirRecursive(extractedDir, targetDir);
    }
    rmDirRecursive(staging);
  } else {
    zip.extractAllTo(targetDir, true);
  }
}

// ── download + install steps ─────────────────────────────────────────

async function downloadNodeRuntime() {
  const platform = getPlatform();
  const arch = getArch();
  const nodePlatform = platform;
  const nodeArch = arch;

  let extension, extractFn;
  if (nodePlatform === 'win') {
    extension = 'zip';
    extractFn = extractZip;
  } else if (nodePlatform === 'linux') {
    extension = 'tar.xz';
    extractFn = extractTarGz; // tar module handles .tar.xz transparently
  } else {
    extension = 'tar.gz';
    extractFn = extractTarGz;
  }

  const url = `https://nodejs.org/dist/${NODE_RUNTIME_VERSION}/node-${NODE_RUNTIME_VERSION}-${nodePlatform}-${nodeArch}.${extension}`;
  const tempFile = join(GENERATED_DIR, `node-${NODE_RUNTIME_VERSION}.${extension}`);
  const targetDir = join(GENERATED_DIR, 'node-runtime');

  if (existsSync(targetDir) && existsSync(join(targetDir, os.platform() === 'win32' ? 'node.exe' : 'bin/node'))) {
    console.log(`Node.js ${NODE_RUNTIME_VERSION} already exists, skipping download.`);
    return targetDir;
  }

  console.log(`Downloading Node.js ${NODE_RUNTIME_VERSION}...`);
  await downloadFile(url, tempFile);

  console.log(`Extracting Node.js...`);
  mkdirSync(targetDir, { recursive: true });
  await extractFn(tempFile, targetDir);

  // Clean up archive
  try { rmSync(tempFile, { force: true }); } catch {}
  return targetDir;
}

async function installNodePackages(nodeRuntimeDir) {
  mkdirSync(NODE_PACKAGES_DIR, { recursive: true });

  const packageJsonPath = join(NODE_PACKAGES_DIR, 'package.json');
  if (!existsSync(packageJsonPath)) {
    writeFileSync(
      packageJsonPath,
      JSON.stringify({ name: 'codepapr-managed-node-packages', private: true }, null, 2)
    );
  }

  // Check if all packages already installed
  const allInstalled = NODE_PACKAGES.every((pkg) =>
    existsSync(join(NODE_PACKAGES_DIR, 'node_modules', pkg, 'package.json'))
  );
  if (allInstalled) {
    console.log('Node LSP packages already installed, skipping.');
    return;
  }

  let nodePath, npmCli;
  if (os.platform() === 'win32') {
    nodePath = join(nodeRuntimeDir, 'node.exe');
    npmCli = join(nodeRuntimeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!existsSync(npmCli)) {
      npmCli = join(nodeRuntimeDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    }
  } else {
    nodePath = join(nodeRuntimeDir, 'bin', 'node');
    npmCli = join(nodeRuntimeDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!existsSync(npmCli)) {
      npmCli = join(nodeRuntimeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    }
  }

  if (!existsSync(nodePath)) {
    throw new Error(`Node executable not found at ${nodePath}`);
  }

  console.log(`Installing Node packages: ${NODE_PACKAGES.join(', ')}...`);

  if (existsSync(npmCli)) {
    const result = spawnSync(
      nodePath,
      [npmCli, 'install', '--no-audit', '--no-fund', '--omit=dev', ...NODE_PACKAGES],
      { cwd: NODE_PACKAGES_DIR, stdio: 'inherit', shell: true }
    );
    if (result.status !== 0) {
      throw new Error(`npm install failed with code ${result.status}`);
    }
  } else {
    const result = spawnSync(
      'npm',
      ['install', '--no-audit', '--no-fund', '--omit=dev', ...NODE_PACKAGES],
      { cwd: NODE_PACKAGES_DIR, stdio: 'inherit', shell: true }
    );
    if (result.status !== 0) {
      throw new Error(`npm install failed with code ${result.status}`);
    }
  }

  // Prune deeply nested paths that cause NSIS bundling failures on Windows
  pruneDeepPaths(NODE_PACKAGES_DIR);
}

function pruneDeepPaths(baseDir) {
  const pruneTargets = [
    // pyright typeshed-fallback contains deeply nested stubs (>260 char paths on Windows)
    join(baseDir, 'node_modules', 'pyright', 'dist', 'typeshed-fallback'),
  ];

  for (const target of pruneTargets) {
    if (existsSync(target)) {
      console.log(`Pruning deep path: ${target}`);
      rmDirRecursive(target);
    }
  }
}

async function downloadClangd() {
  const platform = getPlatform();
  const clangdPlatform = platform === 'win' ? 'windows' : platform === 'darwin' ? 'mac' : 'linux';
  const targetDir = join(GENERATED_DIR, 'clangd');

  if (existsSync(join(targetDir, 'bin', os.platform() === 'win32' ? 'clangd.exe' : 'clangd'))) {
    console.log(`clangd ${CLANGD_VERSION} already exists, skipping download.`);
    return targetDir;
  }

  const url = `https://github.com/clangd/clangd/releases/download/${CLANGD_VERSION}/clangd-${clangdPlatform}-${CLANGD_VERSION}.zip`;
  const tempFile = join(GENERATED_DIR, `clangd-${CLANGD_VERSION}.zip`);

  console.log(`Downloading clangd ${CLANGD_VERSION}...`);
  await downloadFile(url, tempFile);

  console.log(`Extracting clangd...`);
  await extractZip(tempFile, targetDir);

  try { rmSync(tempFile, { force: true }); } catch {}
  return targetDir;
}

async function downloadJavaRuntime() {
  const platform = getPlatform();
  const arch = getArch();
  const javaPlatform = platform === 'win' ? 'windows' : platform === 'darwin' ? 'mac' : 'linux';
  const javaArch = arch === 'arm64' ? 'aarch64' : 'x64';
  const targetDir = join(GENERATED_DIR, 'java', 'jre');

  const javaExe = os.platform() === 'win32'
    ? join(targetDir, 'bin', 'java.exe')
    : join(targetDir, 'bin', 'java');
  if (existsSync(javaExe)) {
    console.log(`Java Runtime ${JAVA_RUNTIME_VERSION} already exists, skipping download.`);
    return targetDir;
  }

  const extension = javaPlatform === 'windows' ? 'zip' : 'tar.gz';
  const url = `https://api.adoptium.net/v3/binary/latest/${JAVA_RUNTIME_VERSION}/ga/${javaPlatform}/${javaArch}/jre/hotspot/normal/eclipse`;
  const tempFile = join(GENERATED_DIR, `java-runtime.${extension}`);

  console.log(`Downloading Java Runtime ${JAVA_RUNTIME_VERSION}...`);
  await downloadFile(url, tempFile);

  console.log(`Extracting Java Runtime...`);
  mkdirSync(targetDir, { recursive: true });
  if (extension === 'zip') {
    await extractZip(tempFile, targetDir);
  } else {
    await extractTarGzKeepRoot(tempFile, targetDir);
  }

  try { rmSync(tempFile, { force: true }); } catch {}
  return targetDir;
}

async function downloadJdtls() {
  const targetDir = join(GENERATED_DIR, 'java', 'jdtls');

  if (existsSync(join(targetDir, 'plugins'))) {
    console.log('JDTLS already exists, skipping download.');
    return targetDir;
  }

  const tempFile = join(GENERATED_DIR, 'jdtls.tar.gz');

  console.log('Downloading JDTLS...');
  await downloadFile(JDTLS_DOWNLOAD_URL, tempFile);

  console.log('Extracting JDTLS...');
  mkdirSync(targetDir, { recursive: true });
  await extractTarGzKeepRoot(tempFile, targetDir);

  try { rmSync(tempFile, { force: true }); } catch {}
  return targetDir;
}

// ── main ─────────────────────────────────────────────────────────────

async function main() {
  console.log('Prebuilding LSP servers...');
  console.log(`Output directory: ${GENERATED_DIR}`);
  mkdirSync(GENERATED_DIR, { recursive: true });

  try {
    const nodeRuntimeDir = await downloadNodeRuntime();
    await installNodePackages(nodeRuntimeDir);
    await downloadClangd();
    await downloadJavaRuntime();
    await downloadJdtls();

    console.log('\nLSP servers prebuilt successfully!');
  } catch (error) {
    console.error('Failed to prebuild LSP servers:', error);
    process.exit(1);
  }
}

main();
