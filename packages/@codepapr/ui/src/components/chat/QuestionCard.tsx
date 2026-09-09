import { useEffect, useState } from 'react';
import type { QuestionData, QuestionOption } from '@codepapr/types';
import { getTranslation } from '../../utils/i18n';
import { buildQuestionAnswerAction, type PlanFollowUpAction } from '../../utils/planMode';
import { MessageContent } from './MessageContent';
import type { Lang } from './utils';

export function QuestionCard({
  question,
  lang,
  disabled,
  onAnswer,
  onOpenWorkspacePath,
  sourceMessageId,
  answered = false,
}: {
  question: QuestionData;
  lang: Lang;
  disabled: boolean;
  onAnswer: (action: PlanFollowUpAction) => void;
  onOpenWorkspacePath?: (path: string) => void;
  sourceMessageId?: string;
  answered?: boolean;
}) {
  const t = getTranslation(lang);
  const hasOptions = question.options && question.options.length > 0;
  const multiple = hasOptions && question.multiple === true;
  const [selected, setSelected] = useState<string[]>([]);
  const [customText, setCustomText] = useState('');
  const [showCustomInput, setShowCustomInput] = useState(false);

  useEffect(() => {
    if (!multiple) {
      setSelected([]);
    }
  }, [multiple]);

  const submitSelection = (options: QuestionOption[], customAnswer?: string) => {
    if (answered || disabled) {
      return;
    }
    const textToSubmit = customAnswer ?? customText;
    if (options.length === 0 && !textToSubmit.trim()) {
      return;
    }
    onAnswer(
      buildQuestionAnswerAction({
        question,
        selected: options,
        customText: textToSubmit.trim() || undefined,
        lang,
        sourceMessageId,
      })
    );
  };

  const clearCustomInput = () => {
    setCustomText('');
    if (!multiple) {
      setShowCustomInput(false);
    }
  };

  const handleOptionClick = (option: QuestionOption) => {
    if (answered || disabled) {
      return;
    }
    clearCustomInput();
    if (multiple) {
      setSelected((current) =>
        current.includes(option.label)
          ? current.filter((label) => label !== option.label)
          : [...current, option.label]
      );
      return;
    }
    setSelected((current) => (current.includes(option.label) ? [] : [option.label]));
  };

  const selectedOptions = (question.options ?? []).filter((option) =>
    selected.includes(option.label)
  );

  const handleConfirm = () => {
    if (answered || disabled) return;
    if (selected.length === 0 && !customText.trim()) return;
    submitSelection(selectedOptions, customText);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleConfirm();
    }
  };

  const renderIndicator = (isSelected: boolean) => (
    <span
      className={`mt-0.5 flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center border transition-colors ${
        multiple ? 'rounded' : 'rounded-full'
      } ${isSelected ? 'bg-info text-white border-info' : 'border-line-strong'}`}
    >
      {isSelected &&
        (multiple ? (
          <svg viewBox="0 0 10 10" className="h-2 w-2" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M1.5 5.5 4 8 8.5 2.5" />
          </svg>
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-white" />
        ))}
    </span>
  );

  const canConfirm = selected.length > 0 || customText.trim().length > 0;

  return (
    <div className="mb-3">
      <div className="overflow-hidden rounded-xl border border-line bg-raised">
        <div className="flex items-center gap-2 border-b border-line bg-base/60 px-3.5 py-2">
          <span className="inline-flex flex-shrink-0 items-center rounded bg-info-bg px-1.5 py-0.5 text-[10px] font-semibold text-info">
            {answered ? t.planQuestionAnswered : t.planDecisionTag}
          </span>
          <h4 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-fg">{question.question}</h4>
          {multiple && !answered && (
            <span className="flex-shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] text-fg-muted">
              {t.planMultiSelectHint}
            </span>
          )}
        </div>
        {question.note && (
          <div className="border-b border-line px-3.5 py-2">
            <MessageContent
              content={question.note}
              lang={lang}
              onOpenWorkspacePath={onOpenWorkspacePath}
            />
          </div>
        )}
        {hasOptions ? (
          <div className="p-1.5">
            {question.options!.map((option, index) => {
              const isSelected = selected.includes(option.label);
              return (
                <button
                  key={`${question.question}-${index}`}
                  type="button"
                  disabled={disabled || answered}
                  onClick={() => handleOptionClick(option)}
                  className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    isSelected ? 'bg-info-bg' : 'hover:bg-hover'
                  }`}
                >
                  {renderIndicator(isSelected)}
                  <span className="min-w-0 flex-1">
                    <span className={`block text-[13px] font-medium ${isSelected ? 'text-info' : 'text-fg'}`}>
                      {option.label}
                    </span>
                    {option.description && (
                      <span className="mt-0.5 block whitespace-pre-wrap text-xs leading-relaxed text-fg-muted">
                        {option.description}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}

            {!answered && (
              <div className="mt-0.5">
                {showCustomInput || multiple ? (
                  <div className="rounded-lg px-2.5 py-2">
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-xs text-fg-muted">{t.planCustomInputOptionalHint}</span>
                      {!multiple && (
                        <button
                          type="button"
                          onClick={() => {
                            setShowCustomInput(false);
                            setCustomText('');
                          }}
                          className="text-[11px] text-fg-dim hover:text-fg-muted"
                        >
                          {t.planCustomInputCancel}
                        </button>
                      )}
                    </div>
                    <input
                      type="text"
                      value={customText}
                      disabled={disabled || answered}
                      onChange={(e) => setCustomText(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder={t.planCustomInputPlaceholder}
                      className="w-full rounded-lg border border-line bg-input px-2.5 py-1.5 text-xs text-fg placeholder:text-fg-dim focus:border-accent focus:outline-none disabled:opacity-50"
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={disabled || answered}
                    onClick={() => {
                      setShowCustomInput(true);
                      setSelected([]);
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full border border-dashed border-line-strong text-[10px] leading-none">
                      +
                    </span>
                    <span>{t.planCustomInputToggle}</span>
                  </button>
                )}
              </div>
            )}

            {!answered && (
              <div className="px-1 pb-1 pt-2">
                <button
                  type="button"
                  disabled={disabled || !canConfirm}
                  onClick={handleConfirm}
                  className={`w-full rounded-lg px-3 py-2 text-[13px] font-semibold transition-opacity ${
                    canConfirm
                      ? 'bg-accent text-white hover:opacity-90'
                      : 'border border-line bg-base text-fg-dim'
                  } disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  {t.planConfirmSelection}
                  {multiple && selected.length > 0 ? `（${selected.length}）` : ''}
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="p-2.5">
            {!answered ? (
              <div className="flex gap-2">
                <input
                  type="text"
                  value={customText}
                  disabled={disabled || answered}
                  onChange={(e) => setCustomText(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={t.planCustomInputPlaceholder}
                  className="flex-1 rounded-lg border border-line bg-input px-2.5 py-1.5 text-xs text-fg placeholder:text-fg-dim focus:border-accent focus:outline-none disabled:opacity-50"
                />
                <button
                  type="button"
                  disabled={disabled || !customText.trim()}
                  onClick={handleConfirm}
                  className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t.planCustomInputSubmit}
                </button>
              </div>
            ) : (
              <p className="text-xs text-fg-muted">{t.planQuestionAnswered}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
