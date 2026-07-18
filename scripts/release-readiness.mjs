#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function checkFile(relativePath) {
  const absolutePath = path.join(rootDir, relativePath);
  return fs.existsSync(absolutePath);
}

function assert(condition, message, failures) {
  if (!condition) {
    failures.push(message);
  }
}

const failures = [];
const rootPackage = readJson(path.join(rootDir, 'package.json'));
const packagePaths = [
  'packages/@codepapr/types/package.json',
  'packages/@codepapr/common/package.json',
  'packages/@codepapr/core/package.json',
  'packages/@codepapr/api/package.json',
  'packages/@codepapr/db/package.json',
  'packages/@codepapr/editor/package.json',
  'packages/@codepapr/ui/package.json',
];

for (const packagePath of packagePaths) {
  const pkg = readJson(path.join(rootDir, packagePath));
  assert(pkg.version === rootPackage.version, `${packagePath} version 与根 package.json 不一致`, failures);
}

const requiredScripts = [
  'verify:ci',
  'verify',
  'debug',
  'release',
  'publish',
  'release:prep',
  'publish:dry-run',
  'release:desktop',
];
for (const scriptName of requiredScripts) {
  assert(
    typeof rootPackage.scripts?.[scriptName] === 'string',
    `package.json 缺少脚本 ${scriptName}`,
    failures
  );
}

const requiredFiles = [
  '.github/workflows/ci.yml',
  '.github/workflows/release-desktop.yml',
  'README.md',
  'docs/ARCHITECTURE.md',
  'docs/SETUP.md',
  'docs/USAGE.md',
  'publish-codepapr.command',
  'publish-codepapr.cmd',
  'packages/@codepapr/ui/src-tauri/Cargo.toml',
  'packages/@codepapr/ui/src-tauri/icons/app-icon.svg',
];

for (const relativePath of requiredFiles) {
  assert(checkFile(relativePath), `缺少文件 ${relativePath}`, failures);
}

if (failures.length > 0) {
  console.error('Release readiness check failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Release readiness check passed.');
