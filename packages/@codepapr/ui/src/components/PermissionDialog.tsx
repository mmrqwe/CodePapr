import { useEffect } from 'react';
import { usePermissionStore } from '../store/permissionStore';

export function PermissionDialog() {
  const pendingRequest = usePermissionStore((s) => s.pendingRequest);
  const respondToExternalAccess = usePermissionStore((s) => s.respondToExternalAccess);
  const hydratePolicy = usePermissionStore((s) => s.hydratePolicy);

  useEffect(() => {
    void hydratePolicy();
  }, [hydratePolicy]);

  if (!pendingRequest) return null;

  const handleAllowDirectory = () => respondToExternalAccess(true, 'directory');
  const handleAllowFile = () => respondToExternalAccess(true, 'file');
  const handleDeny = () => respondToExternalAccess(false, 'file');

  const operationLabel =
    pendingRequest.operation === 'read'
      ? '读取'
      : pendingRequest.operation === 'list'
        ? '列出目录'
        : pendingRequest.operation === 'write'
          ? '写入'
          : '执行命令';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-[#2a2d3a] bg-[#161922] shadow-2xl">
        <div className="border-b border-[#2a2d3a] px-5 py-4">
          <h2 className="text-sm font-semibold text-slate-200">外部文件访问</h2>
        </div>
        <div className="px-5 py-4">
          <p className="mb-3 text-sm leading-relaxed text-slate-300">
            CodePapr 请求{operationLabel}项目外的路径：
          </p>
          <div className="mb-4 rounded-lg border border-[#2a2d3a] bg-[#0d0f15] px-3 py-2.5">
            <code className="break-all text-xs text-cyan-400">{pendingRequest.path}</code>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[#2a2d3a] px-5 py-3">
          <button
            type="button"
            onClick={handleDeny}
            className="rounded-lg border border-[#2a2d3a] bg-transparent px-3.5 py-1.5 text-xs font-medium text-slate-400 transition-colors hover:border-red-500/40 hover:text-red-400"
          >
            拒绝
          </button>
          {pendingRequest.operation !== 'list' && pendingRequest.allowFile !== false && (
            <button
              type="button"
              onClick={handleAllowFile}
              className="rounded-lg border border-[#2a2d3a] bg-transparent px-3.5 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:border-cyan-500/40 hover:text-cyan-300"
            >
              允许此文件
            </button>
          )}
          <button
            type="button"
            onClick={handleAllowDirectory}
            className="rounded-lg bg-cyan-600/20 border border-cyan-500/30 px-3.5 py-1.5 text-xs font-medium text-cyan-300 transition-colors hover:bg-cyan-600/35 hover:border-cyan-500/50"
          >
            允许此文件夹
          </button>
        </div>
      </div>
    </div>
  );
}
