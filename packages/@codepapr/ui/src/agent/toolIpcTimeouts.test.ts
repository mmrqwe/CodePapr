import { describe, expect, it } from 'vitest';
import {
  resolveToolIpcTimeoutMs,
  resolveGraphIpcTimeoutMs,
  TOOL_IPC_TIMEOUT_MS,
} from './toolIpcTimeouts';

describe('resolveToolIpcTimeoutMs', () => {
  it('extends the IPC timeout from the LLM-facing `timeout` argument', () => {
    // 修复回归的核心断言：LLM 传 timeout=300，IPC 必须放宽到 315s，
    // 而不是被 120s 基础值掐死。
    expect(resolveToolIpcTimeoutMs('bash', { command: 'x', timeout: 300 }, TOOL_IPC_TIMEOUT_MS)).toBe(315_000);
    expect(resolveToolIpcTimeoutMs('bash', { command: 'x', timeout: 600 }, TOOL_IPC_TIMEOUT_MS)).toBe(615_000);
    expect(resolveToolIpcTimeoutMs('bash', { command: 'x', timeout: 120 }, TOOL_IPC_TIMEOUT_MS)).toBe(135_000);
  });

  it('falls back to timeoutSeconds for internal callers', () => {
    expect(resolveToolIpcTimeoutMs('bash', { command: 'x', timeoutSeconds: 120 }, TOOL_IPC_TIMEOUT_MS)).toBe(135_000);
    // timeout 优先于 timeoutSeconds
    expect(
      resolveToolIpcTimeoutMs('bash', { command: 'x', timeout: 300, timeoutSeconds: 60 }, TOOL_IPC_TIMEOUT_MS)
    ).toBe(315_000);
  });

  it('keeps the base floor when the requested timeout is small or absent', () => {
    // 默认 30s：45s < 120s 基础值 → 取基础值
    expect(resolveToolIpcTimeoutMs('bash', { command: 'x' }, TOOL_IPC_TIMEOUT_MS)).toBe(TOOL_IPC_TIMEOUT_MS);
    expect(resolveToolIpcTimeoutMs('bash', { command: 'x', timeout: 30 }, TOOL_IPC_TIMEOUT_MS)).toBe(TOOL_IPC_TIMEOUT_MS);
    expect(resolveToolIpcTimeoutMs('bash', { command: 'x', timeout: 10 }, TOOL_IPC_TIMEOUT_MS)).toBe(TOOL_IPC_TIMEOUT_MS);
  });

  it('clamps garbage and out-of-range values to Rust bounds (1-600s)', () => {
    expect(resolveToolIpcTimeoutMs('bash', { command: 'x', timeout: 'long' }, TOOL_IPC_TIMEOUT_MS)).toBe(TOOL_IPC_TIMEOUT_MS);
    expect(resolveToolIpcTimeoutMs('bash', { command: 'x', timeout: 0 }, TOOL_IPC_TIMEOUT_MS)).toBe(TOOL_IPC_TIMEOUT_MS);
    expect(resolveToolIpcTimeoutMs('bash', { command: 'x', timeout: 9999 }, TOOL_IPC_TIMEOUT_MS)).toBe(615_000);
  });

  it('leaves non-bash tools on the base value', () => {
    expect(resolveToolIpcTimeoutMs('read', { relativePath: 'a' }, 42_000)).toBe(42_000);
    expect(resolveToolIpcTimeoutMs('graph', { action: 'full' }, 42_000)).toBe(42_000);
  });

  it('honours a custom base (toolIpcTimeoutMs setting)', () => {
    expect(resolveToolIpcTimeoutMs('bash', { command: 'x', timeout: 30 }, 300_000)).toBe(300_000);
    expect(resolveToolIpcTimeoutMs('bash', { command: 'x', timeout: 300 }, 300_000)).toBe(315_000);
  });
});

describe('resolveGraphIpcTimeoutMs', () => {
  it('aligns the IPC ceiling with the configured graph timeout', () => {
    expect(resolveGraphIpcTimeoutMs(TOOL_IPC_TIMEOUT_MS, 600_000)).toBe(615_000);
    expect(resolveGraphIpcTimeoutMs(TOOL_IPC_TIMEOUT_MS, 300_000)).toBe(315_000);
  });

  it('keeps the IPC base when graph timeout is unset or smaller', () => {
    expect(resolveGraphIpcTimeoutMs(TOOL_IPC_TIMEOUT_MS, undefined)).toBe(TOOL_IPC_TIMEOUT_MS);
    expect(resolveGraphIpcTimeoutMs(TOOL_IPC_TIMEOUT_MS, 60_000)).toBe(TOOL_IPC_TIMEOUT_MS);
  });
});
