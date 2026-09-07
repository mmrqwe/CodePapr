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
  const handleAllowOnce = () => respondToExternalAccess(true, 'file');
  const handleDeny = () => respondToExternalAccess(false, 'file');

  const operationLabel =
    pendingRequest.operation === 'read'
      ? '读取'
      : pendingRequest.operation === 'list'
        ? '列出目录'
        : pendingRequest.operation === 'write'
          ? '写入'
          : '执行命令';

  if (pendingRequest.kind === 'dangerousCommand') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 backdrop-blur-sm">
        <div className="flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-line bg-base shadow-2xl">
          <div className="border-b border-line px-5 py-4">
            <h2 className="text-sm font-semibold text-danger">高危命令确认</h2>
          </div>
          <div className="px-5 py-4">
            <p className="mb-3 text-sm leading-relaxed text-fg-soft">
              Agent 请求执行一条破坏性命令。批准后系统会先自动创建检查点（可随时回滚），再执行该命令；批准仅对本次调用生效。
            </p>
            {pendingRequest.reason && (
              <p className="mb-3 rounded-lg border border-danger-bg bg-base px-3 py-2 text-xs leading-relaxed text-danger">
                {pendingRequest.reason}
              </p>
            )}
            <div className="mb-1 rounded-lg border border-line bg-deep px-3 py-2.5">
              <code className="break-all text-xs text-fg">{pendingRequest.command ?? pendingRequest.path}</code>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
            <button
              type="button"
              onClick={handleDeny}
              className="rounded-lg border border-line bg-transparent px-3.5 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:border-danger-bg hover:text-danger"
            >
              拒绝
            </button>
            <button
              type="button"
              onClick={handleAllowOnce}
              className="rounded-lg bg-info-bg border border-info-bg px-3.5 py-1.5 text-xs font-medium text-info transition-colors hover:bg-info-bg hover:border-info-bg"
            >
              允许本次执行
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 backdrop-blur-sm">
      <div className="flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-line bg-base shadow-2xl">
        <div className="border-b border-line px-5 py-4">
          <h2 className="text-sm font-semibold text-fg">外部文件访问</h2>
        </div>
        <div className="px-5 py-4">
          <p className="mb-3 text-sm leading-relaxed text-fg-soft">
            CodePapr 请求{operationLabel}项目外的路径：
          </p>
          <div className="mb-4 rounded-lg border border-line bg-deep px-3 py-2.5">
            <code className="break-all text-xs text-info">{pendingRequest.path}</code>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
          <button
            type="button"
            onClick={handleDeny}
            className="rounded-lg border border-line bg-transparent px-3.5 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:border-danger-bg hover:text-danger"
          >
            拒绝
          </button>
          {pendingRequest.operation !== 'list' && pendingRequest.allowFile !== false && (
            <button
              type="button"
              onClick={handleAllowFile}
              className="rounded-lg border border-line bg-transparent px-3.5 py-1.5 text-xs font-medium text-fg-soft transition-colors hover:border-info-bg hover:text-info"
            >
              允许此文件
            </button>
          )}
          <button
            type="button"
            onClick={handleAllowDirectory}
            className="rounded-lg bg-info-bg border border-info-bg px-3.5 py-1.5 text-xs font-medium text-info transition-colors hover:bg-info-bg hover:border-info-bg"
          >
            允许此文件夹
          </button>
        </div>
      </div>
    </div>
  );
}
