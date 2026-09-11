import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import {
  MEMORY_SHELL_GUARD_NOTE,
  attachMemoryGuardNote,
  runWithMemoryShellGuard,
} from './memoryShellGuard';
import { requestMemoryMdWrite } from './memoryFile';

let fileContent: string | null = null;

beforeEach(() => {
  fileContent = null;
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'read_text_file') {
      if (fileContent === null) throw new Error('file not found');
      return { path: args?.relativePath, content: fileContent, bytes: fileContent.length };
    }
    if (command === 'write_text_file') {
      fileContent = String(args?.content ?? '');
      return { path: args?.relativePath, bytes: fileContent.length };
    }
    throw new Error(`Unexpected invoke: ${command}`);
  });
});

describe('runWithMemoryShellGuard', () => {
  it('macOS（内核沙箱已强制）→ 不读不比对，零额外 IPC', async () => {
    fileContent = '# m\n- A\n';
    const result = await runWithMemoryShellGuard('/ws', async () => 'done', 'darwin');
    expect(result).toEqual({ result: 'done', intercepted: false });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('非 macOS：命令未改动记忆文件 → 不恢复', async () => {
    fileContent = '# m\n- A\n';
    const result = await runWithMemoryShellGuard(
      '/ws',
      async () => {
        fileContent = '# m\n- A\n';
        return { status: 0 };
      },
      'win32'
    );
    expect(result.intercepted).toBe(false);
    const writes = invokeMock.mock.calls.filter(([command]) => command === 'write_text_file');
    expect(writes).toHaveLength(0);
  });

  it('非 macOS：命令越权改动 → 回滚原内容并标记 intercepted', async () => {
    fileContent = '# m\n- A\n';
    const result = await runWithMemoryShellGuard(
      '/ws',
      async () => {
        fileContent = '# m\n- A\n- injected\n';
        return { status: 0, stderr: 'ok' };
      },
      'win32'
    );
    expect(result.intercepted).toBe(true);
    expect(fileContent).toBe('# m\n- A\n');
  });

  it('命令执行期间有受信写入（curator/面板）→ 归因给它，不回滚', async () => {
    fileContent = '# m\n- A\n';
    const result = await runWithMemoryShellGuard(
      '/ws',
      async () => {
        const written = await requestMemoryMdWrite('/ws', '# m\n- C\n', {
          expectedContent: '# m\n- A\n',
          origin: 'panel',
        });
        expect(written.ok).toBe(true);
        return { status: 0 };
      },
      'win32'
    );
    expect(result.intercepted).toBe(false);
    expect(fileContent).toBe('# m\n- C\n');
  });

  it('命令新建记忆文件 → 不删（无法区分瞬时读失败），不标记', async () => {
    fileContent = null;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const result = await runWithMemoryShellGuard(
        '/ws',
        async () => {
          fileContent = '# m\n- new\n';
          return { status: 0 };
        },
        'win32'
      );
      expect(result.intercepted).toBe(false);
      expect(fileContent).toBe('# m\n- new\n');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('attachMemoryGuardNote', () => {
  it('优先并入 stderr；空 stderr 直接写注记', () => {
    expect(attachMemoryGuardNote({ stdout: 'out', stderr: '' })).toEqual({
      stdout: 'out',
      stderr: MEMORY_SHELL_GUARD_NOTE,
    });
    expect(attachMemoryGuardNote({ stdout: 'out', stderr: 'err' })).toEqual({
      stdout: 'out',
      stderr: `err\n${MEMORY_SHELL_GUARD_NOTE}`,
    });
    expect(attachMemoryGuardNote('raw')).toBe('raw');
  });
});
