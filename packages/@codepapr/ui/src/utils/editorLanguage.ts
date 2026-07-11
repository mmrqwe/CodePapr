const JSON_DOTFILE_NAMES = new Set(['.babelrc', '.eslintrc', '.prettierrc', '.stylelintrc', '.swcrc']);
const INI_DOTFILE_NAMES = new Set(['.editorconfig']);
const PLAINTEXT_DOTFILE_NAMES = new Set(['.dockerignore', '.gitignore', '.npmignore']);

export function languageFromPath(path: string): string {
  const filename = path.split(/[\\/]/).pop()?.toLowerCase() ?? '';

  if (filename === 'dockerfile' || filename.endsWith('.dockerfile')) return 'dockerfile';
  if (filename === 'makefile') return 'shell';
  if (filename === '.env' || filename.startsWith('.env.')) return 'ini';
  if (JSON_DOTFILE_NAMES.has(filename)) return 'json';
  if (INI_DOTFILE_NAMES.has(filename)) return 'ini';
  if (PLAINTEXT_DOTFILE_NAMES.has(filename)) return 'plaintext';

  const extension = filename.includes('.') ? filename.split('.').pop()?.toLowerCase() : filename;
  switch (extension) {
    case 'bat':
    case 'cmd':
      return 'bat';
    case 'bicep':
      return 'bicep';
    case 'c':
    case 'cc':
    case 'cpp':
    case 'cxx':
    case 'h':
    case 'hh':
    case 'hpp':
    case 'hxx':
      return 'cpp';
    case 'cs':
    case 'csx':
      return 'csharp';
    case 'css':
      return 'css';
    case 'dart':
      return 'dart';
    case 'fs':
    case 'fsi':
    case 'fsx':
      return 'fsharp';
    case 'go':
      return 'go';
    case 'graphql':
    case 'gql':
      return 'graphql';
    case 'htm':
    case 'html':
    case 'shtml':
      return 'html';
    case 'ini':
    case 'conf':
    case 'cfg':
    case 'properties':
    case 'toml':
      return 'ini';
    case 'java':
      return 'java';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'json':
    case 'jsonc':
      return 'json';
    case 'kt':
    case 'kts':
      return 'kotlin';
    case 'less':
      return 'less';
    case 'lua':
      return 'lua';
    case 'm':
    case 'mm':
      return 'objective-c';
    case 'md':
    case 'mdx':
      return 'markdown';
    case 'mysql':
      return 'mysql';
    case 'p6':
    case 'pl':
    case 'pm':
      return 'perl';
    case 'pgsql':
      return 'pgsql';
    case 'php':
      return 'php';
    case 'proto':
      return 'protobuf';
    case 'ps1':
    case 'psd1':
    case 'psm1':
      return 'powershell';
    case 'py':
    case 'pyi':
    case 'pyw':
      return 'python';
    case 'r':
      return 'r';
    case 'rb':
      return 'ruby';
    case 'rs':
      return 'rust';
    case 'scala':
    case 'sc':
      return 'scala';
    case 'scss':
      return 'scss';
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'shell';
    case 'sql':
      return 'sql';
    case 'swift':
      return 'swift';
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'vb':
      return 'vb';
    case 'xml':
    case 'xaml':
    case 'csproj':
    case 'fsproj':
    case 'props':
    case 'svg':
      return 'xml';
    case 'yaml':
    case 'yml':
      return 'yaml';
    default:
      return 'plaintext';
  }
}

export function lspLanguageFromPath(path: string): string | null {
  const filename = path.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (JSON_DOTFILE_NAMES.has(filename)) return 'json';
  const extension = filename.includes('.') ? filename.split('.').pop()?.toLowerCase() : filename;
  switch (extension) {
    case 'c':
    case 'cc':
    case 'cpp':
    case 'cxx':
    case 'h':
    case 'hh':
    case 'hpp':
    case 'hxx':
      return 'cpp';
    case 'cs':
    case 'csx':
      return 'csharp';
    case 'java':
      return 'java';
    case 'ts':
      return 'typescript';
    case 'tsx':
      return 'typescriptreact';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'jsx':
      return 'javascriptreact';
    case 'htm':
    case 'html':
    case 'shtml':
      return 'html';
    case 'css':
      return 'css';
    case 'scss':
      return 'scss';
    case 'less':
      return 'less';
    case 'json':
      return 'json';
    case 'jsonc':
      return 'jsonc';
    case 'yaml':
    case 'yml':
      return 'yaml';
    case 'py':
    case 'pyi':
    case 'pyw':
      return 'python';
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'shellscript';
    case 'sql':
      return 'sql';
    case 'md':
    case 'mdx':
      return 'markdown';
    case 'rs':
      return 'rust';
    case 'go':
      return 'go';
    case 'swift':
      return 'swift';
    default:
      return null;
  }
}