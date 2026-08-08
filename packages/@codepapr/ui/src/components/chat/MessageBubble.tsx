import { memo } from 'react';
import type { UIMessage } from '../../store/agentStore';
import { getTranslation } from '../../utils/i18n';
import { parseDecisionOptionCards, type PlanFollowUpAction } from '../../utils/planMode';
import { ReasoningPanel, RunningStatusIndicator } from './ReasoningPanel';
import { ToolInvocationsPanel } from './ToolInvocationsPanel';
import { RelatedFileLinks } from './RelatedFileLinks';
import { MessageContent } from './MessageContent';
import { QuestionCard } from './QuestionCard';
import type { Lang } from './utils';

export interface MessageBubbleProps {
  msg: UIMessage;
  lang: Lang;
  showPlanActions?: boolean;
  planActionsDisabled?: boolean;
  onPlanAction?: (action: PlanFollowUpAction) => void;
  onOpenWorkspacePath?: (path: string) => void;
  onPreviewImage?: (src: string) => void;
  characterAvatar?: string | null;
  characterName?: string;
}

function areMessageBubblePropsEqual(
  previous: Readonly<MessageBubbleProps>,
  next: Readonly<MessageBubbleProps>
): boolean {
  return (
    previous.msg === next.msg &&
    previous.lang === next.lang &&
    previous.showPlanActions === next.showPlanActions &&
    previous.planActionsDisabled === next.planActionsDisabled &&
    previous.onOpenWorkspacePath === next.onOpenWorkspacePath &&
    previous.characterAvatar === next.characterAvatar &&
    previous.characterName === next.characterName &&
    (previous.showPlanActions || next.showPlanActions
      ? previous.onPlanAction === next.onPlanAction
      : true)
  );
}

