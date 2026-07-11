import { spawn } from 'node:child_process';
import process from 'node:process';

const externalWorkspace = process.env.CODEPAPR_EXTERNAL_WORKSPACE?.trim();

if (!externalWorkspace) {
  console.error(
    'CODEPAPR_EXTERNAL_WORKSPACE is required. Example: CODEPAPR_EXTERNAL_WORKSPACE=/absolute/path/to/workspace npm run smoke:desktop-diagnostics'
  );
  process.exit(1);
}

const child = spawn(
  process.execPath,
  [
    './scripts/run-module-bin.mjs',
    'vitest/vitest.mjs',
    'run',
    'packages/@codepapr/ui/src/components/DesktopDiagnosticsSmoke.test.tsx',
  ],
  {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  }
);

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
