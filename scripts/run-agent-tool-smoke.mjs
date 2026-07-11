import { spawn } from 'node:child_process';
import process from 'node:process';

const child = spawn(
  process.execPath,
  ['./scripts/run-module-bin.mjs', 'vitest/vitest.mjs', 'run', 'scripts/agent-tool-smoke.test.ts'],
  {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: {
      ...process.env,
      CODEPAPR_REAL_SMOKE: '1',
    },
  }
);

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
