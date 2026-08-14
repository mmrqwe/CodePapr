import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';

let externalWorkspace = process.env.CODEPAPR_EXTERNAL_WORKSPACE?.trim();

// 自诊断兜底：未显式指定外部工作区时，默认使用本仓库的 ui 包
// （根目录含 vite.config.ts / src/App.tsx / src/main.tsx / package.json，
// 满足桌面烟测对外部工作区的全部要求）。
const selfWorkspace = path.resolve(process.cwd(), 'packages', '@codepapr', 'ui');
if (!externalWorkspace) {
  if (
    existsSync(path.join(selfWorkspace, 'package.json')) &&
    existsSync(path.join(selfWorkspace, 'vite.config.ts'))
  ) {
    externalWorkspace = selfWorkspace;
    console.warn(
      `CODEPAPR_EXTERNAL_WORKSPACE 未设置，自动使用仓库自带的 ui 包作为外部工作区：${selfWorkspace}\n` +
        '如需对指定项目跑烟测：CODEPAPR_EXTERNAL_WORKSPACE=/absolute/path/to/workspace npm run smoke:desktop-diagnostics'
    );
  } else {
    console.error(
      'CODEPAPR_EXTERNAL_WORKSPACE is required. Example: CODEPAPR_EXTERNAL_WORKSPACE=/absolute/path/to/workspace npm run smoke:desktop-diagnostics'
    );
    process.exit(1);
  }
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
    env: { ...process.env, CODEPAPR_EXTERNAL_WORKSPACE: externalWorkspace },
  }
);

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
