import { getTranslation } from './i18n';

const LEADING_FILLER_PATTERNS = [
  /^(请你|请帮我|请|帮我|给我|我想知道|我需要|我想让你|我希望你|现在需要)\s*/u,
  /^(please|can you|could you|help me|i need you to|i want you to|i want to)\s*/iu,
];

function stripLeadingFillers(input: string): string {
  let current = input.trim();
  for (const pattern of LEADING_FILLER_PATTERNS) {
    current = current.replace(pattern, '').trim();
  }
  return current;
}

function firstUsefulLine(input: string): string {
  return (
    input
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !/^[-*\d.、)\]]+\s*$/.test(line)) ?? ''
  );
}

function trimSentence(input: string): string {
  const match = input.match(/^(.{1,80}?)(?:[。！？!?]|$)/u);
  return (match?.[1] ?? input).trim();
}

function normalizeTitleText(input: string): string {
  return input
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/\[[^\]]+\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/^[#>\-*\d.、)\]]+\s*/u, '')
    .trim();
}

function truncateTitle(input: string): string {
  const hasCjk = /[\u3400-\u9fff]/u.test(input);
  const limit = hasCjk ? 24 : 48;
  if (input.length <= limit) {
    return input;
  }
  return `${input.slice(0, limit).trim()}...`;
}

export function buildTaskTitle(input: string, lang?: import('./i18n').Lang): string {
  const normalized = normalizeTitleText(input);
  if (!normalized) {
    return getTranslation(lang).taskTitleFallback;
  }

  const line = firstUsefulLine(normalized) || normalized;
  const sentence = trimSentence(line);
  const concise = stripLeadingFillers(sentence).replace(/[：:;；，,]+$/u, '').trim();

  return truncateTitle(concise || sentence || normalized) || getTranslation(lang).taskTitleFallback;
}

export interface TitleSourceAttachment {
  name: string;
}

/**
 * 首条消息可能没有文字（只发图片/附件），此时退回附件名或「图片 × N」，
 * 避免会话一直停留在新建占位名。
 */
export function buildUserMessageTitleSource(
  text: string | undefined,
  attachedFiles: readonly TitleSourceAttachment[] | undefined,
  imageCount: number,
  lang?: import('./i18n').Lang
): string {
  const trimmedText = (text ?? '').trim();
  if (trimmedText) {
    return trimmedText;
  }

  const separator = lang === 'en' ? ', ' : '、';
  const attachmentNames = (attachedFiles ?? [])
    .map((file) => file.name.trim())
    .filter(Boolean)
    .join(separator);
  if (attachmentNames) {
    return attachmentNames;
  }

  if (imageCount > 0) {
    return getTranslation(lang).taskTitleImageTask.replace('{{count}}', String(imageCount));
  }

  return '';
}
