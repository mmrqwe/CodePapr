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

  useEffect(() => {
    if (!multiple) {
      setSelected([]);
    }
  }, [multiple]);

  const submitSelection = (options: QuestionOption[]) => {
    if (answered || disabled) {
      return;
    }
    onAnswer(
      buildQuestionAnswerAction({
        question,
        selected: options,
        lang,
        sourceMessageId,
      })
    );
  };

  const handleOptionClick = (option: QuestionOption) => {
    if (answered || disabled) {
      return;
    }
    if (multiple) {
      setSelected((current) =>
        current.includes(option.label)
          ? current.filter((label) => label !== option.label)
          : [...current, option.label]
      );
      return;
    }
    submitSelection([option]);
  };

  const selectedOptions = (question.options ?? []).filter((option) =>
    selected.includes(option.label)
  );

  return (
    <div className="mb-3">
      <div className="rounded-xl border border-info-bg bg-base/55 px-3.5 py-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="inline-flex items-center rounded-full border border-info-bg bg-info-bg px-2 py-0.5 text-[10px] font-semibold text-info">
            {answered ? t.planQuestionAnswered : t.planDecisionTag}
          </span>
          <h4 className="text-sm font-semibold text-fg">{question.question}</h4>
          {multiple && !answered && (
            <span className="rounded-full border border-slate-600/60 px-2 py-0.5 text-[10px] text-fg-muted">
              {t.planMultiSelectHint}
            </span>
          )}
        </div>
        {question.note && (
          <div className="mb-3 rounded-lg border border-line bg-base px-3 py-2">
            <MessageContent
              content={question.note}
              lang={lang}
              onOpenWorkspacePath={onOpenWorkspacePath}
            />
          </div>
        )}
        {hasOptions ? (
          <div className="space-y-2">
            {question.options!.map((option, index) => {
              const isSelected = multiple && selected.includes(option.label);
              return (
                <button
                  key={`${question.question}-${index}`}
                  type="button"
                  disabled={disabled || answered}
                  onClick={() => handleOptionClick(option)}
                  className={`flex w-full items-start justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    isSelected
                      ? 'border-info-bg bg-info-bg'
                      : 'border-info-bg bg-info-bg hover:border-info-bg hover:bg-info-bg'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-info">{option.label}</div>
                    {option.description && (
                      <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-fg-soft">
                        {option.description}
                      </p>
                    )}
                  </div>
                  <span className="flex-shrink-0 text-[11px] font-medium text-info">
                    {multiple ? (isSelected ? '✓' : '') : t.planDecisionTag}
                  </span>
                </button>
              );
            })}
            {multiple && (
              <button
                type="button"
                disabled={disabled || answered || selected.length === 0}
                onClick={() => submitSelection(selectedOptions)}
                className="w-full rounded-xl border border-info-bg bg-info-bg px-3 py-2 text-sm font-semibold text-info transition-colors hover:border-info-bg hover:bg-info-bg disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t.planConfirmSelection}
              </button>
            )}
          </div>
        ) : (
          <p className="text-xs text-fg-muted">
            {answered ? t.planQuestionAnswered : t.planQuestionFreeTextHint}
          </p>
        )}
      </div>
    </div>
  );
}
