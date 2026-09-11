import { useEffect, useMemo, useState } from 'react';
import { estimateTokens } from '@codepapr/common';
import { getTranslation, type Lang } from '../utils/i18n';
import {
  MEMORY_MD_MAX_LINES,
  MEMORY_MD_MAX_TOKENS,
  buildMemoryMdTemplate,
  readMemoryMd,
  requestMemoryMdWrite,
  toMemoryMdLang,
} from '../utils/memoryFile';
import { getLastCuratorOutcome } from '../store/internals/memoryTurnPipeline';

interface MemoryFilePanelProps {
  workspacePath: string;
  lang?: Lang;
}

function describeReason(
  reason: string,
  t: ReturnType<typeof getTranslation>
): string {
  if (reason === 'empty') return t.memoryFileRejectEmpty;
  if (reason === 'secrets') return t.memoryFileRejectSecrets;
  if (reason === 'max-tokens') return t.memoryFileRejectMaxTokens;
  if (reason === 'max-lines') return t.memoryFileRejectMaxLines;
  if (reason === 'concurrent-change') return t.memoryFileConflict;
  if (reason.startsWith('risk:')) return t.memoryFileRejectRisk;
  if (reason.startsWith('mass-drop:')) return t.memoryFileRejectMassDrop;
  if (reason.startsWith('write-failed:')) return reason.slice('write-failed:'.length);
  return reason;
}

/**
 * 项目记忆（v5）：MEMORY.md 编辑器。
 *
 * 文件由后台记忆管家在「交付 / 压缩前」两个卡点自动维护；这里提供人工通道：
 * 直接编辑、保存（过同一道机械门：密钥/风险/尺寸/丢行守卫）、冲突检测
 * （后台或外部已改动 → 拒绝保存并提示重新加载）。保存后下一回合生效。
 */
export function MemoryFilePanel({ workspacePath, lang }: MemoryFilePanelProps) {
  const t = getTranslation(lang);
  const mdLang = toMemoryMdLang(lang);
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [curatorTick, setCuratorTick] = useState(0);

  const load = async () => {
    setLoading(true);
    setError(null);
    setNotice(null);
    setConflict(false);
    try {
      const content = await readMemoryMd(workspacePath);
      setSaved(content);
      setDraft(content ?? buildMemoryMdTemplate(mdLang));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setCuratorTick((tick) => tick + 1);
    }
  };

  useEffect(() => {
    void load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 面板按工作区重载
  }, [workspacePath]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    setConflict(false);
    try {
      const result = await requestMemoryMdWrite(workspacePath, draft, {
        expectedContent: saved,
        origin: 'panel',
      });
      if (result.stale) {
        setConflict(true);
        return;
      }
      if (!result.ok) {
        setError(`${t.memoryFileSaveRejected}：${result.reasons.map((r) => describeReason(r, t)).join('；')}`);
        return;
      }
      setSaved(draft);
      setNotice(t.memoryFileSaved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
      setCuratorTick((tick) => tick + 1);
    }
  };

  const curator = useMemo(
    () => getLastCuratorOutcome(workspacePath),
    // curatorTick 用于「加载/保存后」刷新管家状态（模块状态，无订阅）。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 事件驱动刷新
    [workspacePath, curatorTick]
  );

  const dirty = saved === null ? draft.trim().length > 0 : draft !== saved;
  const lineCount = draft.split(/\r?\n/).length;
  const tokenCount = estimateTokens(draft);
  const overBudget = lineCount > MEMORY_MD_MAX_LINES || tokenCount > MEMORY_MD_MAX_TOKENS;

  const curatorText = (() => {
    if (!curator) return t.memoryFileCuratorIdle;
    switch (curator.kind) {
      case 'updated':
        return t.memoryFileCuratorUpdated.replace(
          '{{time}}',
          new Date(curator.at).toLocaleTimeString()
        );
      case 'rejected':
        return t.memoryFileCuratorRejected.replace(
          '{{reasons}}',
          (curator.reasons ?? []).map((r) => describeReason(r, t)).join('；')
        );
      case 'failed':
        return t.memoryFileCuratorFailed;
      case 'timeout':
        return t.memoryFileCuratorTimeout;
      default:
        return t.memoryFileCuratorIdle;
    }
  })();

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain p-4 scrollbar-thin scrollbar-stable">
      <p className="text-[11px] leading-relaxed text-fg-muted">{t.memoryFileHint}</p>

      {error ? (
        <p className="rounded-lg border border-warn-bg bg-warn-bg/10 px-3 py-2 text-xs text-warn">
          {t.memoryFileLoadError}: {error}
        </p>
      ) : null}
      {notice ? (
        <p className="rounded-lg border border-accent-soft bg-accent-soft/10 px-3 py-2 text-xs text-accent-text">
          {notice}
        </p>
      ) : null}
      {conflict ? (
        <p className="rounded-lg border border-warn-bg bg-warn-bg/10 px-3 py-2 text-xs text-warn">
          {t.memoryFileConflict}
        </p>
      ) : null}

      {loading ? (
        <p className="p-6 text-center text-xs text-fg-muted">{t.memoryFileLoading}</p>
      ) : (
        <>
          <div className="flex items-center gap-2 text-[11px] text-fg-muted">
            <span className={overBudget ? 'text-warn' : undefined}>
              {t.memoryFileBudget
                .replace('{{lines}}', String(lineCount))
                .replace('{{maxLines}}', String(MEMORY_MD_MAX_LINES))
                .replace('{{tokens}}', String(tokenCount))
                .replace('{{maxTokens}}', String(MEMORY_MD_MAX_TOKENS))}
            </span>
            <span className="ml-auto flex gap-1">
              <button
                type="button"
                disabled={!dirty || saving}
                onClick={() => void save()}
                className="rounded-md border border-accent-soft px-2 py-0.5 text-[10px] font-medium text-accent-text disabled:opacity-40"
              >
                {t.memoryFileSave}
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void load()}
                className="rounded-md border border-line px-2 py-0.5 text-[10px] font-medium text-fg-dim transition-colors hover:border-slate-500 hover:text-fg-soft disabled:opacity-40"
              >
                {t.memoryFileReload}
              </button>
            </span>
          </div>

          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            rows={16}
            aria-label={t.memoryFileTitle}
            className="min-h-[320px] w-full flex-1 resize-y rounded-lg border border-line bg-base px-3 py-2 font-mono text-xs leading-relaxed text-fg-soft"
          />
        </>
      )}

      <p className="text-[11px] leading-relaxed text-fg-muted">
        {t.memoryFileCuratorLabel}：{curatorText}
      </p>
    </div>
  );
}
