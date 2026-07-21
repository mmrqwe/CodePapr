#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const tauriCliEntry = require.resolve('@tauri-apps/cli/tauri.js');
const cliArgs = process.argv.slice(2);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(uiDir, '../../..');
const releaseDir = path.resolve(repoRoot, 'Release');
const tauriConfigPath = path.resolve(uiDir, 'src-tauri/tauri.conf.json');

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

function cleanupStaleMacOsBundleArtifacts(args) {
  if (process.platform !== 'darwin' || args[0] !== 'build') {
    return;
  }

  const profileDir = args.includes('--debug') ? 'debug' : 'release';
  const bundleDirs = [
    path.resolve(scriptDir, `../src-tauri/target/${profileDir}/bundle/macos`),
    path.resolve(scriptDir, `../src-tauri/target/${profileDir}/bundle/dmg`),
  ];
  const removablePatterns = [/\.dmg$/i, /^rw\..*\.dmg$/i];
  let removedCount = 0;

  for (const bundleDir of bundleDirs) {
    if (!fs.existsSync(bundleDir)) {
      continue;
    }

    for (const entry of fs.readdirSync(bundleDir, { withFileTypes: true })) {
      if (!entry.isFile()) {
        continue;
      }
      if (!removablePatterns.some((pattern) => pattern.test(entry.name))) {
        continue;
      }

      fs.rmSync(path.join(bundleDir, entry.name), { force: true });
      removedCount += 1;
    }
  }

  if (removedCount > 0) {
    console.log(`[tauri-cli] Removed ${removedCount} stale macOS DMG artifact(s) before build.`);
  }
}

function ensureCleanDir(dirPath) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // Fallback for cases where rmSync fails (e.g. directory in use)
    execSync(`rm -rf "${dirPath}"`, { stdio: 'pipe' });
  }
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyRecursive(sourcePath, targetPath) {
  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) {
    fs.mkdirSync(targetPath, { recursive: true });
    for (const entry of fs.readdirSync(sourcePath)) {
      copyRecursive(path.join(sourcePath, entry), path.join(targetPath, entry));
    }
    return;
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
}

function collectBundleArtifacts(bundleRoot, currentDir = bundleRoot) {
  if (!fs.existsSync(currentDir)) {
    return [];
  }

  const bundledArtifacts = [];
  const releaseArtifactMatchers = [
    /\.app$/i,
    /\.dmg$/i,
    /\.msi$/i,
    /\.exe$/i,
    /\.appimage$/i,
    /\.deb$/i,
    /\.rpm$/i,
    /\.pkg$/i,
    /\.zip$/i,
    /\.tar\.gz$/i,
  ];

  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const source = path.join(currentDir, entry.name);
    if (/^rw\..*\.dmg$/i.test(entry.name)) {
      continue;
    }
    if (entry.isDirectory()) {
      if (releaseArtifactMatchers.some((pattern) => pattern.test(entry.name))) {
        bundledArtifacts.push(source);
        continue;
      }
      bundledArtifacts.push(...collectBundleArtifacts(bundleRoot, source));
      continue;
    }

    if (releaseArtifactMatchers.some((pattern) => pattern.test(entry.name))) {
      bundledArtifacts.push(source);
    }
  }

  return bundledArtifacts;
}

