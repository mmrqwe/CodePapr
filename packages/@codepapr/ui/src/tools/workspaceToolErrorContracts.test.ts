import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '@codepapr/core';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(
    async (_command: string, _args?: Record<string, unknown>) => ({})
  ),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import { registerWorkspaceTools } from './workspaceTools';
import { assertErrorContract, captureReject } from '../../../core/tests/error-contract';

function build(): ToolRegistry {
  const registry = new ToolRegistry();
  registerWorkspaceTools(registry, '/tmp/ws', undefined, undefined, {});
  return registry;
}

/** read_text_file 的返回值骨架；overrides 控制换行/截断分支。 */
function readResult(relativePath: string, content: string, overrides: Record<string, unknown> = {}) {
  return {
    path: relativePath,
    content,
    bytes: content.length,
    startLine: 1,
    endLine: content.split('\n').length,
    totalLines: content.split('\n').length,
    truncatedByRange: false,
    truncatedByBytes: false,
    ...overrides,
  };
}

function baseMocks(read: Record<string, unknown>) {
  invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'read_text_file') {
      const rel = String(args?.relativePath);
      if (read[rel] === undefined) {
        throw new Error(`文件不存在: ${rel}`);
      }
      return read[rel] as Record<string, unknown>;
    }
    if (command === 'check_syntax') {
      return { supported: false, errorCount: 0, errors: [] };
    }
    if (command === 'resolve_symbols') {
      return [];
    }
    return {};
  });
}

describe('tool error contracts: UI edit/patch 处理器（模型可见面）', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async () => ({}));
  });

  it('歧义匹配：报出行号清单与两种消歧路径', async () => {
    const content = 'const x = 1;\nfoo();\nconst y = 2;\nfoo();\n';
    baseMocks({ 'src/a.ts': readResult('src/a.ts', content) });
    const registry = build();
    const message = await captureReject(
      registry.execute('edit', { relativePath: 'src/a.ts', search: 'foo();', replace: 'bar();' })
    );
    assertErrorContract(message, {
      locate: [/L2/, /L4/, /匹配到 2 处/],
      explain: [/无法确定修改目标/],
      action: [/加长 search/, /replaceAll=true/, /不能消歧/],
    });
    // 报错即拒写：不允许在歧义未消除时落盘
    expect(
      invokeMock.mock.calls.some(([command]) => command === 'write_text_file')
    ).toBe(false);
  });

  it('AST 预检拒绝：给出错误增量、前几处 L:col(kind) 样例与修复指引', async () => {
    const before = 'const a = 1;\n';
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'read_text_file') {
        return readResult('src/b.ts', before);
      }
      if (command === 'check_syntax') {
        const content = String(args?.content ?? '');
        if (content === before) {
          return { supported: true, errorCount: 0, errors: [] };
        }
        return {
          supported: true,
          errorCount: 2,
          errors: [
            { line: 2, column: 3, kind: 'missing_paren' },
            { line: 4, column: 1, kind: 'unexpected_token' },
          ],
        };
      }
      if (command === 'resolve_symbols') {
        return [];
      }
      return {};
    });
    const registry = build();
    const message = await captureReject(
      registry.execute('edit', { relativePath: 'src/b.ts', search: 'const a = 1;', replace: 'const a = ((1;' })
    );
    assertErrorContract(message, {
      explain: [/语法错误从 0 增至 2/],
      action: [/L2:3\(missing_paren\)/, /括号\/引号闭合/, /重试/],
    });
    expect(
      invokeMock.mock.calls.some(([command]) => command === 'write_text_file')
    ).toBe(false);
  });

  it('超 20MB 拒写：指向模型可用的 write 工具，且不引用隐藏内部名', async () => {
    baseMocks({
      'big.ts': readResult('big.ts', 'head', { truncatedByBytes: true, bytes: 21_000_000 }),
    });
    const registry = build();
    const message = await captureReject(
      registry.execute('edit', { relativePath: 'big.ts', search: 'head', replace: 'tail' })
    );
    assertErrorContract(message, {
      locate: [/big\.ts/],
      explain: [/超过 20MB 上限/],
      action: [/write 工具重写整个文件/],
    });
    // write 必须是 LLM 可见名 `write`，而非被 hideFromLlm 的内部 workspace_* 名
    expect(message).not.toMatch(/workspace_write_file/);
  });

  it('写后验证失败：点名文件、疑似原因与重试动作', async () => {
    const files = new Map<string, string>([['src/c.ts', 'const c = 1;\n']]);
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'read_text_file') {
        const rel = String(args?.relativePath);
        return readResult(rel, files.get(rel) ?? '');
      }
      if (command === 'write_text_file') {
        // 模拟云同步吞写：写入不生效，验证回读仍是旧内容
        return { path: String(args?.relativePath), bytes: 0 };
      }
      if (command === 'check_syntax') {
        return { supported: false, errorCount: 0, errors: [] };
      }
      if (command === 'resolve_symbols') {
        return [];
      }
      return {};
    });
    const registry = build();
    const message = await captureReject(
      registry.execute('edit', { relativePath: 'src/c.ts', search: 'const c = 1;', replace: 'const c = 2;' })
    );
    assertErrorContract(message, {
      locate: [/src\/c\.ts/],
      explain: [/写入验证失败|不一致/],
      action: [/云同步锁|重试/],
    });
  });

  it('成功写回的返回自带 LSP 结论（反馈闭环，不留静默成功）', async () => {
    const files = new Map<string, string>([['src/d.ts', 'const d = 1;\n']]);
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'read_text_file') {
        const rel = String(args?.relativePath);
        return readResult(rel, files.get(rel) ?? '');
      }
      if (command === 'write_text_file') {
        files.set(String(args?.relativePath), String(args?.content ?? ''));
        return { path: String(args?.relativePath), bytes: 0 };
      }
      if (command === 'check_syntax') {
        return { supported: false, errorCount: 0, errors: [] };
      }
      if (command === 'resolve_symbols') {
        return [];
      }
      return {};
    });
    const registry = build();
    const result = (await registry.execute('edit', {
      relativePath: 'src/d.ts',
      search: 'const d = 1;',
      replace: 'const d = 2;',
    })) as { notes?: string[] };
    assertErrorContract((result.notes ?? []).join('\n'), {
      explain: [/LSP 检查通过|编译诊断|诊断跳过/],
      action: [/请检查并继续修复|diagnostics|无编译错误/],
    });
  });
});
