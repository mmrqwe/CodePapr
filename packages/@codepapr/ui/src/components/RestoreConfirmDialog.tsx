import { useState, useEffect } from 'react';
import type { RestorePlan, RestoreResult } from '../utils/snapshot';
import { restorePlan, restoreExecute } from '../utils/snapshot';

interface RestoreConfirmDialogProps {
  workspacePath: string;
  targetSha: string;
  targetLabel: string;
  lang: 'zh-CN' | 'zh-TW' | 'en';
  onConfirm: (result: RestoreResult) => void;
  onCancel: () => void;
}

export function RestoreConfirmDialog({
  workspacePath,
  targetSha,
  targetLabel,
  lang,
  onConfirm,
  onCancel,
}: RestoreConfirmDialogProps) {
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    restorePlan(workspacePath, targetSha)
      .then((p) => {
        if (!cancelled) {
          setPlan(p);
          setPlanError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setPlanError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [workspacePath, targetSha]);

  const handleConfirm = async () => {
    setExecuting(true);
    try {
      const result = await restoreExecute(workspacePath, targetSha);
      onConfirm(result);
    } catch (err) {
      onConfirm({
        ok: false,
        filesRestored: 0,
        filesDeleted: 0,
        backupRef: null,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setExecuting(false);
    }
  };

  const t = {
    title: lang === 'en' ? 'Restore to checkpoint' : lang === 'zh-TW' ? '恢復到檢查點' : '恢复到检查点',
    loading: lang === 'en' ? 'Loading restore plan...' : lang === 'zh-TW' ? '正在計算恢復計劃...' : '正在计算恢复计划...',
    error: lang === 'en' ? 'Failed to load plan' : lang === 'zh-TW' ? '載入計劃失敗' : '加载计划失败',
    willRestore: lang === 'en' ? 'Files to restore' : lang === 'zh-TW' ? '將恢復的檔案' : '将恢复的文件',
    willDelete: lang === 'en' ? 'Files to delete' : lang === 'zh-TW' ? '將刪除的檔案' : '将删除的文件',
    unchanged: lang === 'en' ? 'Unchanged' : lang === 'zh-TW' ? '不變' : '不变',
    details: lang === 'en' ? 'Show details' : lang === 'zh-TW' ? '查看詳情' : '查看详情',
    hide: lang === 'en' ? 'Hide' : lang === 'zh-TW' ? '收起' : '收起',
    warning: lang === 'en'
      ? 'This will roll back code to the snapshot state. Untracked files are not affected. You can undo via the backup reference.'
      : lang === 'zh-TW'
      ? '這將回滾程式碼到快照狀態。未追蹤的檔案不受影響。可通過備份引用撤銷。'
      : '这将回滚代码到快照状态。未跟踪的文件不受影响。可通过备份引用撤销。',
    cancel: lang === 'en' ? 'Cancel' : '取消',
    confirm: lang === 'en' ? 'Confirm Restore' : lang === 'zh-TW' ? '確認恢復' : '确认恢复',
    executing: lang === 'en' ? 'Restoring...' : lang === 'zh-TW' ? '恢復中...' : '恢复中...',
  };

  if (loading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay">
        <div className="mx-4 w-full max-w-md rounded-2xl border border-line bg-base p-6 shadow-2xl">
          <p className="text-sm text-fg-muted">{t.loading}</p>
        </div>
      </div>
    );
  }

  if (planError) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay" onClick={onCancel}>
        <div className="mx-4 w-full max-w-md rounded-2xl border border-danger-bg bg-base p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
          <p className="mb-3 text-sm text-danger">{t.error}</p>
          <p className="mb-4 text-xs text-fg-muted">{planError}</p>
          <div className="flex justify-end">
            <button onClick={onCancel} className="rounded-lg border border-line px-4 py-2 text-xs text-fg-muted hover:border-line-strong hover:text-fg">
              {t.cancel}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const restoreCount = plan?.filesToRestore.length ?? 0;
  const deleteCount = plan?.filesToDelete.length ?? 0;
  const unchangedCount = plan?.filesUnchanged ?? 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay" onClick={() => !executing && onCancel()}>
      <div
        className="mx-4 w-full max-w-lg rounded-2xl border border-line bg-base p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-1 text-sm font-medium text-fg">{t.title}</h3>
        <p className="mb-4 truncate text-xs text-fg-muted">{targetLabel}</p>

        <div className="mb-4 space-y-1.5 text-xs">
          <div className="flex items-center gap-2 text-ok">
            <span>↻</span>
            <span>{t.willRestore}: <span className="font-medium">{restoreCount}</span></span>
          </div>
          {deleteCount > 0 && (
            <div className="flex items-center gap-2 text-danger">
              <span>✗</span>
              <span>{t.willDelete}: <span className="font-medium">{deleteCount}</span></span>
            </div>
          )}
          <div className="flex items-center gap-2 text-fg-muted">
            <span>-</span>
            <span>{t.unchanged}: <span className="font-medium">{unchangedCount}</span></span>
          </div>
        </div>

        <button
          onClick={() => setShowDetails(!showDetails)}
          className="mb-3 text-[10px] text-accent hover:text-accent-text"
        >
          {showDetails ? t.hide : t.details}
        </button>

        {showDetails && plan && (
          <div className="mb-4 max-h-48 overflow-y-auto rounded-lg border border-line bg-base p-3">
            {plan.filesToRestore.map((f, i) => (
              <div key={i} className="flex items-center gap-2 py-0.5 text-[10px]">
                <span className={`w-4 ${f.status === 'A' ? 'text-ok' : f.status === 'D' ? 'text-danger' : 'text-warn'}`}>
                  {f.status}
                </span>
                <span className="truncate text-fg-muted">{f.path}</span>
                {(f.additions > 0 || f.deletions > 0) && (
                  <span className="ml-auto text-fg-dim">+{f.additions} -{f.deletions}</span>
                )}
              </div>
            ))}
          </div>
        )}

        <p className="mb-4 text-[10px] leading-relaxed text-warn">{t.warning}</p>

        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={executing}
            className="rounded-lg border border-line px-4 py-2 text-xs text-fg-muted transition-colors hover:border-line-strong hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t.cancel}
          </button>
          <button
            onClick={handleConfirm}
            disabled={executing}
            className="rounded-lg bg-danger px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-danger disabled:cursor-not-allowed disabled:opacity-60"
          >
            {executing ? t.executing : t.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