function hideDmgVolumeIcons(bundleRoot) {
  if (process.platform !== 'darwin') {
    return;
  }
  const dmgDir = path.join(bundleRoot, 'dmg');
  if (!fs.existsSync(dmgDir)) {
    return;
  }
  const dmgFiles = fs.readdirSync(dmgDir).filter((f) => f.endsWith('.dmg') && !f.startsWith('rw.'));
  for (const dmgName of dmgFiles) {
    const dmgPath = path.join(dmgDir, dmgName);
    const stamp = `${Date.now()}-${process.pid}`;
    const tmpRw = path.join(dmgDir, `__rw_${stamp}.dmg`);
    const tmpNew = path.join(dmgDir, `__new_${stamp}.dmg`);
    const mountPoint = path.join(require('node:os').tmpdir(), `codepapr-dmg-${stamp}`);
    try {
      execSync(`hdiutil convert ${JSON.stringify(dmgPath)} -format UDRW -o ${JSON.stringify(tmpRw)} -quiet`, { stdio: 'inherit' });
      fs.mkdirSync(mountPoint, { recursive: true });
      execSync(`hdiutil attach ${JSON.stringify(tmpRw)} -mountpoint ${JSON.stringify(mountPoint)} -nobrowse -quiet`, { stdio: 'inherit' });
      const srcIcon = path.resolve(uiDir, 'src-tauri/icons/icon.icns');
      const iconPath = path.join(mountPoint, '.VolumeIcon.icns');
      if (fs.existsSync(srcIcon)) {
        fs.copyFileSync(srcIcon, iconPath);
        try {
          execSync(`SetFile -a C ${JSON.stringify(mountPoint)}`, { stdio: 'pipe' });
        } catch { /* SetFile not available */ }
        let hidden = false;
        try {
          execSync(`SetFile -a V ${JSON.stringify(iconPath)}`, { stdio: 'pipe' });
          hidden = true;
        } catch { /* SetFile not available */ }
        if (!hidden) {
          try {
            execSync(`chflags hidden ${JSON.stringify(iconPath)}`, { stdio: 'pipe' });
            hidden = true;
          } catch { /* chflags failed */ }
        }
        if (hidden) {
          console.log(`[tauri-cli] Replaced .VolumeIcon.icns with CodePapr icon and hid it in ${dmgName}`);
        } else {
          console.warn(`[tauri-cli] Replaced .VolumeIcon.icns but could not hide it in ${dmgName}`);
        }
      } else if (fs.existsSync(iconPath)) {
        let hidden = false;
        try {
          execSync(`SetFile -a V ${JSON.stringify(iconPath)}`, { stdio: 'pipe' });
          hidden = true;
        } catch { /* SetFile not available */ }
        if (!hidden) {
          try {
            execSync(`chflags hidden ${JSON.stringify(iconPath)}`, { stdio: 'pipe' });
            hidden = true;
          } catch { /* chflags failed */ }
        }
        if (hidden) {
          console.log(`[tauri-cli] Hid .VolumeIcon.icns inside ${dmgName}`);
        } else {
          console.warn(`[tauri-cli] Could not hide .VolumeIcon.icns inside ${dmgName}`);
        }
      }
      execSync(`hdiutil detach ${JSON.stringify(mountPoint)} -quiet -force`, { stdio: 'inherit' });
      execSync(`hdiutil convert ${JSON.stringify(tmpRw)} -format UDZO -imagekey zlib-level=9 -o ${JSON.stringify(tmpNew)} -quiet`, { stdio: 'inherit' });
      fs.rmSync(dmgPath, { force: true });
      fs.renameSync(tmpNew, dmgPath);
    } catch (err) {
      console.warn(`[tauri-cli] Failed to hide volume icon in ${dmgName}: ${err.message}`);
    } finally {
      try { execSync(`hdiutil detach ${JSON.stringify(mountPoint)} -quiet -force`, { stdio: 'pipe' }); } catch { /* already detached */ }
      try { fs.rmSync(tmpRw, { force: true }); } catch { /* ignore */ }
      try { fs.rmSync(tmpNew, { force: true }); } catch { /* ignore */ }
      try { if (fs.existsSync(mountPoint)) fs.rmdirSync(mountPoint); } catch { /* ignore */ }
    }
  }
}

function collectReleaseArtifacts(args) {
  if (args[0] !== 'build' || args.includes('--debug')) {
    return;
  }

  const profileDir = 'release';
  const bundleRoot = path.resolve(uiDir, `src-tauri/target/${profileDir}/bundle`);
  hideDmgVolumeIcons(bundleRoot);
  const binaryCandidates = [
    path.resolve(uiDir, 'src-tauri/target/release/codepapr'),
    path.resolve(uiDir, 'src-tauri/target/release/codepapr.exe'),
  ];
  const existingArtifacts = [];

  if (fs.existsSync(bundleRoot)) {
    for (const artifactPath of collectBundleArtifacts(bundleRoot)) {
      existingArtifacts.push({
        source: artifactPath,
        target: path.join(releaseDir, path.basename(artifactPath)),
      });
    }
  }

  for (const candidate of binaryCandidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    existingArtifacts.push({
      source: candidate,
      target: path.join(releaseDir, path.basename(candidate)),
    });
  }

  if (existingArtifacts.length === 0) {
    console.warn('[tauri-cli] No release artifacts found to stage into Release/.');
    return;
  }

  ensureCleanDir(releaseDir);
  for (const artifact of existingArtifacts) {
    copyRecursive(artifact.source, artifact.target);
  }

  console.log(`[tauri-cli] Staged release artifacts to ${releaseDir}`);
}

