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
      <div className="rounded-xl border border-cyan-500/20 bg-[#0b0d12]/55 px-3.5 py-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="inline-flex items-center rounded-full border border-cyan-500/35 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-semibold text-cyan-100">
            {answered ? t.planQuestionAnswered : t.planDecisionTag}
          </span>
          <h4 className="text-sm font-semibold text-slate-100">{question.question}</h4>
          {multiple && !answered && (
            <span className="rounded-full border border-slate-600/60 px-2 py-0.5 text-[10px] text-slate-400">
              {t.planMultiSelectHint}
            </span>
          )}
        </div>
        {question.note && (
          <div className="mb-3 rounded-lg border border-[#243040] bg-[#101722] px-3 py-2">
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
                      ? 'border-cyan-400/60 bg-cyan-500/18'
                      : 'border-cyan-500/25 bg-cyan-500/8 hover:border-cyan-400/45 hover:bg-cyan-500/12'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-cyan-50">{option.label}</div>
                    {option.description && (
                      <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-slate-300">
                        {option.description}
                      </p>
                    )}
                  </div>
                  <span className="flex-shrink-0 text-[11px] font-medium text-cyan-200">
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
                className="w-full rounded-xl border border-cyan-500/40 bg-cyan-500/15 px-3 py-2 text-sm font-semibold text-cyan-100 transition-colors hover:border-cyan-400/60 hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t.planConfirmSelection}
              </button>
            )}
          </div>
        ) : (
          <p className="text-xs text-slate-400">
            {answered ? t.planQuestionAnswered : t.planQuestionFreeTextHint}
          </p>
        )}
      </div>
    </div>
  );
}
