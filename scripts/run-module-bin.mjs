#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const [moduleSpecifier, ...args] = process.argv.slice(2);

if (!moduleSpecifier) {
  console.error('Missing module specifier');
  process.exit(1);
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

function resolveEntry(specifier) {
  const requireFromCwd = createRequire(resolve(process.cwd(), 'package.json'));
  const requireFromScript = createRequire(import.meta.url);

  const tryResolve = (resolver) => {
    try {
      return resolver.resolve(specifier);
    } catch {
      const segments = specifier.split('/');
      const packageName = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
      const subPath = segments.slice(specifier.startsWith('@') ? 2 : 1).join('/');

      if (!subPath) {
        throw new Error(`Cannot resolve module entry: ${specifier}`);
      }

      const packageJsonPath = resolver.resolve(`${packageName}/package.json`);
      return resolve(dirname(packageJsonPath), subPath);
    }
  };

  try {
    return tryResolve(requireFromCwd);
  } catch {
    return tryResolve(requireFromScript);
  }
}

const entry = resolveEntry(moduleSpecifier);
const child = spawn(process.execPath, [entry, ...args], {
  stdio: 'inherit',
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
