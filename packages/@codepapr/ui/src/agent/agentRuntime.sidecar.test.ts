// @vitest-environment node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sidecarPath = path.join(uiDir, 'dist-sidecar/agent-runtime.mjs');

describe('agent sidecar stdio', () => {
  it('answers ping with pong over NDJSON', async () => {
    if (!existsSync(sidecarPath)) {
      throw new Error('dist-sidecar/agent-runtime.mjs missing; run npm run build:sidecar');
    }
    const child = spawn(process.execPath, [sidecarPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`sidecar ping timeout; stderr=${stderr}`));
      }, 8000);
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        lines.push(...chunk.toString().split('\n').filter(Boolean));
        if (lines.some((line) => line.includes('"type":"pong"'))) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.stdin?.write(`${JSON.stringify({ type: 'ping' })}\n`);
    });
    child.kill('SIGTERM');
    expect(lines.some((line) => JSON.parse(line).type === 'pong')).toBe(true);
  }, 15_000);
});
