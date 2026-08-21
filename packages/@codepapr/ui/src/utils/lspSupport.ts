import { isLspFamilyEnabled } from './lspFamilies';

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
  running: boolean;
  serverName: string | null;
  toolOrigin: string | null;
  toolSource: string | null;
  message: string;
}

interface LspAvailabilityInfo {
  languageId?: string;
  available?: boolean;
  running?: boolean;
  toolOrigin?: string | null;
  toolSource?: string | null;
  serverStatus?: {
    running?: boolean;
    toolLabel?: string;
    toolSource?: string;
    toolOrigin?: string;
    command?: string;
  } | null;
}

function unavailableStatus(
  languageId: string,
  languageLabel: string,
  installMode: LspInstallMode,
  message: string,
): LspAvailabilityStatus {
  return {
    languageId,
    languageLabel,
    installMode,
    available: false,
    running: false,
    serverName: null,
    toolOrigin: null,
    toolSource: null,
    message,
  };
}

function statusFromAvailabilityInfo(
  descriptor: LspSupportDescriptor,
  langId: string,
  info: LspAvailabilityInfo | null,
): LspAvailabilityStatus {
  const available = info?.available === true;
  const running = info?.running === true || info?.serverStatus?.running === true;
  const toolSource = info?.toolSource ?? info?.serverStatus?.toolSource ?? null;
  const toolOrigin = info?.toolOrigin ?? info?.serverStatus?.toolOrigin ?? null;
  const serverName = available
    ? (info?.serverStatus?.toolLabel ?? toolSource ?? descriptor.recommendedServers[0] ?? 'unknown')
    : null;

  return {
    languageId: langId,
    languageLabel: descriptor.languageLabel,
    installMode: descriptor.installMode,
    available,
    running,
    serverName,
    toolOrigin,
    toolSource,
    message: available
      ? `${descriptor.languageLabel} LSP ${running ? '运行中' : '可用'} (${serverName})`
      : `${descriptor.languageLabel} LSP 不可用`,
  };
}

export async function checkLspAvailability(
  workspacePath: string,
  languageIds?: string[],
): Promise<LspAvailabilityStatus[]> {
  const languages = languageIds ?? Object.keys(LSP_SUPPORT_BY_LANGUAGE);
  const results: LspAvailabilityStatus[] = [];
  const trimmedWorkspace = workspacePath.trim();

  for (const langId of languages) {
    const descriptor = LSP_SUPPORT_BY_LANGUAGE[langId];
    if (!descriptor) {
      results.push(unavailableStatus(langId, langId, 'system', `不支持的语言: ${langId}`));
      continue;
    }
    if (!trimmedWorkspace) {
      results.push(unavailableStatus(
        langId,
        descriptor.languageLabel,
        descriptor.installMode,
        `${descriptor.languageLabel} LSP 检查需要工作区路径`,
      ));
      continue;
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const info = await invoke<LspAvailabilityInfo>('lsp_query_availability', {
        workspacePath: trimmedWorkspace,
        languageId: descriptor.languageId,
      });
      results.push(statusFromAvailabilityInfo(descriptor, langId, info));
    } catch {
      results.push(unavailableStatus(
        langId,
        descriptor.languageLabel,
        descriptor.installMode,
        `${descriptor.languageLabel} LSP 检查失败`,
      ));
    }
  }

  return results;
}

export async function ensureLspServer(
  workspacePath: string,
  languageId: string,
  disabledFamilies?: readonly string[],
): Promise<LspAvailabilityStatus> {
  const descriptor = LSP_SUPPORT_BY_LANGUAGE[languageId];
  if (!descriptor) {
    return unavailableStatus(languageId, languageId, 'system', `不支持的语言: ${languageId}`);
  }

  if (!isLspFamilyEnabled(disabledFamilies, languageId)) {
    return unavailableStatus(
      languageId,
      descriptor.languageLabel,
      descriptor.installMode,
      `${descriptor.languageLabel} LSP 已在设置中关闭`,
    );
  }

  const trimmedWorkspace = workspacePath.trim();
  if (!trimmedWorkspace) {
    return unavailableStatus(
      languageId,
      descriptor.languageLabel,
      descriptor.installMode,
      `${descriptor.languageLabel} LSP 启动需要工作区路径`,
    );
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core');

    await invoke('lsp_start_server', {
      workspacePath: trimmedWorkspace,
      languageId: descriptor.languageId,
    });

    const info = await invoke<LspAvailabilityInfo>('lsp_query_availability', {
      workspacePath: trimmedWorkspace,
      languageId: descriptor.languageId,
    });

    const status = statusFromAvailabilityInfo(descriptor, languageId, info);
    return {
      ...status,
      message: status.available
        ? `${descriptor.languageLabel} LSP 已启动 (${status.serverName})`
        : `${descriptor.languageLabel} LSP 启动后仍不可用`,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const isMissing = isLikelyMissingLspServer(errorMsg);

    return unavailableStatus(
      languageId,
      descriptor.languageLabel,
      descriptor.installMode,
      isMissing
        ? `${descriptor.languageLabel} LSP 服务器未安装。请安装 ${descriptor.recommendedServers.join(' 或 ')}。`
        : `${descriptor.languageLabel} LSP 启动失败: ${errorMsg}`,
    );
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