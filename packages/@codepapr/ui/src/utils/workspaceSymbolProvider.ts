import { invoke } from '@tauri-apps/api/core';
import type { SymbolSource, UnifiedSymbolDefinition, SymbolLocation, HoverResult } from '@codepapr/core';

const LSP_KIND_LABELS: Record<number, string> = {
  1: 'file', 2: 'module', 3: 'namespace', 4: 'package',
  5: 'class', 6: 'method', 7: 'property', 8: 'field',
  9: 'constructor', 10: 'enum', 11: 'interface', 12: 'function',
  13: 'variable', 14: 'constant', 15: 'string', 16: 'number',
  17: 'boolean', 18: 'array', 19: 'object', 20: 'key',
  21: 'null', 22: 'enum-member', 23: 'struct', 24: 'event',
  25: 'operator', 26: 'type-parameter',
};

export interface WorkspaceMapSymbolSummary {
  name: string;
  kind: string;
  signature: string;
  line: number;
  exported: boolean;
  symbolSource?: SymbolSource;
}

function unifiedToMapSymbol(def: UnifiedSymbolDefinition): WorkspaceMapSymbolSummary {
  return {
    name: def.name,
    kind: LSP_KIND_LABELS[def.kind] ?? 'symbol',
    signature: def.signature,
    line: def.line + 1,
    exported: def.exported,
    symbolSource: def.symbolSource,
  };
}

export function isProviderSupportedLanguage(languageId: string | null | undefined): boolean {
  return languageId != null && PROVIDER_LANGUAGE_MAP.has(languageId);
}

const PROVIDER_LANGUAGE_MAP = new Map<string, string>([
  ['typescript', 'typescript'],
  ['typescriptreact', 'typescriptreact'],
  ['javascript', 'javascript'],
  ['javascriptreact', 'javascript'],
  ['python', 'python'],
  ['rust', 'rust'],
  ['go', 'go'],
  ['java', 'java'],
  ['c', 'cpp'],
  ['cpp', 'cpp'],
  ['csharp', 'csharp'],
  ['html', 'html'],
  ['css', 'css'],
  ['scss', 'css'],
  ['less', 'css'],
  ['json', 'json'],
  ['jsonc', 'json'],
  ['yaml', 'yaml'],
  ['shellscript', 'shellscript'],
  ['swift', 'swift'],
  ['ruby', 'ruby'],
  ['php', 'php'],
  ['kotlin', 'kotlin'],
  ['dart', 'dart'],
  ['sql', 'sql'],
  ['markdown', 'markdown'],
]);

export class WorkspaceSymbolProvider {
  static async extractSymbols(
    languageId: string,
    path: string,
    content: string,
  ): Promise<WorkspaceMapSymbolSummary[]> {
    try {
      const defs: UnifiedSymbolDefinition[] = await invoke('resolve_symbols', {
        languageId,
        path,
        content,
      });
      return defs.map(unifiedToMapSymbol);
    } catch {
      return [];
    }
  }

  static async hover(
    languageId: string,
    path: string,
    content: string,
    line: number,
    character: number,
  ): Promise<HoverResult | null> {
    try {
      return await invoke('resolve_symbol_hover', {
        languageId,
        path,
        content,
        line,
        character,
      });
    } catch {
      return null;
    }
  }

  static async definition(
    languageId: string,
    path: string,
    content: string,
    line: number,
    character: number,
  ): Promise<SymbolLocation[]> {
    try {
      return await invoke('resolve_symbol_definition', {
        languageId,
        path,
        content,
        line,
        character,
      });
    } catch {
      return [];
    }
  }

  static async references(
    languageId: string,
    path: string,
    content: string,
    line: number,
    character: number,
  ): Promise<SymbolLocation[]> {
    try {
      return await invoke('resolve_symbol_references', {
        languageId,
        path,
        content,
        line,
        character,
      });
    } catch {
      return [];
    }
  }
}