export const MessageBubble = memo(function MessageBubble({
  msg,
  lang,
  showPlanActions,
  planActionsDisabled,
  onPlanAction,
  onOpenWorkspacePath,
  onPreviewImage,
  characterAvatar,
  characterName,
}: MessageBubbleProps) {
  const isUser = msg.role === 'user';
  const isError = msg.role === 'error';
  const isSyntheticSummary = !isUser && !isError && Boolean(msg.synthetic);
  const useBubbleFrame = isUser || isError || isSyntheticSummary;
  const t = getTranslation(lang);
  const parsedDecisionCards = showPlanActions && !msg.isStreaming
    ? parseDecisionOptionCards(msg.content)
    : null;
  const modelUsageLabel =
    !isUser && !isError && msg.modelTier === 'fast'
      ? t.fastModelTag
      : null;
  const showRunningStatusIndicator =
    !isUser &&
    !isError &&
    msg.isStreaming &&
    Boolean(msg.statusText) &&
    !msg.content &&
    !(msg.displayReasoningContent ?? msg.reasoningContent) &&
    (!msg.toolInvocations || msg.toolInvocations.length === 0);

  const frameClassName = isUser
    ? 'max-w-[80%] rounded-2xl bg-indigo-600 px-4 py-2.5 text-sm leading-relaxed text-white'
    : isError
      ? 'max-w-[80%] rounded-2xl rounded-bl-sm border border-white/10 bg-white/[0.04] px-4 py-3 text-sm leading-relaxed text-slate-400'
      : isSyntheticSummary
        ? 'w-full rounded-2xl rounded-bl-sm border border-[#2a2d3a] bg-[#101722] px-4 py-3 text-sm leading-relaxed text-slate-200 shadow-[0_10px_30px_rgba(15,23,42,0.22)]'
        : 'w-full max-w-4xl px-0 py-0 text-sm leading-relaxed text-slate-200';

  const avatarElement = (() => {
    if (isError || isUser) return null;
    if (characterAvatar) {
      return (
        <div className="mr-2 flex-shrink-0 self-start" title={characterName}>
          <img
            src={characterAvatar}
            alt={characterName ?? ''}
            className="h-8 w-8 rounded-full border border-[#2a2d3a] object-cover"
          />
        </div>
      );
    }
    return (
      <div className="mr-2 flex-shrink-0 self-start">
        <div className="h-8 w-8 rounded-full bg-slate-700/50 border border-[#2a2d3a] flex items-center justify-center">
          <svg className="h-4 w-4 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </svg>
        </div>
      </div>
    );
  })();

  return (
    <div className={`mb-4 flex fade-in ${isUser ? 'justify-end' : 'justify-start'}`} data-message-id={msg.id}>
      {!isUser && avatarElement}
      <div
        className={`min-w-0 ${frameClassName}`}
        data-message-role={msg.role}
        data-message-synthetic={msg.synthetic ? 'true' : 'false'}
        data-message-variant={useBubbleFrame ? 'bubble' : 'plain'}
      >
        {modelUsageLabel && (
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] select-none">
            <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/12 px-2 py-0.5 font-semibold text-amber-200">
              {modelUsageLabel}
            </span>
            {msg.modelName && <span className="text-slate-500">{msg.modelName}</span>}
          </div>
        )}
        {isUser && msg.images && msg.images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {msg.images.map((image, index) => (
              <img
                key={index}
                src={`data:${image.mediaType};base64,${image.data}`}
                alt="attachment"
                className="h-20 w-20 rounded-lg border border-white/20 object-cover cursor-pointer hover:opacity-80 transition-opacity"
                onClick={() => onPreviewImage?.(`data:${image.mediaType};base64,${image.data}`)}
              />
            ))}
          </div>
        )}
        {(msg.displayReasoningContent ?? msg.reasoningContent) && (
          <ReasoningPanel
            content={msg.displayReasoningContent ?? msg.reasoningContent ?? ''}
            isStreaming={msg.isStreaming}
            lang={lang}
          />
        )}
        <ToolInvocationsPanel msg={msg} lang={lang} onOpenWorkspacePath={onOpenWorkspacePath} />
        <RelatedFileLinks paths={msg.relatedFilePaths ?? []} onOpenWorkspacePath={onOpenWorkspacePath} />
        {showRunningStatusIndicator && msg.statusText && (
          <RunningStatusIndicator label={msg.statusText} />
        )}
        {!showRunningStatusIndicator && msg.statusText && !msg.content && !(msg.displayReasoningContent ?? msg.reasoningContent) && (!msg.toolInvocations || msg.toolInvocations.length === 0) && (
          <p className="mb-2 text-xs font-medium text-slate-400/90 select-none">{msg.statusText}</p>
        )}
        {isError && (
          <div className="mb-1.5 flex items-center gap-1.5 select-none">
            <svg className="h-3.5 w-3.5 flex-shrink-0 text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span className="text-xs font-medium text-slate-500">{t.errorOccurred}</span>
          </div>
        )}
        <div className="select-text">
          <MessageContent
            content={
              !msg.isStreaming && showPlanActions && parsedDecisionCards && parsedDecisionCards.questions.length > 0
                ? parsedDecisionCards.remainderContent
                : msg.content
            }
            lang={lang}
            onOpenWorkspacePath={onOpenWorkspacePath}
            isStreaming={msg.isStreaming}
          />
        </div>
        {showPlanActions &&
          onPlanAction &&
          parsedDecisionCards &&
          parsedDecisionCards.questions.length > 0 && (
          <div className="space-y-3">
            {parsedDecisionCards.questions.map((question, index) => (
              <QuestionCard
                key={`decision-card-${index}`}
                question={question}
                lang={lang}
                disabled={Boolean(planActionsDisabled)}
                answered={msg.questionAnswered === true}
                onAnswer={onPlanAction}
                onOpenWorkspacePath={onOpenWorkspacePath}
                sourceMessageId={msg.id}
              />
            ))}
          </div>
        )}
        {showPlanActions && onPlanAction && msg.question && (
          <QuestionCard
            question={msg.question}
            lang={lang}
            disabled={Boolean(planActionsDisabled)}
            answered={msg.questionAnswered === true}
            onAnswer={onPlanAction}
            onOpenWorkspacePath={onOpenWorkspacePath}
            sourceMessageId={msg.id}
          />
        )}
        {typeof msg.agentStep !== 'number' && (
          <p className={`text-[10px] mt-1.5 select-none ${isUser ? 'text-indigo-300' : 'text-slate-500'}`}>
            {new Date(msg.timestamp).toLocaleTimeString(lang === 'en' ? 'en-US' : lang)}
          </p>
        )}
      </div>
    </div>
  );
}, areMessageBubblePropsEqual);
