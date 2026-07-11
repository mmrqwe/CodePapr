import type { WorkMode } from './agentPrompts';
import type { Lang } from './i18n';

export interface PlanFollowUpAction {
  id: string;
  label: string;
  prompt: string;
  mode: WorkMode;
}

export interface DecisionOptionItem {
  id: string;
  label: string;
  description?: string;
}

export interface DecisionOptionCard {
  id: string;
  heading: string;
  question: string;
  options: DecisionOptionItem[];
  note?: string;
}

export interface ParsedDecisionCards {
  cards: DecisionOptionCard[];
  remainderContent: string;
}

interface JsonDecisionOptionItem {
  id?: string;
  label?: string;
  description?: string;
}

interface JsonDecisionCard {
  id?: string;
  heading?: string;
  question?: string;
  options?: Array<JsonDecisionOptionItem | string>;
  note?: string;
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

function buildOptionId(cardIndex: number, optionIndex: number): string {
  return `decision-${cardIndex + 1}-option-${optionIndex + 1}`;
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
    const cards: DecisionOptionCard[] = [];
    rawCards.forEach((card, cardIndex) => {
        const question = typeof card.question === 'string' ? card.question.trim() : '';
        const options = (Array.isArray(card.options) ? card.options : [])
          .map((option, optionIndex) => {
            if (typeof option === 'string') {
              return {
                id: buildOptionId(cardIndex, optionIndex),
                label: option.trim(),
              };
            }
            return {
              id:
                typeof option.id === 'string' && option.id.trim()
                  ? option.id.trim()
                  : buildOptionId(cardIndex, optionIndex),
              label: typeof option.label === 'string' ? option.label.trim() : '',
              description:
                typeof option.description === 'string' ? option.description.trim() : undefined,
            };
          })
          .filter((option) => option.label);

        if (!question || options.length === 0) {
          return;
        }

        cards.push({
          id:
            typeof card.id === 'string' && card.id.trim()
              ? card.id.trim()
              : `decision-card-${cardIndex + 1}`,
          heading:
            typeof card.heading === 'string' && card.heading.trim()
              ? card.heading.trim()
              : question,
          question,
          options,
          note: typeof card.note === 'string' && card.note.trim() ? card.note.trim() : undefined,
        });
      });

    if (cards.length === 0) {
      return null;
    }

    return {
      cards,
      remainderContent:
        typeof parsed.remainderContent === 'string' ? parsed.remainderContent.trim() : '',
    };
  } catch {
    return null;
  }
}

function parseDecisionOptions(body: string, cardIndex: number): {
  options: DecisionOptionItem[];
  note?: string;
} {
  const lines = body.split('\n');
  const options: DecisionOptionItem[] = [];
  const noteLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const optionMatch = line.match(/^(\d+)[.、]\s*(.+)$/);
    if (optionMatch) {
      options.push({
        id: buildOptionId(cardIndex, options.length),
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
      cards: [],
      remainderContent: content.trim(),
    };
  }

  const cards: DecisionOptionCard[] = [];
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
    const question = parseDecisionHeading(heading);
    const sectionStart = (current?.index ?? 0) + (current?.[0]?.length ?? 0);
    const sectionEnd = matches[index + 1]?.index ?? content.length;
    const body = content.slice(sectionStart, sectionEnd).trim();

    if (!question) {
      appendRemainder(`## ${heading}\n${body}`.trim());
      continue;
    }

    const { options, note } = parseDecisionOptions(body, index);
    if (options.length === 0) {
      appendRemainder(`## ${heading}\n${body}`.trim());
      continue;
    }

    cards.push({
      id: `decision-card-${index + 1}`,
      heading,
      question,
      options,
      note,
    });
  }

  return {
    cards,
    remainderContent: remainderParts.join('\n\n').trim(),
  };
}

export function buildDecisionOptionAction(params: {
  card: DecisionOptionCard;
  option: DecisionOptionItem;
  lang: Lang | undefined;
}): PlanFollowUpAction {
  const { card, option, lang } = params;

  switch (lang ?? 'zh-CN') {
    case 'zh-TW':
      return {
        id: `${card.id}-${option.id}`,
        label: `選擇了「${option.label}」`,
        prompt: `在剛才待確認選項「${card.question}」中，用戶選擇了「${option.label}」。請基於這個選擇繼續收斂最終 Plan；如果仍存在會影響實施方向的關鍵分歧，再提出新的待確認選項。不要開始執行。`,
        mode: 'plan',
      };
    case 'en':
      return {
        id: `${card.id}-${option.id}`,
        label: `Chose "${option.label}"`,
        prompt: `For the earlier decision point "${card.question}", the user selected "${option.label}". Continue refining the final plan based on that choice. If another decision still materially changes implementation direction, ask the next decision options. Do not start execution.`,
        mode: 'plan',
      };
    case 'zh-CN':
    default:
      return {
        id: `${card.id}-${option.id}`,
        label: `选择了「${option.label}」`,
        prompt: `在刚才待确认选项「${card.question}」中，用户选择了「${option.label}」。请基于这个选择继续收敛最终 Plan；如果仍存在会影响实施方向的关键分歧，再提出新的待确认选项。不要开始执行。`,
        mode: 'plan',
      };
  }
}
