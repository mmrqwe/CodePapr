const LANGUAGE_ALIAS_MAP: Record<string, string> = {
  '': 'plaintext',
  bash: 'shell',
  cjs: 'javascript',
  cs: 'csharp',
  csx: 'csharp',
  htm: 'html',
  html: 'html',
  js: 'javascript',
  json: 'json',
  jsx: 'javascript',
  mjs: 'javascript',
  mts: 'typescript',
  plain: 'plaintext',
  plaintext: 'plaintext',
  ps: 'powershell',
  ps1: 'powershell',
  sh: 'shell',
  shell: 'shell',
  text: 'plaintext',
  ts: 'typescript',
  tsx: 'typescript',
  yml: 'yaml',
  zsh: 'shell',
};

export function normalizeMarkdownCodeLanguage(language: string): string {
  const normalized = language.trim().toLowerCase();
  if (!normalized) {
    return 'plaintext';
  }

  return LANGUAGE_ALIAS_MAP[normalized] ?? normalized;
}