import type { QuestionData, QuestionOption } from '@codepapr/types';
import type { WorkMode } from './agentPrompts';
import type { Lang } from './i18n';

export interface PlanFollowUpAction {
  id: string;
  label: string;
  prompt: string;
  mode: WorkMode;
  /** 触发回答的源消息 id（用于标记已答状态）。 */
  sourceMessageId?: string;
}

export interface ParsedDecisionCards {
  questions: QuestionData[];
  remainderContent: string;
}

interface JsonQuestionOption {
  id?: string;
  label?: string;
  description?: string;
}

interface JsonDecisionCard {
  id?: string;
  heading?: string;
  question?: string;
  options?: Array<JsonQuestionOption | string>;
  note?: string;
  multiple?: boolean;
}

const DECISION_HEADING_PATTERNS = [
  /^待确认选项/,
  /^待確認選項/,
  /^decision(?:\s+options?|\s+point)?\b/i,
];

function matchesAnyPattern(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function parseDecisionHeading(heading: string): string | null {
  if (!matchesAnyPattern(heading, DECISION_HEADING_PATTERNS)) {
    return null;
  }

  const parts = heading.split(/[|｜]/).map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return parts[1] ?? heading.trim();
  }

  return heading
    .replace(DECISION_HEADING_PATTERNS[0], '')
    .replace(DECISION_HEADING_PATTERNS[1], '')
    .replace(DECISION_HEADING_PATTERNS[2], '')
    .replace(/^[:：-]\s*/, '')
    .trim();
}

function extractJsonObject(content: string): string | null {
  const trimmed = content.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return candidate.slice(start, end + 1);
}

function parseDecisionCardsFromJson(content: string): ParsedDecisionCards | null {
  const jsonText = extractJsonObject(content);
  if (!jsonText) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonText) as {
      decisionCards?: JsonDecisionCard[];
      remainderContent?: string;
    };
    const rawCards = Array.isArray(parsed.decisionCards) ? parsed.decisionCards : [];
    const questions: QuestionData[] = [];
    rawCards.forEach((card) => {
      const questionText = typeof card.question === 'string' ? card.question.trim() : '';
      const options = (Array.isArray(card.options) ? card.options : [])
        .map((option) => {
          if (typeof option === 'string') {
            return { label: option.trim() };
          }
          return {
            label: typeof option.label === 'string' ? option.label.trim() : '',
            description:
              typeof option.description === 'string' ? option.description.trim() : undefined,
          };
        })
        .filter((option) => option.label);

      if (!questionText || options.length === 0) {
        return;
      }

      questions.push({
        question: questionText,
        header: typeof card.heading === 'string' && card.heading.trim() ? card.heading.trim() : questionText,
        options,
        multiple: card.multiple === true,
        note: typeof card.note === 'string' && card.note.trim() ? card.note.trim() : undefined,
      });
    });

    if (questions.length === 0) {
      return null;
    }

    return {
      questions,
      remainderContent:
        typeof parsed.remainderContent === 'string' ? parsed.remainderContent.trim() : '',
    };
  } catch {
    return null;
  }
}

function parseDecisionOptions(body: string): { options: QuestionOption[]; note?: string } {
  const lines = body.split('\n');
  const options: QuestionOption[] = [];
  const noteLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const optionMatch = line.match(/^(\d+)[.、]\s*(.+)$/);
    if (optionMatch) {
      options.push({
        label: optionMatch[2]?.trim() ?? '',
      });
      continue;
    }

    const bulletMatch = line.match(/^[-*]\s*(.+)$/);
    if (bulletMatch && options.length > 0) {
      const lastOption = options[options.length - 1];
      if (lastOption) {
        lastOption.description = lastOption.description
          ? `${lastOption.description}\n${bulletMatch[1]}`
          : bulletMatch[1];
      }
      continue;
    }

    noteLines.push(line);
  }

  return {
    options,
    note: noteLines.length > 0 ? noteLines.join('\n') : undefined,
  };
}

export function parseDecisionOptionCards(content: string): ParsedDecisionCards {
  const jsonCards = parseDecisionCardsFromJson(content);
  if (jsonCards) {
    return jsonCards;
  }

  const headingRegex = /^\s*##\s+(.+?)\s*$/gm;
  const matches = Array.from(content.matchAll(headingRegex));

  if (matches.length === 0) {
    return {
      questions: [],
      remainderContent: content.trim(),
    };
  }

  const questions: QuestionData[] = [];
  const remainderParts: string[] = [];

  const appendRemainder = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) {
      remainderParts.push(trimmed);
    }
  };

  appendRemainder(content.slice(0, matches[0]?.index ?? 0));

  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const heading = current?.[1]?.trim() ?? '';
    const questionText = parseDecisionHeading(heading);
    const sectionStart = (current?.index ?? 0) + (current?.[0]?.length ?? 0);
    const sectionEnd = matches[index + 1]?.index ?? content.length;
    const body = content.slice(sectionStart, sectionEnd).trim();

    if (!questionText) {
      appendRemainder(`## ${heading}\n${body}`.trim());
      continue;
    }

    const { options, note } = parseDecisionOptions(body);
    if (options.length === 0) {
      appendRemainder(`## ${heading}\n${body}`.trim());
      continue;
    }

    questions.push({
      question: questionText,
      header: heading,
      options,
      multiple: false,
      note,
    });
  }

  return {
    questions,
    remainderContent: remainderParts.join('\n\n').trim(),
  };
}

