#!/usr/bin/env node
import { fileURLToPath } from 'url';
import { dirname, join, resolve, sep } from 'path';
import {
  createWriteStream, mkdirSync, existsSync, writeFileSync, readFileSync,
  createReadStream, readdirSync, statSync, copyFileSync, rmSync, cpSync
} from 'fs';
import { finished } from 'stream/promises';
import { execSync, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import os from 'os';
import zlib from 'zlib';
import https from 'https';
import { createRequire } from 'module';
import { unzipSync } from 'fflate';

const require = createRequire(import.meta.url);
const tar = require('tar');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const GENERATED_DIR = join(__dirname, '..', 'generated', 'lsp-tools');
const NODE_PACKAGES_DIR = join(GENERATED_DIR, 'node-packages');

const NODE_RUNTIME_VERSION = 'v20.12.2';
const CLANGD_VERSION = '22.1.6';
const JAVA_RUNTIME_VERSION = '21.0.12.1';
// 钉死到 milestone 版本：快照 URL（jdt-language-server-latest）浮动且无法锁定哈希。
// 与运行时下载共用同一 URL（src/lsp_managed_tools.rs JDTLS_DOWNLOAD_URL）与同一
// 锁定哈希（src/download_verification.rs），升级时三处同步。
const JDTLS_VERSION = '1.54.0';
const JDTLS_DOWNLOAD_URL =
  'https://download.eclipse.org/jdtls/milestones/1.54.0/jdt-language-server-1.54.0-202511261751.tar.gz';

// 与 src/lsp_managed_tools.rs 的托管安装语义一致：钉死版本，禁止 latest 浮动。
// 升级任一包时同步更新版本号；完整性由 npm 的 registry 签名 + 本清单兜底。
const NODE_PACKAGES = [
  { name: 'typescript-language-server', version: '5.3.0' },
  { name: 'typescript', version: '5.9.3' },
  { name: 'vscode-langservers-extracted', version: '4.10.0' },
  { name: 'yaml-language-server', version: '1.23.0' },
  { name: 'pyright', version: '1.1.410' },
  { name: 'bash-language-server', version: '5.6.0' },
];

// ── 锁定校验和清单 ────────────────────────────────────────────────────
// 标准与 src-tauri/src/download_verification.rs 一致：钉死版本 + 锁定哈希，
// 哈希不匹配一律硬错误。升级工具版本时必须同步更新此表
// （哈希可由 `shasum -a 256 <文件>` 计算）。

// Temurin 21 JRE：release 钉死为 21.0.12.1+1，URL/哈希取自
// api.adoptium.net 官方 asset 元数据（2026-08-23 抓取）。
// Windows ARM64 无 21.0.12.1 构建，钉到同大版本最新构建 21.0.12+8。
const TEMURIN_JRE_DOWNLOADS = {
  'mac-arm64': {
    url: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jre_aarch64_mac_hotspot_21.0.12.1_1.tar.gz',
    sha256: 'dec50fc6f9fcd4fe3ae8cabf5a5fa68f6afc48841f7698e468e9aa5d54beed84',
  },
  'mac-x64': {
    url: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jre_x64_mac_hotspot_21.0.12.1_1.tar.gz',
    sha256: '6717ec641fd9ce0bb209ca083ee23b42202ac68cb6fcc5753496e0e4a0f41989',
  },
  'linux-arm64': {
    url: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jre_aarch64_linux_hotspot_21.0.12.1_1.tar.gz',
    sha256: '14be1f35ebdbd1f6e8d57eb911a3ffb74d6d9aa255abc5daf2b1302002cf2cf2',
  },
  'linux-x64': {
    url: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jre_x64_linux_hotspot_21.0.12.1_1.tar.gz',
    sha256: '2413149700df0f7d440500a84a8f764c535f21e5a5e87d38328b64eec2c5b500',
  },
  'win-x64': {
    url: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jre_x64_windows_hotspot_21.0.12.1_1.zip',
    sha256: 'd35f31e712f0fcf6ac5a093edc90204fbff22f720ba3950bd09d331d5e621636',
  },
  'win-arm64': {
    url: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12%2B8/OpenJDK21U-jre_aarch64_windows_hotspot_21.0.12_8.zip',
    sha256: 'a50ed83b6a88d3127d406713f5057d78f845c3412d59e201dac6db37714af85c',
  },
};

// 其余下载按「完整 URL → sha256」锁定。
const PINNED_CHECKSUMS = {
  // Node.js v20.12.2（官方来源：nodejs.org SHASUMS256.txt）
  'https://nodejs.org/dist/v20.12.2/node-v20.12.2-darwin-arm64.tar.gz':
    '98eb624b52efec2530079e1d11296ec0ac20771b94b087d21649250339cf5332',
  'https://nodejs.org/dist/v20.12.2/node-v20.12.2-darwin-x64.tar.gz':
    'cd5e9a80a38ccffc036a87b232a5402339c7bf8fa9a494ae0731a1a671687718',
  'https://nodejs.org/dist/v20.12.2/node-v20.12.2-linux-arm64.tar.xz':
    'b5fc7983fb9506b8c3de53dfa85ff63f9f49cedc94984e29e4c89328536ba4b9',
  'https://nodejs.org/dist/v20.12.2/node-v20.12.2-linux-x64.tar.xz':
    '595272130310cbe12301430756f23d153f7ab95d00174c02adc11a2e3703d183',
  'https://nodejs.org/dist/v20.12.2/node-v20.12.2-win-arm64.zip':
    '010d488af3adad98e44b2d3f61afb7e3d87b5a620f7a406fe75ab0909b72e7ca',
  'https://nodejs.org/dist/v20.12.2/node-v20.12.2-win-x64.zip':
    '66dda1717cae30a13be6bb17ad96ee54b69f2c23c85acd9c3299b095fa26b452',
  // clangd 22.1.6（GitHub release 无官方校验和，锁定哈希；与
  // src/download_verification.rs 的锁定清单一致）
  'https://github.com/clangd/clangd/releases/download/22.1.6/clangd-mac-22.1.6.zip':
    '631aef462556cbd74e0ebaae1778a38d1997d0ba3371652ca54f82652a179e7d',
  'https://github.com/clangd/clangd/releases/download/22.1.6/clangd-linux-22.1.6.zip':
    'a9c77443af2e447ed467e84771848d3a6ac1c56f84bcfcde717e66318de77cfa',
  'https://github.com/clangd/clangd/releases/download/22.1.6/clangd-windows-22.1.6.zip':
    'ce54f16e0b4fd76d450eeda9664420b195360b73febcfe40e661108fa57f2ce1',
  // JDTLS 1.54.0 milestone（与运行时锁定哈希一致）
  [JDTLS_DOWNLOAD_URL]:
    '1a291a269bd88b3c4048219122961a52ec80872afbc7a3f34270b2ce77f7a14c',
};

function computeSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function verifyPinnedChecksum(url, filePath, expectedHex) {
  const expected = expectedHex ?? PINNED_CHECKSUMS[url];
  if (!expected) {
    throw new Error(`No pinned checksum for ${url}; refusing to install an unverified download.`);
  }
  const actual = await computeSha256(filePath);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    try { rmSync(filePath, { force: true }); } catch {}
    throw new Error(
      `Checksum mismatch for ${url}\n  expected: ${expected}\n  actual:   ${actual}`
    );
  }
  console.log(`  Verified sha256: ${actual}`);
}

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

