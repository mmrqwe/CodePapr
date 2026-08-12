import { useMcpConfirmStore } from '../store/mcpConfirmStore';

function formatArguments(args: unknown): string {
  if (args === null || args === undefined) return '';
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

export function McpConfirmDialog() {
  const pendingConfirm = useMcpConfirmStore((s) => s.pendingConfirm);
  const respondToConfirm = useMcpConfirmStore((s) => s.respondToConfirm);

  if (!pendingConfirm) return null;

  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="flex w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-[#2a2d3a] bg-[#161922] shadow-2xl">
        <div className="border-b border-[#2a2d3a] px-5 py-4">
          <h2 className="text-sm font-semibold text-slate-200">MCP 高风险操作确认</h2>
        </div>
        <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto px-5 py-4">
          <p className="text-sm leading-relaxed text-slate-300">
            MCP 服务
            <span className="mx-1 text-indigo-300">{pendingConfirm.serverName}</span>
            请求执行工具：
          </p>
          <div className="rounded-lg border border-[#2a2d3a] bg-[#0d0f15] px-3 py-2.5">
            <code className="break-all text-xs text-cyan-400">{pendingConfirm.toolName}</code>
          </div>
          {Object.keys(pendingConfirm.arguments ?? {}).length > 0 && (
            <pre className="max-h-56 overflow-auto rounded-lg border border-[#2a2d3a] bg-[#0d0f15] p-3 text-xs text-slate-300">
              {formatArguments(pendingConfirm.arguments)}
            </pre>
          )}
          <p className="text-[11px] leading-relaxed text-slate-500">
            允许后将立即执行该工具；拒绝则本次调用以“被用户拒绝”结束。
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[#2a2d3a] px-5 py-3">
          <button
            type="button"
            onClick={() => respondToConfirm(false)}
            className="rounded-lg border border-[#2a2d3a] bg-transparent px-3.5 py-1.5 text-xs font-medium text-slate-400 transition-colors hover:border-red-500/40 hover:text-red-400"
          >
            拒绝
          </button>
          <button
            type="button"
            onClick={() => respondToConfirm(true)}
            className="rounded-lg bg-indigo-600/20 border border-indigo-500/30 px-3.5 py-1.5 text-xs font-medium text-indigo-300 transition-colors hover:bg-indigo-600/35 hover:border-indigo-500/50"
          >
            允许
          </button>
        </div>
      </div>
    </div>
  );
}