/**
 * 统一的「回答后续动作」构建器：question 工具与旧版决策卡片共用。
 * 使用完整问题文本（而非截断的 header），支持单选与多选。
 */
export function buildQuestionAnswerAction(params: {
  question: QuestionData;
  selected?: QuestionOption[];
  customText?: string;
  lang: Lang | undefined;
  sourceMessageId?: string;
}): PlanFollowUpAction {
  const { question, selected = [], customText, lang, sourceMessageId } = params;
  const labels = selected.map((option) => option.label).filter(Boolean);
  const trimmedCustom = customText?.trim() || '';
  const joined = labels.join('、');
  const joinedEn = labels.join('", "');

  const hasOptions = labels.length > 0;
  const hasCustom = trimmedCustom.length > 0;

  switch (lang ?? 'zh-CN') {
    case 'zh-TW': {
      let label = '';
      let prompt = '';
      if (hasOptions && hasCustom) {
        label = `選擇了「${joined}」，補充：「${trimmedCustom}」`;
        prompt = `用戶對問題「${question.question}」的回答：選擇了「${joined}」，並補充了想法：「${trimmedCustom}」。請基於這些輸入繼續收斂最終 Plan；如果仍存在會影響實施方向的關鍵分歧，再提出新的問題。不要開始執行。`;
      } else if (hasCustom) {
        label = `自訂回答：「${trimmedCustom}」`;
        prompt = `用戶對問題「${question.question}」的自訂回答：「${trimmedCustom}」。請基於該回答繼續收斂最終 Plan；如果仍存在會影響實施方向的關鍵分歧，再提出新的問題。不要開始執行。`;
      } else {
        label = `選擇了「${joined}」`;
        prompt = `用戶對問題「${question.question}」的回答：選擇了「${joined}」。請基於這個選擇繼續收斂最終 Plan；如果仍存在會影響實施方向的關鍵分歧，再提出新的問題。不要開始執行。`;
      }
      return {
        id: `question-${question.question}-${joined}-${trimmedCustom}`,
        label,
        prompt,
        mode: 'plan',
        sourceMessageId,
      };
    }
    case 'en': {
      let label = '';
      let prompt = '';
      if (hasOptions && hasCustom) {
        label = `Chose "${joinedEn}" with note: "${trimmedCustom}"`;
        prompt = `Answer to question "${question.question}": chose "${joinedEn}", and added custom note: "${trimmedCustom}". Continue refining the final plan based on this input; if another decision still materially changes implementation direction, ask again. Do not start execution.`;
      } else if (hasCustom) {
        label = `Custom answer: "${trimmedCustom}"`;
        prompt = `Custom answer to question "${question.question}": "${trimmedCustom}". Continue refining the final plan based on this answer; if another decision still materially changes implementation direction, ask again. Do not start execution.`;
      } else {
        label = labels.length > 1 ? `Chose "${joinedEn}"` : `Chose "${joinedEn}"`;
        prompt = `Answer to question "${question.question}": chose "${joinedEn}". Continue refining the final plan based on that choice; if another decision still materially changes implementation direction, ask again. Do not start execution.`;
      }
      return {
        id: `question-${question.question}-${joinedEn}-${trimmedCustom}`,
        label,
        prompt,
        mode: 'plan',
        sourceMessageId,
      };
    }
    case 'zh-CN':
    default: {
      let label = '';
      let prompt = '';
      if (hasOptions && hasCustom) {
        label = `选择了「${joined}」，补充：「${trimmedCustom}」`;
        prompt = `用户对问题「${question.question}」的回答：选择了「${joined}」，并补充了想法：「${trimmedCustom}」。请基于这些输入继续收敛最终 Plan；如果仍存在会影响实施方向的关键分歧，再提出新的问题。不要开始执行。`;
      } else if (hasCustom) {
        label = `自定义回答：「${trimmedCustom}」`;
        prompt = `用户对问题「${question.question}」的自定义回答：「${trimmedCustom}」。请基于该回答继续收敛最终 Plan；如果仍存在会影响实施方向的关键分歧，再提出新的问题。不要开始执行。`;
      } else {
        label = `选择了「${joined}」`;
        prompt = `用户对问题「${question.question}」的回答：选择了「${joined}」。请基于这个选择继续收敛最终 Plan；如果仍存在会影响实施方向的关键分歧，再提出新的问题。不要开始执行。`;
      }
      return {
        id: `question-${question.question}-${joined}-${trimmedCustom}`,
        label,
        prompt,
        mode: 'plan',
        sourceMessageId,
      };
    }
  }
}
