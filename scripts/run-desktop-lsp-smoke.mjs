import { spawn } from 'node:child_process';

const cargoArgs = [
  'test',
  '--manifest-path',
  'packages/@codepapr/ui/src-tauri/Cargo.toml',
  'lsp_smoke_',
  '--',
  '--nocapture',
  '--test-threads=1',
];

const child = spawn('cargo', cargoArgs, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    CODEPAPR_ENABLE_MANAGED_LSP_DOWNLOAD_IN_TESTS: '1',
  },
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  console.error(`failed to run cargo LSP smoke tests: ${error.message}`);
  process.exit(1);
});