function writeZipEntries(files, targetDir, stripPrefix) {
  let written = 0;
  for (const [entryName, bytes] of Object.entries(files)) {
    // zip 目录条目以 '/' 结尾且无内容，跳过（目录由写文件时按需创建）。
    if (entryName.endsWith('/')) continue;
    const rel = stripPrefix ? entryName.slice(stripPrefix) : entryName;
    if (!rel) continue;
    const resolved = join(targetDir, rel);
    // 解压安全（GHSA-vwc7-r8mq-g2x9 的根治）：目录穿越必须仍在 targetDir 内；
    // fflate 只还原常规文件内容（zip 的 symlink/特殊 mode 条目在此结构上
    // 被当普通数据写出，也不会经目标端 symlink 逃逸写外链）。
    if (resolved !== targetDir && !resolved.startsWith(targetDir + sep)) {
      console.warn(`Skipping unsafe zip entry: ${entryName}`);
      continue;
    }
    mkdirSync(dirname(resolved), { recursive: true });
    writeFileSync(resolved, bytes);
    written += 1;
  }
  return written;
}

async function extractZip(filePath, targetDir) {
  const files = unzipSync(new Uint8Array(readFileSync(filePath)));
  const names = Object.keys(files);
  mkdirSync(targetDir, { recursive: true });
  if (names.length === 0) return;

  const rootDir = names[0].split('/')[0];
  const allInRoot = names.length > 1 && names.every((name) => name.startsWith(rootDir + '/'));

  if (allInRoot) {
    // 单一根目录（GitHub/官方包常见）：拍平根目录直接写目标，
    // 与旧的 staging→copy 路径产出一致的目录内容。
    rmDirRecursive(targetDir);
    mkdirSync(targetDir, { recursive: true });
    writeZipEntries(files, targetDir, rootDir.length + 1);
  } else {
    writeZipEntries(files, targetDir, 0);
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
  await verifyPinnedChecksum(url, tempFile);

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

  // Check if all packages already installed at the pinned versions.
  const allInstalled = NODE_PACKAGES.every((pkg) => {
    const pkgJsonPath = join(NODE_PACKAGES_DIR, 'node_modules', pkg.name, 'package.json');
    if (!existsSync(pkgJsonPath)) return false;
    try {
      const installed = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
      return installed.version === pkg.version;
    } catch {
      return false;
    }
  });
  if (allInstalled) {
    console.log('Node LSP packages already installed at pinned versions, skipping.');
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

  // 钉死版本安装：`name@version` 精确规范，杜绝 latest 浮动。
  const installSpecs = NODE_PACKAGES.map((pkg) => `${pkg.name}@${pkg.version}`);
  console.log(`Installing Node packages: ${installSpecs.join(', ')}...`);

  if (existsSync(npmCli)) {
    const result = spawnSync(
      nodePath,
      [npmCli, 'install', '--no-audit', '--no-fund', '--omit=dev', '--save-exact', ...installSpecs],
      { cwd: NODE_PACKAGES_DIR, stdio: 'inherit', shell: true }
    );
    if (result.status !== 0) {
      throw new Error(`npm install failed with code ${result.status}`);
    }
  } else {
    const result = spawnSync(
      'npm',
      ['install', '--no-audit', '--no-fund', '--omit=dev', '--save-exact', ...installSpecs],
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
  await verifyPinnedChecksum(url, tempFile);

  console.log(`Extracting clangd...`);
  await extractZip(tempFile, targetDir);

  try { rmSync(tempFile, { force: true }); } catch {}
  return targetDir;
}

async function downloadJavaRuntime() {
  const platform = getPlatform();
  const arch = getArch();
  const key = `${platform}-${arch}`;
  const targetDir = join(GENERATED_DIR, 'java', 'jre');

  const javaExe = os.platform() === 'win32'
    ? join(targetDir, 'bin', 'java.exe')
    : join(targetDir, 'bin', 'java');
  if (existsSync(javaExe)) {
    console.log(`Java Runtime ${JAVA_RUNTIME_VERSION} already exists, skipping download.`);
    return targetDir;
  }

  // 钉死到具体 Temurin release（21.0.12.1+1）并使用锁定哈希，
  // 替代浮动的 api.adoptium.net/v3/binary/latest/21/... URL。
  const javaDownload = TEMURIN_JRE_DOWNLOADS[key];
  if (!javaDownload) {
    throw new Error(`No pinned Temurin JRE download for platform key "${key}".`);
  }
  const isZip = javaDownload.url.endsWith('.zip');
  const extension = isZip ? 'zip' : 'tar.gz';
  const tempFile = join(GENERATED_DIR, `java-runtime.${extension}`);

  console.log(`Downloading Temurin JRE ${JAVA_RUNTIME_VERSION} (${key})...`);
  await downloadFile(javaDownload.url, tempFile);
  await verifyPinnedChecksum(javaDownload.url, tempFile, javaDownload.sha256);

  console.log(`Extracting Java Runtime...`);
  mkdirSync(targetDir, { recursive: true });
  if (isZip) {
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

  console.log(`Downloading JDTLS ${JDTLS_VERSION}...`);
  await downloadFile(JDTLS_DOWNLOAD_URL, tempFile);
  await verifyPinnedChecksum(JDTLS_DOWNLOAD_URL, tempFile);

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

// 仅在作为脚本直接执行时跑完整下载/构建；被 import（如行为测试）时不触发
// 数百 MB 下载，只导出纯函数 extractZip/writeZipEntries。
const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) main();

export { extractZip, writeZipEntries };
