import { memo, useState } from 'react';
import type { UIMessage } from '../../store/agentStore';
import type { TaskChecklist as TaskChecklistType } from '../../utils/taskChecklistTypes';
import { type Lang, getTranslation } from '../../utils/i18n';
import { type RoundWindow } from '../../utils/messageWindow';
import { type SubAgentRun } from '../../utils/subagentProgress';
import { type PlanFollowUpAction } from '../../utils/planMode';
import { type ExecutionProcessGroup } from './utils';
import { MessageBubble } from './MessageBubble';
import { ExecutionProcessPanel } from './ExecutionProcessPanel';
import { TaskChecklist } from '../TaskChecklist';

interface MessageListProps {
  deferMessages: boolean;
  effectiveRoundWindow: RoundWindow;
  totalRounds: number;
  sessionMessagesLoading: boolean;
  visibleMessagesCount: number;
  isConfigured: boolean;
  t: ReturnType<typeof getTranslation>;
  topSpacerHeight: number;
  bottomSpacerHeight: number;
  subagentRuns: SubAgentRun[];
  renderedMessages: UIMessage[];
  tailExecutionProcessGroup: ExecutionProcessGroup | null;
  latestPlanAssistantMessageId: string | null;
  tailMessageId: string | null;
  lang: Lang;
  isLoading: boolean;
  onPlanAction: (action: PlanFollowUpAction) => void;
  onOpenWorkspacePath?: (path: string) => void;
  onPreviewImage: (src: string) => void;
  characterAvatar?: string | null;
  characterName?: string | null;
  messageCheckpoints: Record<string, { sha: string; sessionId: string }>;
  gitReady: boolean;
  onTtsReplay: (text: string) => void;
  onRequestReset: (msgId: string) => void;
  activeSessionId: string | null;
  taskChecklists: Record<string, TaskChecklistType | null>;
  isActiveLoading: boolean;
  hasStreamingMessage: boolean;
  onShowSettings: (v: boolean) => void;
  onSlideWindow: (dir: 'up' | 'down') => void;
  onToggleSubagentCollapse: (index: number) => void;
}

/**
 * 消息列表渲染（memo）：props 全部是稳定引用/原语——输入框按键只会重渲染
 * ChatPanel 外壳，列表及其中的 Markdown 解析完全跳过。列表自身的悬停状态
 * 放在内部，悬停只重渲染列表本身。
 */
