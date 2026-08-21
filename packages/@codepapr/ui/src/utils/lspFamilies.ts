export const LSP_FAMILY_IDS = [
  'typescript',
  'html',
  'css',
  'json',
  'yaml',
  'python',
  'csharp',
  'java',
  'cpp',
  'shellscript',
  'rust',
  'go',
  'swift',
  'sql',
  'markdown',
] as const;

export type LspFamilyId = (typeof LSP_FAMILY_IDS)[number];

const LSP_FAMILY_ID_SET = new Set<string>(LSP_FAMILY_IDS);

const LANGUAGE_TO_FAMILY: Record<string, LspFamilyId> = {
  typescript: 'typescript',
  typescriptreact: 'typescript',
  javascript: 'typescript',
  javascriptreact: 'typescript',
  html: 'html',
  css: 'css',
  scss: 'css',
  less: 'css',
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  python: 'python',
  csharp: 'csharp',
  java: 'java',
  c: 'cpp',
  cpp: 'cpp',
  shellscript: 'shellscript',
  rust: 'rust',
  go: 'go',
  swift: 'swift',
  sql: 'sql',
  markdown: 'markdown',
};

export function isKnownLspFamilyId(value: string): value is LspFamilyId {
  return LSP_FAMILY_ID_SET.has(value);
}

export function lspFamilyFromLanguageId(languageId: string | null | undefined): LspFamilyId | null {
  if (!languageId) {
    return null;
  }
  return LANGUAGE_TO_FAMILY[languageId] ?? null;
}

/** 缺省或未知语言视为启用，避免新语言被误关。只有明确出现在 disabled 列表里才关闭。 */
export function isLspFamilyEnabled(
  disabledFamilies: readonly string[] | null | undefined,
  languageId: string | null | undefined,
): boolean {
  const family = lspFamilyFromLanguageId(languageId);
  if (!family) {
    return true;
  }
  return !disabledFamilies?.includes(family);
}

export function normalizeLspDisabledFamilies(input: unknown): LspFamilyId[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const unique = new Set<LspFamilyId>();
  for (const item of input) {
    if (typeof item === 'string' && isKnownLspFamilyId(item)) {
      unique.add(item);
    }
  }
  return [...unique];
}
