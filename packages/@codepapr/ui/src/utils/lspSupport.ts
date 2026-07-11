export type LspInstallMode = 'managed' | 'npm' | 'system';

export interface LspSupportDescriptor {
  languageId: string;
  languageLabel: string;
  installMode: LspInstallMode;
  recommendedServers: string[];
  candidateCommands: string[];
}

const LSP_SUPPORT_BY_LANGUAGE: Record<string, LspSupportDescriptor> = {
  typescript: {
    languageId: 'typescript',
    languageLabel: 'TypeScript / JavaScript',
    installMode: 'npm',
    recommendedServers: ['typescript-language-server'],
    candidateCommands: ['typescript-language-server --stdio'],
  },
  typescriptreact: {
    languageId: 'typescript',
    languageLabel: 'TypeScript / JavaScript',
    installMode: 'npm',
    recommendedServers: ['typescript-language-server'],
    candidateCommands: ['typescript-language-server --stdio'],
  },
  javascript: {
    languageId: 'typescript',
    languageLabel: 'TypeScript / JavaScript',
    installMode: 'npm',
    recommendedServers: ['typescript-language-server'],
    candidateCommands: ['typescript-language-server --stdio'],
  },
  javascriptreact: {
    languageId: 'typescript',
    languageLabel: 'TypeScript / JavaScript',
    installMode: 'npm',
    recommendedServers: ['typescript-language-server'],
    candidateCommands: ['typescript-language-server --stdio'],
  },
  html: {
    languageId: 'html',
    languageLabel: 'HTML',
    installMode: 'npm',
    recommendedServers: ['vscode-html-language-server'],
    candidateCommands: ['vscode-html-language-server --stdio'],
  },
  css: {
    languageId: 'css',
    languageLabel: 'CSS / SCSS / LESS',
    installMode: 'npm',
    recommendedServers: ['vscode-css-language-server'],
    candidateCommands: ['vscode-css-language-server --stdio'],
  },
  scss: {
    languageId: 'css',
    languageLabel: 'CSS / SCSS / LESS',
    installMode: 'npm',
    recommendedServers: ['vscode-css-language-server'],
    candidateCommands: ['vscode-css-language-server --stdio'],
  },
  less: {
    languageId: 'css',
    languageLabel: 'CSS / SCSS / LESS',
    installMode: 'npm',
    recommendedServers: ['vscode-css-language-server'],
    candidateCommands: ['vscode-css-language-server --stdio'],
  },
  json: {
    languageId: 'json',
    languageLabel: 'JSON / JSONC',
    installMode: 'npm',
    recommendedServers: ['vscode-json-language-server'],
    candidateCommands: ['vscode-json-language-server --stdio'],
  },
  jsonc: {
    languageId: 'json',
    languageLabel: 'JSON / JSONC',
    installMode: 'npm',
    recommendedServers: ['vscode-json-language-server'],
    candidateCommands: ['vscode-json-language-server --stdio'],
  },
  yaml: {
    languageId: 'yaml',
    languageLabel: 'YAML',
    installMode: 'npm',
    recommendedServers: ['yaml-language-server'],
    candidateCommands: ['yaml-language-server --stdio'],
  },
  python: {
    languageId: 'python',
    languageLabel: 'Python',
    installMode: 'npm',
    recommendedServers: ['pyright-langserver'],
    candidateCommands: ['pyright-langserver --stdio'],
  },
  csharp: {
    languageId: 'csharp',
    languageLabel: 'C#',
    installMode: 'managed',
    recommendedServers: ['csharp-ls', 'OmniSharp'],
    candidateCommands: ['csharp-ls', 'omnisharp -lsp', 'OmniSharp -lsp'],
  },
  java: {
    languageId: 'java',
    languageLabel: 'Java',
    installMode: 'managed',
    recommendedServers: ['jdtls'],
    candidateCommands: ['jdtls'],
  },
  c: {
    languageId: 'cpp',
    languageLabel: 'C / C++',
    installMode: 'managed',
    recommendedServers: ['clangd'],
    candidateCommands: ['clangd'],
  },
  cpp: {
    languageId: 'cpp',
    languageLabel: 'C / C++',
    installMode: 'managed',
    recommendedServers: ['clangd'],
    candidateCommands: ['clangd'],
  },
  shellscript: {
    languageId: 'shellscript',
    languageLabel: 'Shell Script',
    installMode: 'managed',
    recommendedServers: ['bash-language-server'],
    candidateCommands: ['bash-language-server start'],
  },
  rust: {
    languageId: 'rust',
    languageLabel: 'Rust',
    installMode: 'system',
    recommendedServers: ['rust-analyzer'],
    candidateCommands: ['rust-analyzer'],
  },
  go: {
    languageId: 'go',
    languageLabel: 'Go',
    installMode: 'system',
    recommendedServers: ['gopls'],
    candidateCommands: ['gopls'],
  },
  swift: {
    languageId: 'swift',
    languageLabel: 'Swift',
    installMode: 'system',
    recommendedServers: ['sourcekit-lsp'],
    candidateCommands: ['sourcekit-lsp --stdio'],
  },
  sql: {
    languageId: 'sql',
    languageLabel: 'SQL',
    installMode: 'managed',
    recommendedServers: ['sqls'],
    candidateCommands: ['sqls'],
  },
  markdown: {
    languageId: 'markdown',
    languageLabel: 'Markdown',
    installMode: 'managed',
    recommendedServers: ['marksman'],
    candidateCommands: ['marksman server'],
  },
};