export const MessageList = memo(function MessageList({
  deferMessages,
  effectiveRoundWindow,
  totalRounds,
  sessionMessagesLoading,
  visibleMessagesCount,
  isConfigured,
  t,
  topSpacerHeight,
  bottomSpacerHeight,
  subagentRuns,
  renderedMessages,
  tailExecutionProcessGroup,
  latestPlanAssistantMessageId,
  tailMessageId,
  lang,
  isLoading,
  onPlanAction,
  onOpenWorkspacePath,
  onPreviewImage,
  characterAvatar,
  characterName,
  messageCheckpoints,
  gitReady,
  onTtsReplay,
  onRequestReset,
  activeSessionId,
  taskChecklists,
  isActiveLoading,
  hasStreamingMessage,
  onShowSettings,
  onSlideWindow,
  onToggleSubagentCollapse,
}: MessageListProps) {
  const [hoveredActionMsgId, setHoveredActionMsgId] = useState<string | null>(null);

  return (
    <>
      {topSpacerHeight > 0 && (
        <div aria-hidden style={{ height: topSpacerHeight }} />
      )}
      {!deferMessages && effectiveRoundWindow.lo > 0 && (
        <div className="mb-3 flex justify-center">
          <button
            type="button"
            onClick={() => onSlideWindow('up')}
            className="rounded-full border border-[#2a2d3a] bg-[#10131b] px-4 py-1.5 text-xs text-slate-400 transition-colors hover:border-indigo-500/50 hover:text-slate-200"
          >
            {t.chatLoadEarlierRounds.replace('{n}', String(effectiveRoundWindow.lo))}
          </button>
        </div>
      )}
      {!deferMessages && sessionMessagesLoading && visibleMessagesCount === 0 && (
        <div className="flex flex-col items-center justify-center h-full text-slate-600 select-none">
          <div className="h-5 w-5 mb-3 animate-spin rounded-full border-2 border-slate-700 border-t-indigo-400" />
          <p className="text-xs">{t.loadingSessionMessages}</p>
        </div>
      )}
      {!deferMessages && !sessionMessagesLoading && visibleMessagesCount === 0 && (
        <div className="flex flex-col items-center justify-center h-full text-slate-600 select-none">
          <div className="text-4xl mb-3">⌘</div>
          <p className="text-sm">CodePapr</p>
          <p className="text-xs mt-1">
            {isConfigured ? t.welcomeDescConfigured : t.confirmSettings}
          </p>
          {!isConfigured && (
            <button
              onClick={() => onShowSettings(true)}
              className="mt-4 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
            >
              {t.toSettings}
            </button>
          )}
        </div>
      )}
      {!deferMessages && subagentRuns.map((run, idx) => (
        <div key={idx} className="mx-3 mb-3 rounded-xl border border-cyan-500/20 bg-[#0b0d12]/60 overflow-hidden">
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left transition-colors hover:bg-[#0f141d]/50"
            onClick={() => onToggleSubagentCollapse(idx)}
          >
            <span className={`inline-block h-2 w-2 rounded-full flex-shrink-0 ${run.state === 'running' ? 'animate-pulse bg-cyan-400' : 'bg-emerald-400'}`} />
            <span className="flex-1 min-w-0">
              <span className="text-xs font-semibold text-cyan-300">
                {run.agent === 'explore' ? (run.state === 'running' ? 'Explore 正在分析代码...' : 'Explore 分析完成') :
                 run.agent === 'scout' ? (run.state === 'running' ? 'Scout 正在搜索网络...' : 'Scout 搜索完成') :
                 run.agent === 'mentor' ? (run.state === 'running' ? 'Mentor 正在思考...' : 'Mentor 思考完成') :
                 (run.state === 'running' ? `${run.agent} 正在执行...` : `${run.agent} 执行完成`)}
              </span>
              {run.prompt && (
                <span className="block mt-0.5 text-[11px] text-slate-500 truncate">{run.prompt}</span>
              )}
            </span>
            <span className="text-[9px] text-slate-600 transition-transform flex-shrink-0" style={{ transform: run.collapsed ? 'rotate(-90deg)' : 'none' }}>
              ▼
            </span>
          </button>
          {!run.collapsed && (
            <div className="border-t border-cyan-500/10 px-3.5 py-2.5">
              {run.content && run.state === 'completed' && (
                <div className="mb-2 max-h-32 overflow-y-auto rounded-lg bg-[#0d1118] px-3 py-2 text-[11px] leading-relaxed text-slate-400 whitespace-pre-wrap">
                  {run.content.length > 600 ? `${run.content.slice(0, 600)}...` : run.content}
                </div>
              )}
              {run.steps.length > 0 && (
                <div className="space-y-0.5">
                  {run.steps.map((step, i) => (
                    <div key={i} className="flex items-center gap-2 text-[10px]">
                      <span className={step.status === 'error' ? 'text-red-400' : 'text-emerald-400'}>
                        {step.status === 'error' ? '✗' : '✓'}
                      </span>
                      <span className="font-mono text-slate-400">{step.name}</span>
                      {step.summary && step.summary !== step.name && (
                        <span className="truncate text-slate-500">· {step.summary}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
      {!deferMessages && renderedMessages.map((m) => {
        const isUserMsg = m.role === 'user';
        const canShowActions = isUserMsg && !isLoading;

        const bubble = m.id === tailExecutionProcessGroup?.summaryMessageId ? (
          <div key={`process-group:${tailExecutionProcessGroup.summaryMessageId}`}>
            <ExecutionProcessPanel
              group={tailExecutionProcessGroup}
              lang={lang}
              onOpenWorkspacePath={onOpenWorkspacePath}
            />
            <MessageBubble
              msg={m}
              lang={lang}
              showPlanActions={m.id === latestPlanAssistantMessageId && m.id === tailMessageId}
              planActionsDisabled={isLoading}
              onPlanAction={onPlanAction}
              onOpenWorkspacePath={onOpenWorkspacePath}
              onPreviewImage={onPreviewImage}
              characterAvatar={characterAvatar ?? undefined}
              characterName={characterName ?? undefined}
            />
          </div>
        ) : (
          <MessageBubble
            key={m.id}
            msg={m}
            lang={lang}
            showPlanActions={m.id === latestPlanAssistantMessageId && m.id === tailMessageId}
            planActionsDisabled={isLoading}
            onPlanAction={onPlanAction}
            onOpenWorkspacePath={onOpenWorkspacePath}
            onPreviewImage={onPreviewImage}
            characterAvatar={characterAvatar ?? undefined}
            characterName={characterName ?? undefined}
          />
        );

        if (!canShowActions) {
          return (
            <div key={m.id} data-window-item data-message-id={m.id}>
              {bubble}
            </div>
          );
        }

        const hasCheckpoint = Boolean(messageCheckpoints[m.id]);
        const canReset = hasCheckpoint && gitReady;
        const isHover = hoveredActionMsgId === m.id;
        const resetLabel = lang === 'en' ? 'Reset to here' : lang === 'zh-TW' ? '重設到此' : '重置到此点';
        const copyLabel = lang === 'en' ? 'Copy' : '复制';
        const noCheckpointTip = !gitReady
          ? (lang === 'en'
              ? 'Code reset is initializing or unavailable for this workspace.'
              : lang === 'zh-TW'
              ? '程式碼重設正在初始化，或目前工作區不可用。'
              : '代码重置正在初始化，或当前工作区不可用。')
          : (lang === 'en'
              ? 'No code snapshot for this message; cannot reset code.'
              : lang === 'zh-TW'
              ? '此訊息沒有程式碼快照，無法重置程式碼。'
              : '此消息没有代码快照，无法重置代码。');

        return (
          <div key={m.id} data-window-item data-message-id={m.id}>
            {bubble}
            <div
              className="mb-4 flex justify-end"
              onMouseEnter={() => setHoveredActionMsgId(m.id)}
              onMouseLeave={() => setHoveredActionMsgId((prev) => (prev === m.id ? null : prev))}
            >
              <div
                className="flex items-center gap-1 mr-1 transition-opacity duration-150"
                style={{ opacity: isHover ? 1 : 0, pointerEvents: isHover ? 'auto' : 'none' }}
              >
                {m.role === 'assistant' && !m.synthetic && m.content && (
                  <button
                    className="rounded-md border border-[#2a2d3a] bg-[#10131b] px-2.5 py-1 text-[10px] text-slate-400 transition-colors hover:border-indigo-500/40 hover:bg-indigo-500/10 hover:text-indigo-300"
                    onClick={() => onTtsReplay(m.content)}
                    title={lang === 'en' ? 'Replay' : '重播'}
                  >
                    {lang === 'en' ? 'Replay' : '重播'}
                  </button>
                )}
                <button
                  className="rounded-md border border-[#2a2d3a] bg-[#10131b] px-2.5 py-1 text-[10px] text-slate-400 transition-colors enabled:hover:border-indigo-500/40 enabled:hover:bg-indigo-500/10 enabled:hover:text-indigo-300 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!canReset}
                  title={canReset ? undefined : noCheckpointTip}
                  onClick={() => onRequestReset(m.id)}
                >
                  {resetLabel}
                </button>
                <button
                  className="rounded-md border border-[#2a2d3a] bg-[#10131b] px-2.5 py-1 text-[10px] text-slate-400 transition-colors hover:border-slate-500/40 hover:bg-slate-500/10 hover:text-slate-300"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(m.content);
                    } catch {
                      // 复制失败静默忽略
                    }
                  }}
                >
                  {copyLabel}
                </button>
              </div>
            </div>
          </div>
        );
      })}
      {!deferMessages && effectiveRoundWindow.hi < totalRounds && (
        <div className="mb-3 flex justify-center">
          <button
            type="button"
            onClick={() => onSlideWindow('down')}
            className="rounded-full border border-[#2a2d3a] bg-[#10131b] px-4 py-1.5 text-xs text-slate-400 transition-colors hover:border-indigo-500/50 hover:text-slate-200"
          >
            {t.chatLoadLaterRounds.replace('{n}', String(totalRounds - effectiveRoundWindow.hi))}
          </button>
        </div>
      )}
      {bottomSpacerHeight > 0 && (
        <div aria-hidden style={{ height: bottomSpacerHeight }} />
      )}
      {activeSessionId && taskChecklists[activeSessionId] ? (
        <div className="mx-3 mb-4 rounded-2xl border-2 border-indigo-500/50 bg-[#10131b]">{/* debug-visible wrapper */}
          <TaskChecklist
            checklist={taskChecklists[activeSessionId]!}
            lang={lang}
            isLoading={isActiveLoading}
          />
        </div>
      ) : null}
      {isActiveLoading && !hasStreamingMessage && (
        <div className="mb-4 flex justify-start fade-in">
          <div className="flex items-center gap-1.5 px-1 py-2">
            <div className="flex gap-1.5 items-center">
              <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce [animation-delay:0ms]" />
              <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce [animation-delay:150ms]" />
              <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce [animation-delay:300ms]" />
            </div>
          </div>
        </div>
      )}
    </>
  );
});
