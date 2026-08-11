// 工具 IPC 超时解析（纯函数，独立成模块以便单测；worker 与主线程共用语义）。

export const TOOL_IPC_TIMEOUT_MS = 120_000;
// bash 命令最长 600s（Rust MAX_COMMAND_SECONDS）。IPC 超时必须覆盖命令本身的
// 最长运行时间，否则命令还在合法运行、IPC 先超时；配合超时即发 cancel-tool-request，
// 确保超时 = 中止主线程执行，而不是抛弃后让它继续跑完（副作用滞后落地）。
export const BASH_COMMAND_MAX_SECONDS = 600;
export const BASH_IPC_MARGIN_MS = 15_000;

/** 按工具解析 IPC 超时：bash 按其请求的 timeout（LLM 侧参数名，dispatcher 在
 *  执行时才映射成 timeoutSeconds；两者都兼容，默认 30s，Rust 钳制 1-600s）
 *  放宽并留余量；其余工具用基础值。 */
export function resolveToolIpcTimeoutMs(
  toolName: string,
  args: Record<string, unknown>,
  baseMs: number
): number {
  if (toolName !== 'bash') {
    return baseMs;
  }
  const requested =
    typeof args.timeout === 'number' && Number.isFinite(args.timeout)
      ? args.timeout
      : typeof args.timeoutSeconds === 'number' && Number.isFinite(args.timeoutSeconds)
        ? args.timeoutSeconds
        : 30;
  const commandMs = Math.min(Math.max(requested, 1), BASH_COMMAND_MAX_SECONDS) * 1000;
  return Math.max(baseMs, commandMs + BASH_IPC_MARGIN_MS);
}

/** graph 构建可远超默认 IPC 120s：IPC 层必须与 Agent 级 graphToolTimeoutMs
 *  对齐（默认 600s），否则 120s 定时器先于配置的超时开火，误杀大仓库构建。 */
export function resolveGraphIpcTimeoutMs(
  toolIpcTimeoutMs: number,
  graphToolTimeoutMs: number | undefined
): number {
  return Math.max(toolIpcTimeoutMs, (graphToolTimeoutMs ?? 0) + BASH_IPC_MARGIN_MS);
}
