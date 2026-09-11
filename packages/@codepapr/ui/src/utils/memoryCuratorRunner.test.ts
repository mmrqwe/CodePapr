import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runCompactorSessionMock, invokeMock } = vi.hoisted(() => ({
  runCompactorSessionMock: vi.fn(async (): Promise<unknown> => ({ content: 'NO_CHANGE' })),
  invokeMock: vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => ({})),
}));

vi.mock('./compactorRunner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./compactorRunner')>();
  return {
    ...actual,
    runCompactorSession: runCompactorSessionMock,
  };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import {
  buildCuratorDefinition,
  buildCuratorUserPrompt,
  parseCuratorOutput,
  runMemoryCurator,
} from './memoryCuratorRunner';
import type { CompactionSettings } from '../store/internals/types';

const currentMd = '# 项目与用户长期记忆\n\n## 用户偏好与约束\n- 统一使用 pnpm\n';

const settings = {
  model: 'deepseek-v4-pro',
  compactionModel: 'fast',
  fastModelEnabled: true,
  fastModel: 'deepseek-v4-flash',
  compactionTemperature: 0.1,
  compactionMaxTokens: 8000,
} as unknown as CompactionSettings;

beforeEach(() => {
  runCompactorSessionMock.mockReset();
  runCompactorSessionMock.mockResolvedValue({ content: 'NO_CHANGE' });
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({});
});

describe('buildCuratorDefinition', () => {
  it('复用压缩档位：fast 档 + compaction 温度，internal 零工具', () => {
    const def = buildCuratorDefinition({ settings, baseModel: settings.model });
    expect(def.name).toBe('memory-curator');
    expect(def.internal).toBe(true);
    expect(def.model).toBe('fast');
    expect(def.temperature).toBe(0.1);
  });

  it('fast 未启用 → 回退主模型（与 compactor 同策略）', () => {
    const def = buildCuratorDefinition({
      settings: { ...settings, fastModelEnabled: false } as CompactionSettings,
      baseModel: 'deepseek-v4-pro',
    });
    expect(def.model).toBe('deepseek-v4-pro');
  });
});

describe('buildCuratorUserPrompt', () => {
  it('包含当前文件与素材两个区块；缺文件时标注尚不存在', () => {
    const prompt = buildCuratorUserPrompt({ currentMd, material: 'User: 记住用 pnpm\nAssistant: 好的' });
    expect(prompt).toContain('<current_memory>');
    expect(prompt).toContain('统一使用 pnpm');
    expect(prompt).toContain('<interaction>');
    expect(buildCuratorUserPrompt({ currentMd: null, material: 'x' })).toContain('文件尚不存在');
  });
});

describe('parseCuratorOutput', () => {
  const updatedMd = `${currentMd}- 端口固定 5432\n`;

  it('NO_CHANGE（含尾标点/空白）→ nochange', () => {
    expect(parseCuratorOutput('NO_CHANGE', currentMd).kind).toBe('nochange');
    expect(parseCuratorOutput('NO_CHANGE.\n', currentMd).kind).toBe('nochange');
  });

  it('空输出 → failed', () => {
    expect(parseCuratorOutput('   ', currentMd).kind).toBe('failed');
    expect(parseCuratorOutput(null, currentMd).kind).toBe('failed');
  });

  it('围栏包裹的合法文件 → updated', () => {
    const outcome = parseCuratorOutput('```markdown\n' + updatedMd + '```', currentMd);
    expect(outcome.kind).toBe('updated');
    expect(outcome.kind === 'updated' && outcome.content).toContain('端口固定 5432');
  });

  it('含密钥的输出 → rejected（机械门，不依赖模型自觉）', () => {
    const leaky = `${updatedMd}- token = sk-abcdefghijklmnopqrstuvwxyz123456\n`;
    const outcome = parseCuratorOutput(leaky, currentMd);
    expect(outcome.kind).toBe('rejected');
    expect(outcome.kind === 'rejected' && outcome.reasons).toContain('secrets');
  });

  it('mass-drop 输出 → rejected（零新增却丢光其余条目）', () => {
    const stripped = '# 项目与用户长期记忆\n\n## 用户偏好与约束\n- 统一使用 pnpm\n';
    const prev = `${currentMd}- 端口固定 5432\n- 构建用 pnpm build\n- 测试用 pnpm test\n`;
    const outcome = parseCuratorOutput(stripped, prev);
    expect(outcome.kind).toBe('rejected');
    expect(outcome.kind === 'rejected' && outcome.reasons).toContain('mass-drop:3');
  });
});

