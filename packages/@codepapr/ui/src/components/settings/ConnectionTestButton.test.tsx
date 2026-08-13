// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionTestButton } from './ConnectionTestButton';

const labels = {
  idle: '测试',
  connecting: '测试中...',
  success: '连接成功',
  failedPrefix: '连接失败',
};

describe('ConnectionTestButton', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('测试成功后展示成功提示', async () => {
    const onTest = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      root.render(<ConnectionTestButton onTest={onTest} labels={labels} />);
    });

    const button = container.querySelector('button');
    expect(button?.textContent).toContain('测试');

    await act(async () => {
      button?.click();
    });

    expect(onTest).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('连接成功');
  });

  it('测试失败时展示错误信息', async () => {
    const onTest = vi.fn().mockRejectedValue(new Error('boom'));
    await act(async () => {
      root.render(<ConnectionTestButton onTest={onTest} labels={labels} />);
    });

    await act(async () => {
      container.querySelector('button')?.click();
    });

    expect(container.textContent).toContain('连接失败: boom');
  });
});