function isMacOsReleaseBuild(args) {
  return process.platform === 'darwin' && args[0] === 'build' && !args.includes('--debug');
}

function resolveBundleArch(arch) {
  switch (arch) {
    case 'arm64':
      return 'aarch64';
    case 'x64':
      return 'x64';
    default:
      return arch;
  }
}

function readTauriBundleMetadata() {
  try {
    const config = JSON.parse(fs.readFileSync(tauriConfigPath, 'utf8'));
    const productName = typeof config.productName === 'string' ? config.productName.trim() : '';
    const version = typeof config.version === 'string' ? config.version.trim() : '';
    if (!productName || !version) {
      return null;
    }
    return { productName, version };
  } catch {
    return null;
  }
}

function resolveMacOsDmgFallbackPlan(args) {
  if (!isMacOsReleaseBuild(args)) {
    return null;
  }

  const metadata = readTauriBundleMetadata();
  if (!metadata) {
    return null;
  }

  const bundleArch = resolveBundleArch(process.arch);
  const dmgDir = path.resolve(uiDir, 'src-tauri/target/release/bundle/dmg');
  const macosDir = path.resolve(uiDir, 'src-tauri/target/release/bundle/macos');
  const scriptPath = path.join(dmgDir, 'bundle_dmg.sh');
  const appPath = path.join(macosDir, `${metadata.productName}.app`);
  const dmgName = `${metadata.productName}_${metadata.version}_${bundleArch}.dmg`;

  if (!fs.existsSync(scriptPath) || !fs.existsSync(appPath)) {
    return null;
  }

  return {
    cwd: dmgDir,
    scriptPath,
    dmgName,
    sourceArg: path.relative(dmgDir, appPath) || appPath,
  };
}

function runChildProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(command, args, options);
    childProcess.on('error', reject);
    childProcess.on('exit', (exitCode, signal) => {
      if (signal) {
        reject(new Error(`${command} exited due to signal ${signal}`));
        return;
      }
      resolve(exitCode ?? 1);
    });
  });
}

async function recoverMacOsDmgBundle(args) {
  const plan = resolveMacOsDmgFallbackPlan(args);
  if (!plan) {
    return false;
  }

  fs.rmSync(path.join(plan.cwd, plan.dmgName), { force: true });
  console.warn('[tauri-cli] Tauri DMG bundling failed after app bundle creation; retrying bundle_dmg.sh via bash.');
  try {
    const exitCode = await runChildProcess(
      'bash',
      [path.basename(plan.scriptPath), plan.dmgName, plan.sourceArg],
      {
        cwd: plan.cwd,
        stdio: 'inherit',
        env: sanitizeSpawnEnv(process.env),
      }
    );
    return exitCode === 0;
  } catch (error) {
    console.error('[tauri-cli] macOS DMG fallback failed.', error);
    return false;
  }
}

cleanupStaleMacOsBundleArtifacts(cliArgs);

// 强制 cargo 重新编译 main.rs，确保 generate_context!() 重新嵌入最新的 dist/ 前端文件。
// 不这样做的话，如果只改了前端没改 .rs 文件，cargo 增量编译会跳过 main.rs 重编译，
// 导致二进制内嵌的是旧版前端。
function touchMainRsForFreshFrontend(args) {
  if (args[0] !== 'build') return;
  const mainRs = path.resolve(scriptDir, '../src-tauri/src/main.rs');
  if (fs.existsSync(mainRs)) {
    const now = new Date();
    fs.utimesSync(mainRs, now, now);
    console.log('[tauri-cli] Touched main.rs to ensure latest frontend is embedded.');
  }
}

touchMainRsForFreshFrontend(cliArgs);

const child = spawn(process.execPath, [tauriCliEntry, ...cliArgs], {
  stdio: 'inherit',
  env: sanitizeSpawnEnv(process.env),
});

child.on('exit', (code, signal) => {
  void (async () => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  let finalCode = code ?? 1;
  if (finalCode !== 0 && (await recoverMacOsDmgBundle(cliArgs))) {
    finalCode = 0;
  }

  if (finalCode === 0) {
    collectReleaseArtifacts(cliArgs);
  }

  process.exit(finalCode);
  })();
});

child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});