describe('runMemoryCurator', () => {
  it('updated → 过门后写盘（write_text_file 带 MEMORY.md 路径）', async () => {
    const updatedMd = `${currentMd}- 端口固定 5432\n`;
    runCompactorSessionMock.mockResolvedValue({ content: updatedMd });
    invokeMock.mockImplementation(async (cmd) =>
      cmd === 'read_text_file' ? { content: currentMd } : {}
    );
    const result = await runMemoryCurator({
      workspacePath: '/ws',
      currentMd,
      material: 'User: 端口是 5432\nAssistant: 已确认',
      settings,
      lang: 'zh-CN',
    });
    expect(result.kind).toBe('updated');
    expect(result.written).toBe(true);
    const write = invokeMock.mock.calls.find(([cmd]) => cmd === 'write_text_file');
    expect(write?.[1]).toMatchObject({ relativePath: '.CodePapr/MEMORY.md' });
  });

  it('NO_CHANGE → 不写盘', async () => {
    const result = await runMemoryCurator({
      workspacePath: '/ws',
      currentMd,
      material: 'User: 帮我改个 bug\nAssistant: 修好了',
      settings,
      lang: 'zh-CN',
    });
    expect(result.kind).toBe('nochange');
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === 'write_text_file')).toBe(false);
  });

  it('rejected 输出 → 不写盘', async () => {
    runCompactorSessionMock.mockResolvedValue({
      content: `${currentMd}- token = sk-abcdefghijklmnopqrstuvwxyz123456\n`,
    });
    const result = await runMemoryCurator({
      workspacePath: '/ws',
      currentMd,
      material: 'User: 记一下密钥\nAssistant: 好',
      settings,
      lang: 'zh-CN',
    });
    expect(result.kind).toBe('rejected');
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === 'write_text_file')).toBe(false);
  });

  it('stale 守卫（外部并发改文件）→ written=false 且 rejected', async () => {
    const updatedMd = `${currentMd}- 端口固定 5432\n`;
    runCompactorSessionMock.mockResolvedValue({ content: updatedMd });
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === 'read_text_file') return { content: '# 别人改过的记忆\n- 别的条目\n' };
      return {};
    });
    const result = await runMemoryCurator({
      workspacePath: '/ws',
      currentMd,
      material: 'User: 端口是 5432\nAssistant: 已确认',
      settings,
      lang: 'zh-CN',
    });
    expect(result.kind).toBe('rejected');
    expect(result.written).toBe(false);
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === 'write_text_file')).toBe(false);
  });

  it('空素材直接 nochange，不调模型', async () => {
    const result = await runMemoryCurator({
      workspacePath: '/ws',
      currentMd,
      material: '   ',
      settings,
      lang: 'zh-CN',
    });
    expect(result.kind).toBe('nochange');
    expect(runCompactorSessionMock).not.toHaveBeenCalled();
  });

  it('模型抛错 → failed（不上抛）', async () => {
    runCompactorSessionMock.mockRejectedValue(new Error('provider 500'));
    const result = await runMemoryCurator({
      workspacePath: '/ws',
      currentMd,
      material: 'User: x\nAssistant: y',
      settings,
      lang: 'zh-CN',
    });
    expect(result.kind).toBe('failed');
  });

  it('AbortError 原样上抛（全仓取消约定）', async () => {
    runCompactorSessionMock.mockRejectedValue(new DOMException('aborted', 'AbortError'));
    await expect(
      runMemoryCurator({
        workspacePath: '/ws',
        currentMd,
        material: 'User: x\nAssistant: y',
        settings,
        lang: 'zh-CN',
      })
    ).rejects.toThrow('aborted');
  });

  it('abortSignal 已中止 → 写盘前中止（不落盘，AbortError 上抛）', async () => {
    const updatedMd = `${currentMd}- 端口固定 5432\n`;
    runCompactorSessionMock.mockResolvedValue({ content: updatedMd });
    invokeMock.mockImplementation(async (cmd) =>
      cmd === 'read_text_file' ? { content: currentMd } : {}
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      runMemoryCurator({
        workspacePath: '/ws',
        currentMd,
        material: 'User: 端口是 5432\nAssistant: 已确认',
        settings,
        lang: 'zh-CN',
        abortSignal: controller.signal,
      })
    ).rejects.toThrow('aborted');
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === 'write_text_file')).toBe(false);
  });
});