const MISSING_LSP_SERVER_PATTERNS = [
  /no such file or directory/i,
  /os error 2/i,
  /command not found/i,
  /not found/i,
  /cannot find the file/i,
  /system cannot find the file/i,
  /找不到指定的文件/i,
  /无法启动 lsp server/i,
];

export function describeLspSupport(languageId: string | null | undefined): LspSupportDescriptor | null {
  if (!languageId) {
    return null;
  }
  return LSP_SUPPORT_BY_LANGUAGE[languageId] ?? null;
}

export function isLikelyMissingLspServer(errorMessage: string | null | undefined): boolean {
  const normalized = (errorMessage ?? '').trim();
  if (!normalized) {
    return false;
  }
  return MISSING_LSP_SERVER_PATTERNS.some((pattern) => pattern.test(normalized));
}

export interface LspAvailabilityStatus {
  languageId: string;
  languageLabel: string;
  installMode: LspInstallMode;
  available: boolean;
  serverName: string | null;
  message: string;
}

export async function checkLspAvailability(languageIds?: string[]): Promise<LspAvailabilityStatus[]> {
  const languages = languageIds ?? Object.keys(LSP_SUPPORT_BY_LANGUAGE);
  const results: LspAvailabilityStatus[] = [];

  for (const langId of languages) {
    const descriptor = LSP_SUPPORT_BY_LANGUAGE[langId];
    if (!descriptor) {
      results.push({
        languageId: langId,
        languageLabel: langId,
        installMode: 'system',
        available: false,
        serverName: null,
        message: `不支持的语言: ${langId}`,
      });
      continue;
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const providerInfo = await invoke<{ tool_source: string; available: boolean } | null>(
        'resolve_symbol_provider',
        { languageId: descriptor.languageId },
      );

      const available = providerInfo?.available ?? false;
      const serverName = available
        ? (providerInfo?.tool_source ?? descriptor.recommendedServers[0] ?? 'unknown')
        : null;

      results.push({
        languageId: langId,
        languageLabel: descriptor.languageLabel,
        installMode: descriptor.installMode,
        available,
        serverName,
        message: available
          ? `${descriptor.languageLabel} LSP 可用 (${serverName})`
          : `${descriptor.languageLabel} LSP 不可用`,
      });
    } catch {
      results.push({
        languageId: langId,
        languageLabel: descriptor.languageLabel,
        installMode: descriptor.installMode,
        available: false,
        serverName: null,
        message: `${descriptor.languageLabel} LSP 检查失败`,
      });
    }
  }

  return results;
}

export async function ensureLspServer(languageId: string): Promise<LspAvailabilityStatus> {
  const descriptor = LSP_SUPPORT_BY_LANGUAGE[languageId];
  if (!descriptor) {
    return {
      languageId,
      languageLabel: languageId,
      installMode: 'system',
      available: false,
      serverName: null,
      message: `不支持的语言: ${languageId}`,
    };
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core');

    await invoke('lsp_start_server', {
      workspacePath: '',
      languageId: descriptor.languageId,
    });

    const providerInfo = await invoke<{ tool_source: string; available: boolean } | null>(
      'resolve_symbol_provider',
      { languageId: descriptor.languageId },
    );

    const available = providerInfo?.available ?? false;
    const serverName = available
      ? (providerInfo?.tool_source ?? descriptor.recommendedServers[0] ?? 'unknown')
      : null;

    return {
      languageId,
      languageLabel: descriptor.languageLabel,
      installMode: descriptor.installMode,
      available,
      serverName,
      message: available
        ? `${descriptor.languageLabel} LSP 已启动 (${serverName})`
        : `${descriptor.languageLabel} LSP 启动后仍不可用`,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const isMissing = isLikelyMissingLspServer(errorMsg);

    return {
      languageId,
      languageLabel: descriptor.languageLabel,
      installMode: descriptor.installMode,
      available: false,
      serverName: null,
      message: isMissing
        ? `${descriptor.languageLabel} LSP 服务器未安装。请安装 ${descriptor.recommendedServers.join(' 或 ')}。`
        : `${descriptor.languageLabel} LSP 启动失败: ${errorMsg}`,
    };
  }
}

export function getInstallInstructions(languageId: string): string | null {
  const descriptor = LSP_SUPPORT_BY_LANGUAGE[languageId];
  if (!descriptor) return null;

  switch (descriptor.installMode) {
    case 'npm':
      return `npm install -g ${descriptor.recommendedServers[0]}`;
    case 'system':
      return descriptor.candidateCommands[0] ?? '请参考官方文档安装';
    case 'managed':
      return 'CodePapr 将自动下载并安装此语言服务器。';
    default:
      return null;
  }
}