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

const APPROVAL_LABEL_PATTERN =
  /(批准|開始實施|开始实施|确认实施|確認實施|开始执行|開始執行|立即执行|立即執行|确认执行|確認執行|执行方案|執行方案|执行计划|執行計畫|同意执行|同意執行|按计划执行|直接执行|直接執行|approve|proceed|go\s*ahead|start\s+executing|execute\s+the\s+plan)/i;
const APPROVAL_NEGATION_PATTERN =
  /(不批准|暂不|暫不|尚未|拒绝|拒絕|反对|反對|不要执行|先不|不可|no[tn]\s+(approve|proceed|execute)|don'?t|never|reject|deny|hold\s+off)/i;

/** 选中的选项 label 是否携带「批准/开始执行」语义（自定义文本不算授权） */
export function isApprovalAnswer(labels: string[]): boolean {
  return labels.some((label) => APPROVAL_LABEL_PATTERN.test(label) && !APPROVAL_NEGATION_PATTERN.test(label));
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
  const approved = hasOptions && isApprovalAnswer(labels);

  switch (lang ?? 'zh-CN') {
    case 'zh-TW': {
      let label = '';
      let prompt = '';
      if (approved) {
        label = `選擇了「${joined}」${hasCustom ? `，補充：「${trimmedCustom}」` : ''}`;
        prompt = `用戶對問題「${question.question}」的回答：選擇了「${joined}」${hasCustom ? `，並補充了想法：「${trimmedCustom}」` : ''}。該選擇即為執行授權：用戶已批准當前方案，請立即按既定 Plan${hasCustom ? '（結合補充想法）' : ''}開始實施——不要重複輸出 Plan，不要再調用 question 請求確認，直到完成或遇到真實阻塞為止。`;
      } else if (hasOptions && hasCustom) {
        label = `選擇了「${joined}」，補充：「${trimmedCustom}」`;
        prompt = `用戶對問題「${question.question}」的回答：選擇了「${joined}」，並補充了想法：「${trimmedCustom}」。請基於這些輸入收斂並輸出最終 Plan，然後停止並等待用戶指示；不要開始執行，也不要就同一決策反覆提問。`;
      } else if (hasCustom) {
        label = `自訂回答：「${trimmedCustom}」`;
        prompt = `用戶對問題「${question.question}」的自訂回答：「${trimmedCustom}」。請基於該回答收斂並輸出最終 Plan，然後停止並等待用戶指示；不要開始執行，也不要就同一決策反覆提問。`;
      } else {
        label = `選擇了「${joined}」`;
        prompt = `用戶對問題「${question.question}」的回答：選擇了「${joined}」。請基於這個選擇收斂並輸出最終 Plan，然後停止並等待用戶指示；不要開始執行，也不要就同一決策反覆提問。`;
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
      if (approved) {
        label = `Approved: "${joinedEn}"${hasCustom ? ` with note: "${trimmedCustom}"` : ''}`;
        prompt = `Answer to question "${question.question}": chose "${joinedEn}"${hasCustom ? `, with note: "${trimmedCustom}"` : ''}. This selection IS the approval to execute — start implementing the agreed plan${hasCustom ? ' incorporating the note' : ''} immediately: do not restate the plan, do not ask again via the question tool, and keep going until done or genuinely blocked.`;
      } else if (hasOptions && hasCustom) {
        label = `Chose "${joinedEn}" with note: "${trimmedCustom}"`;
        prompt = `Answer to question "${question.question}": chose "${joinedEn}", and added custom note: "${trimmedCustom}". Refine and output the final plan based on this input, then stop and wait for the user's instruction. Do not start execution, and do not re-ask about the same decision.`;
      } else if (hasCustom) {
        label = `Custom answer: "${trimmedCustom}"`;
        prompt = `Custom answer to question "${question.question}": "${trimmedCustom}". Refine and output the final plan based on this answer, then stop and wait for the user's instruction. Do not start execution, and do not re-ask about the same decision.`;
      } else {
        label = `Chose "${joinedEn}"`;
        prompt = `Answer to question "${question.question}": chose "${joinedEn}". Refine and output the final plan based on that choice, then stop and wait for the user's instruction. Do not start execution, and do not re-ask about the same decision.`;
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
      if (approved) {
        label = `选择了「${joined}」${hasCustom ? `，补充：「${trimmedCustom}」` : ''}`;
        prompt = `用户对问题「${question.question}」的回答：选择了「${joined}」${hasCustom ? `，并补充了想法：「${trimmedCustom}」` : ''}。该选择即为执行授权：用户已批准当前方案，请立即按既定 Plan${hasCustom ? '（结合补充想法）' : ''}开始实施——不要重复输出 Plan，不要再调用 question 请求确认，直到完成或遇到真实阻塞为止。`;
      } else if (hasOptions && hasCustom) {
        label = `选择了「${joined}」，补充：「${trimmedCustom}」`;
        prompt = `用户对问题「${question.question}」的回答：选择了「${joined}」，并补充了想法：「${trimmedCustom}」。请基于这些输入收敛并输出最终 Plan，然后停止并等待用户指示；不要开始执行，也不要就同一决策反复提问。`;
      } else if (hasCustom) {
        label = `自定义回答：「${trimmedCustom}」`;
        prompt = `用户对问题「${question.question}」的自定义回答：「${trimmedCustom}」。请基于该回答收敛并输出最终 Plan，然后停止并等待用户指示；不要开始执行，也不要就同一决策反复提问。`;
      } else {
        label = `选择了「${joined}」`;
        prompt = `用户对问题「${question.question}」的回答：选择了「${joined}」。请基于这个选择收敛并输出最终 Plan，然后停止并等待用户指示；不要开始执行，也不要就同一决策反复提问。`;
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
