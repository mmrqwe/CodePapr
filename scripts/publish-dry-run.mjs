#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const rootDir = process.cwd();

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function assertFile(packageDir, relativePath, failures) {
  if (!relativePath) {
    return;
  }
  const normalized = relativePath.replace(/^\.\//, '');
  if (!fs.existsSync(path.join(packageDir, normalized))) {
    failures.push(`${path.relative(rootDir, packageDir)} 缺少 ${relativePath}`);
  }
}

const rootPackage = readJson(path.join(rootDir, 'package.json'));
const workspaces = rootPackage.workspaces ?? [];
const failures = [];
const packed = [];

for (const workspace of workspaces) {
  const packageDir = path.join(rootDir, workspace);
  const packageJsonPath = path.join(packageDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    failures.push(`${workspace} 缺少 package.json`);
    continue;
  }

  const pkg = readJson(packageJsonPath);
  if (pkg.private === true) {
    continue;
  }

  assertFile(packageDir, pkg.main, failures);
  assertFile(packageDir, pkg.types, failures);

  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: packageDir,
    encoding: 'utf8',
    // Windows 上 npm 是 npm.cmd：不经 shell 无法 spawn（恒 ENOENT），
    // 该发布前检查会在 Windows 上永远失败。
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    failures.push(`${workspace} npm pack --dry-run 失败:\n${result.stderr || result.stdout}`);
    continue;
  }

  try {
    const info = JSON.parse(result.stdout)[0];
    packed.push(`${pkg.name}@${pkg.version} (${info.files.length} files, ${info.unpackedSize} bytes)`);
  } catch {
    failures.push(`${workspace} 无法解析 npm pack --dry-run 输出`);
  }
}

if (failures.length > 0) {
  console.error('Publish dry run failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Publish dry run passed.');
for (const item of packed) {
  console.log(`- ${item}`);
}
